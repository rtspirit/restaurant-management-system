// Task L, end to end through the API routes: connect Demo POS, allow its tools, bring in the
// sales, and the reports show the right numbers. Plus every refusal the brief lists.
//
// Real sign-in users against the local sign-in service, throwaway restaurants made with
// `createDemoRestaurant` and NO sales loaded (as `reset-demo --no-sales` leaves them). The
// gateway's MCP client reaches the Demo POS route in-process: same app, same checks, no socket.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SignJWT } from "jose";
// The Demo POS server and the gateway are tested in depth in packages/mcp (isolation between
// restaurants, refusals with their `mcp_calls` rows, hostile answers, a changed tool list).
import { DEMO_POS, DEMO_POS_TOOL_NAMES, SYNC_CONSUMER, type TenantContext, toPublicId } from "@rms/contracts";
import { mintAppToken, mintConnectionToken } from "@rms/auth";
import { adminDb, closeAll, newUuid, withStore } from "@rms/db";
import { requireTestEnv } from "@rms/db/testing";
import { callTool, demoPosUrl } from "@rms/mcp";
import { createDemoRestaurant, installPlatformLibrary, removeRestaurants, seedDemoBooks } from "@rms/seed";
import app from "../index.js";
import { setFailRecordingForTests, setGatewayOptionsForTests } from "./connections.js";

requireTestEnv("DATABASE_URL", "DATABASE_ADMIN_URL", "SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY", "RMS_TOKEN_SECRET", "API_URL");
const env = process.env;

// Task L ids: uuid suffix 40 to 4f, store prefixes o_4141414141xx.
const uuid = (suffix: string) => `0193a3c0-0000-7000-8000-0000000000${suffix}`;
const A = { org: uuid("42"), prefix: "o_414141414102" }; // Marigold Kitchen
const B = { org: uuid("43"), prefix: "o_414141414103" }; // Slice Yard
const C = { org: uuid("44"), prefix: "o_414141414104" }; // not a demo template
const ORGS = [A.org, B.org, C.org];

// The gateway's fetch, routed to this very app.
const inProcess = async (url: string | URL, init?: RequestInit): Promise<Response> => app.fetch(new Request(url, init));
setGatewayOptionsForTests({ fetch: inProcess });

type TestUser = { id: string; token: string };
const users: TestUser[] = [];
const randomHex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");
const signUp = async (): Promise<TestUser> => {
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY as string, "content-type": "application/json" },
    body: JSON.stringify({ email: `conn-l-${randomHex(6)}@integ.rms.test`, password: `Pw-${randomHex(16)}` }),
  });
  const json = (await res.json()) as { access_token?: string; user?: { id: string } };
  if (!res.ok || !json.access_token || !json.user) throw new Error(`sign-up failed with status ${res.status}`);
  const u = { id: json.user.id, token: json.access_token };
  users.push(u);
  return u;
};
const deleteUser = async (id: string) => {
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: { apikey: env.SUPABASE_SECRET_KEY as string, authorization: `Bearer ${env.SUPABASE_SECRET_KEY}` } });
  if (!res.ok && res.status !== 404) throw new Error(`could not delete test user (status ${res.status})`);
};

type Reply = { status: number; body: any; text: string };
const call = async (method: "GET" | "POST", path: string, token?: string, body?: unknown): Promise<Reply> => {
  const res = await app.request(path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON: the status assertions still apply.
  }
  return { status: res.status, body: parsed, text };
};
const ok = (r: Reply) => {
  expect(r.status, r.text.slice(0, 400)).toBe(200);
  return r.body;
};

const live = (org: string, prefix: string): TenantContext => ({
  orgId: toPublicId("org", org), storePrefix: prefix, actor: { type: "system", id: "connections-test" }, role: "owner", locations: "all", env: "live",
});
const countRows = (r: { org: string; prefix: string }, table: string) =>
  withStore(adminDb(), live(r.org, r.prefix), async (tx, store) => Number((await tx.unsafe(`select count(*)::int as n from ${store.table(table)}`))[0]?.n));
const calls = async (org: string, status?: string) => {
  const [r] = status
    ? await adminDb()<{ n: number }[]>`select count(*)::int as n from platform.mcp_calls where org_id = ${org} and status = ${status}`
    : await adminDb()<{ n: number }[]>`select count(*)::int as n from platform.mcp_calls where org_id = ${org}`;
  return r?.n ?? 0;
};

/** Raw POST to the Demo POS route with a given authorization header. */
const posPost = (authorization?: string) =>
  app.fetch(new Request(demoPosUrl(), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(authorization ? { authorization } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  }));


describe("Demo POS: connect, allow, bring in the sales", () => {
  let ownerA: TestUser, staffA: TestUser, ownerB: TestUser, ownerC: TestUser;
  let conA = "con_" as `con_${string}`, conB = "con_" as `con_${string}`, conC = "con_" as `con_${string}`;

  beforeAll(async () => {
    const sql = adminDb();
    await removeRestaurants(sql, ORGS);
    await installPlatformLibrary(sql);
    await createDemoRestaurant(sql, { template: "marigold", orgUuid: A.org, storePrefix: A.prefix });
    await createDemoRestaurant(sql, { template: "slice_yard", orgUuid: B.org, storePrefix: B.prefix });
    await createDemoRestaurant(sql, { template: "marigold", orgUuid: C.org, storePrefix: C.prefix });
    // Named exactly like the template, but its platform-written profile is not the template's.
    await sql`update platform.restaurant_profiles set concept = 'An independent bistro' where org_id = ${C.org}`;
    [ownerA, staffA, ownerB, ownerC] = [await signUp(), await signUp(), await signUp(), await signUp()];
    await sql`insert into platform.members (id, org_id, user_id, role) values
      (${newUuid()}, ${A.org}, ${ownerA.id}, 'owner'), (${newUuid()}, ${A.org}, ${staffA.id}, 'staff'),
      (${newUuid()}, ${B.org}, ${ownerB.id}, 'owner'), (${newUuid()}, ${C.org}, ${ownerC.id}, 'owner')`;
    // As `reset-demo --no-sales` leaves a restaurant: tables, chart of accounts, calendar, no numbers.
    for (const [r, owner, template] of [[A, ownerA, "marigold"], [B, ownerB, "slice_yard"], [C, ownerC, "marigold"]] as const) {
      await seedDemoBooks(sql, { orgUuid: r.org, template, ownerUserId: owner.id, withSales: false, draftSamples: false });
    }
  }, 300_000);

  afterAll(async () => {
    await removeRestaurants(adminDb(), ORGS);
    for (const u of users) await deleteUser(u.id);
    await closeAll();
  }, 120_000);

  describe("the routes refuse", () => {
    it("no token, a staff member, and a body that names a restaurant", async () => {
      expect((await call("GET", "/connections/v1/catalog")).status).toBe(401);
      expect((await call("POST", "/connections/v1", undefined, { kind: "catalog", key: "demo_pos" })).status).toBe(401);
      expect((await call("GET", "/connections/v1/catalog", staffA.token)).status).toBe(403);
      expect((await call("POST", "/connections/v1", staffA.token, { kind: "catalog", key: "demo_pos" })).status).toBe(403);
      expect((await call("POST", "/connections/v1", ownerA.token, { kind: "catalog", key: "demo_pos", orgId: toPublicId("org", B.org) })).status).toBe(400);
      expect((await call("POST", `/connections/v1/con_${"0".repeat(32)}/sync`, ownerA.token, { orgId: toPublicId("org", B.org) })).status).toBe(400);
      expect((await call("POST", `/connections/v1/con_${"0".repeat(32)}/disconnect`, ownerA.token, { orgId: toPublicId("org", B.org) })).status).toBe(400);
      expect((await call("POST", "/connections/v1", ownerA.token, { kind: "custom", name: "Mine", url: "https://example.com/mcp", token: "abcdefgh12" })).status).toBe(503);
    });
  });

  it("the catalog lists Demo POS, not yet connected, with no address in it", async () => {
    const r = await call("GET", "/connections/v1/catalog", ownerA.token);
    const { entries } = ok(r);
    expect(entries).toEqual([expect.objectContaining({ key: "demo_pos", name: "Demo POS", auth: "rms", connected: false })]);
    expect(r.text).not.toMatch(/https?:\/\//);
  });

  it("before connecting, the books are empty", async () => {
    expect(await countRows(A, "sales_day")).toBe(0);
    expect(await countRows(A, "journal_entry")).toBe(0);
  });

  it("connect: waits for the owner's yes, lists the tools in plain words, records the change as confirmed", async () => {
    const r = await call("POST", "/connections/v1", ownerA.token, { kind: "catalog", key: "demo_pos" });
    const view = ok(r);
    conA = view.id;
    expect(view).toMatchObject({ name: "Demo POS", catalogKey: "demo_pos", status: "needs_approval", canSync: true, lastSyncedAt: null });
    expect(view.tools.map((t: any) => t.name).sort()).toEqual([...DEMO_POS_TOOL_NAMES].sort());
    expect(view.tools.every((t: any) => t.readOnly && !t.granted)).toBe(true);
    expect(r.text).not.toMatch(/https?:\/\/|eyJ|Bearer/);
    const changes = await adminDb()<{ decision: string; signals: string[]; origin: string }[]>`
      select decision, signals, origin from platform.change_sets where org_id = ${A.org} and 'new_connection' = any(signals)`;
    expect(changes).toEqual([{ decision: "applied", signals: ["new_connection"], origin: "connection" }]);
  });

  it("connecting again changes nothing: same connection, no second change", async () => {
    const again = ok(await call("POST", "/connections/v1", ownerA.token, { kind: "catalog", key: "demo_pos" }));
    expect(again.id).toBe(conA);
    const [n] = await adminDb()<{ n: number }[]>`select count(*)::int as n from platform.change_sets where org_id = ${A.org} and 'new_connection' = any(signals)`;
    expect(n?.n).toBe(1);
    const [rows] = await adminDb()<{ n: number }[]>`select count(*)::int as n from platform.mcp_connections where org_id = ${A.org}`;
    expect(rows?.n).toBe(1);
  });

  it("bringing in sales before the owner allows it is refused, and nothing is called", async () => {
    const res = ok(await call("POST", `/connections/v1/${conA}/sync`, ownerA.token, {}));
    expect(res.status).toBe("failed");
    expect(await calls(A.org)).toBe(0);
  });

  it("allow: refused unless the names AND the version are the list shown; then every read-only tool is granted, on the record", async () => {
    const shown = ok(await call("GET", "/connections/v1", ownerA.token)).connections[0];
    expect(shown.toolsVersion).toMatch(/^[0-9a-f]{64}$/);
    expect((await call("POST", `/connections/v1/${conA}/approve`, ownerA.token, { tools: ["list_locations"], toolsVersion: shown.toolsVersion })).status).toBe(409);
    expect((await call("POST", `/connections/v1/${conA}/approve`, ownerA.token, { tools: [...DEMO_POS_TOOL_NAMES] })).status).toBe(400);
    expect((await call("POST", `/connections/v1/${conA}/approve`, ownerA.token, { tools: [...DEMO_POS_TOOL_NAMES], toolsVersion: "0".repeat(64) })).status).toBe(409);
    const view = ok(await call("POST", `/connections/v1/${conA}/approve`, ownerA.token, { tools: [...DEMO_POS_TOOL_NAMES], toolsVersion: shown.toolsVersion }));
    expect(view.status).toBe("connected");
    expect(view.tools.every((t: any) => t.granted)).toBe(true);
    expect(view.statusText).toBe("Connected. Nothing brought in yet.");
    const audit = await adminDb()<{ action: string; meta: unknown }[]>`select action, meta from platform.audit_log where org_id = ${A.org} and action = 'connection.approve'`;
    expect(audit).toEqual([{ action: "connection.approve", meta: { tools: 9, granted: 9 } }]);
  });

  it("bring in my sales: eight weeks for two locations, last week $84,310; the reports show 61.3% prime cost", async () => {
    const started = Date.now();
    const res = ok(await call("POST", `/connections/v1/${conA}/sync`, ownerA.token, {}));
    console.info(`Demo POS sync, Marigold, first run: ${Date.now() - started} ms`);
    expect(res).toMatchObject({ status: "ok", from: "2026-09-21", to: "2026-11-15" });
    expect(res.counts).toMatchObject({ salesDays: 112, labourDays: 336, stockCounts: 18 });
    expect(res.counts.posted).toBeGreaterThan(400);
    expect(res.message).toBe("Brought in 8 weeks of sales for 2 locations. Last week's sales: $84,310.00.");
    expect(await countRows(A, "sales_day")).toBe(112);
    // Every call went through the gateway and is on the record, with names and dates only.
    expect(await calls(A.org, "ok")).toBe(2 + 7); // list_locations, get_stock_items, then the seven dated tools in one chunk
    const [summary] = await adminDb()<{ args_summary: Record<string, unknown> }[]>`
      select args_summary from platform.mcp_calls where org_id = ${A.org} and tool_name = 'get_daily_sales' limit 1`;
    expect(summary?.args_summary).toEqual({ names: ["from", "to"], from: "2026-09-20", to: "2026-11-15" });
    // The named query, read back by the one loader: nothing new, and the figures on the sketches.
    const check = await seedDemoBooks(adminDb(), { orgUuid: A.org, template: "marigold", ownerUserId: ownerA.id, withSales: true, draftSamples: false });
    expect(check.books?.posted).toEqual({ salesDays: 0, vendorBills: 0, labourDays: 0, stockCounts: 0 });
    expect(check.books?.lastWeek).toEqual({ weekStart: "2026-11-09", netSalesMinor: 8_431_000, primeCostPct: "61.3", stockCounted: true });
  }, 300_000);

  it("bring in my sales again: nothing new, same numbers", async () => {
    const before = { days: await countRows(A, "sales_day"), entries: await countRows(A, "journal_entry") };
    const res = ok(await call("POST", `/connections/v1/${conA}/sync`, ownerA.token, {}));
    expect(res.status).toBe("nothing_new");
    expect(res.counts.posted).toBe(0);
    expect(res.message).toBe("Your sales are already up to date. Last week's sales: $84,310.00.");
    expect({ days: await countRows(A, "sales_day"), entries: await countRows(A, "journal_entry") }).toEqual(before);
    const list = ok(await call("GET", "/connections/v1", ownerA.token));
    expect(list.connections[0].statusText).toMatch(/^Connected\. Last brought in sales /);
  }, 300_000);

  it("if the change cannot be recorded, the connection ends in error with nothing allowed, and the next press records it", async () => {
    const changes = async () =>
      (await adminDb()<{ n: number }[]>`select count(*)::int as n from platform.change_sets where org_id = ${B.org} and 'new_connection' = any(signals)`)[0]?.n;
    setFailRecordingForTests(true);
    try {
      expect((await call("POST", "/connections/v1", ownerB.token, { kind: "catalog", key: "demo_pos" })).status).toBe(500);
    } finally {
      setFailRecordingForTests(false);
    }
    expect(await changes()).toBe(0);
    const [row] = await adminDb()<{ status: string; grants: number }[]>`
      select c.status, (select count(*)::int from platform.mcp_tool_grants g where g.connection_id = c.id) as grants
        from platform.mcp_connections c where c.org_id = ${B.org}`;
    expect(row).toEqual({ status: "error", grants: 0 });
    const view = ok(await call("GET", "/connections/v1", ownerB.token)).connections[0];
    expect(view.status).toBe("error");
    expect((await call("POST", `/connections/v1/${view.id}/approve`, ownerB.token, { tools: [...DEMO_POS_TOOL_NAMES], toolsVersion: view.toolsVersion })).status).toBe(409);
    const again = ok(await call("POST", "/connections/v1", ownerB.token, { kind: "catalog", key: "demo_pos" }));
    expect(again).toMatchObject({ id: view.id, status: "needs_approval" });
    expect(await changes()).toBe(1);
  });

  describe("the Demo POS server", () => {
    it("refuses no token, a forged token, an expired token and a data token", async () => {
      expect((await posPost()).status).toBe(401);
      const claims = { kind: "connection", aud: "mcp", org: toPublicId("org", A.org), connection: conA, iss: "rms", jti: crypto.randomUUID() };
      const now = Math.floor(Date.now() / 1000);
      const forged = await new SignJWT({ ...claims, iat: now, exp: now + 600 }).setProtectedHeader({ alg: "HS256", typ: "rms+jwt" }).sign(new TextEncoder().encode("x".repeat(48)));
      expect((await posPost(`Bearer ${forged}`)).status).toBe(401);
      const expired = await new SignJWT({ ...claims, iat: now - 7200, exp: now - 3600 })
        .setProtectedHeader({ alg: "HS256", typ: "rms+jwt" })
        .sign(new TextEncoder().encode(env.RMS_TOKEN_SECRET as string));
      expect((await posPost(`Bearer ${expired}`)).status).toBe(401);
      const data = await mintAppToken({
        kind: "app", aud: "data", org: toPublicId("org", A.org), sub: toPublicId("usr", ownerA.id), app: toPublicId("app", newUuid()), ver: toPublicId("ver", newUuid()),
        role: "owner", loc: "all", env: "live",
      } as never);
      expect((await posPost(`Bearer ${data}`)).status).toBe(401);
    });

    it("refuses a token naming another restaurant's connection, and one for a connection that does not exist", async () => {
      const crossed = await mintConnectionToken({ kind: "connection", aud: "mcp", org: toPublicId("org", B.org), connection: conA });
      expect((await posPost(`Bearer ${crossed}`)).status).toBe(403);
      const missing = await mintConnectionToken({ kind: "connection", aud: "mcp", org: toPublicId("org", A.org), connection: toPublicId("con", newUuid()) });
      expect((await posPost(`Bearer ${missing}`)).status).toBe(403);
    });

    it("refuses a browser (an Origin) and a host that is not the API's", async () => {
      const token = await mintConnectionToken({ kind: "connection", aud: "mcp", org: toPublicId("org", A.org), connection: conA });
      const res = await app.fetch(new Request(demoPosUrl(), { method: "POST", headers: { authorization: `Bearer ${token}`, origin: "https://evil.example", "content-type": "application/json" }, body: "{}" }));
      expect(res.status).toBe(403);
      const other = await app.fetch(new Request(`https://evil.example${DEMO_POS.route}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" }));
      expect(other.status).toBe(403);
      // Host shapes that must not slip past the check: userinfo, a trailing dot, another host with the right port.
      const api = new URL(demoPosUrl());
      const send = (url: string) => app.fetch(new Request(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" }));
      // Userinfo ("api-host@evil.example") cannot even reach the server: a request with credentials in its address cannot be made.
      expect(() => new Request(`${api.protocol}//${api.hostname}@evil.example${DEMO_POS.route}`)).toThrow();
      // A trailing dot: the address parser turns an IP address with one back into the same host, and
      // a name with one is a different host. Either way it never gets an answer with data in it.
      expect((await send(`${api.protocol}//${api.hostname}.${api.port ? `:${api.port}` : ""}${DEMO_POS.route}`)).status).not.toBe(200);
      for (const url of [
        `${api.protocol}//evil.example${api.port ? `:${api.port}` : ""}${DEMO_POS.route}`,
        `${api.protocol}//${api.hostname}.evil.example${DEMO_POS.route}`,
      ]) {
        expect((await send(url)).status, url).toBe(403);
      }
      // The same host in upper case or on another port is the same host: it gets past the host check to the token check.
      for (const url of [`${api.protocol}//${api.hostname.toUpperCase()}${api.port ? `:${api.port}` : ""}${DEMO_POS.route}`, `${api.protocol}//${api.hostname}:1${DEMO_POS.route}`]) {
        expect((await send(url)).status, url).not.toBe(403);
      }
    });

    it("one restaurant's tokens reach only its own connection", async () => {
      conB = ok(await call("POST", "/connections/v1", ownerB.token, { kind: "catalog", key: "demo_pos" })).id;
      const own = await mintConnectionToken({ kind: "connection", aud: "mcp", org: toPublicId("org", B.org), connection: conB });
      expect((await posPost(`Bearer ${own}`)).status).toBe(200);
      const crossed = await mintConnectionToken({ kind: "connection", aud: "mcp", org: toPublicId("org", B.org), connection: conA });
      expect((await posPost(`Bearer ${crossed}`)).status).toBe(403);
    });
  });

  it("another restaurant's connection id is not found, through the gateway and through every route", async () => {
    const before = await calls(B.org);
    await expect(callTool({ orgId: toPublicId("org", B.org) }, conA, SYNC_CONSUMER, "list_locations", {}, { fetch: inProcess })).rejects.toMatchObject({ reason: "not_found" });
    expect(await calls(B.org)).toBe(before);
    expect((await call("POST", `/connections/v1/${conA}/approve`, ownerB.token, { tools: [...DEMO_POS_TOOL_NAMES], toolsVersion: "0".repeat(64) })).status).toBe(404);
    expect((await call("POST", `/connections/v1/${conA}/sync`, ownerB.token, {})).status).toBe(404);
    expect((await call("POST", `/connections/v1/${conA}/disconnect`, ownerB.token)).status).toBe(404);
    expect((await call("POST", "/connections/v1/not-an-id/sync", ownerB.token, {})).status).toBe(404);
  });

  it("a restaurant named like a template, but not made from one, brings in nothing, and says so", async () => {
    const view = ok(await call("POST", "/connections/v1", ownerC.token, { kind: "catalog", key: "demo_pos" }));
    conC = view.id;
    ok(await call("POST", `/connections/v1/${conC}/approve`, ownerC.token, { tools: [...DEMO_POS_TOOL_NAMES], toolsVersion: view.toolsVersion }));
    const res = ok(await call("POST", `/connections/v1/${conC}/sync`, ownerC.token, {}));
    expect(res).toMatchObject({ status: "nothing_new", message: "Demo POS has no sales for this restaurant, so nothing was brought in." });
    expect(await countRows(C, "sales_day")).toBe(0);
  });

  it("disconnect: switched off, no grants, the Demo POS refuses its token, and a sync is refused", async () => {
    const view = ok(await call("POST", `/connections/v1/${conA}/disconnect`, ownerA.token));
    expect(view).toMatchObject({ status: "disconnected", statusText: "Not connected." });
    const [g] = await adminDb()<{ n: number }[]>`select count(*)::int as n from platform.mcp_tool_grants where org_id = ${A.org}`;
    expect(g?.n).toBe(0);
    const token = await mintConnectionToken({ kind: "connection", aud: "mcp", org: toPublicId("org", A.org), connection: conA });
    expect((await posPost(`Bearer ${token}`)).status).toBe(403);
    expect(ok(await call("POST", `/connections/v1/${conA}/sync`, ownerA.token, {})).status).toBe("failed");
    expect(ok(await call("GET", "/connections/v1", ownerA.token)).connections).toEqual([]);
    const { entries } = ok(await call("GET", "/connections/v1/catalog", ownerA.token));
    expect(entries[0].connected).toBe(false);
  });

  it("connecting again after a disconnect switches the same connection back on, waiting for a new yes", async () => {
    const view = ok(await call("POST", "/connections/v1", ownerA.token, { kind: "catalog", key: "demo_pos" }));
    expect(view).toMatchObject({ id: conA, status: "needs_approval" });
    expect(view.tools.every((t: any) => !t.granted)).toBe(true);
  });
});

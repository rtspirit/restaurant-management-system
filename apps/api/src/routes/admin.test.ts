import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor, toPublicId } from "@rms/contracts";
import { type Sql, adminDb, apiDb, closeAll, withOrg } from "@rms/db";
import { recordChange } from "@rms/governance";
import app from "../index.js";
import { loadTestEnv } from "@rms/db/testing";

loadTestEnv();
const hasDb = Boolean(process.env.DATABASE_URL && process.env.DATABASE_ADMIN_URL && process.env.SUPABASE_URL);

// Task F id range (f0..ff). The governance package tests use f1..f3, these use f4..f8.
const ORG_A = "0193a3c0-0000-7000-8000-0000000000f4";
const ORG_B = "0193a3c0-0000-7000-8000-0000000000f5";
const STAFF = "0193a3c0-0000-7000-8000-0000000000f6";
const MEMBER = "0193a3c0-0000-7000-8000-0000000000f7";
const PA = "o_f1f1f1f1f1f4";
const PB = "o_f1f1f1f1f1f5";
const ADMIN_ORIGIN = "http://console.f.rms.test:3001";

const supabase = () => (process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
const users: string[] = [];
let staffToken = "";
let memberToken = "";
let strangerToken = "";

const signUp = async (): Promise<{ id: string; token: string }> => {
  const res = await fetch(`${supabase()}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY ?? "", "content-type": "application/json" },
    body: JSON.stringify({ email: `admin-${crypto.randomUUID()}@f.rms.test`, password: crypto.randomUUID() + crypto.randomUUID() }),
  });
  if (!res.ok) throw new Error(`sign-up failed with ${res.status}`);
  const body = (await res.json()) as { access_token: string; user: { id: string } };
  users.push(body.user.id);
  return { id: body.user.id, token: body.access_token };
};

const cleanup = async (sql: Sql) => {
  const orgs = [ORG_A, ORG_B];
  await sql`delete from platform.notifications where org_id = any(${orgs}::uuid[])`;
  await sql`delete from platform.change_reviews where change_set_id in (select id from platform.change_sets where org_id = any(${orgs}::uuid[]))`;
  await sql`delete from platform.change_sets where org_id = any(${orgs}::uuid[])`;
  await sql`delete from platform.outbox where org_id = any(${orgs}::uuid[])`;
  await sql`delete from platform.audit_log where org_id = any(${orgs}::uuid[])`;
  await sql`delete from platform.members where id = ${MEMBER}`;
  await sql`delete from platform.staff_users where id = ${STAFF}`;
  await sql`delete from platform.organizations where id = any(${orgs}::uuid[])`;
};

const call = (path: string, init: { token?: string; method?: string; body?: unknown; origin?: string } = {}) => {
  const headers: Record<string, string> = {};
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.origin) headers.origin = init.origin;
  return app.request(path, { method: init.method ?? "GET", headers, body: init.body === undefined ? null : JSON.stringify(init.body) });
};

type Item = { id: string; orgId: string; tier: string; decision: string; restaurantName: string; createdAt: string };
const mine = (items: Item[]) => items.filter((i) => i.orgId === toPublicId("org", ORG_A) || i.orgId === toPublicId("org", ORG_B));

const owner: Actor = { type: "user", id: toPublicId("usr", MEMBER) };
const record = (org: string, signals: Parameters<typeof recordChange>[1]["signals"]) =>
  withOrg(apiDb(), org, (tx) => recordChange(tx, { orgUuid: org, origin: "build", actor: owner, signals }));

const UNKNOWN_CHANGE = toPublicId("chg", "0193a3c0-0000-7000-8000-0000000000ff");

describe.skipIf(!hasDb)("maintainer console API", () => {
  const created: Record<string, { id: string }> = {};
  // The POST targets a real change held for a maintainer, so a refusal is meaningful.
  const ROUTES: Array<{ method: string; path: () => string; body?: unknown }> = [
    { method: "GET", path: () => "/admin/feed" },
    { method: "GET", path: () => "/admin/queue" },
    { method: "POST", path: () => `/admin/changes/${created.t3a?.id}/decision`, body: { decision: "approve" } },
  ];

  beforeAll(async () => {
    process.env.ADMIN_URL = ADMIN_ORIGIN;
    const sql = adminDb();
    await cleanup(sql);
    await sql`insert into platform.organizations (id, slug, name, store_prefix)
              values (${ORG_A}, 'admin-test-a', 'Admin Test Kitchen', ${PA}), (${ORG_B}, 'admin-test-b', 'Admin Test Pizza', ${PB})`;
    const staff = await signUp();
    staffToken = staff.token;
    await sql`insert into platform.staff_users (id, user_id, name) values (${STAFF}, ${staff.id}, 'Admin Test Maintainer')`;
    const member = await signUp();
    memberToken = member.token;
    await sql`insert into platform.members (id, org_id, user_id, role) values (${MEMBER}, ${ORG_A}, ${member.id}, 'owner')`;
    // Signed in, but neither a maintainer nor a member of any restaurant.
    strangerToken = (await signUp()).token;

    created.t0 = await record(ORG_A, ["theme_change"]);
    created.t1 = await record(ORG_B, ["new_model"]);
    created.t2 = await record(ORG_A, ["new_connection"]);
    created.t3a = await record(ORG_A, ["public_share"]);
    created.t3b = await record(ORG_B, ["new_dependency"]);
  });

  afterAll(async () => {
    await cleanup(adminDb());
    for (const id of users) {
      await fetch(`${supabase()}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: { apikey: process.env.SUPABASE_SECRET_KEY ?? "" } });
    }
    await closeAll();
  });

  it("refuses every route without a valid token (401), for a restaurant member and for a user with no restaurant (403)", async () => {
    for (const r of ROUTES) {
      expect((await call(r.path(), { method: r.method, body: r.body })).status).toBe(401);
      expect((await call(r.path(), { method: r.method, body: r.body, token: "not-a-token" })).status).toBe(401);
      expect((await call(r.path(), { method: r.method, body: r.body, token: `${staffToken.slice(0, -4)}AAAA` })).status).toBe(401);
      for (const token of [memberToken, strangerToken]) {
        const res = await call(r.path(), { method: r.method, body: r.body, token });
        expect(res.status).toBe(403);
        expect(JSON.stringify(await res.json())).not.toMatch(/Admin Test/);
      }
    }
    // The refused decision attempts changed nothing.
    const [row] = await adminDb()<{ decision: string; decided_at: Date | null; reviews: number }[]>`
      select decision, decided_at, (select count(*)::int from platform.change_reviews r where r.change_set_id = c.id) as reviews
      from platform.change_sets c where c.org_id = ${ORG_A} and c.tier = 'T3'`;
    expect(row).toEqual({ decision: "pending_maintainer", decided_at: null, reviews: 0 });
  });

  it("serves the feed without the client naming a restaurant, with restaurant names", async () => {
    // Other tasks share this database: the unfiltered call only checks the shape.
    const res = await call("/admin/feed?limit=100", { token: staffToken });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Item[] };
    for (const i of body.items) expect(typeof i.restaurantName).toBe("string");
    for (const i of mine(body.items)) expect(["Admin Test Kitchen", "Admin Test Pizza"]).toContain(i.restaurantName);
  });

  // A malformed stored row (tier disagreeing with signals) can no longer be inserted; its
  // handling is unit-tested in @rms/governance (mapper, drain and approve refusal).
  it("shows one restaurant's changes newest first", async () => {
    const a = (await (await call(`/admin/feed?org=${toPublicId("org", ORG_A)}`, { token: staffToken })).json()) as { items: Item[] };
    expect(a.items.map((i) => i.id)).toEqual([created.t3a, created.t2, created.t0].map((c) => c?.id));
    expect(a.items.map((i) => [i.tier, i.decision, i.restaurantName])).toEqual([
      ["T3", "pending_maintainer", "Admin Test Kitchen"],
      ["T2", "pending_owner", "Admin Test Kitchen"],
      ["T0", "applied", "Admin Test Kitchen"],
    ]);
    const bRes = await call(`/admin/feed?org=${toPublicId("org", ORG_B)}`, { token: staffToken });
    expect(bRes.status).toBe(200);
    const b = (await bRes.json()) as { items: Array<Item & { mismatch?: boolean }> };
    expect(b.items.map((i) => [i.id, i.mismatch ?? false])).toEqual([
      [created.t3b?.id, false],
      [created.t1?.id, false],
    ]);
    expect(b.items[0]?.restaurantName).toBe("Admin Test Pizza");
  });

  it("filters by tier, decision and (optionally) restaurant, and pages with a cursor", async () => {
    const t3 = (await (await call(`/admin/feed?tier=T3&org=${toPublicId("org", ORG_A)}`, { token: staffToken })).json()) as { items: Item[] };
    expect(t3.items.map((i) => i.id)).toEqual([created.t3a?.id]);
    const applied = (await (await call(`/admin/feed?decision=applied&org=${toPublicId("org", ORG_B)}`, { token: staffToken })).json()) as {
      items: Item[];
    };
    expect(applied.items.map((i) => i.id)).toEqual([created.t1?.id]);

    const p1 = (await (await call(`/admin/feed?limit=2&org=${toPublicId("org", ORG_A)}`, { token: staffToken })).json()) as {
      items: Item[];
      nextBefore: string | null;
    };
    expect(p1.items.map((i) => i.id)).toEqual([created.t3a?.id, created.t2?.id]);
    const p2 = (await (await call(`/admin/feed?limit=2&org=${toPublicId("org", ORG_A)}&before=${p1.nextBefore}`, { token: staffToken })).json()) as {
      items: Item[];
      nextBefore: string | null;
    };
    expect(p2.items.map((i) => i.id)).toEqual([created.t0?.id]);
    expect(p2.nextBefore).toBeNull();

    for (const bad of ["tier=T9", "decision=done", "org=o_f1f1f1f1f1f4", "orgId=x", "limit=1000", "before=1"]) {
      expect((await call(`/admin/feed?${bad}`, { token: staffToken })).status).toBe(400);
    }
  });

  it("lists held changes oldest first and records a maintainer's decision", async () => {
    const qa = (await (await call(`/admin/queue?org=${toPublicId("org", ORG_A)}`, { token: staffToken })).json()) as { items: Item[] };
    expect(qa.items.map((i) => i.id)).toEqual([created.t3a?.id]);
    const qbRes = await call(`/admin/queue?org=${toPublicId("org", ORG_B)}`, { token: staffToken });
    expect(qbRes.status).toBe(200);
    const qb = (await qbRes.json()) as { items: Array<Item & { mismatch?: boolean }> };
    expect(qb.items.map((i) => [i.id, i.mismatch ?? false])).toEqual([[created.t3b?.id, false]]);
    expect((await call("/admin/queue", { token: staffToken })).status).toBe(200);
    expect((await call("/admin/queue?org=bad", { token: staffToken })).status).toBe(400);

    const ok = await call(`/admin/changes/${created.t3a?.id}/decision`, { method: "POST", token: staffToken, body: { decision: "approve", note: "Fine to share" } });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { change: Item }).change.decision).toBe("approved");
    const no = await call(`/admin/changes/${created.t3b?.id}/decision`, { method: "POST", token: staffToken, body: { decision: "reject" } });
    expect(((await no.json()) as { change: Item }).change.decision).toBe("rejected");

    const reviews = await adminDb()<{ decision: string; note: string | null }[]>`
      select r.decision, r.note from platform.change_reviews r join platform.change_sets c on c.id = r.change_set_id
      where r.staff_id = ${STAFF} and c.org_id = any(${[ORG_A, ORG_B]}::uuid[]) order by r.decision`;
    expect(reviews).toEqual([{ decision: "approved", note: "Fine to share" }, { decision: "rejected", note: null }]);
    const [staffDecided] = await adminDb()<{ n: number }[]>`
      select count(*)::int as n from platform.change_sets where decided_by_staff_id = ${STAFF} and decided_at is not null`;
    expect(staffDecided?.n).toBe(2);

    const after = (await (await call(`/admin/queue?org=${toPublicId("org", ORG_A)}`, { token: staffToken })).json()) as { items: Item[] };
    expect(after.items).toEqual([]);

    // Already decided, owner's call (T2), unknown, malformed, bad body.
    expect((await call(`/admin/changes/${created.t3a?.id}/decision`, { method: "POST", token: staffToken, body: { decision: "reject" } })).status).toBe(409);
    expect((await call(`/admin/changes/${created.t2?.id}/decision`, { method: "POST", token: staffToken, body: { decision: "approve" } })).status).toBe(409);
    expect((await call(`/admin/changes/${UNKNOWN_CHANGE}/decision`, { method: "POST", token: staffToken, body: { decision: "approve" } })).status).toBe(404);
    expect((await call("/admin/changes/not-an-id/decision", { method: "POST", token: staffToken, body: { decision: "approve" } })).status).toBe(404);
    expect((await call(`/admin/changes/${created.t2?.id}/decision`, { method: "POST", token: staffToken, body: { decision: "maybe" } })).status).toBe(400);
    expect(
      (await call(`/admin/changes/${created.t2?.id}/decision`, { method: "POST", token: staffToken, body: { decision: "approve", orgId: "x" } })).status,
    ).toBe(400);
  });

  it("allows the console origin only, with the authorization header, never a wildcard", async () => {
    const pre = await app.request("/admin/feed", {
      method: "OPTIONS",
      headers: { origin: ADMIN_ORIGIN, "access-control-request-method": "GET", "access-control-request-headers": "authorization" },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe(ADMIN_ORIGIN);
    expect(pre.headers.get("access-control-allow-headers")).toContain("authorization");
    expect(pre.headers.get("access-control-allow-credentials")).toBeNull();

    const other = await app.request("/admin/feed", {
      method: "OPTIONS",
      headers: { origin: "http://evil.example", "access-control-request-method": "GET" },
    });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();

    const get = await call("/admin/feed?limit=1", { token: staffToken, origin: ADMIN_ORIGIN });
    expect(get.headers.get("access-control-allow-origin")).toBe(ADMIN_ORIGIN);
    const denied = await call("/admin/feed", { origin: ADMIN_ORIGIN });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("access-control-allow-origin")).toBe(ADMIN_ORIGIN);
    const evil = await call("/admin/feed?limit=1", { token: staffToken, origin: "http://evil.example" });
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
  });
});

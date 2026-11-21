// The hidden "demo data" loader mini-app, its per-restaurant lock and the sweep (task L fix
// rounds: packages/seed/src/books.ts, packages/mcp/src/sync.ts, apps/api start-up).
//
// The loader may write to every library model, so it must be on only while a load runs. The
// questions here: can one restaurant's sweep or lock touch another's loader, and can a request
// set the sweep off against a load that is running?
//
// Two throwaway restaurants with fresh random ids, made here and removed here. Local database only.
//
// KNOWN GAP tests use `it.fails`: the body states the rule we want, and today it does not hold.
// The day one is fixed its test goes red. That is the signal to remove `.fails`, nothing else.
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toPublicId } from "@rms/contracts";
import { mintConnectionToken } from "@rms/auth";
import { adminDb, newUuid } from "@rms/db";
import { askAs } from "../helpers/actors.js";
import { repoPath } from "../helpers/env.js";

type Sql = ReturnType<typeof adminDb>;
type Tenant = { orgId: string };
type View = { id: string; status: string; toolsVersion: string | null };

// Loaded by path so this suite does not take on the packages' own build settings.
const seed = (await import(repoPath("packages/seed/src/index.ts"))) as {
  createDemoRestaurant: (sql: Sql, opts: { template: string; orgUuid: string; storePrefix: string }) => Promise<unknown>;
  removeRestaurants: (sql: Sql, orgs: string[]) => Promise<void>;
  ensureBooksApp: (sql: Sql, org: string) => Promise<{ appUuid: string }>;
  sweepBooksLoader: (sql: Sql) => Promise<{ paused: number; buildsRemoved: number }>;
};
const mcp = (await import(repoPath("packages/mcp/src/index.ts"))) as {
  connectDemoPos: (t: Tenant, o: object) => Promise<{ view: View }>;
  syncDemoPos: (i: { tenant: Tenant; ownerUserId: string; connectionId: string; loadBooks?: unknown }, o: object) => Promise<{ status: string }>;
  serveDemoPos: (r: Request) => Promise<Response>;
  demoPosUrl: () => string;
};
type Signer = { setProtectedHeader(header: object): Signer; sign(key: Uint8Array): Promise<string> };
const { SignJWT } = (await import(pathToFileURL(createRequire(repoPath("packages/auth/package.json")).resolve("jose")).href)) as { SignJWT: new (claims: Record<string, unknown>) => Signer };

const hex = (n: number) => randomBytes(n).toString("hex");
const A = { org: newUuid(), prefix: `o_${hex(6)}` };
const B = { org: newUuid(), prefix: `o_${hex(6)}` };
const tB: Tenant = { orgId: toPublicId("org", B.org) };
const sql = adminDb();
const pos = async (u: string | URL, init?: RequestInit) => mcp.serveDemoPos(new Request(u, init));
const lockKey = (org: string) => `rms.books_loader:${org}`;
const loader = async (org: string): Promise<string | undefined> =>
  (await sql<{ status: string }[]>`select status from platform.apps where org_id = ${org} and slug = 'demo-data' and kind = 'system'`)[0]?.status;
/** Runs `fn` while a load for `org` is running, as far as the database can tell: its loader lock is held. */
const whileLoading = async (org: string, fn: () => Promise<void>): Promise<void> => {
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${lockKey(org)}, 0))`;
    await fn();
  });
};
const mustNotLoad = async () => {
  throw new Error("must not load");
};

let conB = "";

beforeAll(async () => {
  await seed.createDemoRestaurant(sql, { template: "marigold", orgUuid: A.org, storePrefix: A.prefix });
  await seed.createDemoRestaurant(sql, { template: "slice_yard", orgUuid: B.org, storePrefix: B.prefix });
  conB = (await mcp.connectDemoPos(tB, { fetch: pos })).view.id;
}, 60_000);

afterAll(async () => {
  await seed.removeRestaurants(sql, [A.org, B.org]);
  const left = await sql<{ n: number }[]>`select count(*)::int as n from platform.organizations where id in (${A.org}, ${B.org})`;
  expect(left[0]?.n).toBe(0);
}, 60_000);

describe("the loader sweep and the loader lock", () => {
  it("the sweep switches off a loader left on, and leaves alone a loader whose load is running", async () => {
    await seed.ensureBooksApp(sql, A.org); // left on: stands in for a load that crashed
    await seed.ensureBooksApp(sql, B.org);
    expect([await loader(A.org), await loader(B.org)]).toEqual(["published", "published"]); // control: both really were on
    await whileLoading(B.org, async () => {
      await seed.sweepBooksLoader(sql);
      expect(await loader(A.org)).toBe("paused");
      expect(await loader(B.org)).toBe("published");
    });
    await seed.sweepBooksLoader(sql);
    expect(await loader(B.org)).toBe("paused");
  });

  it("a request from another restaurant cannot switch off a loader whose load is running", async () => {
    await seed.ensureBooksApp(sql, A.org);
    await whileLoading(A.org, async () => {
      // B's "bring in my sales" runs the sweep first, whatever state B's own connection is in.
      const res = await mcp.syncDemoPos({ tenant: tB, ownerUserId: newUuid(), connectionId: conB, loadBooks: mustNotLoad }, { fetch: pos });
      expect(res.status).toBe("failed"); // B is still waiting for its own yes
      expect(await loader(A.org)).toBe("published");
    });
    // Control: with no load running, the same request does switch a left-on loader off.
    await mcp.syncDemoPos({ tenant: tB, ownerUserId: newUuid(), connectionId: conB, loadBooks: mustNotLoad }, { fetch: pos });
    expect(await loader(A.org)).toBe("paused");
  });

  it("the sweep never touches a mini-app that is not the loader", async () => {
    const mine = newUuid();
    await sql`insert into platform.apps (id, org_id, slug, number, name, kind, status) values (${mine}, ${A.org}, 'demo-data-mine', 90, 'Mine', 'custom', 'published')`;
    await seed.sweepBooksLoader(sql);
    expect((await sql<{ status: string }[]>`select status from platform.apps where id = ${mine}`)[0]?.status).toBe("published");
  });

  // KNOWN GAP. The lock is an advisory lock: a number anyone on the database may take. The Ask
  // login runs model-written SQL, so one restaurant's question can hold the lock of another
  // restaurant whose id it knows: that restaurant's loads then wait, and the sweep skips its
  // loader ("a load is running"). No data crosses. The key here is for a restaurant that does
  // not exist, so nothing real is held.
  it.fails("KNOWN GAP: a restaurant's Ask login cannot hold another restaurant's loader lock", async () => {
    const key = lockKey(newUuid());
    const ask = await askAs("a");
    await ask.query(`select pg_advisory_lock(hashtextextended('${key}', 0)) is not null as held`).catch(() => undefined);
    try {
      const [free] = await sql.begin((tx) => tx<{ got: boolean }[]>`select pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) as got`);
      expect(free?.got).toBe(true);
    } finally {
      await ask.raw("select pg_advisory_unlock_all()").catch(() => undefined);
    }
  });
});

describe("connection tokens last one minute", () => {
  const list = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  const ask = (token: string) =>
    mcp.serveDemoPos(new Request(mcp.demoPosUrl(), { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` }, body: list }));

  it("a properly signed token made 61 seconds ago is refused, even when its own expiry is far off", async () => {
    const fresh = await mintConnectionToken({ kind: "connection", aud: "mcp", org: tB.orgId, connection: conB } as never);
    const claims = JSON.parse(Buffer.from(fresh.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown> & { iat: number; exp: number };
    expect(claims.exp - claims.iat).toBe(60);
    expect((await ask(fresh)).status).toBe(200); // control: the honest token is accepted

    const header = JSON.parse(Buffer.from(fresh.split(".")[0] ?? "", "base64url").toString("utf8")) as { alg: string; typ?: string };
    const now = Math.floor(Date.now() / 1000);
    const sign = (iat: number, exp: number) =>
      new SignJWT({ ...claims, iat, exp, jti: crypto.randomUUID() }).setProtectedHeader(header).sign(new TextEncoder().encode(process.env.RMS_TOKEN_SECRET as string));
    expect((await ask(await sign(now - 5, now + 3600))).status).toBe(200); // control: our own signing is accepted
    expect((await ask(await sign(now - 61, now + 3600))).status).toBe(401);
  });
});

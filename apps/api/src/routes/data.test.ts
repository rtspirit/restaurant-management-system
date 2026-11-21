// Data API tests: happy paths, every error code, and the attack cases from the Wave 1 brief.
// They run against the shared local database with two fictional restaurants (A and B) made
// by the test-only helper in @rms/data. Tokens are real ones from mintAppToken / mintRunToken
// and every request goes through the real app, so `requireDataToken` is part of what is tested.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mintAppToken, mintRunToken } from "@rms/auth";
import { DATA_ERROR_STATUS, DATA_ROUTES, type DataErrorCode, toPublicId } from "@rms/contracts";
import { readOnlyStore, run } from "@rms/data";
import { adminDb, closeAll, newUuid, withStore } from "@rms/db";
import { ACTION_KEYS, CANARY_A, CANARY_B, QUERY_KEYS, T, type Who, cleanupData, setupData, tenantFor } from "../../../../packages/data/src/testing/fixtures.js";

for (const f of [resolve(import.meta.dirname, "../../../../.env.local"), "/Users/rahultiwari/github/restaurant-management-system/.env.local"]) {
  if (existsSync(f)) {
    process.loadEnvFile(f);
    break;
  }
}
const hasDb = Boolean(process.env.DATABASE_URL && process.env.DATABASE_ADMIN_URL && process.env.RMS_TOKEN_SECRET);
const { default: app } = hasDb ? await import("../index.js") : { default: null };

type Reply = { status: number; body: any; text: string };
type Caller = { token: string | null; org: "A" | "B" };

/** Every response body, by the restaurant whose token asked. Swept for the other one's canary at the end. */
const seen: Record<"A" | "B", string[]> = { A: [], B: [] };
const failures: string[] = [];

const ids = (w: Who) => {
  const b = w.org === "B";
  return {
    org: toPublicId("org", b ? T.orgB : T.orgA),
    sub: toPublicId("usr", w.user ?? (b ? T.ownerB : w.role === "staff" ? T.staffA : T.ownerA)),
    app: toPublicId("app", w.app ?? (b ? T.appB : T.appA)),
    role: w.role ?? ("owner" as const),
    loc: w.locations === undefined || w.locations === "all" ? ("all" as const) : (w.locations.map((l) => toPublicId("loc", l)) as [`loc_${string}`]),
  };
};
const live = async (w: Who = {}): Promise<Caller> => ({
  org: w.org ?? "A",
  token: await mintAppToken({ ...ids(w), kind: "app", aud: "data", ver: toPublicId("ver", w.version ?? (w.org === "B" ? T.verB : T.verA)), env: "live" }),
});
const draft = async (w: Who = {}): Promise<Caller> => ({
  org: w.org ?? "A",
  token: await mintRunToken({ ...ids(w), kind: "run", aud: "data", run: toPublicId("run", newUuid()), env: "draft" }),
});

const call = async (route: keyof typeof DATA_ROUTES, who: Caller, body: unknown, extra: { headers?: Record<string, string>; query?: string } = {}): Promise<Reply> => {
  const res = await app!.request(`${DATA_ROUTES[route]}${extra.query ?? ""}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(who.token ? { authorization: `Bearer ${who.token}` } : {}), ...extra.headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  seen[who.org].push(text);
  if (res.status >= 400) failures.push(text);
  return { status: res.status, body: JSON.parse(text), text };
};

const refused = (r: Reply, code: DataErrorCode) => {
  expect(r.body?.error?.code, r.text).toBe(code);
  expect(r.status).toBe(DATA_ERROR_STATUS[code]);
  expect(typeof r.body.error.message).toBe("string");
  expect(typeof r.body.error.requestId).toBe("string");
};
const ok = (r: Reply) => {
  expect(r.status, r.text).toBe(200);
  return r.body;
};

const pool = (label: string, amount: number, more: Record<string, unknown> = {}) => ({ op: "insert" as const, model: "tip_pool", values: { business_date: "2026-11-15", label, amount, ...more } });
const insertPool = async (who: Caller, label: string, amount: number, more: Record<string, unknown> = {}): Promise<string> =>
  ok(await call("batch", who, { ops: [pool(label, amount, more)] })).results[0].id;
const pools = async (who: Caller, body: Record<string, unknown> = {}) => ok(await call("query", who, { model: "tip_pool", limit: 500, ...body }));
const count = async (table: string, org: "A" | "B" = "A", env: "live" | "draft" = "live"): Promise<number> =>
  withStore(adminDb(), tenantFor(env, { org }), async (tx, s) => Number((await tx.unsafe(`select count(*)::int as n from ${s.table(table)}`))[0]?.n));
const audits = async (org: string, action: string) =>
  adminDb().unsafe("select action, target_type, target_id, meta::text as meta, request_id, actor from platform.audit_log where org_id = $1::uuid and action = $2::text order by at", [org, action]);

describe.skipIf(!hasDb)("Data API", () => {
  let ownerA: Caller, staffA: Caller, staffA1: Caller, ownerA1: Caller, ownerB: Caller, viewerA: Caller, runA: Caller;
  const P: Record<string, string> = {};

  beforeAll(async () => {
    await setupData();
    ownerA = await live();
    staffA = await live({ role: "staff" });
    staffA1 = await live({ role: "staff", locations: [T.locA1] });
    ownerA1 = await live({ locations: [T.locA1] });
    ownerB = await live({ org: "B" });
    viewerA = await live({ app: T.appViewer, version: T.verViewer });
    runA = await draft();

    // Seed rows through the API itself. Each restaurant plants its canary.
    P.d1 = await insertPool(ownerA, "Dinner", 12000, {
      location_id: T.locA1, hourly_rate: 2150, status: "open", share: "12.50", closed: false,
      weight: { value: "2.5", unit: "kg" }, notes: { tags: ["a", 1], canary: CANARY_A }, counted_at: "2026-11-15T03:10:00.123Z", headcount: 7,
    });
    P.d2 = await insertPool(ownerA, "Lunch", 4000, { location_id: T.locA1, status: "closed", share: "3.25", headcount: 3 });
    P.d3 = await insertPool(ownerA, "Bar", 9000, { location_id: T.locA1 });
    P.r1 = await insertPool(ownerA, "Dinner", 7000, { location_id: T.locA2, hourly_rate: 1980, status: "open" });
    P.r2 = await insertPool(ownerA, "Late", 500, { location_id: T.locA2 });
    P.b1 = await insertPool(ownerB, `Dinner ${CANARY_B}`, 99999, { hourly_rate: 3300, notes: { canary: CANARY_B } });
    ok(await call("batch", ownerB, { ops: [{ op: "insert", model: "b_only", values: { secret: CANARY_B } }] }));
  }, 120_000);

  afterAll(async () => {
    await cleanupData();
    await closeAll();
  }, 60_000);

  // ------------------------------------------------------------------ tokens
  describe("tokens", () => {
    it("refuses a request with no token, a forged token or a token in the wrong place", async () => {
      refused(await call("query", { token: null, org: "A" }, { model: "tip_pool" }), "unauthenticated");
      refused(await call("query", { token: `${ownerA.token!.slice(0, -4)}AAAA`, org: "A" }, { model: "tip_pool" }), "unauthenticated");
      const res = await app!.request(`${DATA_ROUTES.query}?token=${ownerA.token}`, { method: "POST", body: JSON.stringify({ model: "tip_pool" }) });
      expect(res.status).toBe(401);
    });

    it("an app token must pin a published version of its own app in its own restaurant", async () => {
      refused(await call("query", await live({ version: T.verADraft }), { model: "tip_pool" }), "unauthenticated"); // not published
      refused(await call("query", await live({ version: T.verViewer }), { model: "tip_pool" }), "unauthenticated"); // another app's version
      refused(await call("query", await live({ version: T.verB }), { model: "tip_pool" }), "unauthenticated"); // B's version
      refused(await call("query", await live({ app: T.appB, version: T.verB }), { model: "tip_pool" }), "unauthenticated"); // B's app, A's org
      refused(await call("batch", await live({ app: T.appB, version: T.verB }), { ops: [pool("x", 1, { location_id: T.locA1 })] }), "unauthenticated");
    });

    it("a paused mini-app stops working at once", async () => {
      await adminDb().unsafe("update platform.apps set status = 'paused' where id = $1::uuid", [T.appViewer]);
      refused(await call("query", viewerA, { model: "tip_pool" }), "unauthenticated");
      await adminDb().unsafe("update platform.apps set status = 'published' where id = $1::uuid", [T.appViewer]);
      ok(await call("query", viewerA, { model: "tip_pool" }));
    });
  });

  // ------------------------------------------------------------------ query
  describe("query", () => {
    it("returns every field type in the wire format", async () => {
      const { rows, masked, nextCursor } = await pools(ownerA, { where: { field: "id", op: "eq", value: P.d1 } });
      expect(masked).toEqual([]);
      expect(nextCursor).toBeNull();
      expect(rows).toHaveLength(1);
      const r = rows[0];
      expect(r).toMatchObject({
        id: P.d1, location_id: T.locA1, currency: "USD", source: "manual", source_id: null, created_by: `user:${T.ownerA}`, updated_by: `user:${T.ownerA}`, deleted_at: null,
        business_date: "2026-11-15", label: "Dinner", amount: 12000, hourly_rate: 2150, status: "open", share: "12.50", closed: false,
        weight: { value: "2.5", unit: "kg" }, notes: { tags: ["a", 1], canary: CANARY_A }, counted_at: "2026-11-15T03:10:00.123Z", headcount: 7,
      });
      expect(r.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(r.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it("filters, sorts and picks fields", async () => {
      const labels = async (body: Record<string, unknown>) => (await pools(ownerA, { fields: ["label", "amount"], ...body })).rows.map((r: any) => `${r.label}:${r.amount}`);
      expect(await labels({ where: { field: "amount", op: "gte", value: 7000 }, sort: [{ field: "amount", dir: "desc" }] })).toEqual(["Dinner:12000", "Bar:9000", "Dinner:7000"]);
      expect(await labels({ where: { and: [{ field: "label", op: "starts_with", value: "din" }, { field: "location_id", op: "eq", value: T.locA2 }] } })).toEqual(["Dinner:7000"]);
      expect(await labels({ where: { field: "label", op: "contains", value: "AT" }, sort: [{ field: "label" }] })).toEqual(["Late:500"]);
      expect(await labels({ where: { field: "amount", op: "between", value: [500, 4000] }, sort: [{ field: "amount" }] })).toEqual(["Late:500", "Lunch:4000"]);
      expect(await labels({ where: { field: "status", op: "in", value: ["closed"] } })).toEqual(["Lunch:4000"]);
      expect(await labels({ where: { not: { field: "status", op: "is_null", value: true } }, sort: [{ field: "amount" }] })).toEqual(["Lunch:4000", "Dinner:7000", "Dinner:12000"]);
      expect(await labels({ where: { or: [{ field: "share", op: "gt", value: "10" }, { field: "headcount", op: "eq", value: 3 }] }, sort: [{ field: "amount" }] })).toEqual(["Lunch:4000", "Dinner:12000"]);
      expect(await labels({ where: { field: "counted_at", op: "lte", value: "2026-11-15T03:10:00.123Z" } })).toEqual(["Dinner:12000"]);
      expect(Object.keys((await pools(ownerA, { fields: ["label"] })).rows[0])).toEqual(["label"]);
    });

    it("pages through rows with a signed cursor, with empty values and mixed directions", async () => {
      const body = { sort: [{ field: "status", dir: "desc" }, { field: "amount", dir: "asc" }], limit: 2, fields: ["id", "status", "amount"] };
      const all = (await pools(ownerA, { ...body, limit: 500 })).rows.map((r: any) => r.id);
      expect(all).toHaveLength(5);
      const got: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 5; page++) {
        const res: any = await pools(ownerA, { ...body, ...(cursor ? { cursor } : {}) });
        got.push(...res.rows.map((r: any) => r.id));
        cursor = res.nextCursor;
        if (!cursor) break;
      }
      expect(got).toEqual(all);
      expect(new Set(got).size).toBe(5);
    });

    it("refuses a cursor from any other question", async () => {
      const first = await pools(ownerA, { sort: [{ field: "amount" }], limit: 2 });
      const cursor = first.nextCursor as string;
      expect(cursor).toBeTruthy();
      ok(await call("query", ownerA, { model: "tip_pool", sort: [{ field: "amount" }], limit: 2, cursor }));
      refused(await call("query", ownerA, { model: "tip_pool", sort: [{ field: "amount", dir: "desc" }], limit: 2, cursor }), "invalid_request");
      refused(await call("query", ownerA, { model: "tip_pool", sort: [{ field: "amount" }], where: { field: "amount", op: "gt", value: 1 }, limit: 2, cursor }), "invalid_request");
      refused(await call("query", ownerA, { model: "cash_event", sort: [{ field: "amount" }], limit: 2, cursor }), "invalid_request");
      refused(await call("query", await live({ user: T.otherOwnerA }), { model: "tip_pool", sort: [{ field: "amount" }], limit: 2, cursor }), "invalid_request");
      refused(await call("query", ownerA1, { model: "tip_pool", sort: [{ field: "amount" }], limit: 2, cursor }), "invalid_request");
      refused(await call("query", ownerB, { model: "tip_pool", sort: [{ field: "amount" }], limit: 2, cursor }), "invalid_request");
      const [payload, mac] = cursor.split(".") as [string, string];
      const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), k: ["0", P.b1] })).toString("base64url");
      refused(await call("query", ownerA, { model: "tip_pool", sort: [{ field: "amount" }], limit: 2, cursor: `${forged}.${mac}` }), "invalid_request");
      refused(await call("query", ownerA, { model: "tip_pool", sort: [{ field: "amount" }], limit: 2, cursor: "not-a-cursor" }), "invalid_request");
    });

    it("totals the filtered rows, with groups", async () => {
      const res = await pools(ownerA, {
        limit: 1,
        totals: { groupBy: ["location_id"], aggregates: [{ fn: "count", as: "n" }, { fn: "sum", field: "amount", as: "total" }, { fn: "avg", field: "amount", as: "mean" }, { fn: "max", field: "business_date", as: "latest" }, { fn: "sum", field: "share", as: "shares" }] },
      });
      const by = Object.fromEntries(res.totals.map((t: any) => [t.location_id, t]));
      expect(by[T.locA1]).toEqual({ location_id: T.locA1, n: 3, total: 25000, mean: "8333.333333", latest: "2026-11-15", shares: "15.75" });
      expect(by[T.locA2]).toEqual({ location_id: T.locA2, n: 2, total: 7500, mean: "3750", latest: "2026-11-15", shares: null });
      const one = await pools(ownerA, { where: { field: "amount", op: "gt", value: 8000 }, totals: { aggregates: [{ fn: "count", as: "n" }] } });
      expect(one.totals).toEqual([{ n: 2 }]);
    });

    it("refuses requests that do not fit the model", async () => {
      refused(await call("query", ownerA, { model: "tip_pool", fields: ["nope"] }), "invalid_request");
      refused(await call("query", ownerA, { model: "tip_pool", where: { field: "amount", op: "eq", value: "12" } }), "invalid_request");
      refused(await call("query", ownerA, { model: "tip_pool", where: { field: "amount", op: "contains", value: "1" } }), "invalid_request");
      refused(await call("query", ownerA, { model: "tip_pool", where: { field: "notes", op: "eq", value: "x" } }), "invalid_request");
      refused(await call("query", ownerA, { model: "tip_pool", where: { field: "business_date", op: "eq", value: "2026-02-30" } }), "invalid_request");
      refused(await call("query", ownerA, { model: "tip_pool", where: { field: "id", op: "eq", value: "x' or '1'='1" } }), "invalid_request");
      refused(await call("query", ownerA, { model: "tip_pool", sort: [{ field: "notes" }] }), "invalid_request");
      refused(await call("query", ownerA, { model: "tip_pool", totals: { aggregates: [{ fn: "sum", field: "label", as: "x" }] } }), "invalid_request");
      refused(await call("query", ownerA, { model: "tip_pool", limit: 501 }), "invalid_request");
      refused(await call("query", ownerA, { model: 'tip_pool"; drop table x; --' }), "invalid_request");
      refused(await call("query", ownerA, "{not json"), "invalid_request");
      let deep: any = { field: "amount", op: "eq", value: 1 };
      for (let i = 0; i < 30; i++) deep = { not: deep };
      refused(await call("query", ownerA, { model: "tip_pool", where: deep }), "invalid_request");
    });

    it("treats hostile text in a filter as a value, never as SQL", async () => {
      const evil = "'; drop table tip_pool; select '";
      expect((await pools(ownerA, { where: { field: "label", op: "eq", value: evil } })).rows).toEqual([]);
      expect((await pools(ownerA, { where: { field: "label", op: "contains", value: "%" } })).rows).toEqual([]);
      expect(await count("tip_pool")).toBeGreaterThanOrEqual(5);
    });

    it("hides removed rows unless asked", async () => {
      const id = await insertPool(ownerA, "To remove", 1, { location_id: T.locA1 });
      ok(await call("batch", ownerA, { ops: [{ op: "delete", model: "tip_pool", id }] }));
      expect((await pools(ownerA, { where: { field: "id", op: "eq", value: id } })).rows).toEqual([]);
      const withRemoved = await pools(ownerA, { where: { field: "id", op: "eq", value: id }, includeDeleted: true });
      expect(withRemoved.rows[0].deleted_at).toMatch(/Z$/);
      refused(await call("batch", ownerA, { ops: [{ op: "update", model: "tip_pool", id, values: { amount: 2 } }] }), "not_found");
    });

    it("reads parent data, and never more than the role and locations allow", async () => {
      const owner = ok(await call("query", ownerA, { model: "parent.staff", sort: [{ field: "full_name" }] }));
      expect(owner.rows.map((r: any) => [r.full_name, r.hourly_rate_minor, r.email])).toEqual([["Avery Stone", 2150, "avery@taskd-a.test"], ["Blake Rivers", 1980, "blake@taskd-a.test"]]);
      const staff = ok(await call("query", staffA, { model: "parent.staff", sort: [{ field: "full_name" }] }));
      expect(staff.masked.sort()).toEqual(["email", "hourly_rate_minor", "phone"]);
      for (const r of staff.rows) for (const k of ["hourly_rate_minor", "email", "phone"]) expect(k in r).toBe(false);
      expect(JSON.stringify(staff)).not.toContain("avery@taskd-a.test");
      refused(await call("query", staffA, { model: "parent.staff", fields: ["hourly_rate_minor"] }), "forbidden_field");
      refused(await call("query", staffA, { model: "parent.staff", where: { field: "hourly_rate_minor", op: "gt", value: 2000 } }), "forbidden_field");
      refused(await call("query", staffA, { model: "parent.staff", sort: [{ field: "email" }] }), "forbidden_field");
      const scoped = ok(await call("query", staffA1, { model: "parent.staff" }));
      expect(scoped.rows.map((r: any) => r.full_name)).toEqual(["Avery Stone"]);
      expect(ok(await call("query", staffA1, { model: "parent.locations" })).rows.map((r: any) => r.name)).toEqual(["Downtown"]);
      expect(ok(await call("query", ownerA, { model: "parent.locations", sort: [{ field: "name" }] })).rows.map((r: any) => r.name)).toEqual(["Downtown", "Riverside"]);
      refused(await call("query", ownerA, { model: "parent.jobs" }), "forbidden_model"); // not in the manifest
    });
  });

  // ------------------------------------------------------------------ field rules
  describe("fields a role cannot read", () => {
    it("are absent for staff and listed as masked", async () => {
      const res = await pools(staffA);
      expect(res.masked).toEqual(["hourly_rate"]);
      for (const r of res.rows) {
        expect("hourly_rate" in r).toBe(false);
        expect(Object.values(r)).not.toContain(2150);
      }
    });

    it("cannot be named in fields, filter, sort, totals or writes", async () => {
      const q = (body: Record<string, unknown>) => call("query", staffA, { model: "tip_pool", ...body });
      refused(await q({ fields: ["label", "hourly_rate"] }), "forbidden_field");
      refused(await q({ where: { field: "hourly_rate", op: "gt", value: 2000 } }), "forbidden_field");
      refused(await q({ where: { or: [{ field: "label", op: "eq", value: "x" }, { not: { field: "hourly_rate", op: "is_null", value: true } }] } }), "forbidden_field");
      refused(await q({ sort: [{ field: "hourly_rate" }] }), "forbidden_field");
      refused(await q({ totals: { aggregates: [{ fn: "sum", field: "hourly_rate", as: "x" }] } }), "forbidden_field");
      refused(await q({ totals: { aggregates: [{ fn: "count", field: "hourly_rate", as: "x" }] } }), "forbidden_field");
      refused(await q({ totals: { groupBy: ["hourly_rate"], aggregates: [{ fn: "count", as: "x" }] } }), "forbidden_field");
      refused(await call("batch", staffA, { ops: [pool("Staff rate", 1, { location_id: T.locA1, hourly_rate: 1 })] }), "forbidden_field");
      refused(await call("batch", staffA, { ops: [{ op: "update", model: "tip_pool", id: P.d2, values: { hourly_rate: 1 } }] }), "forbidden_field");
      refused(await call("batch", staffA, { ops: [{ op: "upsert_by_source", model: "tip_pool", sourceId: "x-1", values: { business_date: "2026-11-15", label: "u", amount: 1, hourly_rate: 5 } }] }), "forbidden_field");
      expect((await pools(ownerA, { where: { field: "hourly_rate", op: "gt", value: 2000 } })).rows.map((r: any) => r.id)).toEqual([P.d1]);
    });
  });

  // ------------------------------------------------------------------ locations
  describe("locations", () => {
    it("a user only sees rows of their locations", async () => {
      const rows = (await pools(staffA1)).rows;
      expect(rows.length).toBeGreaterThanOrEqual(3);
      expect(new Set(rows.map((r: any) => r.location_id))).toEqual(new Set([T.locA1]));
      expect((await pools(staffA1, { where: { field: "location_id", op: "eq", value: T.locA2 } })).rows).toEqual([]);
      expect((await pools(staffA1, { where: { field: "id", op: "eq", value: P.r1 } })).rows).toEqual([]);
      expect((await pools(staffA1, { totals: { aggregates: [{ fn: "count", as: "n" }] }, where: { field: "location_id", op: "eq", value: T.locA2 } })).totals).toEqual([{ n: 0 }]);
    });

    it("a user can only write rows of their locations", async () => {
      const id = await insertPool(staffA1, "Scoped", 10); // defaults to their only location
      expect((await pools(ownerA, { where: { field: "id", op: "eq", value: id } })).rows[0].location_id).toBe(T.locA1);
      refused(await call("batch", staffA1, { ops: [pool("Elsewhere", 1, { location_id: T.locA2 })] }), "forbidden_location");
      refused(await call("batch", staffA1, { ops: [{ op: "update", model: "tip_pool", id, values: { location_id: T.locA2 } }] }), "forbidden_location");
      refused(await call("batch", staffA1, { ops: [{ op: "update", model: "tip_pool", id: P.r1, values: { amount: 1 } }] }), "not_found");
      refused(await call("batch", staffA1, { ops: [{ op: "delete", model: "tip_pool", id: P.r1 }] }), "not_found");
      expect((await pools(ownerA, { where: { field: "id", op: "eq", value: P.r1 } })).rows[0].amount).toBe(7000);
    });

    it("an owner with every location must say which one, and it must be their own", async () => {
      refused(await call("batch", ownerA, { ops: [pool("Nowhere", 1)] }), "invalid_request");
      refused(await call("batch", ownerA, { ops: [pool("B's place", 1, { location_id: T.locB1 })] }), "forbidden_location");
      refused(await call("batch", ownerA, { ops: [pool("Made up", 1, { location_id: newUuid() })] }), "forbidden_location");
    });
  });

  // ------------------------------------------------------------------ writes
  describe("batch", () => {
    it("updates with a version check and refuses a stale one", async () => {
      const id = await insertPool(ownerA, "Versioned", 100, { location_id: T.locA1 });
      const before = (await pools(ownerA, { where: { field: "id", op: "eq", value: id } })).rows[0].updated_at;
      await new Promise((r) => setTimeout(r, 15));
      ok(await call("batch", ownerA, { ops: [{ op: "update", model: "tip_pool", id, values: { amount: 150, status: "closed", notes: null }, ifUpdatedAt: before }] }));
      const after = (await pools(ownerA, { where: { field: "id", op: "eq", value: id } })).rows[0];
      expect(after.amount).toBe(150);
      expect(after.updated_at > before).toBe(true);
      refused(await call("batch", ownerA, { ops: [{ op: "update", model: "tip_pool", id, values: { amount: 999 }, ifUpdatedAt: before }] }), "conflict");
      expect((await pools(ownerA, { where: { field: "id", op: "eq", value: id } })).rows[0].amount).toBe(150);
    });

    it("rolls back the whole batch when one op fails, and writes no audit row for it", async () => {
      const n = await count("tip_pool");
      const a = (await audits(T.orgA, "data.batch")).length;
      refused(await call("batch", ownerA, { ops: [pool("Rolled back", 1, { location_id: T.locA1 }), pool("Dinner", 2, { location_id: T.locA1 })] }), "conflict"); // unique rule
      refused(await call("batch", ownerA, { ops: [pool("Rolled back", 1, { location_id: T.locA1 }), { op: "update", model: "tip_pool", id: newUuid(), values: { amount: 1 } }] }), "not_found");
      expect(await count("tip_pool")).toBe(n);
      expect((await pools(ownerA, { where: { field: "label", op: "eq", value: "Rolled back" } })).rows).toEqual([]);
      expect((await audits(T.orgA, "data.batch")).length).toBe(a);
    });

    it("refuses values that do not fit the model", async () => {
      const bad = (values: Record<string, unknown>) => call("batch", ownerA, { ops: [pool("Bad", 1, { location_id: T.locA1, ...values })] });
      refused(await bad({ amount: "12" }), "invalid_request");
      const rule = await bad({ amount: -1 }); // a model's own check rule, answered with the rule's own plain words
      refused(rule, "invalid_request");
      expect(rule.body.error.message).toBe("A tip pool cannot be less than zero.");
      refused(await bad({ amount: 1.5 }), "invalid_request");
      refused(await bad({ status: "weird" }), "invalid_request");
      refused(await bad({ share: "1.234" }), "invalid_request");
      refused(await bad({ share: 1.5 }), "invalid_request");
      refused(await bad({ business_date: "15/11/2026" }), "invalid_request");
      refused(await bad({ counted_at: "yesterday" }), "invalid_request");
      refused(await bad({ weight: { value: "2", unit: "KG!" } }), "invalid_request");
      refused(await bad({ closed: "yes" }), "invalid_request");
      refused(await bad({ label: "x".repeat(81) }), "invalid_request");
      refused(await bad({ label: null }), "invalid_request");
      refused(await bad({ nope: 1 }), "invalid_request");
      refused(await bad({ source: "seed" }), "invalid_request");
      refused(await bad({ created_by: "user:someone-else" }), "invalid_request");
      refused(await bad({ currency: "usd" }), "invalid_request");
      refused(await call("batch", ownerA, { ops: [{ op: "insert", model: "tip_pool", values: { label: "No date", amount: 1, location_id: T.locA1 } }] }), "invalid_request");
      refused(await call("batch", ownerA, { ops: [{ op: "update", model: "tip_pool", id: P.d2, values: {} }] }), "invalid_request");
      refused(await call("batch", ownerA, { ops: [] }), "invalid_request");
      refused(await call("batch", ownerA, { ops: Array.from({ length: 501 }, (_, i) => pool(`n${i}`, 1, { location_id: T.locA1 })) }), "invalid_request");
      expect((await pools(ownerA, { where: { field: "label", op: "eq", value: "Bad" } })).rows).toEqual([]);
    });

    it("append-only records can be added but never changed or removed", async () => {
      const ev = { op: "insert" as const, model: "cash_event", values: { business_date: "2026-11-14", amount: 100, kind: "paid_in", location_id: T.locA1 } };
      const id = ok(await call("batch", ownerA, { ops: [ev] })).results[0].id;
      refused(await call("batch", ownerA, { ops: [{ op: "update", model: "cash_event", id, values: { amount: 1 } }] }), "forbidden_model");
      refused(await call("batch", ownerA, { ops: [{ op: "delete", model: "cash_event", id }] }), "forbidden_model");
      const up = { op: "upsert_by_source" as const, model: "cash_event", sourceId: "till-1", values: { business_date: "2026-11-14", amount: 5, kind: "paid_in", location_id: T.locA1 } };
      const first = ok(await call("batch", ownerA, { ops: [up] })).results[0].id;
      const again = ok(await call("batch", ownerA, { ops: [{ ...up, values: { ...up.values, amount: 6 } }] })).results[0].id;
      expect(again).toBe(first);
      const row = ok(await call("query", ownerA, { model: "cash_event", where: { field: "id", op: "eq", value: first } })).rows[0];
      expect(row.amount).toBe(5);
      expect("deleted_at" in row).toBe(false);
    });

    it("upsert by source id inserts once, then updates the same row", async () => {
      const up = (amount: number) => call("batch", ownerA, { ops: [{ op: "upsert_by_source", model: "tip_pool", sourceId: "import-77", values: { business_date: "2026-11-13", label: "Imported", amount, location_id: T.locA2 } }] });
      const a = ok(await up(10)).results[0].id;
      const b = ok(await up(20)).results[0].id;
      expect(b).toBe(a);
      const rows = (await pools(ownerA, { where: { field: "source_id", op: "eq", value: "import-77" } })).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ amount: 20, source: "import", source_id: "import-77" });
    });

    it("checks parent links and stores the name as it was", async () => {
      const note = (staff: unknown, more: Record<string, unknown> = {}) => call("batch", ownerA, { ops: [{ op: "insert", model: "staff_note", values: { staff, note: "On time", location_id: T.locA1, ...more } }] });
      const id = ok(await note(T.staffRowA1, { tip_pool: P.d1 })).results[0].id;
      const row = ok(await call("query", ownerA, { model: "staff_note", where: { field: "id", op: "eq", value: id } })).rows[0];
      expect(row.staff).toEqual({ id: T.staffRowA1, label: "Avery Stone" });
      expect(row.tip_pool).toBe(P.d1);
      expect(ok(await call("query", ownerA, { model: "staff_note", where: { field: "staff", op: "eq", value: T.staffRowA1 } })).rows).toHaveLength(1);
      refused(await note(newUuid()), "invalid_request");
      refused(await note(T.staffRowB1), "invalid_request"); // B's staff member
      refused(await note("not-an-id"), "invalid_request");
      refused(await note({ id: T.staffRowA1, label: "Forged name" }), "invalid_request");
      refused(await note(T.staffRowA1, { tip_pool: newUuid() }), "invalid_request"); // linked record does not exist
      refused(await note(T.staffRowA1, { tip_pool: P.b1 }), "invalid_request"); // B's tip pool
      refused(await note(T.staffRowA1, { staff_label: "Forged name" }), "invalid_request"); // the label column is not a field
      // a user limited to Downtown cannot point at a Riverside staff member
      const ownerNote = await call("batch", ownerA1, { ops: [{ op: "insert", model: "staff_note", values: { staff: T.staffRowA2, note: "x" } }] });
      refused(ownerNote, "invalid_request");
    });

    it("parent data can never be written", async () => {
      refused(await call("batch", ownerA, { ops: [{ op: "insert", model: "parent.staff", values: { full_name: "Ghost" } }] }), "read_only");
      refused(await call("batch", ownerA, { ops: [{ op: "update", model: "parent.staff", id: T.staffRowA1, values: { hourly_rate_minor: 1 } }] }), "read_only");
      refused(await call("batch", ownerA, { ops: [{ op: "delete", model: "parent.locations", id: T.locA1 }] }), "read_only");
      refused(await call("batch", ownerA, { ops: [{ op: "insert", model: "staff", values: { full_name: "Ghost" } }] }), "forbidden_model");
      expect(ok(await call("query", ownerA, { model: "parent.staff" })).rows).toHaveLength(2);
    });

    it("a manifest with read access refuses writes, and an unlisted model is refused outright", async () => {
      expect(ok(await call("query", viewerA, { model: "tip_pool" })).rows.length).toBeGreaterThan(0);
      refused(await call("batch", viewerA, { ops: [pool("Viewer write", 1, { location_id: T.locA1 })] }), "forbidden_model");
      refused(await call("batch", viewerA, { ops: [{ op: "delete", model: "tip_pool", id: P.d3 }] }), "forbidden_model");
      refused(await call("query", viewerA, { model: "cash_event" }), "forbidden_model");
      refused(await call("query", ownerA, { model: "secret_plan" }), "forbidden_model");
      refused(await call("batch", ownerA, { ops: [{ op: "insert", model: "secret_plan", values: { plan: "x" } }] }), "forbidden_model");
      refused(await call("query", ownerA, { model: "no_such_model" }), "forbidden_model"); // same answer as a real unlisted model
      // one unlisted model in a batch refuses the whole batch
      refused(await call("batch", ownerA, { ops: [pool("With secret", 1, { location_id: T.locA1 }), { op: "insert", model: "secret_plan", values: { plan: "x" } }] }), "forbidden_model");
      expect(await count("secret_plan")).toBe(0);
    });

    it("the role decides: none, read or write", async () => {
      refused(await call("query", staffA, { model: "owner_ledger" }), "forbidden_role");
      refused(await call("batch", staffA, { ops: [{ op: "insert", model: "owner_ledger", values: { memo: "x" } }] }), "forbidden_role");
      ok(await call("query", staffA, { model: "staff_note" }));
      refused(await call("batch", staffA, { ops: [{ op: "insert", model: "staff_note", values: { staff: T.staffRowA1, note: "x", location_id: T.locA1 } }] }), "forbidden_role");
      const id = ok(await call("batch", ownerA, { ops: [{ op: "insert", model: "owner_ledger", values: { memo: "Private", total: 5 } }] })).results[0].id;
      const row = ok(await call("query", ownerA, { model: "owner_ledger", where: { field: "id", op: "eq", value: id } })).rows[0];
      expect(row).toMatchObject({ memo: "Private", total: 5, currency: "USD" });
      expect("location_id" in row).toBe(false);
      refused(await call("batch", ownerA, { ops: [{ op: "insert", model: "owner_ledger", values: { memo: "x", location_id: T.locA1 } }] }), "invalid_request");
      ok(await call("batch", ownerA, { ops: [{ op: "delete", model: "owner_ledger", id }] })); // no soft delete on this model: really gone
      refused(await call("batch", ownerA, { ops: [{ op: "delete", model: "owner_ledger", id }] }), "not_found");
    });

    it("a rule checked at the end of the batch holds, and a broken one rolls everything back", async () => {
      const ev = (amount: number) => ({ op: "insert" as const, model: "cash_event", values: { business_date: "2026-11-01", amount, kind: "paid_out", location_id: T.locA2 } });
      const n = await count("cash_event");
      ok(await call("batch", ownerA, { ops: [ev(-500), ev(500)] })); // dips below zero inside the batch, fine at the end
      expect(await count("cash_event")).toBe(n + 2);
      const r = await call("batch", ownerA, { ops: [ev(100), ev(-900)] });
      refused(r, "conflict");
      expect(r.body.error.message).toMatch(/does not balance/);
      expect(r.text).not.toContain("cash went negative");
      expect(await count("cash_event")).toBe(n + 2);
    });

    it("replays an idempotent batch without writing twice, per user", async () => {
      const key = `key-${newUuid()}`;
      const body = { ops: [pool("Idempotent", 42, { location_id: T.locA2 })], idempotencyKey: key };
      const a = (await audits(T.orgA, "data.batch")).length;
      const first = ok(await call("batch", ownerA, body));
      const second = ok(await call("batch", ownerA, body));
      expect(second).toEqual(first);
      expect((await pools(ownerA, { where: { field: "label", op: "eq", value: "Idempotent" } })).rows).toHaveLength(1);
      expect((await audits(T.orgA, "data.batch")).length).toBe(a + 1);
      // same key, different request: refused, never silently replayed
      refused(await call("batch", ownerA, { ops: [pool("Different", 1, { location_id: T.locA2 })], idempotencyKey: key }), "conflict");
      // the key belongs to one user of one mini-app in one restaurant
      const other = await call("batch", await live({ user: T.otherOwnerA }), { ops: [pool("Idempotent other user", 42, { location_id: T.locA2 })], idempotencyKey: key });
      expect(ok(other).results[0].id).not.toBe(first.results[0].id);
      const fromB = ok(await call("batch", ownerB, { ops: [pool("Idempotent in B", 42)], idempotencyKey: key }));
      expect(fromB.results[0].id).not.toBe(first.results[0].id);
      // two at once with the same key: one write
      const k2 = `key-${newUuid()}`;
      const racing = { ops: [pool("Racing", 1, { location_id: T.locA2 })], idempotencyKey: k2 };
      const [x, y] = await Promise.all([call("batch", ownerA, racing), call("batch", ownerA, racing)]);
      expect(ok(x)).toEqual(ok(y));
      expect((await pools(ownerA, { where: { field: "label", op: "eq", value: "Racing" } })).rows).toHaveLength(1);
    });

    it("writes one audit row per batch, with counts and keys only", async () => {
      const before = (await audits(T.orgA, "data.batch")).length;
      const secret = "AUDIT-SECRET-VALUE-9917";
      ok(await call("batch", ownerA, { ops: [pool(secret, 31337, { location_id: T.locA1, hourly_rate: 4242 }), { op: "insert", model: "owner_ledger", values: { memo: secret } }] }));
      const rows = await audits(T.orgA, "data.batch");
      expect(rows.length).toBe(before + 1);
      const last = rows[rows.length - 1]!;
      expect(last.actor).toBe(`user:${T.ownerA}`);
      expect(last.target_id).toBe(toPublicId("app", T.appA));
      expect(JSON.parse(last.meta)).toEqual({ env: "live", ops: 2, byOp: { insert: 2 }, byModel: { tip_pool: 1, owner_ledger: 1 }, idempotent: false });
      expect(JSON.stringify(last)).not.toContain(secret);
    });
  });

  // ------------------------------------------------------------------ named queries and actions
  describe("named queries", () => {
    const totals = (who: Caller, params: Record<string, unknown>, more: Record<string, unknown> = {}) => call("named", who, { query: QUERY_KEYS.totals, params, ...more });

    it("runs a report with bound parameters", async () => {
      const res = ok(await totals(ownerA, { business_date: "2026-11-15" }));
      expect(res.columns.map((c: any) => c.key)).toEqual(["location_id", "location_name", "business_date", "total", "entries"]);
      expect(res.masked).toEqual([]);
      const by = Object.fromEntries(res.rows.map((r: any) => [r.location_name, r]));
      const direct = await pools(ownerA, { where: { field: "business_date", op: "eq", value: "2026-11-15" }, totals: { groupBy: ["location_id"], aggregates: [{ fn: "sum", field: "amount", as: "total" }, { fn: "count", as: "n" }] } });
      const want = Object.fromEntries(direct.totals.map((t: any) => [t.location_id, t]));
      expect(by.Riverside).toEqual({ location_id: T.locA2, location_name: "Riverside", business_date: "2026-11-15", total: want[T.locA2].total, entries: want[T.locA2].n });
      expect(by.Downtown.total).toBe(want[T.locA1].total);
      expect(typeof by.Downtown.total).toBe("number");
      expect(by.Downtown.entries).toBeGreaterThanOrEqual(3);
      // a missing optional parameter is bound as NULL, a given one narrows
      const one = ok(await totals(ownerA, { business_date: "2026-11-15", location_id: T.locA2 }));
      expect(one.rows.map((r: any) => r.location_name)).toEqual(["Riverside"]);
      expect(ok(await totals(ownerA, { business_date: "2026-11-15", location_id: null })).rows).toHaveLength(2);
      expect(ok(await totals(ownerA, { business_date: "2026-11-15" }, { limit: 1 })).rows).toHaveLength(1);
    });

    it("checks parameters", async () => {
      refused(await totals(ownerA, {}), "invalid_request"); // required one missing
      refused(await totals(ownerA, { business_date: "soon" }), "invalid_request");
      refused(await totals(ownerA, { business_date: "2026-11-15", location_id: "x' or '1'='1" }), "invalid_request");
      refused(await totals(ownerA, { business_date: "2026-11-15", extra: 1 }), "invalid_request");
      refused(await call("named", ownerA, { query: QUERY_KEYS.totals, params: { business_date: "2026-11-15" }, org: T.orgB }), "invalid_request");
    });

    it("masks result columns and source fields by role, and keeps the location rule", async () => {
      const staff = ok(await totals(staffA, { business_date: "2026-11-15" }));
      expect(staff.masked).toEqual(["entries"]);
      expect(staff.columns.map((c: any) => c.key)).not.toContain("entries");
      for (const r of staff.rows) expect("entries" in r).toBe(false);
      const scoped = ok(await totals(staffA1, { business_date: "2026-11-15" }));
      expect(scoped.rows.map((r: any) => r.location_name)).toEqual(["Downtown"]);
      expect(ok(await totals(staffA1, { business_date: "2026-11-15", location_id: T.locA2 })).rows).toEqual([]);
      // a report that needs an owner-only field cannot be run by staff
      expect(ok(await call("named", ownerA, { query: QUERY_KEYS.rates, params: {} })).rows[0].rate_total).toBeGreaterThanOrEqual(4130);
      refused(await call("named", staffA, { query: QUERY_KEYS.rates, params: {} }), "forbidden_field");
    });

    it("refuses reports the manifest does not list, with the same answer whether or not they exist", async () => {
      refused(await call("named", ownerA, { query: QUERY_KEYS.unlisted, params: {} }), "forbidden_model");
      refused(await call("named", ownerA, { query: "no_such_report", params: {} }), "forbidden_model");
      refused(await call("named", viewerA, { query: QUERY_KEYS.totals, params: { business_date: "2026-11-15" } }), "forbidden_model");
      refused(await call("named", runA, { query: QUERY_KEYS.totals, params: { business_date: "2026-11-15" } }), "forbidden_model");
    });

    it("a template that tries to write, or reads an undeclared model, never runs", async () => {
      const n = await count("tip_pool");
      const w = await call("named", ownerA, { query: QUERY_KEYS.writes, params: {} });
      refused(w, "internal");
      refused(await call("named", ownerA, { query: QUERY_KEYS.undeclared, params: {} }), "internal");
      expect(await count("tip_pool")).toBe(n);
    });

    it("the report envelope is read-only at the database, whatever the statement says", async () => {
      const t = tenantFor("live");
      const n = await count("tip_pool");
      await expect(readOnlyStore(t, "report", (tx, s) => run(tx, `delete from ${s.table("tip_pool")}`))).rejects.toMatchObject({ code: "25006" });
      await expect(readOnlyStore(t, "report", (tx, s) => run(tx, `select * from (with gone as (delete from ${s.table("tip_pool")} returning id) select count(*) from gone) as q limit $1::int`, ["5"]))).rejects.toMatchObject({ code: "0A000" });
      await expect(readOnlyStore(t, "report", (tx, s) => run(tx, `select 1; delete from ${s.table("tip_pool")}`))).rejects.toMatchObject({ code: "42601" });
      await expect(readOnlyStore(t, "report", (tx, s) => run(tx, `select * from ${s.table("tip_pool")} for update`))).rejects.toMatchObject({ code: "25006" });
      expect(await count("tip_pool")).toBe(n);
    });
  });

  describe("named actions", () => {
    it("runs once, is idempotent, and writes an audit row", async () => {
      const before = (await audits(T.orgA, "data.action")).length;
      const first = ok(await call("action", ownerA, { action: ACTION_KEYS.close, params: { pool_id: P.r1 } }));
      expect(first).toEqual({ affected: 1 });
      expect(ok(await call("action", ownerA, { action: ACTION_KEYS.close, params: { pool_id: P.r1 } }))).toEqual({ affected: 0 });
      const ev = ok(await call("query", ownerA, { model: "cash_event", where: { field: "source_id", op: "eq", value: `tip_pool/${P.r1}` } })).rows;
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ amount: 7000, kind: "payout", source: "app", location_id: T.locA2, currency: "USD", created_by: `user:${T.ownerA}` });
      const rows = await audits(T.orgA, "data.action");
      expect(rows.length).toBe(before + 2);
      expect(rows[rows.length - 2]).toMatchObject({ target_type: "named_action", target_id: ACTION_KEYS.close });
      expect(JSON.parse(rows[rows.length - 2]!.meta)).toMatchObject({ env: "live", affected: 1, params: ["pool_id"] });
    });

    it("keeps the role, location and manifest rules", async () => {
      refused(await call("action", ownerA, { action: ACTION_KEYS.close, params: {} }), "invalid_request");
      refused(await call("action", ownerA, { action: ACTION_KEYS.close, params: { pool_id: "nope" } }), "invalid_request");
      // a pool at a location the user does not work at is simply not there
      expect(ok(await call("action", staffA1, { action: ACTION_KEYS.close, params: { pool_id: P.r2 } }))).toEqual({ affected: 0 });
      // another restaurant's pool is not there either
      expect(ok(await call("action", ownerA, { action: ACTION_KEYS.close, params: { pool_id: P.b1 } }))).toEqual({ affected: 0 });
      // writing an owner-only field
      refused(await call("action", staffA, { action: ACTION_KEYS.setRate, params: { pool_id: P.d2 } }), "forbidden_field");
      expect(ok(await call("action", ownerA, { action: ACTION_KEYS.setRate, params: { pool_id: P.d2 } }))).toEqual({ affected: 1 });
      refused(await call("action", ownerA, { action: ACTION_KEYS.unlisted, params: {} }), "forbidden_model");
      refused(await call("action", ownerA, { action: "no_such_action", params: {} }), "forbidden_model");
      refused(await call("action", viewerA, { action: ACTION_KEYS.close, params: { pool_id: P.d1 } }), "forbidden_model");
      refused(await call("action", runA, { action: ACTION_KEYS.close, params: { pool_id: P.d1 } }), "forbidden_model");
    });
  });

  // ------------------------------------------------------------------ live and draft
  describe("live and draft", () => {
    it("a run token works in the draft store only, under the working manifest", async () => {
      const id = await insertPool(runA, "Draft only row", 5, { location_id: T.locA1 });
      expect((await pools(runA)).rows.map((r: any) => r.id)).toEqual([id]); // none of the live rows
      expect((await pools(ownerA, { where: { field: "id", op: "eq", value: id } })).rows).toEqual([]);
      expect(await count("tip_pool", "A", "draft")).toBe(1);
      refused(await call("query", runA, { model: "cash_event" }), "forbidden_model"); // in the published manifest, not the working one
      refused(await call("batch", runA, { ops: [{ op: "update", model: "tip_pool", id: P.d1, values: { amount: 1 } }] }), "not_found"); // a live row
      ok(await call("batch", runA, { ops: [{ op: "insert", model: "draft_idea", values: { idea: "Try brunch" } }] }));
      expect(ok(await call("query", runA, { model: "draft_idea" })).rows).toHaveLength(1);
    });

    it("an app token cannot reach a model that is only in draft", async () => {
      refused(await call("query", ownerA, { model: "draft_idea" }), "not_found");
      refused(await call("batch", ownerA, { ops: [{ op: "insert", model: "draft_idea", values: { idea: "x" } }] }), "not_found");
    });

    it("builds and previews never see real pay or contact details", async () => {
      const res = ok(await call("query", runA, { model: "parent.staff", sort: [{ field: "full_name" }] }));
      expect(res.masked.sort()).toEqual(["email", "hourly_rate_minor", "phone"]);
      expect(res.rows.map((r: any) => r.full_name)).toEqual(["Avery Stone", "Blake Rivers"]);
      for (const r of res.rows) for (const k of ["hourly_rate_minor", "email", "phone"]) expect(k in r).toBe(false);
      refused(await call("query", runA, { model: "parent.staff", fields: ["hourly_rate_minor"] }), "forbidden_field");
    });
  });

  // ------------------------------------------------------------------ one restaurant never reaches another
  describe("restaurant A can never read or write restaurant B", () => {
    it("reads only its own rows", async () => {
      const rows = (await pools(ownerA)).rows;
      expect(rows.some((r: any) => r.id === P.b1)).toBe(false);
      expect((await pools(ownerA, { where: { field: "id", op: "eq", value: P.b1 } })).rows).toEqual([]);
      expect((await pools(ownerA, { where: { field: "id", op: "in", value: [P.b1, P.d1] } })).rows.map((r: any) => r.id)).toEqual([P.d1]);
      expect((await pools(ownerA, { where: { field: "label", op: "contains", value: "CANARY-B" }, includeDeleted: true })).rows).toEqual([]);
      expect((await pools(ownerA, { where: { field: "location_id", op: "eq", value: T.locB1 } })).rows).toEqual([]);
      expect((await pools(ownerB)).rows.map((r: any) => r.id)).toContain(P.b1);
      expect((await pools(ownerB)).rows.some((r: any) => r.id === P.d1)).toBe(false);
    });

    it("cannot write B's rows by id", async () => {
      refused(await call("batch", ownerA, { ops: [{ op: "update", model: "tip_pool", id: P.b1, values: { amount: 1 } }] }), "not_found");
      refused(await call("batch", ownerA, { ops: [{ op: "delete", model: "tip_pool", id: P.b1 }] }), "not_found");
      expect((await pools(ownerB, { where: { field: "id", op: "eq", value: P.b1 } })).rows[0]).toMatchObject({ amount: 99999, deleted_at: null });
    });

    it("cannot name B in a body, a header, a query string or a model name", async () => {
      const base = { model: "tip_pool" };
      for (const extra of [{ org: toPublicId("org", T.orgB) }, { orgId: T.orgB }, { schema: T.prefixB }, { storePrefix: T.prefixB }, { env: "draft" }, { role: "owner" }, { tenant: { orgId: T.orgB } }]) {
        refused(await call("query", ownerA, { ...base, ...extra }), "invalid_request");
        refused(await call("batch", ownerA, { ops: [pool("x", 1, { location_id: T.locA1 })], ...extra }), "invalid_request");
        refused(await call("catalog", ownerA, extra), "invalid_request");
      }
      refused(await call("batch", ownerA, { ops: [{ ...pool("x", 1, { location_id: T.locA1 }), org: T.orgB }] }), "invalid_request");
      for (const model of [`${T.prefixB}.tip_pool`, `"${T.prefixB}"."tip_pool"`, `${T.prefixB}_parent.staff`, "parent.staff; select 1", "platform.secrets", "tip_pool as x", "PARENT.staff"]) {
        refused(await call("query", ownerA, { model }), "invalid_request");
        refused(await call("batch", ownerA, { ops: [{ op: "insert", model, values: {} }] }), model.startsWith("parent.") ? "read_only" : "invalid_request");
      }
      const spoofed = await call("query", ownerA, { model: "tip_pool", limit: 500 }, {
        query: `?org=${toPublicId("org", T.orgB)}&orgId=${T.orgB}&schema=${T.prefixB}&env=draft`,
        headers: { "x-org-id": T.orgB, "x-rms-org": toPublicId("org", T.orgB), "x-store-prefix": T.prefixB, "x-rms-role": "owner", "x-forwarded-host": "b.example.test" },
      });
      expect(ok(spoofed).rows.some((r: any) => r.id === P.b1)).toBe(false);
      expect(ok(spoofed).rows.some((r: any) => r.id === P.d1)).toBe(true);
    });

    it("cannot reach a model only B has, even when A's manifest names it", async () => {
      refused(await call("query", ownerA, { model: "b_only" }), "not_found");
      refused(await call("batch", ownerA, { ops: [{ op: "insert", model: "b_only", values: { secret: "x" } }] }), "not_found");
      expect(ok(await call("query", ownerB, { model: "b_only" })).rows).toHaveLength(1);
    });

    it("a token signed for B's restaurant with A's mini-app is refused", async () => {
      const mixed: Caller = { org: "B", token: await mintAppToken({ kind: "app", aud: "data", org: toPublicId("org", T.orgB), sub: toPublicId("usr", T.ownerA), app: toPublicId("app", T.appA), ver: toPublicId("ver", T.verA), role: "owner", loc: "all", env: "live" }) };
      refused(await call("query", mixed, { model: "tip_pool" }), "unauthenticated");
      refused(await call("catalog", mixed, {}), "unauthenticated");
    });

    it("parent data, reports and the catalog stay inside the restaurant", async () => {
      expect(JSON.stringify(ok(await call("query", ownerA, { model: "parent.staff" })))).not.toContain("Casey");
      expect(ok(await call("query", ownerA, { model: "parent.staff", where: { field: "id", op: "eq", value: T.staffRowB1 } })).rows).toEqual([]);
      const b = ok(await call("named", ownerB, { query: QUERY_KEYS.totals, params: { business_date: "2026-11-15" } }));
      expect(b.rows).toHaveLength(1);
      expect(b.rows[0].total).toBeGreaterThanOrEqual(99999);
      const a = ok(await call("named", ownerA, { query: QUERY_KEYS.totals, params: { business_date: "2026-11-15", location_id: T.locB1 } }));
      expect(a.rows).toEqual([]);
    });
  });

  // ------------------------------------------------------------------ catalog
  describe("catalog", () => {
    it("lists only what the token can use", async () => {
      const owner = ok(await call("catalog", ownerA, {}));
      const refs = owner.models.map((m: any) => m.ref).sort();
      expect(refs).toEqual(["cash_event", "owner_ledger", "parent.locations", "parent.staff", "staff_note", "tip_pool"]); // no secret_plan, b_only or draft_idea
      const tip = owner.models.find((m: any) => m.ref === "tip_pool");
      expect(tip.access).toBe("write");
      expect(tip.fields.map((f: any) => f.key)).toContain("hourly_rate");
      expect(tip.fields.find((f: any) => f.key === "status").values).toEqual(["open", "closed"]);
      expect(owner.namedQueries.map((q: any) => q.key).sort()).toEqual([QUERY_KEYS.rates, QUERY_KEYS.totals, QUERY_KEYS.writes, QUERY_KEYS.undeclared].sort());
      expect(owner.actions.map((a: any) => a.key).sort()).toEqual([ACTION_KEYS.close, ACTION_KEYS.setRate].sort());
      expect(JSON.stringify(owner)).not.toMatch(/select |insert |\{\{/i);

      const staff = ok(await call("catalog", staffA, {}));
      expect(staff.models.map((m: any) => m.ref)).not.toContain("owner_ledger");
      expect(staff.models.find((m: any) => m.ref === "tip_pool").fields.map((f: any) => f.key)).not.toContain("hourly_rate");
      expect(staff.models.find((m: any) => m.ref === "staff_note").access).toBe("read");
      expect(staff.models.find((m: any) => m.ref === "parent.staff").fields.map((f: any) => f.key)).not.toContain("hourly_rate_minor");
      expect(staff.namedQueries.find((q: any) => q.key === QUERY_KEYS.totals).columns.map((c: any) => c.key)).not.toContain("entries");

      const viewer = ok(await call("catalog", viewerA, {}));
      expect(viewer.models.map((m: any) => [m.ref, m.access]).sort()).toEqual([["parent.staff", "read"], ["tip_pool", "read"]]);
      expect(viewer.namedQueries).toEqual([]);
      expect(viewer.actions).toEqual([]);

      const run = ok(await call("catalog", runA, {}));
      expect(run.models.map((m: any) => m.ref).sort()).toEqual(["draft_idea", "parent.staff", "tip_pool"]);
    });
  });

  // ------------------------------------------------------------------ limits
  describe("limits", () => {
    it("refuses a body that is too large", async () => {
      const r = await call("batch", ownerA, { ops: [pool("Big", 1, { location_id: T.locA1, notes: "x".repeat(2_200_000) })] });
      refused(r, "limit");
    });
  });

  // ------------------------------------------------------------------ sweeps over everything above
  describe("sweeps", () => {
    it("no response to one restaurant ever held the other's canary", () => {
      expect(seen.A.length).toBeGreaterThan(150);
      expect(seen.B.length).toBeGreaterThan(5);
      expect(seen.B.some((t) => t.includes(CANARY_B))).toBe(true); // the canary is really there for its owner
      expect(seen.A.some((t) => t.includes(CANARY_A))).toBe(true);
      expect(seen.A.filter((t) => t.includes("CANARY-B"))).toEqual([]);
      expect(seen.B.filter((t) => t.includes("CANARY-A"))).toEqual([]);
      expect(seen.A.filter((t) => t.includes("Casey") || t.includes("taskd-b.test"))).toEqual([]);
    });

    it("no error response held database text, a schema name or a table name", () => {
      expect(failures.length).toBeGreaterThan(100);
      const leaks = /permission denied|violates|relation |syntax error|duplicate key|constraint|row-level security|sqlstate|postgres|o_e1e1e1|_parent|platform\.|taskd internal|select |insert into|invalid input|column "/i;
      expect(failures.filter((t) => leaks.test(t))).toEqual([]);
      for (const t of failures) {
        const e = JSON.parse(t).error;
        expect(Object.keys(e).sort()).toEqual(["code", "message", "requestId"]);
        expect(e.message.length).toBeLessThan(200);
      }
    });
  });
});

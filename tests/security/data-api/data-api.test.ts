// Data API level attacks, written against DATA_ROUTES and the wire shapes in @rms/contracts.
//
// Task D builds the routes in parallel. While apps/api/src/routes/data.ts is still the empty stub
// (POST /data/v1/catalog answers 404), every test here is SKIPPED and the run says so loudly.
// Set RMS_REQUIRE_DATA_API=1 (the lead does at integration) to turn that skip into a failure.
//
// These tests have NOT run against a real Data API yet. Expect to adjust fixtures at integration,
// never the assertions about refusal.
import { describe, expect, it } from "vitest";
import { DATA_ERROR_STATUS, DATA_ROUTES, type DataErrorCode, toPublicId } from "@rms/contracts";
import api from "../../../apps/api/src/index.js";
import { holds, platform, sweep } from "../helpers/actors.js";
import { type ClaimOpts, appToken, bearer, hmacToken, realSecret, runToken, stamped, appClaims } from "../helpers/tokens.js";
import { CANARY, NAMED_QUERY_KEY, ORG, type OrgKey, ids, orgPublicId } from "../helpers/world.js";

const probe = await api.request(DATA_ROUTES.catalog, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
const STUB = probe.status === 404;
const REQUIRED = process.env.RMS_REQUIRE_DATA_API === "1";

if (STUB) {
  // Straight to stderr, so no reporter setting can hide it.
  process.stderr.write(
    [
      "",
      "######################################################################",
      "#  DATA API ATTACK TESTS SKIPPED                                     #",
      "#  apps/api/src/routes/data.ts is still the empty stub (404).        #",
      "#  Nothing in tests/security/data-api ran. Re-run after task D       #",
      "#  merges, with RMS_REQUIRE_DATA_API=1 so a stub fails the suite.    #",
      "######################################################################",
      "",
      "",
    ].join("\n"),
  );
}

describe("Data API availability", () => {
  // Shows up as one more skipped test in the summary while the routes are a stub.
  it.skipIf(STUB)("the Data API routes are built, so the attack tests below ran", () => {
    expect(probe.status).not.toBe(404);
  });

  it.runIf(REQUIRED)("the Data API routes exist (RMS_REQUIRE_DATA_API=1)", () => {
    expect(probe.status, "POST /data/v1/catalog is still a 404: the Data API attack tests cannot run").not.toBe(404);
  });
});

type Reply = { status: number; text: string; json: Record<string, unknown> & { error?: { code?: string; message?: string; requestId?: string }; rows?: Record<string, unknown>[] } };

/** One Data API call. Every response body is swept for the other restaurant's canary. */
const call = async (actor: OrgKey, route: keyof typeof DATA_ROUTES, token: string | null, body: unknown, extra: { headers?: Record<string, string>; query?: string; method?: string } = {}): Promise<Reply> => {
  const res = await api.request(`${DATA_ROUTES[route]}${extra.query ?? ""}`, {
    method: extra.method ?? "POST",
    headers: { "content-type": "application/json", ...(token ? bearer(token) : {}), ...extra.headers },
    ...(extra.method === "GET" ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  sweep(actor, `Data API ${route} response`, text);
  let json: Reply["json"] = {};
  try {
    json = JSON.parse(text) as Reply["json"];
  } catch {
    // Not JSON: left empty, the status assertions below still apply.
  }
  return { status: res.status, text, json };
};

/** Database words that must never reach a caller. */
const INTERNAL = /permission denied|row-level security|violates|constraint|relation "|column "|syntax error|SQLSTATE|postgres|pg_|o_[0-9a-f]{12}|platform\.|rms_api|rms_admin|\bselect\b.*\bfrom\b|at .*\.(ts|js):\d+/i;

const expectRefused = (r: Reply, codes: DataErrorCode[]) => {
  expect(codes, `status ${r.status}, body ${r.text.slice(0, 200)}`).toContain(r.json.error?.code);
  expect(r.status).toBe(DATA_ERROR_STATUS[r.json.error?.code as DataErrorCode]);
  expect(r.json.rows).toBeUndefined();
  expect(r.text).not.toMatch(INTERNAL);
  expect(typeof r.json.error?.message).toBe("string");
  expect(typeof r.json.error?.requestId).toBe("string");
};

const tok = (k: OrgKey, opts: ClaimOpts = {}) => appToken(k, opts);
const A = ids("a");
const B = ids("b");

describe.skipIf(STUB)("Data API: no valid token, no data", () => {
  const routes = Object.keys(DATA_ROUTES) as (keyof typeof DATA_ROUTES)[];

  it.each(routes)("%s refuses a request with no token", async (route) => {
    expectRefused(await call("a", route, null, { model: "sec_note" }), ["unauthenticated"]);
  });

  it.each(routes)("%s refuses a forged token", async (route) => {
    const forged = hmacToken(stamped(appClaims("b")), "another-secret-another-secret-another-1");
    expectRefused(await call("a", route, forged, { model: "sec_note" }), ["unauthenticated"]);
  });

  it.each(routes)("%s answers only POST", async (route) => {
    const r = await call("a", route, await tok("a"), undefined, { method: "GET" });
    expect([404, 405]).toContain(r.status);
    expect(r.json.rows).toBeUndefined();
  });
});

describe.skipIf(STUB)("Data API: control, the happy path works and returns the caller's own data", () => {
  it("A reads its notes and finds its own canary", async () => {
    const r = await call("a", "query", await tok("a"), { model: "sec_note" });
    expect(r.status).toBe(200);
    expect(holds(r.json.rows, CANARY.a)).toBe(true);
  });

  it("B reads its notes and finds its own canary", async () => {
    const r = await call("b", "query", await tok("b"), { model: "sec_note" });
    expect(holds(r.json.rows, CANARY.b)).toBe(true);
  });

  it("the catalog lists only what the mini-app's manifest allows, with no SQL in it", async () => {
    const r = await call("a", "catalog", await tok("a"), {});
    expect(r.status).toBe(200);
    const refs = ((r.json.models as { ref: string }[]) ?? []).map((m) => m.ref).sort();
    expect(refs).toEqual(["parent.jobs", "parent.staff", "sec_note", "sec_visit"]);
    expect(r.text).not.toMatch(/\{\{|select |insert /i);
    expect(r.text).not.toContain(ORG.a.prefix);
  });
});

describe.skipIf(STUB)("Data API: the restaurant comes from the token only", () => {
  const smuggledBodies = ["org", "orgId", "org_id", "restaurant", "tenant", "schema", "storePrefix", "store_prefix", "role", "env", "environment", "userId", "user_id", "locations", "actor"];

  it.each(smuggledBodies)("a body field %s is refused on every route", async (key) => {
    const token = await tok("a");
    for (const value of [orgPublicId("b"), ORG.b.uuid, ORG.b.prefix, "owner", "draft"]) {
      expectRefused(await call("a", "query", token, { model: "sec_note", [key]: value }), ["invalid_request"]);
      expectRefused(await call("a", "batch", token, { ops: [{ op: "insert", model: "sec_note", values: { body: "x" } }], [key]: value }), ["invalid_request"]);
      expectRefused(await call("a", "named", token, { query: NAMED_QUERY_KEY, params: { q: "%" }, [key]: value }), ["invalid_request"]);
      expectRefused(await call("a", "action", token, { action: "sec_missing", [key]: value }), ["invalid_request", "forbidden_model"]);
    }
  });

  it("identity fields nested inside ops and filters are refused", async () => {
    const token = await tok("a");
    expectRefused(await call("a", "batch", token, { ops: [{ op: "insert", model: "sec_note", values: { body: "x" }, org: orgPublicId("b") }] }), ["invalid_request"]);
    expectRefused(await call("a", "batch", token, { ops: [{ op: "insert", model: "sec_note", schema: ORG.b.prefix, values: { body: "x" } }] }), ["invalid_request"]);
    expectRefused(await call("a", "query", token, { model: "sec_note", where: { field: "body", op: "eq", value: "x", org: orgPublicId("b") } }), ["invalid_request"]);
    expectRefused(await call("a", "query", token, { model: "sec_note", sort: [{ field: "body", schema: ORG.b.prefix }] }), ["invalid_request"]);
  });

  it("an identity name used as a field or a parameter is an unknown field, not a way in", async () => {
    const token = await tok("a");
    for (const key of ["org_id", "role", "env", "schema", "tenant"]) {
      expectRefused(await call("a", "batch", token, { ops: [{ op: "insert", model: "sec_note", values: { body: "x", [key]: ORG.b.uuid } }] }), ["invalid_request", "forbidden_field"]);
      expectRefused(await call("a", "query", token, { model: "sec_note", where: { field: key, op: "eq", value: ORG.b.uuid } }), ["invalid_request", "forbidden_field"]);
      expectRefused(await call("a", "named", token, { query: NAMED_QUERY_KEY, params: { q: "%", [key]: ORG.b.uuid } }), ["invalid_request"]);
    }
  });

  it.each([
    ["the query string", { query: `?org=${orgPublicId("b")}&org_id=${ORG.b.uuid}&schema=${ORG.b.prefix}&env=draft&role=owner` }],
    ["headers", { headers: { "x-org-id": orgPublicId("b"), "x-rms-org": orgPublicId("b"), "x-tenant-id": ORG.b.uuid, "x-store-prefix": ORG.b.prefix, "x-schema": ORG.b.prefix, "x-role": "owner", "x-env": "draft" } }],
    ["a host header", { headers: { "x-forwarded-host": `${ORG.b.prefix}.rms.test`, forwarded: `host=${ORG.b.prefix}.rms.test` } }],
  ])("%s naming B changes nothing: A's staff token still reads A's own rows", async (_what, extra) => {
    const token = await tok("a", { role: "staff", loc: [A.loc1] });
    const plain = await call("a", "query", token, { model: "sec_visit", fields: ["body"] });
    const smuggled = await call("a", "query", token, { model: "sec_visit", fields: ["body"] }, extra);
    expect(smuggled.status).toBe(200);
    expect(smuggled.json.rows).toEqual(plain.json.rows);
    expect(smuggled.json.rows).toHaveLength(1);
  });

  it("A's token cannot name B's store as a model", async () => {
    const token = await tok("a");
    for (const model of [ORG.b.prefix, `${ORG.b.prefix}_parent`, "platform", "auth", "pg_catalog", "information_schema", "organizations", "secrets", "pg_class"]) {
      expectRefused(await call("a", "query", token, { model }), ["forbidden_model", "invalid_request", "not_found"]);
    }
    for (const model of [`${ORG.b.prefix}.sec_note`, "platform.secrets", "auth.users", "parent.secrets"]) {
      expectRefused(await call("a", "query", token, { model }), ["invalid_request"]);
    }
  });

  it("A's token finds nothing when it asks for B's rows by id", async () => {
    const token = await tok("a");
    const r = await call("a", "query", token, { model: "sec_note", where: { field: "id", op: "in", value: [B.noteRow, B.ledgerRow] } });
    expect(r.status).toBe(200);
    expect(r.json.rows).toEqual([]);
  });

  it("A's token cannot update or delete B's rows by id, and B's rows are untouched", async () => {
    const token = await tok("a");
    expectRefused(await call("a", "batch", token, { ops: [{ op: "update", model: "sec_note", id: B.noteRow, values: { body: "taken over" } }] }), ["not_found"]);
    expectRefused(await call("a", "batch", token, { ops: [{ op: "delete", model: "sec_note", id: B.noteRow }] }), ["not_found"]);
    const r = await call("b", "query", await tok("b"), { model: "sec_note", fields: ["body"] });
    expect(r.json.rows).toEqual([{ body: `note ${CANARY.b} live` }]);
  });

  it("A's token with B's mini-app or B's version is refused: the manifest must belong to the token's restaurant", async () => {
    const mixed = [
      await appToken("a", { app: B.app, ver: B.appVersion }),
      await appToken("a", { ver: B.appVersion }),
      await appToken("a", { app: B.app }),
      await appToken("a", { app: A.readOnlyApp, ver: A.appVersion }), // a version of a different mini-app of the same restaurant
    ];
    for (const token of mixed) {
      expectRefused(await call("a", "query", token, { model: "sec_note" }), ["forbidden_model", "unauthenticated", "not_found"]);
      expectRefused(await call("a", "catalog", token, {}), ["forbidden_model", "unauthenticated", "not_found"]);
    }
  });

  it("a token for a version that is not published is refused", async () => {
    await platform()`update platform.app_versions set status = 'draft' where id = ${A.readOnlyAppVersion}`;
    try {
      expectRefused(await call("a", "query", await appToken("a", { app: A.readOnlyApp, ver: A.readOnlyAppVersion }), { model: "sec_note" }), ["forbidden_model", "unauthenticated", "not_found"]);
    } finally {
      await platform()`update platform.app_versions set status = 'published' where id = ${A.readOnlyAppVersion}`;
    }
  });
});

describe.skipIf(STUB)("Data API: live and draft stay apart", () => {
  it("a mini-app token reads live rows only", async () => {
    const r = await call("a", "query", await tok("a"), { model: "sec_note", fields: ["body"] });
    expect(r.json.rows).toEqual([{ body: `note ${CANARY.a} live` }]);
  });

  it("a build token reads draft rows only", async () => {
    const r = await call("a", "query", await runToken("a"), { model: "sec_note", fields: ["body"] });
    expect(r.status).toBe(200);
    expect(r.json.rows).toEqual([{ body: `note ${CANARY.a} draft` }]);
  });

  it("a build token's write lands in draft, never in live", async () => {
    const token = await runToken("a");
    const w = await call("a", "batch", token, { ops: [{ op: "insert", model: "sec_note", values: { body: "written by a build" } }] });
    expect(w.status).toBe(200);
    const liveRows = await call("a", "query", await tok("a"), { model: "sec_note", fields: ["body"] });
    expect(liveRows.json.rows).toEqual([{ body: `note ${CANARY.a} live` }]);
    const id = (w.json.results as { id: string }[])[0]?.id as string;
    await call("a", "batch", token, { ops: [{ op: "delete", model: "sec_note", id }] });
  });
});

describe.skipIf(STUB)("Data API: the manifest and the role decide", () => {
  it("a model that is not in the manifest is refused, for reads and writes", async () => {
    const token = await tok("a");
    expectRefused(await call("a", "query", token, { model: "sec_ledger" }), ["forbidden_model"]);
    expectRefused(await call("a", "batch", token, { ops: [{ op: "insert", model: "sec_ledger", values: { body: "x" } }] }), ["forbidden_model"]);
    expectRefused(await call("a", "query", token, { model: "parent.licences" }), ["forbidden_model"]);
  });

  it("a mini-app with read access cannot write", async () => {
    const token = await appToken("a", { app: A.readOnlyApp, ver: A.readOnlyAppVersion });
    expect((await call("a", "query", token, { model: "sec_note" })).status).toBe(200);
    for (const op of [{ op: "insert", model: "sec_note", values: { body: "x" } }, { op: "update", model: "sec_note", id: A.noteRow, values: { body: "x" } }, { op: "delete", model: "sec_note", id: A.noteRow }, { op: "upsert_by_source", model: "sec_note", sourceId: "s1", values: { body: "x" } }]) {
      expectRefused(await call("a", "batch", token, { ops: [op] }), ["forbidden_model"]);
    }
    expectRefused(await call("a", "query", token, { model: "sec_visit" }), ["forbidden_model"]);
    expectRefused(await call("a", "named", token, { query: NAMED_QUERY_KEY, params: { q: "%" } }), ["forbidden_model"]);
  });

  it("a named action that is not in the manifest is refused", async () => {
    expectRefused(await call("a", "action", await tok("a"), { action: "post_sales_day", params: {} }), ["forbidden_model", "not_found"]);
  });

  it("staff cannot write a model their role may only read", async () => {
    const token = await tok("a", { role: "staff", loc: [A.loc1] });
    expectRefused(await call("a", "batch", token, { ops: [{ op: "insert", model: "sec_note", values: { body: "x" } }] }), ["forbidden_role"]);
  });

  it.each([
    ["naming it in fields", { model: "sec_visit", fields: ["body", "wage"] }],
    ["filtering on it", { model: "sec_visit", where: { field: "wage", op: "gt", value: 5000 } }],
    ["filtering on it inside a nested filter", { model: "sec_visit", where: { or: [{ field: "body", op: "eq", value: "x" }, { not: { field: "wage", op: "lt", value: 5000 } }] } }],
    ["sorting by it", { model: "sec_visit", sort: [{ field: "wage", dir: "desc" }] }],
    ["totalling it", { model: "sec_visit", totals: { aggregates: [{ fn: "sum", field: "wage", as: "total" }] } }],
    ["taking its minimum", { model: "sec_visit", totals: { aggregates: [{ fn: "min", field: "wage", as: "low" }] } }],
    ["grouping by it", { model: "sec_visit", totals: { groupBy: ["wage"], aggregates: [{ fn: "count", as: "n" }] } }],
  ])("staff cannot reach a payroll field by %s", async (_what, body) => {
    const token = await tok("a", { role: "staff", loc: [A.loc1] });
    expectRefused(await call("a", "query", token, body), ["forbidden_field"]);
  });

  it("staff cannot write a payroll field", async () => {
    const token = await tok("a", { role: "staff", loc: [A.loc1] });
    expectRefused(await call("a", "batch", token, { ops: [{ op: "insert", model: "sec_visit", values: { body: "x", wage: 1 } }] }), ["forbidden_field"]);
    expectRefused(await call("a", "batch", token, { ops: [{ op: "update", model: "sec_visit", id: A.visitRow1, values: { wage: 1 } }] }), ["forbidden_field"]);
  });

  it("staff reading without naming fields get rows with the payroll field absent, and are told it was hidden", async () => {
    const token = await tok("a", { role: "staff", loc: [A.loc1] });
    const r = await call("a", "query", token, { model: "sec_visit" });
    expect(r.status).toBe(200);
    for (const row of r.json.rows ?? []) expect(Object.keys(row)).not.toContain("wage");
    expect(r.json.masked).toContain("wage");
    expect(r.text).not.toContain("4321");
  });

  it("control: the owner reads the payroll field", async () => {
    const r = await call("a", "query", await tok("a"), { model: "sec_visit", fields: ["wage"], sort: [{ field: "wage" }] });
    expect(r.json.rows).toEqual([{ wage: 4321 }, { wage: 8765 }]);
  });
});

describe.skipIf(STUB)("Data API: locations", () => {
  const staffToken = () => tok("a", { role: "staff", loc: [A.loc1] });

  it("a caller with one location reads only that location's rows", async () => {
    const r = await call("a", "query", await staffToken(), { model: "sec_visit", fields: ["body"] });
    expect(r.json.rows).toEqual([{ body: `visit loc1 ${CANARY.a} live` }]);
  });

  it("asking for another location's rows finds nothing", async () => {
    const token = await staffToken();
    expect((await call("a", "query", token, { model: "sec_visit", where: { field: "location_id", op: "eq", value: A.loc2 } })).json.rows).toEqual([]);
    expect((await call("a", "query", token, { model: "sec_visit", where: { field: "id", op: "eq", value: A.visitRow2 } })).json.rows).toEqual([]);
    const totals = await call("a", "query", token, { model: "sec_visit", totals: { aggregates: [{ fn: "count", as: "n" }] } });
    expect(totals.json.totals).toEqual([{ n: 1 }]);
  });

  it("writing a row for another location, or another restaurant's location, is refused", async () => {
    const token = await staffToken();
    expectRefused(await call("a", "batch", token, { ops: [{ op: "insert", model: "sec_visit", values: { body: "x", location_id: A.loc2 } }] }), ["forbidden_location"]);
    expectRefused(await call("a", "batch", token, { ops: [{ op: "insert", model: "sec_visit", values: { body: "x", location_id: B.loc1 } }] }), ["forbidden_location"]);
    expectRefused(await call("a", "batch", token, { ops: [{ op: "update", model: "sec_visit", id: A.visitRow1, values: { location_id: A.loc2 } }] }), ["forbidden_location"]);
    expectRefused(await call("a", "batch", token, { ops: [{ op: "update", model: "sec_visit", id: A.visitRow2, values: { body: "x" } }] }), ["not_found", "forbidden_location"]);
    expectRefused(await call("a", "batch", token, { ops: [{ op: "delete", model: "sec_visit", id: A.visitRow2 }] }), ["not_found", "forbidden_location"]);
  });

  it("an owner cannot write a row for another restaurant's location", async () => {
    expectRefused(await call("a", "batch", await tok("a"), { ops: [{ op: "insert", model: "sec_visit", values: { body: "x", location_id: B.loc1 } }] }), ["forbidden_location", "invalid_request"]);
  });
});

describe.skipIf(STUB)("Data API: parent data and server-owned fields", () => {
  it("parent data can be read when the manifest allows it", async () => {
    const r = await call("a", "query", await tok("a"), { model: "parent.jobs" });
    expect(r.status).toBe(200);
    expect(holds(r.json.rows, CANARY.a)).toBe(true);
  });

  it("parent data cannot be written", async () => {
    const token = await tok("a");
    for (const op of [{ op: "insert", model: "parent.jobs", values: { name: "x" } }, { op: "update", model: "parent.jobs", id: A.job, values: { name: "x" } }, { op: "delete", model: "parent.jobs", id: A.job }]) {
      expectRefused(await call("a", "batch", token, { ops: [op] }), ["invalid_request", "read_only"]);
    }
    const after = await call("a", "query", token, { model: "parent.jobs", fields: ["name"] });
    expect(after.json.rows).toEqual([{ name: `Server ${CANARY.a}` }]);
  });

  it("a caller cannot set the fields the server owns", async () => {
    const token = await tok("a");
    for (const key of ["id", "source", "source_id", "created_by", "created_at", "updated_by", "updated_at", "deleted_at"]) {
      expectRefused(await call("a", "batch", token, { ops: [{ op: "insert", model: "sec_note", values: { body: "x", [key]: "user:someone-else" } }] }), ["invalid_request"]);
    }
  });

  it("one failing op undoes the whole batch", async () => {
    const token = await tok("a");
    expectRefused(await call("a", "batch", token, { ops: [{ op: "insert", model: "sec_note", values: { body: "should not stay" } }, { op: "insert", model: "sec_ledger", values: { body: "x" } }] }), ["forbidden_model"]);
    const r = await call("a", "query", token, { model: "sec_note", fields: ["body"] });
    expect(r.json.rows).toEqual([{ body: `note ${CANARY.a} live` }]);
  });
});

describe.skipIf(STUB)("Data API: values are data, never SQL", () => {
  const INJECTIONS = [
    "' or '1'='1", "'; drop table sec_note; --", "x' union select ciphertext from platform.secrets --", `x' union select body from ${ORG.b.prefix}.sec_note --`,
    "$1", "${1}", "\\'; select pg_sleep(10); --", "%' or body like '%", "{{sec_note}}", ":q", "\u0000", "'||(select current_setting('app.settings.jwt_secret'))||'",
  ];

  it.each(INJECTIONS)("a filter value %j is matched as text and finds nothing", async (value) => {
    const r = await call("a", "query", await tok("a"), { model: "sec_note", where: { field: "body", op: "eq", value } });
    expect([200, 400]).toContain(r.status);
    if (r.status === 200) expect(r.json.rows).toEqual([]);
    expect(r.text).not.toMatch(INTERNAL);
  });

  it.each(INJECTIONS)("a named query parameter %j is bound, not spliced", async (value) => {
    const started = Date.now();
    const r = await call("a", "named", await tok("a"), { query: NAMED_QUERY_KEY, params: { q: value } });
    expect([200, 400]).toContain(r.status);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r.text).not.toMatch(INTERNAL);
    expect(holds(r.text, "ciphertext")).toBe(false);
  });

  it("control: the named query returns the caller's own notes for an honest parameter", async () => {
    const r = await call("a", "named", await tok("a"), { query: NAMED_QUERY_KEY, params: { q: "%" } });
    expect(r.status).toBe(200);
    expect(r.json.rows).toEqual([{ body: `note ${CANARY.a} live` }]);
  });

  it("a written value with SQL in it is stored as text", async () => {
    const token = await tok("a");
    const body = "'); drop table sec_note; --";
    const w = await call("a", "batch", token, { ops: [{ op: "insert", model: "sec_note", values: { body } }] });
    expect(w.status).toBe(200);
    const id = (w.json.results as { id: string }[])[0]?.id as string;
    const r = await call("a", "query", token, { model: "sec_note", where: { field: "id", op: "eq", value: id }, fields: ["body"] });
    expect(r.json.rows).toEqual([{ body }]);
    await call("a", "batch", token, { ops: [{ op: "delete", model: "sec_note", id }] });
  });

  it("an unknown named query, parameter or field is refused in plain words", async () => {
    const token = await tok("a");
    expectRefused(await call("a", "named", token, { query: "sec_does_not_exist", params: {} }), ["forbidden_model", "not_found"]);
    expectRefused(await call("a", "named", token, { query: NAMED_QUERY_KEY, params: { q: "%", extra: "x" } }), ["invalid_request"]);
    expectRefused(await call("a", "named", token, { query: NAMED_QUERY_KEY, params: {} }), ["invalid_request"]);
    expectRefused(await call("a", "query", token, { model: "sec_note", fields: ["no_such_field"] }), ["invalid_request", "forbidden_field"]);
    expectRefused(await call("a", "query", token, { model: "sec_note", where: { field: "no_such_field", op: "eq", value: 1 } }), ["invalid_request", "forbidden_field"]);
  });
});

describe.skipIf(STUB)("Data API: cursors and idempotency keys belong to one caller", () => {
  it("a cursor from B's query is refused for A, and a changed cursor is refused", async () => {
    const first = await call("b", "query", await tok("b"), { model: "sec_visit", limit: 1, sort: [{ field: "body" }] });
    const cursor = first.json.nextCursor as string;
    expect(typeof cursor).toBe("string");
    expectRefused(await call("a", "query", await tok("a"), { model: "sec_visit", limit: 1, sort: [{ field: "body" }], cursor }), ["invalid_request"]);
    expectRefused(await call("b", "query", await tok("b"), { model: "sec_note", limit: 1, cursor }), ["invalid_request"]);
    expectRefused(await call("b", "query", await tok("b"), { model: "sec_visit", limit: 1, sort: [{ field: "body", dir: "desc" }], cursor }), ["invalid_request"]);
    const flipped = `${cursor.slice(0, -2)}${cursor.endsWith("AA") ? "BB" : "AA"}`;
    expectRefused(await call("b", "query", await tok("b"), { model: "sec_visit", limit: 1, sort: [{ field: "body" }], cursor: flipped }), ["invalid_request"]);
    expect(cursor).not.toContain(ORG.b.prefix);
  });

  it("the same idempotency key used by A and by B are two different keys", async () => {
    const key = "shared-key-00000001";
    const a = await call("a", "batch", await tok("a"), { idempotencyKey: key, ops: [{ op: "insert", model: "sec_note", values: { body: "from A" } }] });
    const b = await call("b", "batch", await tok("b"), { idempotencyKey: key, ops: [{ op: "insert", model: "sec_note", values: { body: "from B" } }] });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const idA = (a.json.results as { id: string }[])[0]?.id;
    const idB = (b.json.results as { id: string }[])[0]?.id;
    expect(idA).not.toBe(idB);
    // A replay returns A's own first result and writes nothing.
    const again = await call("a", "batch", await tok("a"), { idempotencyKey: key, ops: [{ op: "insert", model: "sec_note", values: { body: "from A" } }] });
    expect((again.json.results as { id: string }[])[0]?.id).toBe(idA);
    await call("a", "batch", await tok("a"), { ops: [{ op: "delete", model: "sec_note", id: idA }] });
    await call("b", "batch", await tok("b"), { ops: [{ op: "delete", model: "sec_note", id: idB }] });
  });
});

describe.skipIf(STUB)("Data API: errors and the audit trail", () => {
  it("a request the database would refuse comes back in plain words, with nothing internal in it", async () => {
    const token = await tok("a");
    const bodies = [
      await call("a", "batch", token, { ops: [{ op: "insert", model: "sec_note", id: A.noteRow, values: { body: "duplicate id" } }] }),
      await call("a", "batch", token, { ops: [{ op: "update", model: "sec_note", id: A.noteRow, values: { body: "x" }, ifUpdatedAt: "2000-01-01T00:00:00.000Z" }] }),
      await call("a", "query", token, { model: "sec_note", where: { field: "body", op: "gt", value: 5 } }),
      await call("a", "query", token, "not an object"),
      await call("a", "query", token, null),
    ];
    for (const r of bodies) {
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
      expect(r.text).not.toMatch(INTERNAL);
    }
  });

  it("a write leaves an audit entry for the caller's restaurant, with no field values in it", async () => {
    const token = await tok("a");
    const marker = `audit-probe-${crypto.randomUUID()}`;
    const w = await call("a", "batch", token, { ops: [{ op: "insert", model: "sec_note", values: { body: marker } }] });
    expect(w.status).toBe(200);
    const id = (w.json.results as { id: string }[])[0]?.id as string;
    const audit = await platform()`select org_id, meta::text as meta from platform.audit_log where org_id = ${ORG.a.uuid} order by at desc limit 5`;
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.every((r) => r.org_id === ORG.a.uuid)).toBe(true);
    expect(holds(audit, marker)).toBe(false);
    await call("a", "batch", token, { ops: [{ op: "delete", model: "sec_note", id }] });
  });

  it("an expired token is refused on a real route", async () => {
    const expired = hmacToken({ ...stamped(appClaims("a")), iat: Math.floor(Date.now() / 1000) - 900, exp: Math.floor(Date.now() / 1000) - 300 }, realSecret());
    expectRefused(await call("a", "query", expired, { model: "sec_note" }), ["unauthenticated"]);
  });

  it("a token for a suspended restaurant is refused on a real route", async () => {
    const token = hmacToken(stamped({ ...appClaims("c"), app: toPublicId("app", A.app), ver: toPublicId("ver", A.appVersion) }), realSecret());
    const r = await call("a", "query", token, { model: "sec_note" });
    expect(r.status).toBe(403);
    expect(r.json.rows).toBeUndefined();
  });
});

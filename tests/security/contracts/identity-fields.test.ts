// Contract level: no request shape accepts a field that names a restaurant, a schema, a role, a user
// or an environment, at any depth. packages/contracts/src/contracts.test.ts checks one field on the
// top level of each request. This walks every object inside a full example of every request.
import { describe, expect, it } from "vitest";
import * as contracts from "@rms/contracts";

const hex = "a".repeat(32);
const uuid = "0193a3c0-9191-7000-8000-000000000001";

/** Field names that would let a caller say who they are or where to look. */
const IDENTITY_KEYS = [
  "org", "orgId", "org_id", "organization", "organizationId", "restaurant", "restaurantId", "tenant", "tenantId",
  "schema", "schemaName", "storePrefix", "store_prefix", "store", "database",
  "role", "roles", "userRole", "env", "environment", "user", "userId", "user_id", "sub", "actor",
  "locations", "loc", "locationScope", "token", "claims", "sql", "raw", "__proto__", "constructor",
];

type Sample = {
  schema: { safeParse: (v: unknown) => { success: boolean } };
  value: unknown;
  /** Keys that are legitimately part of this shape and so are not attacks on it. */
  allowed?: string[];
  /** Paths (dot-joined) of open maps whose keys are field or parameter names, checked separately below. */
  openMaps?: string[];
};

const c = contracts;
const SAMPLES: Record<string, Sample> = {
  QueryRequest: {
    schema: c.QueryRequest,
    value: {
      model: "sec_note", fields: ["body"], limit: 10, includeDeleted: false, cursor: "abc",
      where: { and: [{ field: "body", op: "eq", value: "x" }, { not: { or: [{ field: "body", op: "in", value: ["a", "b"] }, { field: "body", op: "between", value: [1, 2] }, { field: "body", op: "is_null", value: false }] } }] },
      sort: [{ field: "body", dir: "asc" }],
      totals: { groupBy: ["body"], aggregates: [{ fn: "count", as: "n" }, { fn: "sum", field: "wage", as: "total" }] },
    },
  },
  BatchRequest: {
    schema: c.BatchRequest,
    value: {
      idempotencyKey: "key-12345678",
      ops: [
        { op: "insert", model: "sec_note", id: uuid, values: { body: "x", location_id: uuid, currency: "USD" } },
        { op: "update", model: "sec_note", id: uuid, values: { body: "y" }, ifUpdatedAt: "2026-11-21T10:00:00.000Z" },
        { op: "delete", model: "sec_note", id: uuid },
        { op: "upsert_by_source", model: "sec_note", sourceId: "pos-1", values: { body: "z" } },
      ],
    },
    openMaps: ["ops.0.values", "ops.1.values", "ops.3.values"],
  },
  NamedQueryRequest: { schema: c.NamedQueryRequest, value: { query: "sec_note_search", params: { q: "%" }, limit: 10 }, openMaps: ["params"] },
  NamedActionRequest: { schema: c.NamedActionRequest, value: { action: "post_sales_day", params: { day: "2026-11-15" } }, openMaps: ["params"] },
  AskQueryToolInput: { schema: c.AskQueryToolInput, value: { sql: "select 1", purpose: "count rows" }, allowed: ["sql"] },
  StartRunRequest: { schema: c.StartRunRequest, value: { mode: "ask", text: "How were sales last week?", sessionId: `ses_${hex}`, appId: `app_${hex}` } },
  "StartRunRequest (reply)": { schema: c.StartRunRequest, value: { mode: "build", reply: { kind: "choose", to: "q1", choice: "build_anyway", ref: "x" } } },
  "RunReply (answer)": { schema: c.RunReply, value: { kind: "answer", to: "q1", text: "yes" } },
  "RunReply (confirm)": { schema: c.RunReply, value: { kind: "confirm", to: "q1", ok: true } },
  OnboardingAnswers: { schema: c.OnboardingAnswers, value: { restaurantName: "Alder House", serviceStyle: "full_service", cuisine: "Grill", locationCount: 2, systemsUsed: ["Demo POS"] } },
  // Wave 2 (contracts 0.4.0). The same examples as WAVE2_SAMPLES in packages/contracts/src/wave2.test.ts.
  CatalogLookupInput: { schema: c.CatalogLookupInput, value: { kind: "models", search: "vendors", name: "vendor" } },
  ProposeModelChangesInput: {
    schema: c.ProposeModelChangesInput,
    value: { why: "To keep a list of suppliers.", changes: [{ op: "use_template", template: "vendor" }, { op: "add_field", model: "x_notes", field: { key: "extra", label: "Extra", type: "text" } }] },
  },
  "RunGeneratorInput (list)": { schema: c.RunGeneratorInput, value: { generator: "list_detail", screen: "vendors", title: "Vendors", model: "vendor", fields: ["name"], form: true } },
  "RunGeneratorInput (dashboard)": {
    schema: c.RunGeneratorInput,
    value: { generator: "dashboard", screen: "money", title: "Money", query: "weekly_pnl", stats: [{ label: "Sales", column: "net_sales", format: "money" }], chart: { label: "By day", category: "day", value: "net_sales", format: "money" } },
  },
  CheckInput: { schema: c.CheckInput, value: { only: ["locked", "types"] } },
  "ConnectRequest (catalog)": { schema: c.ConnectRequest, value: { kind: "catalog", key: "demo_pos" } },
  // `token` here is the connected system's own token, typed by the owner. It is a legitimate key of this one shape.
  "ConnectRequest (custom)": { schema: c.ConnectRequest, value: { kind: "custom", name: "My POS", url: "https://pos.example.com/mcp", token: "a-long-token-value" }, allowed: ["token"] },
  ApproveToolsRequest: { schema: c.ApproveToolsRequest, value: { tools: ["get_daily_sales"] } },
  SyncRequest: { schema: c.SyncRequest, value: { from: "2026-09-21", to: "2026-11-15" } },
  DemoPosRangeInput: { schema: c.DemoPosRangeInput, value: { from: "2026-11-09", to: "2026-11-15", location: "downtown" } },
  DemoPosNoInput: { schema: c.DemoPosNoInput, value: {} },
  AskRequest: { schema: c.AskRequest, value: { sessionId: `ses_${hex}`, text: "What was my prime cost last week?" } },
  DuplicateCheckRequest: { schema: c.DuplicateCheckRequest, value: { text: "I want to see how much money I am making" } },
  // Sent by agent-written code in a frame. `body` is passed on untouched and checked by the Data API's own shapes above.
  "FrameToShell (ready)": { schema: c.FrameToShell, value: { rms: 1, type: "rms.ready" } },
  "FrameToShell (data)": { schema: c.FrameToShell, value: { rms: 1, type: "rms.data", id: "req_00000001", route: "query", body: {} }, openMaps: ["body"] },
  // Not requests from a browser, but written by the build agent, which is just as untrusted.
  AppManifest: {
    schema: c.AppManifest,
    value: {
      name: "Tracker", description: "x", slots: [{ type: "nav", label: "Tracker" }, { type: "dashboard-widget", component: "Summary" }],
      models: [{ use: "sec_note", access: "write" }, { use: "parent.staff", access: "read" }], namedQueries: ["sec_note_search"], actions: [], tools: [],
      connections: [{ id: "demo_pos", tools: ["list_sales"], access: "read" }], jobs: [{ name: "nightly", cron: "0 5 * * *", run: { kind: "query", key: "sec_note_search" } }],
    },
  },
  "ModelChange (custom model)": {
    schema: c.ModelChange,
    value: {
      op: "create_custom_model",
      definition: {
        key: "notes", pack: "custom", version: 1, name: "Notes", description: "Plain notes the owner keeps.",
        fields: [{ key: "body", label: "Body", type: "text" }, { key: "amount", label: "Amount", type: "money", sensitivity: "financial", readableBy: ["owner"] }],
        defaultAccess: { owner: "write", staff: "read" },
        rules: [{ kind: "check", name: "body_set", expr: { op: "ne", args: [{ field: "body" }, { lit: "" }] }, message: "Write something." }],
      },
    },
    // In a model definition `readableBy` is a list of roles on a FIELD: a legitimate key. Role fields elsewhere are not.
  },
  "ModelChange (add field)": { schema: c.ModelChange, value: { op: "add_field", model: "notes", field: { key: "extra", label: "Extra", type: "text" } } },
  AppTokenClaims: { schema: c.AppTokenClaims, value: { iss: "rms", iat: 1, exp: 2, jti: "12345678", org: `org_${hex}`, sub: `usr_${hex}`, app: `app_${hex}`, ver: `ver_${hex}`, role: "owner", loc: "all", kind: "app", aud: "data", env: "live" }, allowed: ["org", "sub", "role", "loc", "env"] },
  RunTokenClaims: { schema: c.RunTokenClaims, value: { iss: "rms", iat: 1, exp: 2, jti: "12345678", org: `org_${hex}`, sub: `usr_${hex}`, app: `app_${hex}`, run: `run_${hex}`, role: "owner", loc: "all", kind: "run", aud: "data", env: "draft" }, allowed: ["org", "sub", "role", "loc", "env"] },
  ConnectionTokenClaims: { schema: c.ConnectionTokenClaims, value: { iss: "rms", iat: 1, exp: 2, jti: "12345678", org: `org_${hex}`, kind: "connection", aud: "mcp", connection: `con_${hex}` }, allowed: ["org"] },
  // Wave 3: what an owner or a maintainer sends to publish, confirm, decide, share and install.
  PublishRequest: { schema: c.PublishRequest, value: { confirm: true } },
  RollbackRequest: { schema: c.RollbackRequest, value: { confirm: true } },
  ConfirmChangeRequest: { schema: c.ConfirmChangeRequest, value: { confirm: true } },
  DecideChangeRequest: { schema: c.DecideChangeRequest, value: { decision: "approve", note: "Looks fine." } },
  ShareRequest: { schema: c.ShareRequest, value: { title: "Money at a glance", summary: "Shows sales, costs and what is left each week.", category: "money", confirm: true } },
  InstallRequest: { schema: c.InstallRequest, value: { confirm: true } },
  PublicListing: { schema: c.PublicListing, value: { id: `lst_${hex}`, title: "t", summary: "s", category: "c", requiredModels: ["sec_note"], requiredConnections: [], installCount: 0 } },
};

/** Every plain object inside `value`, with its path. */
const objectsIn = (value: unknown, path: string[] = []): { path: string[]; node: Record<string, unknown> }[] => {
  if (Array.isArray(value)) return value.flatMap((v, i) => objectsIn(v, [...path, String(i)]));
  if (value === null || typeof value !== "object") return [];
  const node = value as Record<string, unknown>;
  return [{ path, node }, ...Object.entries(node).flatMap(([k, v]) => objectsIn(v, [...path, k]))];
};

const withKeyAt = (value: unknown, path: string[], key: string, injected: unknown): unknown => {
  const copy = structuredClone(value);
  let node = copy as Record<string, unknown>;
  for (const p of path) node = node[p] as Record<string, unknown>;
  Object.defineProperty(node, key, { value: injected, enumerable: true, writable: true, configurable: true });
  return copy;
};

describe("every example is valid to begin with (otherwise a rejection below would prove nothing)", () => {
  it.each(Object.entries(SAMPLES))("%s", (_name, sample) => {
    expect(sample.schema.safeParse(sample.value).success).toBe(true);
  });
});

describe("no request shape accepts an identity field, at any depth", () => {
  it.each(Object.entries(SAMPLES))("%s", (_name, sample) => {
    const open = new Set(sample.openMaps ?? []);
    let attempts = 0;
    for (const { path, node } of objectsIn(sample.value)) {
      if (open.has(path.join("."))) continue;
      for (const key of IDENTITY_KEYS) {
        if (key in node && Object.hasOwn(node, key)) continue; // already a real field of this shape
        if (path.length === 0 && sample.allowed?.includes(key)) continue;
        for (const injected of ["x", `org_${hex}`, "o_000000000000", { id: `org_${hex}` }]) {
          const result = sample.schema.safeParse(withKeyAt(sample.value, path, key, injected));
          expect(result.success, `${key} at /${path.join("/")}`).toBe(false);
          attempts++;
        }
      }
    }
    expect(attempts).toBeGreaterThan(50);
  });

  it("covers every request, input, reply and answers shape the contracts package exports", () => {
    // A new request shape must get an example above before this suite passes again.
    const exported = Object.entries(contracts)
      .filter(([name, v]) => /(Request|Input|Reply|Answers)$/.test(name) && typeof (v as { safeParse?: unknown }).safeParse === "function")
      .map(([name]) => name);
    const covered = new Set(Object.keys(SAMPLES).map((k) => k.replace(/ \(.*\)$/, "")));
    expect(exported.filter((name) => !covered.has(name))).toEqual([]);
    expect(exported.length).toBeGreaterThanOrEqual(7);
  });
});

describe("the only open maps are field values and parameters, and their keys must be plain names", () => {
  const hostileKeys = ["org-id", "Org", "o_000000000000.sec_note", "platform.organizations", "body; drop table x", 'body"', "body--", "", " body", "bödy", "a".repeat(49), "1body", "body.sub", "$1", "*"];

  it("a write cannot use a key that is not a plain field name", () => {
    for (const key of hostileKeys) {
      expect(c.BatchRequest.safeParse({ ops: [{ op: "insert", model: "sec_note", values: { [key]: "x" } }] }).success, key).toBe(false);
    }
  });

  it("a named query or action cannot use a parameter that is not a plain name, or a value that is not a simple value", () => {
    for (const key of hostileKeys) {
      expect(c.NamedQueryRequest.safeParse({ query: "sec_note_search", params: { [key]: "x" } }).success, key).toBe(false);
      expect(c.NamedActionRequest.safeParse({ action: "post_sales_day", params: { [key]: "x" } }).success, key).toBe(false);
    }
    for (const value of [{ org: "x" }, ["a"], { raw: "select 1" }]) {
      expect(c.NamedQueryRequest.safeParse({ query: "sec_note_search", params: { q: value } }).success).toBe(false);
    }
  });

  it("a write cannot set a field the server owns", () => {
    for (const key of ["id", "source", "source_id", "created_at", "created_by", "updated_at", "updated_by", "deleted_at"]) {
      for (const op of [{ op: "insert", model: "sec_note" }, { op: "update", model: "sec_note", id: uuid }, { op: "upsert_by_source", model: "sec_note", sourceId: "s" }]) {
        expect(c.BatchRequest.safeParse({ ops: [{ ...op, values: { [key]: "x" } }] }).success, `${op.op} ${key}`).toBe(false);
      }
    }
  });

  it("NOTE for the Data API: plain names such as org_id, role and env DO pass as value keys and parameter names", () => {
    // By design: a model may have a field called "role". So the wire shape cannot refuse these keys. The Data API must,
    // by checking every key against the model definition (unknown field) and every parameter against the named query.
    // tests/security/data-api has the tests for that.
    for (const key of ["org_id", "role", "env", "schema", "tenant"]) {
      expect(c.BatchRequest.safeParse({ ops: [{ op: "insert", model: "sec_note", values: { [key]: "x" } }] }).success, key).toBe(true);
      expect(c.NamedQueryRequest.safeParse({ query: "sec_note_search", params: { [key]: "x" } }).success, key).toBe(true);
    }
  });
});

describe("a request cannot name a table outside the caller's models by its spelling", () => {
  const qualified = ["o_000000000000.sec_note", "platform.organizations", "auth.users", "pg_catalog.pg_class", "information_schema.tables", "parent.secrets", "parent.staff.x", "public.sec_note", '"sec_note"', "sec_note; drop table x", "sec_note--", "Sec_Note", "sec note", "", "sec_note\u0000", "../sec_note", "parent.", ".sec_note"];

  it.each(qualified)("model %j is refused on reads, writes, filters, sorts and totals", (name) => {
    expect(c.QueryRequest.safeParse({ model: name }).success).toBe(false);
    expect(c.BatchRequest.safeParse({ ops: [{ op: "insert", model: name, values: {} }] }).success).toBe(false);
    expect(c.BatchRequest.safeParse({ ops: [{ op: "delete", model: name, id: uuid }] }).success).toBe(false);
    expect(c.QueryRequest.safeParse({ model: "sec_note", fields: [name] }).success).toBe(false);
    expect(c.QueryRequest.safeParse({ model: "sec_note", where: { field: name, op: "eq", value: 1 } }).success).toBe(false);
    expect(c.QueryRequest.safeParse({ model: "sec_note", sort: [{ field: name }] }).success).toBe(false);
    expect(c.QueryRequest.safeParse({ model: "sec_note", totals: { aggregates: [{ fn: "sum", field: name, as: "t" }] } }).success).toBe(false);
    expect(c.QueryRequest.safeParse({ model: "sec_note", totals: { groupBy: [name], aggregates: [{ fn: "count", as: "n" }] } }).success).toBe(false);
    expect(c.QueryRequest.safeParse({ model: "sec_note", totals: { aggregates: [{ fn: "count", as: name }] } }).success).toBe(false);
    expect(c.NamedQueryRequest.safeParse({ query: name }).success).toBe(false);
    expect(c.NamedActionRequest.safeParse({ action: name }).success).toBe(false);
    expect(c.AppManifest.safeParse({ name: "X", models: [{ use: name, access: "read" }] }).success).toBe(false);
  });

  it("parent data cannot be written, by any op or in any manifest", () => {
    for (const key of c.ParentModelKey.options) {
      for (const op of [{ op: "insert", values: {} }, { op: "update", id: uuid, values: {} }, { op: "delete", id: uuid }, { op: "upsert_by_source", sourceId: "s", values: {} }]) {
        expect(c.BatchRequest.safeParse({ ops: [{ ...op, model: `parent.${key}` }] }).success, `${op.op} parent.${key}`).toBe(false);
      }
      expect(c.AppManifest.safeParse({ name: "X", models: [{ use: `parent.${key}`, access: "write" }] }).success, key).toBe(false);
    }
  });

  it("NOTE for the Data API: a bare name that happens to be a schema or another store's prefix DOES pass the shape", () => {
    // "platform", "auth", "pg_catalog" and "o_919191919b01" are plain names, so the wire shape accepts them as model keys.
    // The Data API must refuse them because they are not in the mini-app's manifest. tests/security/data-api checks it.
    for (const name of ["platform", "auth", "pg_catalog", "information_schema", "o_919191919b01", "o_919191919b01_parent"]) {
      expect(c.QueryRequest.safeParse({ model: name }).success, name).toBe(true);
    }
  });
});

describe("request sizes are bounded", () => {
  it("page size, batch size, sort keys, filter width and depth, text length", () => {
    const leaf = { field: "body", op: "eq", value: 1 };
    const no = (schema: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) => expect(schema.safeParse(v).success).toBe(false);
    no(c.QueryRequest, { model: "sec_note", limit: c.MAX_PAGE + 1 });
    no(c.QueryRequest, { model: "sec_note", limit: 0 });
    no(c.QueryRequest, { model: "sec_note", limit: -1 });
    no(c.QueryRequest, { model: "sec_note", limit: 1.5 });
    no(c.QueryRequest, { model: "sec_note", limit: "50" });
    no(c.QueryRequest, { model: "sec_note", fields: Array.from({ length: 101 }, () => "body") });
    no(c.QueryRequest, { model: "sec_note", sort: Array.from({ length: 6 }, () => ({ field: "body" })) });
    no(c.QueryRequest, { model: "sec_note", where: { and: Array.from({ length: 21 }, () => leaf) } });
    no(c.QueryRequest, { model: "sec_note", where: { field: "body", op: "in", value: Array.from({ length: 201 }, (_, i) => i) } });
    no(c.QueryRequest, { model: "sec_note", where: { field: "body", op: "eq", value: "x".repeat(2001) } });
    no(c.QueryRequest, { model: "sec_note", cursor: "x".repeat(1025) });
    no(c.QueryRequest, { model: "sec_note", totals: { aggregates: Array.from({ length: 11 }, () => ({ fn: "count", as: "n" })) } });
    no(c.BatchRequest, { ops: [] });
    no(c.BatchRequest, { ops: Array.from({ length: c.MAX_BATCH + 1 }, () => ({ op: "delete", model: "sec_note", id: uuid })) });
    no(c.BatchRequest, { ops: [{ op: "delete", model: "sec_note", id: uuid }], idempotencyKey: "short" });
    no(c.NamedQueryRequest, { query: "sec_note_search", limit: 5001 });
    no(c.AskQueryToolInput, { sql: "x".repeat(8001), purpose: "p" });
    no(c.AskQueryToolInput, { sql: "", purpose: "p" });
    let deep: unknown = leaf;
    for (let i = 0; i < c.MAX_FILTER_DEPTH + 12; i++) deep = { not: deep };
    no(c.QueryRequest, { model: "sec_note", where: deep });
  });

  it("an unknown filter operator or aggregate is refused", () => {
    for (const op of ["like", "regex", "raw", "sql", "~", "=", "or 1=1"]) expect(c.QueryRequest.safeParse({ model: "sec_note", where: { field: "body", op, value: "x" } }).success, op).toBe(false);
    for (const fn of ["string_agg", "array_agg", "pg_sleep", "count(*)", "raw"]) expect(c.QueryRequest.safeParse({ model: "sec_note", totals: { aggregates: [{ fn, as: "n" }] } }).success, fn).toBe(false);
  });
});

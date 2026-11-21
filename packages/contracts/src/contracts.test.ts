import { describe, expect, it } from "vitest";
import * as c from "./index.js";

const ok = (r: { success: boolean }) => expect(r.success).toBe(true);
const no = (r: { success: boolean }) => expect(r.success).toBe(false);
const hex = "a".repeat(32);
const f = (key: string, extra: object = {}) => ({ key, label: key, type: "text", ...extra });
const custom = { key: "notes", pack: "custom", version: 1, name: "Notes", description: "Plain notes the owner keeps.", fields: [f("body")], defaultAccess: { owner: "write", staff: "read" } };
const claims = { iss: "rms", iat: 1, exp: 2, jti: "12345678", org: `org_${hex}`, sub: `usr_${hex}`, app: `app_${hex}`, role: "owner", loc: "all" };

describe("no request can name a restaurant", () => {
  it("rejects unknown keys on every Data API request", () => {
    no(c.QueryRequest.safeParse({ model: "sales_day", org: "x" }));
    no(c.QueryRequest.safeParse({ model: "sales_day", schema: "o_000000000000" }));
    no(c.BatchRequest.safeParse({ ops: [{ op: "delete", model: "vendor", id: "0193a3c0-0000-7000-8000-000000000001" }], orgId: "x" }));
    no(c.NamedQueryRequest.safeParse({ query: "prime_cost", role: "owner" }));
    no(c.NamedActionRequest.safeParse({ action: "post_sales_day", env: "live" }));
    no(c.AskQueryToolInput.safeParse({ sql: "select 1", purpose: "p", org: "x" }));
  });
  it("only accepts a well-formed store prefix", () => {
    ok(c.StorePrefix.safeParse("o_0123456789ab"));
    no(c.StorePrefix.safeParse("o_0123456789ab; drop schema platform"));
    no(c.StorePrefix.safeParse("platform"));
  });
});

describe("tokens", () => {
  it("a run token can only be draft", () => {
    no(c.RunTokenClaims.safeParse({ ...claims, kind: "run", aud: "data", run: `run_${hex}`, env: "live" }));
    ok(c.RunTokenClaims.safeParse({ ...claims, kind: "run", aud: "data", run: `run_${hex}`, env: "draft" }));
  });
  it("an app token needs a version and takes no extra claims", () => {
    no(c.AppTokenClaims.safeParse({ ...claims, kind: "app", aud: "data", env: "live" }));
    no(c.AppTokenClaims.safeParse({ ...claims, kind: "app", aud: "data", env: "live", ver: `ver_${hex}`, storePrefix: "o_000000000000" }));
    no(c.AppTokenClaims.safeParse({ ...claims, kind: "app", aud: "data", env: "draft", ver: `ver_${hex}` }));
    ok(c.AppTokenClaims.safeParse({ ...claims, kind: "app", aud: "data", env: "live", ver: `ver_${hex}` }));
  });
  it("a connection token is not a data token", () => {
    no(c.DataTokenClaims.safeParse({ ...claims, kind: "connection", aud: "mcp", connection: `con_${hex}` }));
  });
});

describe("parent data is read-only", () => {
  it("cannot be written through a batch or granted write in a manifest", () => {
    no(c.BatchRequest.safeParse({ ops: [{ op: "insert", model: "parent.staff", values: {} }] }));
    no(c.AppManifest.safeParse({ name: "X", models: [{ use: "parent.staff", access: "write" }] }));
    ok(c.AppManifest.safeParse({ name: "X", models: [{ use: "parent.staff", access: "read" }] }));
  });
  it("can be read, but only known parent models", () => {
    ok(c.QueryRequest.safeParse({ model: "parent.staff" }));
    no(c.QueryRequest.safeParse({ model: "parent.payroll_secrets" }));
  });
});

describe("model definitions cannot carry SQL", () => {
  it("accepts a plain custom model", () => ok(c.CustomModelDefinition.safeParse(custom)));
  it("rejects a raw SQL string where an expression tree is expected", () => {
    no(c.CustomModelDefinition.safeParse({ ...custom, rules: [{ kind: "check", name: "x", expr: "true)); drop schema platform cascade; --", message: "m" }] }));
    ok(c.CustomModelDefinition.safeParse({ ...custom, rules: [{ kind: "check", name: "x", expr: { op: "ne", args: [{ field: "body" }, { lit: "" }] }, message: "m" }] }));
  });
  it("keeps agent-made models in the custom pack with check rules only", () => {
    no(c.CustomModelDefinition.safeParse({ ...custom, pack: "finance" }));
    no(c.CustomModelDefinition.safeParse({ ...custom, rules: [{ kind: "balanced", name: "x", lineModel: "a", lineRef: "b", debit: "d", credit: "e" }] }));
  });
  it("rejects system fields, duplicates and unit-column collisions", () => {
    no(c.CustomModelDefinition.safeParse({ ...custom, fields: [f("deleted_at")] }));
    no(c.CustomModelDefinition.safeParse({ ...custom, fields: [f("location_id")] }));
    no(c.CustomModelDefinition.safeParse({ ...custom, fields: [f("a"), f("a")] }));
    no(c.CustomModelDefinition.safeParse({ ...custom, fields: [{ key: "qty", label: "q", type: "quantity" }, f("qty_unit")] }));
  });
  it("rejects identifiers that are not plain", () => {
    no(c.CustomModelDefinition.safeParse({ ...custom, key: 'notes"; drop table x; --' }));
    no(c.CustomModelDefinition.safeParse({ ...custom, fields: [f("Body")] }));
  });
});

describe("request shapes are bounded", () => {
  it("rejects a filter nested 3000 deep without overflowing the stack", () => {
    let deep: unknown = { field: "a", op: "eq", value: 1 };
    for (let i = 0; i < 3000; i++) deep = { not: deep };
    no(c.QueryRequest.safeParse({ model: "sales_day", where: deep }));
  });
  it("checks the value shape for each filter op", () => {
    no(c.QueryRequest.safeParse({ model: "sales_day", where: { field: "a", op: "between", value: 3 } }));
    no(c.QueryRequest.safeParse({ model: "sales_day", where: { field: "a", op: "eq" } }));
    ok(c.QueryRequest.safeParse({ model: "sales_day", where: { field: "a", op: "between", value: ["2026-11-09", "2026-11-15"] } }));
  });
  it("does not let a caller set server-owned fields", () => {
    for (const k of ["id", "source", "source_id", "created_by", "created_at", "updated_by", "updated_at", "deleted_at"]) {
      no(c.BatchRequest.safeParse({ ops: [{ op: "insert", model: "vendor", values: { [k]: "x" } }] }));
    }
    ok(c.BatchRequest.safeParse({ ops: [{ op: "insert", model: "vendor", values: { name: "x", location_id: "0193a3c0-0000-7000-8000-000000000001" } }] }));
  });
});

describe("governance and marketplace", () => {
  it("a listing cannot carry a publisher or free-text model names", () => {
    const listing = { id: `lst_${hex}`, title: "t", summary: "s", category: "c", requiredModels: [], requiredConnections: [], installCount: 0 };
    ok(c.PublicListing.safeParse(listing));
    no(c.PublicListing.safeParse({ ...listing, publisherOrgId: `org_${hex}` }));
    no(c.PublicListing.safeParse({ ...listing, requiredModels: ["Marigold Kitchen vendors"] }));
  });
  it("the tier always matches the signals", () => {
    expect(c.tierForSignals([])).toBe("T0");
    expect(c.tierForSignals(["screen_change", "first_publish"])).toBe("T2");
    expect(c.tierForSignals(["first_publish", "public_share"])).toBe("T3");
    const now = new Date().toISOString();
    no(c.ChangeSet.safeParse({ id: `chg_${hex}`, orgId: `org_${hex}`, appId: null, origin: "share", signals: ["public_share"], tier: "T1", summary: "s", decision: "applied", createdAt: now, decidedAt: null }));
  });
});

describe("ids", () => {
  it("round-trips between public ids and uuids", () => {
    const u = "0193a3c0-1234-7abc-8def-000000000001";
    expect(c.toUuid(c.toPublicId("org", u))).toBe(u);
    expect(() => c.toUuid("org_nothex")).toThrow();
  });
});

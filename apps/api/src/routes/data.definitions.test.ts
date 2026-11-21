// The Data API checks a request against the model as it is in the token's environment.
//
// A restaurant's draft tables can be ahead of live (a build added a field that is not published
// yet). A published mini-app must keep working, and must not see the new field, until the change
// goes live. This test uses the real path end to end: a seeded restaurant, tables made by the
// model compiler, a change applied with `applyChange`, and requests through the HTTP routes
// with real tokens.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mintAppToken, mintRunToken } from "@rms/auth";
import { type AppManifestInput, DATA_ROUTES, toPublicId } from "@rms/contracts";
import { adminDb, closeAll, newUuid } from "@rms/db";
import { requireTestEnv } from "@rms/db/testing";
import { LIBRARY, applyChange, ensureModels, publishModelChanges } from "@rms/models";
import { createDemoRestaurant, removeRestaurants } from "@rms/seed";
import app from "../index.js";

requireTestEnv("DATABASE_URL", "DATABASE_ADMIN_URL", "RMS_TOKEN_SECRET");

// Integration test ids: uuid suffix d0 to df, store prefixes o_d1d1d1d1d1xx.
const ORG = "0193a3c0-0000-7000-8000-0000000000d1";
const PREFIX = "o_d1d1d1d1d101";
const OWNER = "0193a3c0-0000-7000-8000-0000000000d2";
const APP = newUuid();
const VER_LIVE = newUuid();
const VER_DRAFT = newUuid();
const SESSION = newUuid();
const RUN = newUuid();
const library = { models: LIBRARY.models };

const MANIFEST: AppManifestInput = { name: "Vendor list", models: [{ use: "vendor", access: "write" }] };

type Reply = { status: number; body: any };
const call = async (route: keyof typeof DATA_ROUTES, token: string, body: unknown): Promise<Reply> => {
  const res = await app.request(DATA_ROUTES[route], { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const ok = (r: Reply) => {
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
};
const fieldsOf = (catalog: any): string[] => catalog.models.find((m: any) => m.ref === "vendor").fields.map((f: any) => f.key);

describe("a field that is only in draft", () => {
  let live = "";
  let draft = "";

  beforeAll(async () => {
    const sql = adminDb();
    await removeRestaurants(sql, [ORG]);
    await createDemoRestaurant(sql, { template: "slice_yard", orgUuid: ORG, storePrefix: PREFIX });
    await ensureModels(sql, ORG, ["vendor"], { library });

    await sql.begin(async (tx) => {
      await tx`insert into platform.apps (id, org_id, slug, number, name, status) values (${APP}, ${ORG}, 'vendor-list', 1, 'Vendor list', 'published')`;
      await tx`insert into platform.app_versions (id, app_id, org_id, number, manifest, status) values (${VER_LIVE}, ${APP}, ${ORG}, 1, ${JSON.stringify(MANIFEST)}::text::jsonb, 'published')`;
      await tx`insert into platform.app_versions (id, app_id, org_id, number, manifest, status) values (${VER_DRAFT}, ${APP}, ${ORG}, 2, ${JSON.stringify(MANIFEST)}::text::jsonb, 'draft')`;
      await tx`update platform.apps set current_version_id = ${VER_DRAFT}, published_version_id = ${VER_LIVE} where id = ${APP}`;
      await tx`insert into platform.agent_sessions (id, org_id, user_id, app_id, mode, model) values (${SESSION}, ${ORG}, ${OWNER}, ${APP}, 'build', 'integration-test')`;
      await tx`insert into platform.agent_runs (id, session_id, org_id, status) values (${RUN}, ${SESSION}, ${ORG}, 'running')`;
    });

    const who = { org: toPublicId("org", ORG), sub: toPublicId("usr", OWNER), app: toPublicId("app", APP), role: "owner" as const, loc: "all" as const, aud: "data" as const };
    live = await mintAppToken({ ...who, kind: "app", ver: toPublicId("ver", VER_LIVE), env: "live" });
    draft = await mintRunToken({ ...who, kind: "run", run: toPublicId("run", RUN), env: "draft" });

    ok(await call("batch", live, { ops: [{ op: "insert", model: "vendor", values: { name: "Pellbrook Beverage Supply", active: true } }] }));
    // The build adds a field. It lands in the draft tables only.
    const change = await applyChange(sql, ORG, { op: "add_field", model: "vendor", field: { key: "delivery_day", label: "Delivery day", type: "text", maxLength: 20, required: false } }, { library });
    expect([change.appliedDraft, change.appliedLive]).toEqual([true, false]);
  }, 120_000);

  afterAll(async () => {
    await removeRestaurants(adminDb(), [ORG]);
    await closeAll();
  }, 60_000);

  it("the published mini-app still reads its rows, without the new field", async () => {
    const res = ok(await call("query", live, { model: "vendor" }));
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].name).toBe("Pellbrook Beverage Supply");
    expect(Object.keys(res.rows[0])).not.toContain("delivery_day");
    expect(fieldsOf(ok(await call("catalog", live, {})))).not.toContain("delivery_day");
  });

  it("the published mini-app can still write, and is told plainly that the new field does not exist", async () => {
    ok(await call("batch", live, { ops: [{ op: "insert", model: "vendor", values: { name: "Tidewell Paper and Cleaning", active: true } }] }));
    for (const r of [
      await call("query", live, { model: "vendor", fields: ["name", "delivery_day"] }),
      await call("query", live, { model: "vendor", where: { field: "delivery_day", op: "eq", value: "Tuesday" } }),
      await call("query", live, { model: "vendor", sort: [{ field: "delivery_day" }] }),
      await call("batch", live, { ops: [{ op: "insert", model: "vendor", values: { name: "Quillfield Flour and Dairy", active: true, delivery_day: "Tuesday" } }] }),
    ]) {
      // Not "internal": the request names something this version of the mini-app does not have.
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      expect(r.body.error.code).toBe("invalid_request");
    }
    expect(ok(await call("query", live, { model: "vendor" })).rows).toHaveLength(2);
  });

  it("the build and its preview see and use the new field", async () => {
    expect(fieldsOf(ok(await call("catalog", draft, {})))).toContain("delivery_day");
    ok(await call("batch", draft, { ops: [{ op: "insert", model: "vendor", values: { name: "Lanterbury Greengrocers Co-op", active: true, delivery_day: "Tuesday" } }] }));
    const res = ok(await call("query", draft, { model: "vendor", where: { field: "delivery_day", op: "eq", value: "Tuesday" } }));
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].delivery_day).toBe("Tuesday");
  });

  it("once the change is published, the live mini-app has the field too", async () => {
    expect(await publishModelChanges(adminDb(), ORG, ["vendor"], { library })).toEqual(["vendor"]);
    expect(fieldsOf(ok(await call("catalog", live, {})))).toContain("delivery_day");
    const res = ok(await call("query", live, { model: "vendor", sort: [{ field: "name" }] }));
    expect(res.rows).toHaveLength(2);
    expect(res.rows[0]).toHaveProperty("delivery_day", null);
    ok(await call("batch", live, { ops: [{ op: "insert", model: "vendor", values: { name: "Quillfield Flour and Dairy", active: true, delivery_day: "Friday" } }] }));
  });
});

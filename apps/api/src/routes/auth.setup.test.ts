// A new sign-up gets a restaurant that is ready to use: its parent data, the library tables,
// a chart of accounts and a fiscal calendar (no sales yet), and a line in the maintainer feed.
// If that extra set-up fails, the owner still has their restaurant and still lands in RMS.
//
// Real sign-in users against the local sign-in service, the real `createDemoRestaurant` and the
// real set-up. Every restaurant and user made here is removed again. The demo restaurants are
// never touched.
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type TenantContext, toPublicId, toUuid } from "@rms/contracts";
import { adminDb, closeAll, withStore } from "@rms/db";
import { requireTestEnv } from "@rms/db/testing";
import { listFeed } from "@rms/governance";
import { LIBRARY } from "@rms/models";
import { createDemoRestaurant, installPlatformLibrary, removeRestaurants } from "@rms/seed";
import { type SetUpRestaurant, createAuthRoutes, setUpNewRestaurant } from "./auth.js";
import { parentRoutes } from "./parent.js";

requireTestEnv("DATABASE_URL", "DATABASE_ADMIN_URL", "SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY");
const env = process.env;
// The shared database holds other restaurants too. This file is not about the cap.
env.RMS_MAX_RESTAURANTS = "1000000";

type TestUser = { id: string; token: string };
const users: TestUser[] = [];
const randomHex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");

const signUp = async (): Promise<TestUser> => {
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY as string, "content-type": "application/json" },
    body: JSON.stringify({ email: `setup-${randomHex(6)}@integ.rms.test`, password: `Pw-${randomHex(16)}` }),
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

const appWith = (setUpRestaurant: SetUpRestaurant | undefined) =>
  new Hono().route("/auth", createAuthRoutes({ createDemoRestaurant, ...(setUpRestaurant ? { setUpRestaurant } : {}) })).route("/auth", parentRoutes);

const ANSWERS = { restaurantName: "Corner Slice (set-up test)", serviceStyle: "counter_service", cuisine: "Pizza", locationCount: 1, systemsUsed: [] };

const onboard = async (app: Hono, user: TestUser) => {
  const res = await app.request("/auth/onboarding", { method: "POST", headers: { authorization: `Bearer ${user.token}`, "content-type": "application/json" }, body: JSON.stringify(ANSWERS) });
  return { status: res.status, body: (await res.json()) as any };
};
const get = async (app: Hono, path: string, user: TestUser) => {
  const res = await app.request(path, { headers: { authorization: `Bearer ${user.token}` } });
  return { status: res.status, body: (await res.json()) as any };
};

/** Row counts from the restaurant's own tables, as its own role. A missing table counts as -1. */
const counts = async (orgUuid: string, tables: string[]): Promise<Record<string, number>> => {
  const [org] = await adminDb()<{ prefix: string }[]>`select store_prefix as prefix from platform.organizations where id = ${orgUuid}`;
  const ctx: TenantContext = { orgId: toPublicId("org", orgUuid), storePrefix: org?.prefix as string, actor: { type: "system", id: "setup-test" }, role: "owner", locations: "all", env: "live" };
  const out: Record<string, number> = {};
  for (const t of tables) {
    out[t] = await withStore(adminDb(), ctx, async (tx, store) => Number((await tx.unsafe(`select count(*)::int as n from ${store.table(t)}`))[0]?.n)).catch(() => -1);
  }
  return out;
};
const feedFor = async (orgUuid: string) => (await listFeed(adminDb(), { limit: 100 })).items.filter((i) => toUuid(i.orgId) === orgUuid);

describe("what a new sign-up gets", () => {
  beforeAll(async () => {
    await installPlatformLibrary(adminDb());
  }, 60_000);

  afterAll(async () => {
    // Every restaurant these test users ended up owning, whatever happened in between.
    const ids = users.map((u) => u.id);
    const orgs = ids.length > 0 ? await adminDb()<{ org_id: string }[]>`select distinct org_id from platform.members where user_id = any(${ids}::uuid[])` : [];
    await removeRestaurants(adminDb(), orgs.map((o) => o.org_id));
    for (const u of users) await deleteUser(u.id);
    await closeAll();
  }, 120_000);

  it("a new owner's restaurant has its tables, chart of accounts and fiscal calendar, no sales, and shows in the maintainer feed", async () => {
    const app = appWith(setUpNewRestaurant);
    const user = await signUp();
    const res = await onboard(app, user);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.created).toBe(true);
    expect(res.body.restaurant.name).toBe("Slice Yard");
    const org = toUuid(res.body.restaurant.id);

    const [models] = await adminDb()<{ n: number }[]>`select count(*)::int as n from platform.org_models where org_id = ${org} and status = 'live'`;
    expect(models?.n).toBe(LIBRARY.models.length);
    const n = await counts(org, ["account", "posting_rule", "fiscal_calendar", "fiscal_week", "sales_day", "journal_entry"]);
    expect(n.account).toBeGreaterThan(30);
    expect(n.posting_rule).toBeGreaterThan(20);
    expect(n.fiscal_calendar).toBe(1);
    expect(n.fiscal_week).toBeGreaterThan(0);
    expect([n.sales_day, n.journal_entry]).toEqual([0, 0]);

    // On the record, as the least kind of change, already applied.
    const feed = await feedFor(org);
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ origin: "system", tier: "T0", decision: "applied", signals: [], restaurantName: "Slice Yard" });

    // The loader that set the books up is switched off again.
    const [published] = await adminDb()<{ n: number }[]>`select count(*)::int as n from platform.apps where org_id = ${org} and kind = 'system' and status = 'published'`;
    expect(published?.n).toBe(0);

    // And the owner can use RMS straight away.
    const me = await get(app, "/auth/me", user);
    expect(me.body.restaurant).toMatchObject({ name: "Slice Yard", role: "owner", ready: true });
    const staff = await get(app, "/auth/parent/staff", user);
    expect(staff.status).toBe(200);
    expect(staff.body.rows).toHaveLength(9);

    // Asking again makes nothing new.
    const again = await onboard(app, user);
    expect([again.status, again.body.created]).toEqual([200, false]);
    expect(await feedFor(org)).toHaveLength(1);
  }, 120_000);

  it("if the set-up fails, the owner still has their restaurant and still lands in RMS", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      let asked: Parameters<SetUpRestaurant>[1] | undefined;
      const app = appWith(async (_sql, opts) => {
        asked = opts;
        throw new Error("the books could not be set up");
      });
      const user = await signUp();
      const res = await onboard(app, user);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.created).toBe(true);
      const org = toUuid(res.body.restaurant.id);
      // The set-up was asked for this restaurant, this owner, and the template their answer picked.
      expect(asked).toEqual({ orgUuid: org, template: "slice_yard", ownerUserId: user.id });

      const me = await get(app, "/auth/me", user);
      expect(me.body.restaurant).toMatchObject({ name: "Slice Yard", role: "owner", ready: true });
      expect((await get(app, "/auth/parent/menu_items", user)).status).toBe(200);
      const [members] = await adminDb()<{ n: number }[]>`select count(*)::int as n from platform.members where org_id = ${org} and user_id = ${user.id} and role = 'owner' and status = 'active'`;
      expect(members?.n).toBe(1);
      const [state] = await adminDb()<{ status: string; ready: boolean }[]>`select status, store_ready as ready from platform.organizations where id = ${org}`;
      expect(state).toEqual({ status: "active", ready: true });

      // Logged for us, and nothing of it reaches the owner.
      expect(logged.mock.calls.some((c) => String(c[0]).includes("new restaurant set-up did not finish"))).toBe(true);
      expect(JSON.stringify(res.body)).not.toMatch(/set-up|books/);
    } finally {
      logged.mockRestore();
    }
  }, 120_000);

  it("the real set-up reports a failure of its own without undoing anything, and still records the sign-up", async () => {
    // A restaurant with no store yet: its books cannot be set up.
    const made = await createDemoRestaurant(adminDb(), { template: "slice_yard" });
    const owner = await signUp();
    await adminDb()`insert into platform.members (id, org_id, user_id, role) values (gen_random_uuid(), ${made.orgUuid}, ${owner.id}, 'owner')`;
    await adminDb()`select platform.drop_store(${made.orgUuid})`;
    await expect(setUpNewRestaurant(adminDb(), { orgUuid: made.orgUuid, template: "slice_yard", ownerUserId: owner.id })).rejects.toThrow("the books could not be set up");
    const feed = await feedFor(made.orgUuid);
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ origin: "system", tier: "T0", decision: "applied" });
  }, 120_000);
});

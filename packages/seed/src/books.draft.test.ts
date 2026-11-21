// The draft store's sample numbers (task L). Sign-up no longer waits for them: `seedDemoBooks`
// leaves the draft store alone unless asked, and `ensureDraftSamples` fills it when a build starts
// (cheap when they are there already). Plus the loader sweep. Throwaway restaurants only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TenantContext, toPublicId } from "@rms/contracts";
import { adminDb, closeAll, newUuid, withStore } from "@rms/db";
import { requireTestEnv } from "@rms/db/testing";
import { SAMPLE_SOURCE, ensureDraftSamples, seedDemoBooks, sweepBooksLoader, templateForProfile } from "./books.js";
import { createDemoRestaurant, removeRestaurants } from "./demo.js";
import { installPlatformLibrary } from "./library.js";
import { authAdminFromEnv } from "./reset.js";
import { TEMPLATES } from "./templates.js";

requireTestEnv("DATABASE_URL", "DATABASE_ADMIN_URL", "SUPABASE_URL", "SUPABASE_SECRET_KEY");

// Task L ids: uuid suffix 40 to 4f, store prefixes o_4141414141xx.
const uuid = (suffix: string) => `0193a3c0-0000-7000-8000-0000000000${suffix}`;
const R = { org: uuid("40"), prefix: "o_414141414100", owner: "" };

const ctx = (env: "live" | "draft"): TenantContext => ({
  orgId: toPublicId("org", R.org), storePrefix: R.prefix, actor: { type: "system", id: "books-draft-test" }, role: "owner", locations: "all", env,
});

/** Row counts and the sources used, straight from one of the restaurant's stores, as its own role. */
const look = (env: "live" | "draft") =>
  withStore(adminDb(), ctx(env), async (tx, store) => {
    const n = async (t: string) => Number((await tx.unsafe(`select count(*)::int as n from ${store.table(t)}`))[0]?.n);
    const sources = await tx.unsafe<{ s: string }[]>(`select distinct split_part(source_id, '/', 1) as s from ${store.table("sales_day")}`);
    return { salesDays: await n("sales_day"), entries: await n("journal_entry"), bills: await n("vendor_bill"), sources: sources.map((r) => r.s) };
  });
const leftovers = async () =>
  (await adminDb()<{ sessions: number; runs: number; published: number }[]>`
    select (select count(*)::int from platform.agent_sessions where org_id = ${R.org}) as sessions,
           (select count(*)::int from platform.agent_runs where org_id = ${R.org}) as runs,
           (select count(*)::int from platform.apps where org_id = ${R.org} and kind = 'system' and status = 'published') as published`)[0];

describe("sample numbers in the draft store", () => {
  let setUpMs = 0;

  beforeAll(async () => {
    const sql = adminDb();
    await removeRestaurants(sql, [R.org]);
    await installPlatformLibrary(sql);
    await createDemoRestaurant(sql, { template: "marigold", orgUuid: R.org, storePrefix: R.prefix });
    const hex = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, "0")).join("");
    const { data, error } = await authAdminFromEnv().createUser({ email: `draft-l-${hex}@integ.rms.test`, password: `Pw-${hex}${hex}`, email_confirm: true });
    if (error || !data.user) throw new Error("could not create the test owner");
    R.owner = data.user.id;
    await sql`insert into platform.members (id, org_id, user_id, role) values (${newUuid()}, ${R.org}, ${R.owner}, 'owner')`;
    const started = Date.now();
    const result = await seedDemoBooks(sql, { orgUuid: R.org, template: "marigold", ownerUserId: R.owner, withSales: false });
    setUpMs = Date.now() - started;
    expect(result.draft).toBeNull();
  }, 300_000);

  afterAll(async () => {
    await removeRestaurants(adminDb(), [R.org]);
    if (R.owner) await authAdminFromEnv().deleteUser(R.owner);
    await closeAll();
  }, 120_000);

  it("sign-up's set-up no longer fills the draft store (and so no longer waits for it)", async () => {
    console.info(`seedDemoBooks as sign-up runs it: ${setUpMs} ms`);
    expect((await look("draft")).salesDays).toBe(0);
  });

  it("a build's start fills it: eight weeks, posted, every row marked as a sample; live untouched", async () => {
    const started = Date.now();
    const res = await ensureDraftSamples(adminDb(), R.org);
    console.info(`ensureDraftSamples, first time: ${Date.now() - started} ms`);
    expect(res.status).toBe("filled");
    if (res.status !== "filled") return;
    expect(res.draft.rows.sales_day).toBe(112);
    expect(res.draft.lastWeek).toEqual({ weekStart: "2026-11-09", netSalesMinor: 8_431_000, primeCostPct: "61.3", stockCounted: true });
    const draft = await look("draft");
    expect(draft.salesDays).toBe(112);
    expect(draft.sources).toEqual([SAMPLE_SOURCE]);
    expect(await look("live")).toMatchObject({ salesDays: 0, entries: 0, bills: 0 });
    expect(await leftovers()).toEqual({ sessions: 0, runs: 0, published: 0 });
  }, 300_000);

  it("a second build start is one cheap lookup", async () => {
    const started = Date.now();
    expect((await ensureDraftSamples(adminDb(), R.org)).status).toBe("already");
    const ms = Date.now() - started;
    console.info(`ensureDraftSamples, already there: ${ms} ms`);
    expect(ms).toBeLessThan(2_000);
  });

  it("a restaurant whose profile is not a template's gets nothing, whatever its name", async () => {
    expect(templateForProfile({ name: "Marigold Kitchen", concept: "Something else", cuisine: TEMPLATES.marigold.profile.cuisine })).toBeNull();
    expect(templateForProfile({ name: TEMPLATES.marigold.name, concept: TEMPLATES.marigold.profile.concept, cuisine: TEMPLATES.marigold.profile.cuisine })).toBe("marigold");
    await adminDb()`update platform.restaurant_profiles set concept = 'A real place' where org_id = ${R.org}`;
    try {
      expect((await ensureDraftSamples(adminDb(), R.org)).status).toBe("not_demo");
    } finally {
      await adminDb()`update platform.restaurant_profiles set concept = ${TEMPLATES.marigold.profile.concept} where org_id = ${R.org}`;
    }
  });

  it("the sweep switches off a loader a crash left on, and removes its build", async () => {
    const [app] = await adminDb()<{ id: string }[]>`select id from platform.apps where org_id = ${R.org} and kind = 'system'`;
    const session = newUuid();
    await adminDb()`update platform.apps set status = 'published' where id = ${app?.id as string}`;
    await adminDb()`insert into platform.agent_sessions (id, org_id, user_id, app_id, mode, model, title, status)
                    values (${session}, ${R.org}, ${R.owner}, ${app?.id as string}, 'build', 'none', 'Sample numbers', 'closed')`;
    await adminDb()`insert into platform.agent_runs (id, session_id, org_id, status) values (${newUuid()}, ${session}, ${R.org}, 'running')`;
    const swept = await sweepBooksLoader(adminDb());
    expect(swept.paused).toBeGreaterThanOrEqual(1);
    expect(swept.buildsRemoved).toBeGreaterThanOrEqual(1);
    expect(await leftovers()).toEqual({ sessions: 0, runs: 0, published: 0 });
  });
});

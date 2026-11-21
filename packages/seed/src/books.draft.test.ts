// The draft store's sample numbers (task L): `seedDemoBooks` fills the draft store, which a
// mini-app's preview reads during a build, with the template's numbers marked as samples. The
// live store is left alone. Throwaway restaurants only, never the demo restaurants.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TenantContext, toPublicId } from "@rms/contracts";
import { adminDb, closeAll, withStore } from "@rms/db";
import { requireTestEnv } from "@rms/db/testing";
import { SAMPLE_SOURCE, type SeedBooksResult, seedDemoBooks } from "./books.js";
import { createDemoRestaurant, removeRestaurants } from "./demo.js";
import { installPlatformLibrary } from "./library.js";

requireTestEnv("DATABASE_URL", "DATABASE_ADMIN_URL");

// Task L ids: uuid suffix 40 to 4f, store prefixes o_4141414141xx.
const uuid = (suffix: string) => `0193a3c0-0000-7000-8000-0000000000${suffix}`;
const R = { org: uuid("40"), prefix: "o_414141414100", owner: uuid("41") };

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

describe("seedDemoBooks fills the draft store with sample numbers", () => {
  let first: SeedBooksResult;

  beforeAll(async () => {
    const sql = adminDb();
    await removeRestaurants(sql, [R.org]);
    await installPlatformLibrary(sql);
    await createDemoRestaurant(sql, { template: "marigold", orgUuid: R.org, storePrefix: R.prefix });
    const started = Date.now();
    first = await seedDemoBooks(sql, { orgUuid: R.org, template: "marigold", ownerUserId: R.owner, withSales: false });
    console.info(`seedDemoBooks without sales, with draft samples: ${Date.now() - started} ms`);
  }, 300_000);

  afterAll(async () => {
    await removeRestaurants(adminDb(), [R.org]);
    await closeAll();
  }, 120_000);

  it("the draft store has eight weeks for both locations, posted, every row marked as a sample", async () => {
    expect(first.draft?.rows.sales_day).toBe(8 * 7 * 2);
    expect(first.draft?.posted).toBeGreaterThan(400);
    const draft = await look("draft");
    expect(draft.salesDays).toBe(112);
    expect(draft.entries).toBeGreaterThan(400);
    expect(draft.sources).toEqual([SAMPLE_SOURCE]);
  });

  it("a preview's prime cost report reads the template's own figures from the draft store", () => {
    expect(first.draft?.lastWeek).toEqual({ weekStart: "2026-11-09", netSalesMinor: 8_431_000, primeCostPct: "61.3", stockCounted: true });
  });

  it("the live store stays empty: no sales, no entries", async () => {
    expect(first.books).toBeNull();
    expect(await look("live")).toMatchObject({ salesDays: 0, entries: 0, bills: 0 });
  });

  it("leaves no build behind and the loader switched off", async () => {
    const [left] = await adminDb()<{ sessions: number; runs: number }[]>`
      select (select count(*)::int from platform.agent_sessions where org_id = ${R.org}) as sessions,
             (select count(*)::int from platform.agent_runs where org_id = ${R.org}) as runs`;
    expect(left).toEqual({ sessions: 0, runs: 0 });
    const apps = await adminDb()<{ status: string }[]>`select status from platform.apps where org_id = ${R.org} and kind = 'system'`;
    expect(apps.map((a) => a.status)).toEqual(["paused"]);
  });

  it("running it again adds nothing to the draft store", async () => {
    const before = await look("draft");
    const again = await seedDemoBooks(adminDb(), { orgUuid: R.org, template: "marigold", ownerUserId: R.owner, withSales: false });
    expect(again.draft?.posted).toBe(0);
    expect(await look("draft")).toEqual(before);
  }, 300_000);

  it("draftSamples: false leaves the draft store alone", async () => {
    const result = await seedDemoBooks(adminDb(), { orgUuid: R.org, template: "marigold", ownerUserId: R.owner, withSales: false, draftSamples: false });
    expect(result.draft).toBeNull();
  }, 120_000);
});

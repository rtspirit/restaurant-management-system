// `seedDemoBooks` is the function the demo reset and onboarding call. This runs that very
// function on throwaway restaurants: with numbers (as the reset does) and without (as
// onboarding does). It never touches the demo restaurants.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TenantContext, toPublicId } from "@rms/contracts";
import { handleData } from "@rms/data";
import { adminDb, closeAll, withStore } from "@rms/db";
import { requireTestEnv } from "@rms/db/testing";
import { LIBRARY } from "@rms/models";
import { type SeedBooksResult, seedDemoBooks } from "./books.js";
import { createDemoRestaurant, removeRestaurants } from "./demo.js";
import { installPlatformLibrary } from "./library.js";

requireTestEnv("DATABASE_URL", "DATABASE_ADMIN_URL");

// Integration test ids: uuid suffix 70 to 7f, store prefixes o_7171717171xx.
const uuid = (suffix: string) => `0193a3c0-0000-7000-8000-0000000000${suffix}`;
const FULL = { org: uuid("7b"), prefix: "o_71717171710b", owner: uuid("7d") };
const BARE = { org: uuid("7c"), prefix: "o_71717171710c", owner: uuid("7e") };

const systemApps = (org: string) =>
  adminDb()<{ id: string; status: string; version: string }[]>`
    select id, status, published_version_id as version from platform.apps where org_id = ${org} and kind = 'system'`;

/** Row counts straight from the restaurant's own tables, as its own role. */
const counts = async (r: { org: string; prefix: string }, tables: string[]): Promise<Record<string, number>> => {
  const ctx: TenantContext = { orgId: toPublicId("org", r.org), storePrefix: r.prefix, actor: { type: "system", id: "books-test" }, role: "owner", locations: "all", env: "live" };
  return withStore(adminDb(), ctx, async (tx, store) => {
    const out: Record<string, number> = {};
    for (const t of tables) out[t] = Number((await tx.unsafe(`select count(*)::int as n from ${store.table(t)}`))[0]?.n);
    return out;
  });
};

describe("seedDemoBooks", () => {
  beforeAll(async () => {
    const sql = adminDb();
    await removeRestaurants(sql, [FULL.org, BARE.org]);
    await installPlatformLibrary(sql);
    await createDemoRestaurant(sql, { template: "marigold", orgUuid: FULL.org, storePrefix: FULL.prefix });
    await createDemoRestaurant(sql, { template: "slice_yard", orgUuid: BARE.org, storePrefix: BARE.prefix });
  }, 120_000);

  afterAll(async () => {
    await removeRestaurants(adminDb(), [FULL.org, BARE.org]);
    await closeAll();
  }, 120_000);

  describe("with numbers, as the reset runs it", () => {
    let first: SeedBooksResult;

    beforeAll(async () => {
      first = await seedDemoBooks(adminDb(), { orgUuid: FULL.org, template: "marigold", ownerUserId: FULL.owner, withSales: true });
    }, 300_000);

    it("makes the tables, loads eight weeks and posts every document", async () => {
      const [models] = await adminDb()<{ n: number }[]>`select count(*)::int as n from platform.org_models where org_id = ${FULL.org} and status = 'live'`;
      expect(models?.n).toBe(LIBRARY.models.length);
      const books = first.books;
      expect(books).not.toBeNull();
      expect(books?.rows.sales_day).toBe(8 * 7 * 2);
      expect(books?.posted).toEqual({ salesDays: 112, vendorBills: books?.rows.vendor_bill, labourDays: 336, stockCounts: 18 });
      expect(first.setUp.accountsAndRules).toBeGreaterThan(40);
      expect(first.setUp.calendar).toBeGreaterThan(9);
    });

    it("the prime cost report then shows the week on the sketches: $84,310.00 and 61.3%", () => {
      expect(first.books?.lastWeek).toEqual({ weekStart: "2026-11-09", netSalesMinor: 8_431_000, primeCostPct: "61.3", stockCounted: true });
    });

    it("leaves no published system mini-app behind: the loader is switched off again", async () => {
      const apps = await systemApps(FULL.org);
      expect(apps).toHaveLength(1);
      expect(apps[0]?.status).toBe("paused");
      const [published] = await adminDb()<{ n: number }[]>`select count(*)::int as n from platform.apps where org_id = ${FULL.org} and kind = 'system' and status = 'published'`;
      expect(published?.n).toBe(0);
    });

    it("the switched-off loader can no longer read or write through the Data API", async () => {
      const [app] = await systemApps(FULL.org);
      const tenant: TenantContext = {
        orgId: toPublicId("org", FULL.org), storePrefix: FULL.prefix, actor: { type: "user", id: toPublicId("usr", FULL.owner) }, role: "owner", locations: "all", env: "live",
        appId: toPublicId("app", app?.id as string), appVersionId: toPublicId("ver", app?.version as string),
      };
      const before = await counts(FULL, ["vendor"]);
      for (const [route, body] of [
        ["query", { model: "journal_line", limit: 1 }],
        ["batch", { ops: [{ op: "insert", model: "vendor", values: { name: "Should never be written", active: true } }] }],
        ["action", { action: "seed_chart_of_accounts", params: {} }],
        ["catalog", {}],
      ] as const) {
        const reply = await handleData(route, tenant, body, "books-test");
        expect(reply.status, route).toBe(401);
      }
      expect(await counts(FULL, ["vendor"])).toEqual(before);
    });

    it("running it again changes nothing, and switches the loader off again", async () => {
      const before = await counts(FULL, ["sales_day", "journal_entry", "journal_line", "account", "fiscal_week"]);
      const again = await seedDemoBooks(adminDb(), { orgUuid: FULL.org, template: "marigold", ownerUserId: FULL.owner, withSales: true });
      expect(again.setUp).toEqual({ accountsAndRules: 0, calendar: 0 });
      expect(again.books?.posted).toEqual({ salesDays: 0, vendorBills: 0, labourDays: 0, stockCounts: 0 });
      expect(again.books?.lastWeek).toEqual(first.books?.lastWeek);
      expect(await counts(FULL, ["sales_day", "journal_entry", "journal_line", "account", "fiscal_week"])).toEqual(before);
      expect((await systemApps(FULL.org)).map((a) => a.status)).toEqual(["paused"]);
    }, 300_000);

    it("a load that fails still switches the loader off", async () => {
      // Zero weeks is refused by the number generator, after the loader has been switched on.
      await expect(seedDemoBooks(adminDb(), { orgUuid: FULL.org, template: "marigold", ownerUserId: FULL.owner, withSales: true, weeks: 0 })).rejects.toThrow();
      expect((await systemApps(FULL.org)).map((a) => a.status)).toEqual(["paused"]);
    });
  });

  describe("without numbers, as onboarding runs it", () => {
    let result: SeedBooksResult;

    beforeAll(async () => {
      result = await seedDemoBooks(adminDb(), { orgUuid: BARE.org, template: "slice_yard", ownerUserId: BARE.owner, withSales: false });
    }, 120_000);

    it("the restaurant has its tables, its chart of accounts and its fiscal calendar, and no numbers", async () => {
      expect(result.books).toBeNull();
      expect(result.setUp.accountsAndRules).toBeGreaterThan(40);
      expect(result.setUp.calendar).toBeGreaterThan(9);
      const [models] = await adminDb()<{ n: number }[]>`select count(*)::int as n from platform.org_models where org_id = ${BARE.org} and status = 'live'`;
      expect(models?.n).toBe(LIBRARY.models.length);
      const n = await counts(BARE, ["account", "posting_rule", "fiscal_calendar", "fiscal_week", "sales_day", "journal_entry", "vendor_bill"]);
      expect(n.account).toBeGreaterThan(30);
      expect(n.posting_rule).toBeGreaterThan(20);
      expect(n.fiscal_calendar).toBe(1);
      expect(n.fiscal_week).toBe(9);
      expect([n.sales_day, n.journal_entry, n.vendor_bill]).toEqual([0, 0, 0]);
    });

    it("leaves no published system mini-app behind either", async () => {
      expect((await systemApps(BARE.org)).map((a) => a.status)).toEqual(["paused"]);
    });

    it("the numbers can still be loaded later, by the same function", async () => {
      const later = await seedDemoBooks(adminDb(), { orgUuid: BARE.org, template: "slice_yard", ownerUserId: BARE.owner, withSales: true });
      expect(later.setUp).toEqual({ accountsAndRules: 0, calendar: 0 });
      expect(later.books?.lastWeek).toMatchObject({ weekStart: "2026-11-09", netSalesMinor: 2_875_000, stockCounted: true });
      expect((await systemApps(BARE.org)).map((a) => a.status)).toEqual(["paused"]);
    }, 300_000);
  });
});

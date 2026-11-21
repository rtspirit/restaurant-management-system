// End to end on the real path: the library installed through the checker, two seeded
// restaurants, their tables made by the model compiler, eight weeks of numbers loaded through
// the HTTP routes with real tokens, posted with the library's named actions, and read back with
// its named queries. This is the test that says the accounts mini-app is possible.
//
// The figures are the ones on the approved design sketches (Marigold, week of Mon 2026-11-09).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mintAppToken } from "@rms/auth";
import { DATA_ROUTES, type TenantContext, toPublicId } from "@rms/contracts";
import { adminDb, closeAll, withStore } from "@rms/db";
import { requireTestEnv } from "@rms/db/testing";
import { LIBRARY, ensureModels } from "@rms/models";
import { type BooksClient, type BooksRoute, type LoadBooksResult, createDemoRestaurant, ensureBooksApp, installPlatformLibrary, loadDemoBooks, removeRestaurants } from "@rms/seed";
import app from "../index.js";

requireTestEnv("DATABASE_URL", "DATABASE_ADMIN_URL", "RMS_TOKEN_SECRET");

// Integration test ids: uuid suffix 70 to 7f, store prefixes o_7171717171xx. (d0 to df belongs to the @rms/db tests.)
const uuid = (suffix: string) => `0193a3c0-0000-7000-8000-0000000000${suffix}`;
const M = { org: uuid("73"), prefix: "o_717171717103", owner: uuid("75"), staff: uuid("76"), template: "marigold" as const };
const S = { org: uuid("74"), prefix: "o_717171717104", owner: uuid("77"), staff: uuid("78"), template: "slice_yard" as const };

const CANARY_M = "CANARY-MARIGOLD-4c1d7e90-books";
const CANARY_S = "CANARY-SLICEYARD-9a2b6f13-books";

const WEEK = { from_date: "2026-11-09", to_date: "2026-11-15" };
const usd = (dollars: number) => dollars * 100;

type Reply = { status: number; body: any; text: string };
type Who = { org: string; app: string; ver: string; user: string; role: "owner" | "staff"; locations?: string[] };

/** Every response body, by the restaurant whose token asked. */
const seen: Record<string, string[]> = { [M.org]: [], [S.org]: [] };

const tokenFor = (w: Who) =>
  mintAppToken({
    org: toPublicId("org", w.org), sub: toPublicId("usr", w.user), app: toPublicId("app", w.app), role: w.role,
    loc: w.locations ? (w.locations.map((l) => toPublicId("loc", l)) as [`loc_${string}`]) : "all",
    kind: "app", aud: "data", ver: toPublicId("ver", w.ver), env: "live",
  });

const call = async (w: Who, route: BooksRoute | "catalog", body: unknown): Promise<Reply> => {
  const res = await app.request(DATA_ROUTES[route], { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${await tokenFor(w)}` }, body: JSON.stringify(body) });
  const text = await res.text();
  seen[w.org]?.push(text);
  return { status: res.status, body: JSON.parse(text), text };
};
const ok = (r: Reply) => {
  expect(r.status, r.text.slice(0, 600)).toBe(200);
  return r.body;
};
/** A loader client that goes through the HTTP routes with a real token, as a mini-app would. */
const clientFor = (w: Who): BooksClient => async (route, body) => {
  const r = await call(w, route, body);
  if (r.status !== 200) throw new Error(`${route} was refused (${r.status}): ${r.text.slice(0, 600)}`);
  return r.body;
};
const named = async (w: Who, query: string, params: Record<string, unknown> = {}) => ok(await call(w, "named", { query, params })).rows as any[];

/** Reads every row of a model the caller may see, page by page. */
const allRows = async (w: Who, model: string): Promise<any[]> => {
  const out: any[] = [];
  let cursor: string | undefined;
  do {
    const res = ok(await call(w, "query", { model, limit: 500, ...(cursor ? { cursor } : {}) }));
    out.push(...res.rows);
    cursor = res.nextCursor ?? undefined;
  } while (cursor);
  return out;
};

const ledger = async (w: Who) => {
  const lines = ok(await call(w, "query", { model: "journal_line", limit: 1, totals: { aggregates: [{ fn: "sum", field: "debit", as: "debits" }, { fn: "sum", field: "credit", as: "credits" }, { fn: "count", as: "n" }] } })).totals[0];
  const entries = ok(await call(w, "query", { model: "journal_entry", limit: 1, totals: { aggregates: [{ fn: "count", as: "n" }] } })).totals[0];
  return { debits: Number(lines.debits), credits: Number(lines.credits), lines: Number(lines.n), entries: Number(entries.n) };
};

describe("the books, end to end", () => {
  let ownerM: Who, staffM: Who, ownerS: Who;
  let firstM: LoadBooksResult, firstS: LoadBooksResult;
  let downtown = "";

  beforeAll(async () => {
    const sql = adminDb();
    await removeRestaurants(sql, [M.org, S.org]);
    await installPlatformLibrary(sql);
    const keys = LIBRARY.models.map((m) => m.key);
    const whos: Who[] = [];
    for (const r of [M, S]) {
      await createDemoRestaurant(sql, { template: r.template, orgUuid: r.org, storePrefix: r.prefix });
      // No `library` option: the tables come from the library as installed in the database.
      await ensureModels(sql, r.org, keys);
      const made = await ensureBooksApp(sql, r.org);
      whos.push({ org: r.org, app: made.appUuid, ver: made.versionUuid, user: r.owner, role: "owner" });
    }
    [ownerM, ownerS] = whos as [Who, Who];
    const [loc] = await sql<{ id: string }[]>`select id from platform.locations where org_id = ${M.org} and name = 'Downtown'`;
    downtown = loc?.id as string;
    staffM = { ...ownerM, user: M.staff, role: "staff", locations: [downtown] };

    firstM = await loadDemoBooks(clientFor(ownerM), { template: "marigold" });
    firstS = await loadDemoBooks(clientFor(ownerS), { template: "slice_yard" });

    // Each restaurant plants a secret only it should ever see again.
    ok(await call(ownerM, "batch", { ops: [{ op: "insert", model: "vendor", values: { name: `Secret supplier ${CANARY_M}`, active: true, note: CANARY_M } }] }));
    ok(await call(ownerS, "batch", { ops: [{ op: "insert", model: "vendor", values: { name: `Secret supplier ${CANARY_S}`, active: true, note: CANARY_S } }] }));
  }, 600_000);

  afterAll(async () => {
    await removeRestaurants(adminDb(), [M.org, S.org]);
    await closeAll();
  }, 120_000);

  it("loaded eight weeks for both restaurants and posted every document", () => {
    expect([firstM.startsOn, firstM.endsOn]).toEqual(["2026-09-21", "2026-11-15"]);
    expect(firstM.rows.sales_day).toBe(8 * 7 * 2);
    expect(firstS.rows.sales_day).toBe(8 * 7);
    expect(firstM.rows.labour_day).toBe(8 * 7 * 2 * 3);
    expect(firstM.rows.stock_count).toBe(9 * 2);
    expect(firstS.rows.stock_count).toBe(9);
    expect(firstM.rows.vendor_bill).toBeGreaterThan(50);
    for (const r of [firstM, firstS]) {
      expect(r.posted.salesDays).toBe(r.rows.sales_day);
      expect(r.posted.vendorBills).toBe(r.rows.vendor_bill);
      expect(r.posted.labourDays).toBe(r.rows.labour_day);
      expect(r.posted.stockCounts).toBe(r.rows.stock_count);
      expect(r.setUp.accountsAndRules).toBeGreaterThan(40);
      expect(r.setUp.calendar).toBeGreaterThan(9);
    }
  });

  describe("Marigold, week of Monday 2026-11-09", () => {
    it("prime cost: net sales $84,310.00, food and drink $25,460.00, staff $26,220.00, 61.3%", async () => {
      const rows = await named(ownerM, "prime_cost_by_week", WEEK);
      const all = rows.filter((r) => r.scope === "all_locations");
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({
        week_start: "2026-11-09", week_end: "2026-11-15", net_sales: usd(84_310), cost_of_goods: usd(25_460), labour: usd(26_220),
        prime_cost: usd(51_680), prime_cost_pct: "61.3", stock_counted: true,
      });
      const byLocation = Object.fromEntries(rows.filter((r) => r.scope === "location").map((r) => [r.location_name, r.net_sales]));
      expect(byLocation).toEqual({ Downtown: usd(51_870), Riverside: usd(32_440) });
      for (const r of rows) expect(r.stock_counted).toBe(true);
    });

    it("sales by location: Downtown $51,870, Riverside $32,440", async () => {
      const rows = await named(ownerM, "sales_by_location", WEEK);
      expect(rows.map((r) => [r.location_name, r.net_sales])).toEqual([["Downtown", usd(51_870)], ["Riverside", usd(32_440)]]);
      expect(rows.map((r) => r.share_pct)).toEqual(["61.5", "38.5"]);
    });

    it("sales by day: the seven daily totals", async () => {
      const rows = await named(ownerM, "sales_by_day", { week_of: "2026-11-09" });
      expect(rows.map((r) => [r.business_date, r.net_sales])).toEqual([
        ["2026-11-09", usd(8_140)], ["2026-11-10", usd(8_960)], ["2026-11-11", usd(9_870)], ["2026-11-12", usd(11_420)],
        ["2026-11-13", usd(15_830)], ["2026-11-14", usd(17_950)], ["2026-11-15", usd(12_140)],
      ]);
      // Any day of the week names the same week.
      expect(await named(ownerM, "sales_by_day", { week_of: "2026-11-13" })).toEqual(rows);
    });

    it("the weekly profit and loss agrees with prime cost", async () => {
      const rows = await named(ownerM, "weekly_pnl", { week_of: "2026-11-09" });
      const line = (kind: string, section: string) => rows.find((r) => r.line_kind === kind && r.section === section);
      expect(line("section_total", "sales").amount).toBe(usd(84_310));
      expect(line("section_total", "cost_of_goods").amount).toBe(usd(25_460));
      expect(line("section_total", "labour").amount).toBe(usd(26_220));
      expect(line("summary", "prime_cost")).toMatchObject({ amount: usd(51_680), pct_of_net_sales: "61.3", stock_counted: true });
      expect(line("summary", "gross_profit").amount).toBe(usd(84_310 - 25_460));
      // Account lines add up to their section.
      const sales = rows.filter((r) => r.line_kind === "account" && r.section === "sales");
      expect(sales.length).toBeGreaterThan(1);
      expect(sales.reduce((a, r) => a + r.amount, 0)).toBe(usd(84_310));
    });

    it("food and drink cost is usage: opening stock plus purchases minus closing stock", async () => {
      const rows = await named(ownerM, "cost_of_goods_by_week", WEEK);
      expect(rows).toHaveLength(3);
      for (const r of rows) {
        expect(r.stock_counted).toBe(true);
        expect(r.opening_value + r.purchases - r.closing_value).toBe(r.usage);
        expect(r.purchases).not.toBe(r.usage); // a count really moved the figure
      }
      expect(rows.find((r) => r.scope === "all_locations").usage).toBe(usd(25_460));
    });

    it("every day adds up: collected equals what there is to account for", async () => {
      for (const day of ["2026-11-09", "2026-11-14"]) {
        const rows = await named(ownerM, "daily_sales_summary", { business_date: day });
        expect(rows.map((r) => r.location_name)).toEqual(["Downtown", "Riverside"]);
        for (const r of rows) {
          expect(r.difference).toBe(0);
          expect(r.net_sales).toBe(r.gross_sales - r.discounts - r.comps);
        }
      }
    });

    it("delivery payouts match the till and their own lines", async () => {
      const rows = await named(ownerM, "delivery_payout_reconciliation", WEEK);
      expect(rows).toHaveLength(4); // two platforms at two locations
      for (const r of rows) {
        expect(r.collected_difference).toBe(0);
        expect(r.net_difference).toBe(0);
        expect(r.commission).toBeLessThan(0);
      }
    });

    it("stock on hand is the last Sunday count", async () => {
      const rows = await named(ownerM, "stock_on_hand");
      expect(rows.map((r) => [r.location_name, r.counted_on])).toEqual([["Downtown", "2026-11-15"], ["Riverside", "2026-11-15"]]);
      for (const r of rows) expect(r.total_value).toBe(r.food_value + r.beverage_value + r.alcohol_value + r.supplies_value);
    });
  });

  it("all eight weeks match the sketches, and the dip week starting 2026-10-19 is $61,480", async () => {
    const rows = (await named(ownerM, "prime_cost_by_week")).filter((r) => r.scope === "all_locations");
    expect(rows.map((r) => [r.week_start, r.net_sales])).toEqual([
      ["2026-09-21", usd(81_940)], ["2026-09-28", usd(83_120)], ["2026-10-05", usd(82_560)], ["2026-10-12", usd(84_870)],
      ["2026-10-19", usd(61_480)], ["2026-10-26", usd(80_230)], ["2026-11-02", usd(83_790)], ["2026-11-09", usd(84_310)],
    ]);
    for (const r of rows) expect(r.stock_counted).toBe(true);
    const dip = await named(ownerM, "prime_cost_by_week", { from_date: "2026-10-19", to_date: "2026-10-25" });
    expect(dip.find((r) => r.scope === "all_locations").net_sales).toBe(usd(61_480));
  });

  it("Slice Yard has its own, leaner numbers", async () => {
    const rows = (await named(ownerS, "prime_cost_by_week", WEEK)).filter((r) => r.scope === "all_locations");
    expect(rows[0].net_sales).toBe(usd(28_750));
    expect(Number(rows[0].prime_cost_pct)).toBeGreaterThan(50);
    expect(Number(rows[0].prime_cost_pct)).toBeLessThan(59);
    expect(rows[0].stock_counted).toBe(true);
  });

  it("the ledger balances", async () => {
    for (const w of [ownerM, ownerS]) {
      const l = await ledger(w);
      expect(l.debits).toBe(l.credits);
      expect(l.debits).toBeGreaterThan(0);
      expect(l.lines).toBeGreaterThan(l.entries);
    }
    // And entry by entry, straight from the tables, as each restaurant's own role.
    for (const r of [M, S]) {
      const ctx: TenantContext = { orgId: toPublicId("org", r.org), storePrefix: r.prefix, actor: { type: "system", id: "integration-test" }, role: "owner", locations: "all", env: "live" };
      const bad = await withStore(adminDb(), ctx, (tx, store) =>
        tx.unsafe(`select count(*)::int as n from (select entry from ${store.table("journal_line")} group by entry having sum(debit) <> sum(credit)) x`),
      );
      expect(bad[0]?.n).toBe(0);
    }
  });

  it("loading and posting twice changes nothing", async () => {
    const before = await ledger(ownerM);
    const counts = async () => {
      const out: Record<string, number> = {};
      // One at a time: the Data API caps how much one restaurant may ask for at once.
      for (const m of ["sales_day", "payment_day", "vendor_bill_line", "stock_count_line", "labour_day"]) out[m] = (await allRows(ownerM, m)).length;
      return out;
    };
    const rowsBefore = await counts();
    const again = await loadDemoBooks(clientFor(ownerM), { template: "marigold" });
    expect(again.rows).toEqual(firstM.rows);
    expect(again.posted).toEqual({ salesDays: 0, vendorBills: 0, labourDays: 0, stockCounts: 0 });
    expect(again.setUp).toEqual({ accountsAndRules: 0, calendar: 0 });
    expect(await ledger(ownerM)).toEqual(before);
    expect(await counts()).toEqual(rowsBefore);
    // Posting one day by hand a third time: still nothing.
    const [day] = ok(await call(ownerM, "query", { model: "sales_day", limit: 1 })).rows;
    expect(ok(await call(ownerM, "action", { action: "post_sales_day", params: { sales_day_id: day.id } }))).toEqual({ affected: 0 });
    expect(await ledger(ownerM)).toEqual(before);
    const week = (await named(ownerM, "prime_cost_by_week", WEEK)).find((r) => r.scope === "all_locations");
    expect([week.net_sales, week.cost_of_goods, week.labour]).toEqual([usd(84_310), usd(25_460), usd(26_220)]);
  }, 300_000);

  describe("a staff-role token cannot see staff cost", () => {
    it("staff cost is left out of the daily staff rows, and cannot be asked for, filtered or totalled", async () => {
      const res = ok(await call(staffM, "query", { model: "labour_day", limit: 5 }));
      expect(res.rows.length).toBeGreaterThan(0);
      expect(res.masked).toContain("labour_cost");
      for (const r of res.rows) expect(Object.keys(r)).not.toContain("labour_cost");
      for (const body of [
        { model: "labour_day", fields: ["labour_cost"] },
        { model: "labour_day", where: { field: "labour_cost", op: "gt", value: 0 } },
        { model: "labour_day", sort: [{ field: "labour_cost" }] },
        { model: "labour_day", totals: { aggregates: [{ fn: "sum", field: "labour_cost", as: "total" }] } },
      ]) {
        const r = await call(staffM, "query", body);
        expect(r.status, r.text).toBe(403);
        expect(r.body.error.code).toBe("forbidden_field");
      }
      // The owner, same rows: the cost is there.
      const owner = ok(await call(ownerM, "query", { model: "labour_day", limit: 5 }));
      expect(owner.rows[0].labour_cost).toBeGreaterThan(0);
    });

    it("the reports that carry staff cost give staff nothing of it", async () => {
      for (const [query, params] of [["prime_cost_by_week", WEEK], ["weekly_pnl", { week_of: "2026-11-09" }], ["cost_of_goods_by_week", WEEK]] as const) {
        const r = await call(staffM, "named", { query, params });
        expect(r.status, r.text).toBe(403);
        expect(["forbidden_role", "forbidden_field"]).toContain(r.body.error.code);
        expect(r.text).not.toContain("2622000");
      }
      // Staff also cannot post to the books.
      const [day] = ok(await call(staffM, "query", { model: "sales_day", limit: 1 })).rows;
      const post = await call(staffM, "action", { action: "post_sales_day", params: { sales_day_id: day.id } });
      expect(post.status, post.text).toBe(403);
    });

    it("a staff token for Downtown sees Downtown sales only", async () => {
      const rows = await named(staffM, "sales_by_location", WEEK);
      expect(rows.map((r) => [r.location_name, r.net_sales])).toEqual([["Downtown", usd(51_870)]]);
    });
  });

  describe("Slice Yard sees none of Marigold's rows", () => {
    it("the sweep can fail: each restaurant does see its own secret", async () => {
      expect(JSON.stringify(await allRows(ownerM, "vendor"))).toContain(CANARY_M);
      expect(JSON.stringify(await allRows(ownerS, "vendor"))).toContain(CANARY_S);
    });

    it("every model and every report, read as Slice Yard, holds nothing of Marigold's (and the other way round)", async () => {
      for (const w of [ownerS, ownerM]) {
        for (const m of LIBRARY.models) await allRows(w, m.key);
        await allRows(w, "parent.locations");
        await named(w, "prime_cost_by_week");
        await named(w, "cost_of_goods_by_week");
        await named(w, "stock_on_hand");
        await named(w, "delivery_payout_reconciliation");
        await named(w, "weekly_pnl", { week_of: "2026-11-09" });
        await named(w, "sales_by_day", { week_of: "2026-11-09" });
        await named(w, "sales_by_location", WEEK);
        await named(w, "daily_sales_summary", { business_date: "2026-11-14" });
        ok(await call(w, "catalog", {}));
      }
      const sliceYard = seen[S.org]?.join("\n") ?? "";
      const marigold = seen[M.org]?.join("\n") ?? "";
      expect(sliceYard.length).toBeGreaterThan(100_000);
      expect(sliceYard).not.toContain(CANARY_M);
      expect(marigold).not.toContain(CANARY_S);
      // Marigold's locations, a Marigold-only stock item, and its ids never reach Slice Yard.
      for (const word of ["Downtown", "Riverside", "Hanger steak", M.org, downtown]) expect(sliceYard, word).not.toContain(word);
      for (const word of ["Mill Street", "Tipo 00 flour", S.org]) expect(marigold, word).not.toContain(word);
    }, 300_000);

    it("a Slice Yard token cannot post or read a Marigold document by its id", async () => {
      const [day] = ok(await call(ownerM, "query", { model: "sales_day", limit: 1 })).rows;
      const before = await ledger(ownerS);
      const post = await call(ownerS, "action", { action: "post_sales_day", params: { sales_day_id: day.id } });
      expect(post.status).not.toBe(200);
      expect(post.text).not.toContain(day.id);
      expect(await ledger(ownerS)).toEqual(before);
      expect(ok(await call(ownerS, "query", { model: "sales_day", where: { field: "id", op: "eq", value: day.id } })).rows).toEqual([]);
    });
  });
});

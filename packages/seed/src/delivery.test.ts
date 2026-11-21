// What the delivery apps keep, in the demo books (ADR 0011).
//
// First half: the statements themselves, with no database. Second half: two throwaway
// restaurants are loaded the way the demo reset loads them, and the reports are read back. The
// figures the demo script quotes must not move: commissions change profit and nothing else.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type StorePrefix, type TenantContext, toPublicId } from "@rms/contracts";
import { handleData } from "@rms/data";
import { adminDb, closeAll, newStorePrefix, newUuid, withStore } from "@rms/db";
import { requireTestEnv } from "@rms/db/testing";
import { DEFAULT_CHART_OF_ACCOUNTS } from "@rms/models";
import { type BooksClient, type SeededBooks, booksManifest, seedDemoBooks } from "./books.js";
import { DELIVERY_COMMISSIONS_ACCOUNT_CODE, type DeliveryStatement, deliveryStatements } from "./delivery.js";
import { createDemoRestaurant, removeRestaurants } from "./demo.js";
import { installPlatformLibrary } from "./library.js";
import { sum } from "./rng.js";
import { type GeneratedSales, generateSales } from "./sales.js";

const usd = (dollars: number) => Math.round(dollars * 100);
const M = generateSales("marigold");
const S = generateSales("slice_yard");
const WEEKS = ["2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02", "2026-11-09"];
const LAST = "2026-11-09";

/** What the delivery apps kept each week, oldest first. The dip week is lower, in line with its sales. */
const KEPT = {
  marigold: [1_295.23, 1_312.63, 1_271.53, 1_288.42, 1_003.49, 1_285.79, 1_302.85, 1_306.56].map(usd),
  slice_yard: [2_210.69, 2_312.39, 1_681.92, 2_408.16, 2_376.18, 2_163.83, 2_377.82, 2_369.25].map(usd),
};
const NET_SALES = {
  marigold: [81_940, 83_120, 82_560, 84_870, 61_480, 80_230, 83_790, 84_310].map(usd),
  slice_yard: [27_640, 28_110, 20_410, 28_480, 27_930, 27_520, 28_260, 28_750].map(usd),
};
const DIP = { marigold: 4, slice_yard: 2 };

const keptInWeek = (statements: DeliveryStatement[], weekStart: string) => sum(statements.filter((s) => s.periodStart === weekStart).map((s) => s.totalMinor));
const lineTotal = (statements: DeliveryStatement[], kind: string) => sum(statements.flatMap((s) => s.lines).filter((l) => l.kind === kind).map((l) => l.amountMinor));

describe.each([
  ["marigold", M],
  ["slice_yard", S],
] as const)("delivery statements: %s", (template, g: GeneratedSales) => {
  const statements = deliveryStatements(g);

  it("one statement per delivery company, location and week, across the whole seeded period", () => {
    const companies = [...new Set(statements.map((s) => s.company))].sort();
    expect(companies).toEqual(["Ferrymeal", "Trolleybite"]);
    expect(statements).toHaveLength(8 * g.locations.length * 2);
    expect(new Set(statements.map((s) => `${s.company}/${s.locationKey}/${s.periodStart}`)).size).toBe(statements.length);
    // A bill number is unique per vendor.
    expect(new Set(statements.map((s) => `${s.company}/${s.statementNumber}`)).size).toBe(statements.length);
    expect([...new Set(statements.map((s) => s.periodStart))].sort()).toEqual(WEEKS);
  });

  it("each statement is exactly what its payout statement says the app kept, as positive costs", () => {
    for (const s of statements) {
      const payout = g.deliveryPayouts.find((p) => p.platform === s.platform && p.locationKey === s.locationKey && p.periodStart === s.periodStart);
      expect(payout).toBeDefined();
      const passedOn = sum((payout?.lines ?? []).filter((l) => l.type === "sales" || l.type === "tips").map((l) => l.amountMinor));
      expect(s.totalMinor).toBe(passedOn - (payout?.payoutMinor ?? 0));
      expect(s.totalMinor).toBe(sum(s.lines.map((l) => l.amountMinor)));
      expect(s.deliverySalesMinor).toBe(payout?.lines.find((l) => l.type === "sales")?.amountMinor);
      for (const l of s.lines) {
        expect(["commission", "marketing_fee", "error_charge"]).toContain(l.kind);
        expect(Number.isSafeInteger(l.amountMinor) && l.amountMinor > 0).toBe(true);
      }
      expect(s.lines.filter((l) => l.kind === "commission")).toHaveLength(1);
      expect(s.currency).toBe("USD");
    }
  });

  it("the commission rate is in the usual 15 to 30 percent range, and so is everything the apps keep in a week", () => {
    for (const s of statements) {
      const rate = (s.lines.find((l) => l.kind === "commission")?.amountMinor ?? 0) / s.deliverySalesMinor;
      expect(rate).toBeGreaterThanOrEqual(0.15);
      expect(rate).toBeLessThanOrEqual(0.3);
    }
    for (const w of WEEKS) {
      const mine = statements.filter((s) => s.periodStart === w);
      const share = sum(mine.map((s) => s.totalMinor)) / sum(mine.map((s) => s.deliverySalesMinor));
      expect(share).toBeGreaterThan(0.15);
      expect(share).toBeLessThan(0.3);
    }
  });

  it("the cost counts in the week the orders were sold, and is settled when the payout lands", () => {
    for (const s of statements) {
      expect(WEEKS).toContain(s.periodStart);
      expect(new Date(`${s.periodEnd}T00:00:00Z`).getUTCDay()).toBe(0); // a Sunday
      expect(new Date(`${s.dueDate}T00:00:00Z`).getUTCDay()).toBe(3); // the Wednesday after
      expect(s.dueDate > s.periodEnd).toBe(true);
      expect(s.settled).toBe(s.periodStart !== LAST);
    }
  });

  it("the weekly totals are fixed, and the slow week is lower in proportion to its sales", () => {
    const kept = WEEKS.map((w) => keptInWeek(statements, w));
    expect(kept).toEqual(KEPT[template]);
    const net = g.weeks.map((w) => w.netSalesMinor);
    const dip = DIP[template];
    const others = (xs: number[]) => sum(xs.filter((_, i) => i !== dip)) / (xs.length - 1);
    expect(Math.min(...kept)).toBe(kept[dip]);
    const keptDrop = (kept[dip] as number) / others(kept);
    const salesDrop = (net[dip] as number) / others(net);
    expect(Math.abs(keptDrop - salesDrop)).toBeLessThan(0.05);
  });

  it("is deterministic, and a week's statements do not depend on the range asked for", () => {
    expect(deliveryStatements(generateSales(template))).toEqual(statements);
    const short = deliveryStatements(generateSales(template, { weeks: 2 }));
    expect(short).toEqual(statements.filter((s) => s.periodStart >= "2026-11-02"));
  });

  it("the sales numbers themselves have not moved", () => {
    expect(g.weeks.map((w) => w.netSalesMinor)).toEqual(NET_SALES[template]);
  });
});

describe("delivery statements: the two restaurants differ", () => {
  it("a full-service place sells little through the apps, a pizza counter a lot", () => {
    const share = (g: GeneratedSales) => sum(deliveryStatements(g).map((s) => s.deliverySalesMinor)) / sum(g.weeks.map((w) => w.netSalesMinor));
    expect(share(M)).toBeGreaterThan(0.05);
    expect(share(M)).toBeLessThan(0.07);
    expect(share(S)).toBeGreaterThan(0.29);
    expect(share(S)).toBeLessThan(0.34);
  });

  it("Marigold, week of 9 November: commission $1,205.95, sponsored listing $90.61, one refund charge $10.00", () => {
    const week = deliveryStatements(M).filter((s) => s.periodStart === LAST);
    expect(week).toHaveLength(4);
    expect([lineTotal(week, "commission"), lineTotal(week, "marketing_fee"), lineTotal(week, "error_charge")]).toEqual([usd(1_205.95), usd(90.61), usd(10)]);
    expect(sum(week.map((s) => s.deliverySalesMinor))).toBe(usd(5_069.69));
    expect(sum(week.map((s) => s.totalMinor))).toBe(usd(1_306.56));
  });

  it("Slice Yard, week of 9 November: commission $2,070.12, sponsored listing $282.13, one refund charge $17.00", () => {
    const week = deliveryStatements(S).filter((s) => s.periodStart === LAST);
    expect(week).toHaveLength(2);
    expect([lineTotal(week, "commission"), lineTotal(week, "marketing_fee"), lineTotal(week, "error_charge")]).toEqual([usd(2_070.12), usd(282.13), usd(17)]);
    expect(sum(week.map((s) => s.totalMinor))).toBe(usd(2_369.25));
  });

  it("the account they are coded to is a running cost in the standard chart", () => {
    expect(DEFAULT_CHART_OF_ACCOUNTS.find((a) => a.code === DELIVERY_COMMISSIONS_ACCOUNT_CODE)).toMatchObject({ type: "expense", reportSection: "controllable" });
  });
});

// ---------------------------------------------------------------------------------- in the books

requireTestEnv("DATABASE_URL", "DATABASE_ADMIN_URL");

// Fresh ids and store prefixes every run: this database is shared with other test runs.
type Place = { org: string; prefix: StorePrefix; owner: string; template: "marigold" | "slice_yard" };
const MK: Place = { org: newUuid(), prefix: newStorePrefix(), owner: newUuid(), template: "marigold" };
const SY: Place = { org: newUuid(), prefix: newStorePrefix(), owner: newUuid(), template: "slice_yard" };

type Row = Record<string, any>;

describe("delivery commissions in the books", () => {
  const clients = new Map<string, BooksClient>();
  const loaded = new Map<string, SeededBooks>();
  const client = (r: Place) => clients.get(r.org) as BooksClient;

  /**
   * Loads and posts the demo numbers the way the reset does. Other test runs share this database
   * and one of them may switch a loader off while it works. A load is repeatable, so it is simply
   * run again. Nothing below relies on how much one particular attempt posted.
   */
  const load = async (r: Place): Promise<SeededBooks> => {
    for (let attempt = 1; ; attempt++) {
      try {
        const { books } = await seedDemoBooks(adminDb(), { orgUuid: r.org, template: r.template, ownerUserId: r.owner, withSales: true });
        if (!books) throw new Error("No numbers were loaded");
        return books;
      } catch (e) {
        if (attempt >= 5 || !String(e).includes("unauthenticated")) throw e;
      }
    }
  };

  /**
   * A published mini-app of this test's own to read the reports with (and to try two bills by
   * hand). The loader itself is switched off after every load, as it should be.
   */
  const reader = async (r: Place): Promise<BooksClient> => {
    const [appUuid, versionUuid] = [newUuid(), newUuid()];
    const manifest = JSON.stringify({ ...booksManifest(), name: "Delivery check", description: "Reads the reports back in a test." });
    await adminDb().begin(async (tx) => {
      const [next] = await tx<{ n: number }[]>`select coalesce(max(number), 0) + 1 as n from platform.apps where org_id = ${r.org}`;
      await tx`insert into platform.apps (id, org_id, slug, number, name, kind, status) values (${appUuid}, ${r.org}, 'delivery-check', ${next?.n ?? 1}, 'Delivery check', 'custom', 'published')`;
      await tx`insert into platform.app_versions (id, app_id, org_id, number, manifest, status, summary)
               values (${versionUuid}, ${appUuid}, ${r.org}, 1, ${manifest}::text::jsonb, 'published', 'Reads the reports back')`;
      await tx`update platform.apps set current_version_id = ${versionUuid}, published_version_id = ${versionUuid} where id = ${appUuid} and org_id = ${r.org}`;
    });
    // The same context a signed app token would give: this restaurant, its owner, live data.
    const tenant: TenantContext = {
      orgId: toPublicId("org", r.org), storePrefix: r.prefix, actor: { type: "user", id: toPublicId("usr", r.owner) }, role: "owner", locations: "all", env: "live",
      appId: toPublicId("app", appUuid), appVersionId: toPublicId("ver", versionUuid),
    };
    return async (route, body) => {
      const reply = await handleData(route, tenant, body, newUuid());
      if (reply.status !== 200) throw new Error(`${route} was refused (${reply.status}): ${JSON.stringify(reply.body).slice(0, 600)}`);
      return reply.body;
    };
  };
  const named = async (r: Place, query: string, params: Record<string, unknown> = {}): Promise<Row[]> => ((await client(r)("named", { query, params })) as { rows: Row[] }).rows;
  const pnl = async (r: Place, weekOf: string, locationId?: string) => {
    const rows = await named(r, "weekly_pnl", { week_of: weekOf, ...(locationId ? { location_id: locationId } : {}) });
    return {
      rows,
      account: (code: string) => rows.find((x) => x.line_kind === "account" && x.account_code === code),
      total: (section: string) => rows.find((x) => x.line_kind === "section_total" && x.section === section),
      summary: (name: string) => rows.find((x) => x.line_kind === "summary" && x.section === name),
    };
  };
  /** Straight from the restaurant's own tables, as its own role. */
  const raw = (r: Place, sql: (table: (model: string) => string) => string): Promise<Row[]> => {
    const ctx: TenantContext = { orgId: toPublicId("org", r.org), storePrefix: r.prefix, actor: { type: "system", id: "delivery-test" }, role: "owner", locations: "all", env: "live" };
    return withStore(adminDb(), ctx, async (tx, store) => (await tx.unsafe(sql((m) => store.table(m)))) as unknown as Row[]);
  };
  const ledger = async (r: Place) => {
    const [row] = await raw(r, (t) => `select (select count(*)::int from ${t("journal_entry")}) as entries, (select count(*)::int from ${t("journal_line")}) as lines, (select count(*)::int from ${t("vendor_bill")}) as bills, (select count(*)::int from ${t("vendor")}) as vendors, (select count(*)::int from ${t("account")}) as accounts`);
    return row as Row;
  };

  beforeAll(async () => {
    const sql = adminDb();
    await installPlatformLibrary(sql);
    for (const r of [MK, SY]) {
      await createDemoRestaurant(sql, { template: r.template, orgUuid: r.org, storePrefix: r.prefix });
      loaded.set(r.org, await load(r));
      clients.set(r.org, await reader(r));
    }
  }, 900_000);

  afterAll(async () => {
    await removeRestaurants(adminDb(), [MK.org, SY.org]);
    await closeAll();
  }, 120_000);

  it("every statement was recorded as a bill from the delivery company and posted", async () => {
    for (const [r, g] of [[MK, M], [SY, S]] as const) {
      const statements = deliveryStatements(g);
      const first = loaded.get(r.org) as SeededBooks;
      expect(first.rows.vendor_bill).toBe(g.vendorBills.length + statements.length);
      // Every bill, the statements among them, has its one entry in the books.
      const [posted] = await raw(r, (t) => `select count(*)::int as n from ${t("journal_entry")} where origin = 'vendor_bill'`);
      expect(posted?.n).toBe(first.rows.vendor_bill);
      const [row] = await raw(
        r,
        (t) => `select count(distinct e.id)::int as entries, count(*)::int as lines, sum(l.debit)::bigint as debits, sum(l.credit)::bigint as credits
                from ${t("journal_line")} l join ${t("journal_entry")} e on e.id = l.entry join ${t("account")} a on a.id = l.account
                where a.code = '${DELIVERY_COMMISSIONS_ACCOUNT_CODE}' and e.origin = 'vendor_bill'`,
      );
      expect(row?.entries).toBe(statements.length);
      expect(row?.lines).toBe(statements.flatMap((s) => s.lines).length);
      expect(Number(row?.debits)).toBe(sum(statements.map((s) => s.totalMinor)));
      expect(Number(row?.credits)).toBe(0);
      const vendors = await raw(r, (t) => `select v.name, a.code from ${t("vendor")} v join ${t("account")} a on a.id = v.default_account order by v.name`);
      expect(vendors).toEqual([{ name: "Ferrymeal", code: "7500" }, { name: "Trolleybite", code: "7500" }]);
    }
  });

  it("the chart has the account once, as a running cost", async () => {
    for (const r of [MK, SY]) {
      const rows = await raw(r, (t) => `select code, name, type, report_section from ${t("account")} where name ilike '%delivery%' and type = 'expense'`);
      expect(rows).toEqual([{ code: "7500", name: "Delivery platform commissions and fees", type: "expense", report_section: "controllable" }]);
    }
  });

  describe("Marigold, week of Monday 2026-11-09", () => {
    const WEEK = { from_date: "2026-11-09", to_date: "2026-11-15" };

    it("unchanged: net sales $84,310.00, food and drink $25,460.00 (30.2%), staff $26,220.00 (31.1%), prime cost 61.3%", async () => {
      const rows = await named(MK, "prime_cost_by_week", WEEK);
      const all = rows.filter((x) => x.scope === "all_locations");
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({
        net_sales: usd(84_310), cost_of_goods: usd(25_460), labour: usd(26_220), prime_cost: usd(51_680),
        cost_of_goods_pct: "30.2", labour_pct: "31.1", prime_cost_pct: "61.3", stock_counted: true,
      });
      expect(Object.fromEntries(rows.filter((x) => x.scope === "location").map((x) => [x.location_name, x.net_sales]))).toEqual({ Downtown: usd(51_870), Riverside: usd(32_440) });
    });

    it("unchanged: the seven daily totals", async () => {
      const rows = await named(MK, "sales_by_day", { week_of: "2026-11-09" });
      expect(rows.map((x) => [x.business_date, x.net_sales])).toEqual([
        ["2026-11-09", usd(8_140)], ["2026-11-10", usd(8_960)], ["2026-11-11", usd(9_870)], ["2026-11-12", usd(11_420)],
        ["2026-11-13", usd(15_830)], ["2026-11-14", usd(17_950)], ["2026-11-15", usd(12_140)],
      ]);
    });

    it("the profit and loss has a delivery commissions line of $1,306.56, and net profit after it is $29,885.45", async () => {
      const p = await pnl(MK, "2026-11-09");
      expect(p.account("7500")).toMatchObject({ section: "controllable", account_name: "Delivery platform commissions and fees", amount: usd(1_306.56), pct_of_net_sales: "1.5" });
      expect(p.total("controllable")?.amount).toBe(usd(1_437.99) + usd(1_306.56));
      expect(p.summary("net_profit")).toMatchObject({ amount: usd(29_885.45), pct_of_net_sales: "35.4" });
      // Net profit is sales less every cost on the report, the new line included.
      const costs = sum(p.rows.filter((x) => x.line_kind === "section_total" && !["sales", "other_income"].includes(x.section)).map((x) => x.amount as number));
      expect(usd(84_310) - costs).toBe(usd(29_885.45));
      expect(usd(29_885.45) + usd(1_306.56)).toBe(usd(31_192.01)); // what the report said before
      // The lines above it did not move.
      expect(p.total("sales")?.amount).toBe(usd(84_310));
      expect(p.total("cost_of_goods")?.amount).toBe(usd(25_460));
      expect(p.total("labour")?.amount).toBe(usd(26_220));
      expect(p.summary("gross_profit")?.amount).toBe(usd(58_850));
      expect(p.summary("prime_cost")).toMatchObject({ amount: usd(51_680), pct_of_net_sales: "61.3", stock_counted: true });
      // On the report it comes after prime cost and before net profit.
      const at = (x: Row | undefined) => p.rows.indexOf(x as Row);
      expect(at(p.account("7500"))).toBeGreaterThan(at(p.summary("prime_cost")));
      expect(at(p.account("7500"))).toBeLessThan(at(p.summary("net_profit")));
    });

    it("the line is split by location, and each location's share is what its own statements say", async () => {
      const places = ((await client(MK)("query", { model: "parent.locations", limit: 10 })) as { rows: Row[] }).rows;
      const week = deliveryStatements(M).filter((s) => s.periodStart === LAST);
      let total = 0;
      for (const l of M.locations) {
        const id = places.find((x) => x.name === l.name)?.id as string | undefined;
        if (!id) throw new Error(`No location ${l.name}`);
        const line = (await pnl(MK, "2026-11-09", id)).account("7500");
        expect(line?.amount).toBe(sum(week.filter((s) => s.locationKey === l.key).map((s) => s.totalMinor)));
        total += line?.amount as number;
      }
      expect(total).toBe(usd(1_306.56));
    });

    it("the books agree with the payout statements: what the apps kept is the same number in both", async () => {
      // The library is installed again first, so this reads the report as this code defines it
      // even if another test run stored its own copy in the meantime.
      await installPlatformLibrary(adminDb());
      const rows = await named(MK, "delivery_payout_reconciliation", WEEK);
      expect(rows).toHaveLength(4);
      for (const x of rows) {
        expect(x.net_difference).toBe(0);
        expect(x.collected_difference).toBe(0);
        expect(x.kept_by_platform).toBe(x.commission + x.fees + x.refunds_and_errors);
        expect(x.statement_collected + x.kept_by_platform).toBe(x.net_paid);
      }
      expect(-sum(rows.map((x) => x.kept_by_platform as number))).toBe(usd(1_306.56));
      expect(-sum(rows.map((x) => x.commission as number))).toBe(usd(1_205.95));
    });
  });

  it("Marigold: every weekly net sales total is unchanged, and the slow week of 2026-10-19 keeps $61,480 with lower commissions", async () => {
    const rows = (await named(MK, "prime_cost_by_week")).filter((x) => x.scope === "all_locations");
    expect(rows.map((x) => [x.week_start, x.net_sales])).toEqual(WEEKS.map((w, i) => [w, NET_SALES.marigold[i]]));
    for (const [i, w] of WEEKS.entries()) expect((await pnl(MK, w)).account("7500")?.amount, w).toBe(KEPT.marigold[i]);
    const dip = await named(MK, "prime_cost_by_week", { from_date: "2026-10-19", to_date: "2026-10-25" });
    expect(dip.find((x) => x.scope === "all_locations")).toMatchObject({ net_sales: usd(61_480), prime_cost_pct: "64.1" });
    expect((await pnl(MK, "2026-10-19")).summary("net_profit")?.amount).toBe(usd(19_881.99));
  });

  it("Slice Yard, last week: $28,750 and 55.3% are unchanged, commissions are $2,369.25 and net profit is $9,396.23", async () => {
    const [week] = (await named(SY, "prime_cost_by_week", { from_date: "2026-11-09", to_date: "2026-11-15" })).filter((x) => x.scope === "all_locations");
    expect(week).toMatchObject({ net_sales: usd(28_750), cost_of_goods: usd(8_150), labour: usd(7_743), prime_cost: usd(15_893), prime_cost_pct: "55.3", stock_counted: true });
    const p = await pnl(SY, "2026-11-09");
    expect(p.account("7500")).toMatchObject({ section: "controllable", amount: usd(2_369.25), pct_of_net_sales: "8.2" });
    expect(p.summary("net_profit")).toMatchObject({ amount: usd(9_396.23), pct_of_net_sales: "32.7" });
    expect(p.summary("prime_cost")).toMatchObject({ amount: usd(15_893), pct_of_net_sales: "55.3" });
    expect((await named(SY, "prime_cost_by_week")).filter((x) => x.scope === "all_locations").map((x) => x.net_sales)).toEqual(NET_SALES.slice_yard);
  });

  it("the books balance, entry by entry, and what is owed for the statements matches the cost", async () => {
    for (const r of [MK, SY]) {
      const [bad] = await raw(r, (t) => `select count(*)::int as n from (select entry from ${t("journal_line")} group by entry having sum(debit) <> sum(credit)) x`);
      expect(bad?.n).toBe(0);
      // Each statement's entry: the cost on one side, the same amount owed to the delivery company on the other.
      const [odd] = await raw(
        r,
        (t) => `select count(*)::int as n from ${t("vendor_bill")} b join ${t("vendor")} v on v.id = b.vendor
                where v.name in ('Ferrymeal', 'Trolleybite')
                  and b.total_amount is distinct from (
                    select sum(l.credit) from ${t("journal_line")} l join ${t("journal_entry")} e on e.id = l.entry join ${t("account")} a on a.id = l.account
                    where e.origin = 'vendor_bill' and e.origin_id = b.id::text and a.code = '2000')`,
      );
      expect(odd?.n).toBe(0);
    }
  });

  it("loading twice adds nothing", async () => {
    for (const r of [MK, SY]) {
      const before = await ledger(r);
      const again = await load(r);
      expect(again.rows).toEqual(loaded.get(r.org)?.rows);
      expect(again.posted).toEqual({ salesDays: 0, vendorBills: 0, labourDays: 0, stockCounts: 0 });
      expect(again.setUp).toEqual({ accountsAndRules: 0, calendar: 0 });
      expect(await ledger(r)).toEqual(before);
    }
    expect((await pnl(MK, "2026-11-09")).account("7500")?.amount).toBe(usd(1_306.56));
    expect((await pnl(MK, "2026-11-09")).summary("net_profit")?.amount).toBe(usd(29_885.45));
  }, 600_000);

  it("a statement dated in a closed period is refused, and one in an open period is posted once", async () => {
    const c = client(MK);
    const periods = ((await c("query", { model: "fiscal_period", limit: 50 })) as { rows: Row[] }).rows;
    const october = periods.find((x) => x.start_date === "2026-10-01");
    expect(october?.status).toBe("open");
    await c("batch", { ops: [{ op: "update", model: "fiscal_period", id: october?.id, values: { status: "closed" } }] });

    const [place] = ((await c("query", { model: "parent.locations", limit: 10 })) as { rows: Row[] }).rows;
    const [vendor] = ((await c("query", { model: "vendor", where: { field: "name", op: "eq", value: "Ferrymeal" }, limit: 1 })) as { rows: Row[] }).rows;
    const [account] = ((await c("query", { model: "account", where: { field: "code", op: "eq", value: "7500" }, limit: 1 })) as { rows: Row[] }).rows;
    const statement = async (billNumber: string, businessDate: string): Promise<string> => {
      const bill = newUuid();
      await c("batch", {
        ops: [
          { op: "insert", model: "vendor_bill", id: bill, values: { location_id: place?.id, vendor: vendor?.id, bill_number: billNumber, business_date: businessDate, total_amount: 4_200, status: "open" } },
          { op: "insert", model: "vendor_bill_line", values: { location_id: place?.id, vendor_bill: bill, line_number: 1, description: "Commission at 25%", account: account?.id, amount: 4_200 } },
        ],
      });
      return bill;
    };

    const before = await ledger(MK);
    const closed = await statement("FER-TEST-CLOSED", "2026-10-20");
    await expect(c("action", { action: "post_vendor_bill", params: { vendor_bill_id: closed } })).rejects.toThrow();
    expect(await ledger(MK)).toEqual({ ...before, bills: before.bills + 1 });

    const open = await statement("FER-TEST-OPEN", "2026-11-12");
    expect(((await c("action", { action: "post_vendor_bill", params: { vendor_bill_id: open } })) as { affected: number }).affected).toBe(3);
    expect(((await c("action", { action: "post_vendor_bill", params: { vendor_bill_id: open } })) as { affected: number }).affected).toBe(0);
    expect(await ledger(MK)).toEqual({ ...before, bills: before.bills + 2, entries: before.entries + 1, lines: before.lines + 2 });
    expect((await pnl(MK, "2026-11-09")).account("7500")?.amount).toBe(usd(1_306.56) + 4_200);
    // Still unchanged: a delivery statement can never move prime cost.
    const [week] = (await named(MK, "prime_cost_by_week", { from_date: "2026-11-09", to_date: "2026-11-15" })).filter((x) => x.scope === "all_locations");
    expect(week).toMatchObject({ net_sales: usd(84_310), prime_cost: usd(51_680), prime_cost_pct: "61.3" });
  });
});

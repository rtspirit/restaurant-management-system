import { describe, expect, it } from "vitest";
import { addDays, allocate } from "./rng.js";
import { type GeneratedSales, type SalesDay, generateSales } from "./sales.js";

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const usd = (d: number) => Math.round(d * 100);
const M = generateSales("marigold", { weeks: 8, endingOn: "2026-11-15" });
const S = generateSales("slice_yard", { weeks: 8, endingOn: "2026-11-15" });

const moneyFields = (d: SalesDay): number[] => [
  d.grossSalesMinor, d.discountsMinor, d.compsMinor, d.netSalesMinor, d.salesTaxMinor, d.marketplaceTaxMinor, d.tipsMinor,
  d.giftCardsSoldMinor, d.giftCardsRedeemedMinor, d.costOfGoodsMinor, d.labourCostMinor,
  ...d.categories.flatMap((c) => [c.grossMinor, c.discountsMinor, c.compsMinor, c.netMinor]),
  ...d.discounts.map((x) => x.amountMinor), ...d.comps.map((x) => x.amountMinor), ...d.voids.map((x) => x.amountMinor),
  ...d.payments.map((x) => x.amountMinor), ...d.labour.map((x) => x.costMinor),
  ...d.deliverySales.flatMap((x) => [x.netMinor, x.tipsMinor]),
];

const weekNet = (g: GeneratedSales) => g.weeks.map((w) => w.netSalesMinor);

describe("allocate", () => {
  it("splits exactly and proportionally", () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(sum(allocate(5_187_000, [0.3, 0.2, 0.5]))).toBe(5_187_000);
    expect(() => allocate(1.5, [1])).toThrow();
    expect(() => allocate(10, [0, 1])).toThrow();
  });
});

describe.each([
  ["Marigold", M],
  ["Slice Yard", S],
] as const)("generateSales: %s", (_name, g) => {
  it("covers eight Monday-to-Sunday weeks, every day, every location", () => {
    expect(g.startsOn).toBe("2026-09-21");
    expect(g.endsOn).toBe("2026-11-15");
    expect(g.weeks).toHaveLength(8);
    expect(g.days).toHaveLength(56 * g.locations.length);
    expect(new Set(g.days.map((d) => `${d.businessDate}|${d.locationKey}`)).size).toBe(g.days.length);
  });

  it("is deterministic: same input, same numbers", () => {
    expect(generateSales(g.template, { weeks: 8, endingOn: "2026-11-15" })).toEqual(g);
    expect(generateSales(g.template)).toEqual(g);
  });

  it("money is whole cents, never negative", () => {
    for (const d of g.days) for (const m of moneyFields(d)) expect(Number.isSafeInteger(m) && m >= 0).toBe(true);
  });

  it("every day balances to the cent: net + tax + tips + gift cards sold = payments + gift cards redeemed", () => {
    for (const d of g.days) {
      const left = d.netSalesMinor + d.salesTaxMinor + d.tipsMinor + d.giftCardsSoldMinor;
      const right = sum(d.payments.map((p) => p.amountMinor)) + d.giftCardsRedeemedMinor;
      expect(right).toBe(left);
    }
  });

  it("gross, discounts, comps and net agree by category, by reason and in total", () => {
    for (const d of g.days) {
      for (const c of d.categories) expect(c.grossMinor - c.discountsMinor - c.compsMinor).toBe(c.netMinor);
      expect(sum(d.categories.map((c) => c.netMinor))).toBe(d.netSalesMinor);
      expect(sum(d.categories.map((c) => c.grossMinor))).toBe(d.grossSalesMinor);
      expect(d.grossSalesMinor - d.discountsMinor - d.compsMinor).toBe(d.netSalesMinor);
      expect(sum(d.discounts.map((x) => x.amountMinor))).toBe(d.discountsMinor);
      expect(sum(d.comps.map((x) => x.amountMinor))).toBe(d.compsMinor);
      expect(d.discounts.every((x) => x.reason.length > 0) && d.comps.every((x) => x.reason.length > 0)).toBe(true);
      expect(sum(d.labour.map((l) => l.costMinor))).toBe(d.labourCostMinor);
      expect(d.discountsMinor / d.grossSalesMinor).toBeLessThan(0.05);
    }
  });

  it("weekly and per-location summaries add up from the days", () => {
    for (const w of g.weeks) {
      const mine = g.days.filter((d) => d.weekStart === w.weekStart);
      expect(sum(mine.map((d) => d.netSalesMinor))).toBe(w.netSalesMinor);
      expect(sum(mine.map((d) => d.costOfGoodsMinor))).toBe(w.costOfGoodsMinor);
      expect(sum(mine.map((d) => d.labourCostMinor))).toBe(w.labourCostMinor);
      expect(sum(w.byLocation.map((l) => l.netSalesMinor))).toBe(w.netSalesMinor);
    }
  });

  it("weekends are busier: Friday and Saturday beat every Monday to Thursday", () => {
    for (const w of g.weeks) {
      const days = [...new Set(g.days.filter((d) => d.weekStart === w.weekStart).map((d) => d.businessDate))].sort();
      const net = days.map((date) => sum(g.days.filter((d) => d.businessDate === date).map((d) => d.netSalesMinor)));
      const weekday = Math.max(...net.slice(0, 4));
      expect(net[4]).toBeGreaterThan(weekday);
      expect(net[5]).toBeGreaterThan(weekday);
      expect(net[6]).toBeGreaterThan(sum(net.slice(0, 4)) / 4);
    }
  });

  it("exactly one week has an obvious dip, 25 to 30 percent below the others", () => {
    const nets = weekNet(g);
    const sorted = [...nets].sort((a, b) => a - b);
    const median = ((sorted[3] as number) + (sorted[4] as number)) / 2;
    const dips = nets.filter((n) => n < 0.85 * median);
    expect(dips).toHaveLength(1);
    const dip = dips[0] as number;
    const others = nets.filter((n) => n !== dip);
    const drop = 1 - dip / (sum(others) / others.length);
    expect(drop).toBeGreaterThanOrEqual(0.25);
    expect(drop).toBeLessThanOrEqual(0.3);
    for (const n of others) expect(Math.abs(n / median - 1)).toBeLessThan(0.05);
  });

  it("delivery payouts reconcile with delivery sales, and commissions only appear on the payout", () => {
    for (const p of g.deliveryPayouts) {
      expect(sum(p.lines.map((l) => l.amountMinor))).toBe(p.payoutMinor);
      const mine = g.days
        .filter((d) => d.locationKey === p.locationKey && d.businessDate >= p.periodStart && d.businessDate <= p.periodEnd)
        .flatMap((d) => d.payments.filter((x) => x.type === "delivery_platform" && x.platform === p.platform));
      const salesAndTips = sum(p.lines.filter((l) => l.type === "sales" || l.type === "tips").map((l) => l.amountMinor));
      expect(sum(mine.map((x) => x.amountMinor))).toBe(salesAndTips);
      expect(p.lines.find((l) => l.type === "commission")!.amountMinor).toBeLessThan(0);
      expect(p.payoutMinor).toBeLessThan(salesAndTips);
    }
    expect(g.deliveryPayouts.some((p) => p.status === "pending")).toBe(true);
    expect(g.deliveryPayouts.filter((p) => p.status === "pending").every((p) => p.periodStart === "2026-11-09")).toBe(true);
  });

  it("vendor bills are purchases: a few lumpy deliveries a week, lines that add up", () => {
    for (const b of g.vendorBills) {
      expect(b.lines.length).toBeGreaterThan(0);
      for (const l of b.lines) {
        expect(l.quantity).toBeGreaterThan(0);
        expect(Math.abs(l.quantity * l.unitPriceMinor - l.amountMinor)).toBeLessThanOrEqual(0.5 + 1e-6);
        expect(["food", "beverage", "alcohol", "supplies"]).toContain(l.costGroup);
        expect(Number.isSafeInteger(l.amountMinor)).toBe(true);
      }
      expect(sum(b.lines.map((l) => l.amountMinor))).toBe(b.totalMinor);
      expect(b.dueDate > b.billDate).toBe(true);
      expect(b.billDate >= g.startsOn && b.billDate <= g.endsOn).toBe(true);
    }
    expect(new Set(g.vendorBills.map((b) => b.billNumber)).size).toBe(g.vendorBills.length);
    for (const w of g.weeks) {
      for (const loc of g.locations) {
        const bills = g.vendorBills.filter((b) => b.locationKey === loc.key && b.billDate >= w.weekStart && b.billDate <= w.weekEnd);
        expect(bills.length).toBeGreaterThanOrEqual(3);
        expect(bills.length).toBeLessThanOrEqual(12);
        // Bigger deliveries before the weekend: Thursday and Friday carry more than Monday to Wednesday.
        const value = (from: number, to: number) =>
          sum(bills.filter((b) => { const d = (Date.parse(b.billDate) - Date.parse(w.weekStart)) / 86_400_000; return d >= from && d <= to; }).map((b) => b.totalMinor));
        expect(value(3, 4)).toBeGreaterThan(value(0, 2) * 0.8);
      }
    }
  });

  it("stock items: one list, fictional names, whole-cent unit costs", () => {
    expect(g.items.length).toBeGreaterThanOrEqual(g.template === "marigold" ? 28 : 13);
    expect(g.items.length).toBeLessThanOrEqual(g.template === "marigold" ? 36 : 18);
    expect(new Set(g.items.map((i) => i.key)).size).toBe(g.items.length);
    for (const i of g.items) {
      expect(["food", "beverage", "alcohol", "supplies"]).toContain(i.costGroup);
      expect(["kg", "l", "each", "case", "bottle"]).toContain(i.unit);
      expect(Number.isSafeInteger(i.unitCostMinor) && i.unitCostMinor > 0).toBe(true);
    }
  });

  it("stock counts: an opening count the Sunday before, then every week-ending Sunday, per location", () => {
    for (const loc of g.locations) {
      const counts = g.stockCounts.filter((c) => c.locationKey === loc.key);
      expect(counts.map((c) => c.countedOn)).toEqual([
        "2026-09-20", "2026-09-27", "2026-10-04", "2026-10-11", "2026-10-18", "2026-10-25", "2026-11-01", "2026-11-08", "2026-11-15",
      ]);
      expect(counts.map((c) => c.kind)).toEqual(["opening", ...Array(8).fill("week_end")]);
      for (const c of counts) {
        expect(c.lines.map((l) => l.itemKey)).toEqual(g.items.map((i) => i.key));
        for (const l of c.lines) {
          expect(l.quantity).toBeGreaterThanOrEqual(0);
          expect(Math.abs(l.quantity * l.unitCostMinor - l.valueMinor)).toBeLessThanOrEqual(0.5 + 1e-6);
          expect(Number.isSafeInteger(l.valueMinor) && l.valueMinor >= 0).toBe(true);
        }
        for (const grp of c.byCostGroup) expect(sum(c.lines.filter((l) => l.costGroup === grp.costGroup).map((l) => l.valueMinor))).toBe(grp.valueMinor);
        expect(sum(c.lines.map((l) => l.valueMinor))).toBe(c.totalValueMinor);
        expect(sum(c.byCostGroup.map((x) => x.valueMinor))).toBe(c.totalValueMinor);
      }
    }
    // A few items are at zero now and then.
    expect(g.stockCounts.flatMap((c) => c.lines).some((l) => l.quantity === 0)).toBe(true);
  });

  it("usage = opening count + purchases - closing count, to the cent, per location, week and cost group", () => {
    for (const w of g.weeks) {
      for (const loc of w.byLocation) {
        const opening = g.stockCounts.find((c) => c.locationKey === loc.locationKey && c.countedOn === addDays(w.weekStart, -1))!;
        const closing = g.stockCounts.find((c) => c.locationKey === loc.locationKey && c.countedOn === w.weekEnd)!;
        const bills = g.vendorBills.filter((b) => b.locationKey === loc.locationKey && b.billDate >= w.weekStart && b.billDate <= w.weekEnd);
        for (const row of loc.stock.byCostGroup) {
          const open = opening.byCostGroup.find((x) => x.costGroup === row.costGroup)!.valueMinor;
          const close = closing.byCostGroup.find((x) => x.costGroup === row.costGroup)!.valueMinor;
          const bought = sum(bills.flatMap((b) => b.lines).filter((l) => l.costGroup === row.costGroup).map((l) => l.amountMinor));
          expect([row.openingStockMinor, row.closingStockMinor, row.purchasesMinor]).toEqual([open, close, bought]);
          expect(row.usageMinor).toBe(open + bought - close);
          expect(row.usageMinor).toBeGreaterThanOrEqual(0);
          expect(row.purchasesMinor).toBeGreaterThanOrEqual(0);
        }
        const s = loc.stock;
        expect(s.usageMinor).toBe(s.openingStockMinor + s.purchasesMinor - s.closingStockMinor);
        const foodAndDrink = loc.stock.byCostGroup.filter((r) => r.costGroup !== "supplies");
        expect(sum(foodAndDrink.map((r) => r.usageMinor))).toBe(loc.costOfGoodsMinor);
        expect(sum(g.days.filter((d) => d.weekStart === w.weekStart && d.locationKey === loc.locationKey).map((d) => d.costOfGoodsMinor))).toBe(loc.costOfGoodsMinor);
        // Stock on hand is about one to two weeks of use.
        const onHand = sum(foodAndDrink.map((r) => r.closingStockMinor)) / loc.costOfGoodsMinor;
        expect(onHand).toBeGreaterThanOrEqual(1);
        expect(onHand).toBeLessThanOrEqual(2);
      }
      const all = w.stock;
      expect(all.usageMinor).toBe(all.openingStockMinor + all.purchasesMinor - all.closingStockMinor);
      expect(sum(all.byCostGroup.filter((r) => r.costGroup !== "supplies").map((r) => r.usageMinor))).toBe(w.costOfGoodsMinor);
      expect(sum(w.byLocation.map((l) => l.costOfGoodsMinor))).toBe(w.costOfGoodsMinor);
    }
  });

  it("labour hours are believable", () => {
    for (const d of g.days) for (const l of d.labour) expect(l.hours).toBeGreaterThan(0);
  });
});

describe("Marigold: the numbers on the approved sketches", () => {
  const week = (start: string) => M.weeks.find((w) => w.weekStart === start)!;
  const nov9 = M.days.filter((d) => d.weekStart === "2026-11-09");

  it("the eight weekly net totals, by week start", () => {
    expect(M.weeks.map((w) => [w.weekStart, w.netSalesMinor])).toEqual([
      ["2026-09-21", usd(81_940)],
      ["2026-09-28", usd(83_120)],
      ["2026-10-05", usd(82_560)],
      ["2026-10-12", usd(84_870)],
      ["2026-10-19", usd(61_480)],
      ["2026-10-26", usd(80_230)],
      ["2026-11-02", usd(83_790)],
      ["2026-11-09", usd(84_310)],
    ]);
  });

  it("week of 9 November: $84,310.00 net, Downtown $51,870.00, Riverside $32,440.00", () => {
    expect(sum(nov9.map((d) => d.netSalesMinor))).toBe(usd(84_310));
    expect(sum(nov9.filter((d) => d.locationName === "Downtown").map((d) => d.netSalesMinor))).toBe(usd(51_870));
    expect(sum(nov9.filter((d) => d.locationName === "Riverside").map((d) => d.netSalesMinor))).toBe(usd(32_440));
    expect(week("2026-11-09").byLocation).toEqual([
      expect.objectContaining({ locationKey: "downtown", netSalesMinor: usd(51_870) }),
      expect.objectContaining({ locationKey: "riverside", netSalesMinor: usd(32_440) }),
    ]);
  });

  it("week of 9 November: daily totals Mon to Sun", () => {
    const dates = ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"];
    const daily = dates.map((date) => sum(nov9.filter((d) => d.businessDate === date).map((d) => d.netSalesMinor)));
    expect(daily).toEqual([8_140, 8_960, 9_870, 11_420, 15_830, 17_950, 12_140].map(usd));
  });

  it("week of 9 November: cost of goods $25,460 and labour $26,220", () => {
    expect(sum(nov9.map((d) => d.costOfGoodsMinor))).toBe(usd(25_460));
    expect(sum(nov9.map((d) => d.labourCostMinor))).toBe(usd(26_220));
  });

  it("week of 9 November, worked: opening + purchases - closing = $25,460.00 of food and drink, prime cost 61.3%", () => {
    const w = week("2026-11-09");
    const fd = w.stock.byCostGroup.filter((r) => r.costGroup !== "supplies");
    const opening = sum(M.stockCounts.filter((c) => c.countedOn === "2026-11-08").flatMap((c) => c.lines).filter((l) => l.costGroup !== "supplies").map((l) => l.valueMinor));
    const closing = sum(M.stockCounts.filter((c) => c.countedOn === "2026-11-15").flatMap((c) => c.lines).filter((l) => l.costGroup !== "supplies").map((l) => l.valueMinor));
    const purchases = sum(
      M.vendorBills.filter((b) => b.billDate >= "2026-11-09" && b.billDate <= "2026-11-15").flatMap((b) => b.lines).filter((l) => l.costGroup !== "supplies").map((l) => l.amountMinor),
    );
    expect(opening + purchases - closing).toBe(usd(25_460));
    expect(sum(fd.map((r) => r.usageMinor))).toBe(usd(25_460));
    expect(w.costOfGoodsMinor).toBe(usd(25_460));
    expect(((w.costOfGoodsMinor + w.labourCostMinor) / w.netSalesMinor).toFixed(3)).toBe("0.613");
    // Purchases in a week need not equal usage.
    expect(sum(fd.map((r) => r.purchasesMinor))).not.toBe(usd(25_460));
  });

  it("the dip is the week starting 19 October at $61,480", () => {
    const nets = weekNet(M);
    expect(Math.min(...nets)).toBe(usd(61_480));
    expect(week("2026-10-19").netSalesMinor).toBe(usd(61_480));
  });

  it("cost of goods near 30%, labour near 31%, prime cost near 61%", () => {
    for (const w of M.weeks) {
      expect(w.costOfGoodsMinor / w.netSalesMinor).toBeGreaterThan(0.285);
      expect(w.costOfGoodsMinor / w.netSalesMinor).toBeLessThan(0.315);
      if (w.weekStart !== "2026-10-19") {
        expect(w.labourCostMinor / w.netSalesMinor).toBeGreaterThan(0.295);
        expect(w.labourCostMinor / w.netSalesMinor).toBeLessThan(0.325);
      }
    }
    const net = sum(M.weeks.map((w) => w.netSalesMinor));
    const cogs = sum(M.weeks.map((w) => w.costOfGoodsMinor)) / net;
    const labour = sum(M.weeks.map((w) => w.labourCostMinor)) / net;
    expect(Math.abs(cogs - 0.3)).toBeLessThan(0.01);
    expect(Math.abs(labour - 0.31)).toBeLessThan(0.01);
    expect(Math.abs(cogs + labour - 0.61)).toBeLessThan(0.015);
  });

  it("has two locations with Downtown the bigger one", () => {
    expect(M.locations.map((l) => l.name)).toEqual(["Downtown", "Riverside"]);
    for (const w of M.weeks) expect(w.byLocation[0]!.netSalesMinor).toBeGreaterThan(w.byLocation[1]!.netSalesMinor);
  });
});

describe("Slice Yard runs leaner", () => {
  it("prime cost near 55%, below Marigold's", () => {
    const net = sum(S.weeks.map((w) => w.netSalesMinor));
    const prime = (sum(S.weeks.map((w) => w.costOfGoodsMinor)) + sum(S.weeks.map((w) => w.labourCostMinor))) / net;
    expect(Math.abs(prime - 0.55)).toBeLessThan(0.015);
    const mNet = sum(M.weeks.map((w) => w.netSalesMinor));
    const mPrime = (sum(M.weeks.map((w) => w.costOfGoodsMinor)) + sum(M.weeks.map((w) => w.labourCostMinor))) / mNet;
    expect(prime).toBeLessThan(mPrime - 0.03);
  });

  it("has one location and a bigger share of delivery", () => {
    expect(S.locations).toHaveLength(1);
    const share = (g: GeneratedSales) => sum(g.days.flatMap((d) => d.deliverySales.map((x) => x.netMinor))) / sum(g.days.map((d) => d.netSalesMinor));
    expect(share(S)).toBeGreaterThan(share(M) * 3);
  });
});

describe("options", () => {
  it("refuses an end date that is not a Sunday, or a bad week count", () => {
    expect(() => generateSales("marigold", { endingOn: "2026-11-14" })).toThrow(/Sunday/);
    expect(() => generateSales("marigold", { endingOn: "2026-13-01" })).toThrow();
    expect(() => generateSales("marigold", { weeks: 0 })).toThrow();
  });

  it("the sketch figures are pinned to calendar weeks, whatever the range", () => {
    const later = generateSales("marigold", { endingOn: "2026-11-22", weeks: 9 });
    expect(later.weeks.at(-1)!.weekStart).toBe("2026-11-16");
    const nov9 = later.days.filter((d) => d.weekStart === "2026-11-09");
    expect(sum(nov9.map((d) => d.netSalesMinor))).toBe(usd(84_310));
    expect(sum(nov9.filter((d) => d.locationName === "Downtown").map((d) => d.netSalesMinor))).toBe(usd(51_870));
    expect(sum(nov9.map((d) => d.costOfGoodsMinor))).toBe(usd(25_460));
    expect(sum(nov9.map((d) => d.labourCostMinor))).toBe(usd(26_220));
    const dates = ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"];
    expect(dates.map((date) => sum(nov9.filter((d) => d.businessDate === date).map((d) => d.netSalesMinor)))).toEqual(
      [8_140, 8_960, 9_870, 11_420, 15_830, 17_950, 12_140].map(usd),
    );
    // The eight sketch weeks keep their totals; the extra week after them is a typical week.
    expect(later.weeks.slice(0, 8).map((w) => w.netSalesMinor)).toEqual(weekNet(M));
    expect(later.weeks.find((w) => w.weekStart === "2026-10-19")!.netSalesMinor).toBe(usd(61_480));
    const extra = later.weeks.at(-1)!.netSalesMinor;
    expect(extra).toBeGreaterThan(usd(78_000));
    expect(extra).toBeLessThan(usd(87_000));
    // A shorter range that starts inside the pinned weeks still lands on the same numbers.
    const short = generateSales("marigold", { endingOn: "2026-11-15", weeks: 2 });
    expect(short.weeks.map((w) => w.netSalesMinor)).toEqual([usd(83_790), usd(84_310)]);
    expect(short.days.filter((d) => d.weekStart === "2026-11-09")).toEqual(M.days.filter((d) => d.weekStart === "2026-11-09"));
  });

  it("stock counts and purchases are pinned to calendar dates too", () => {
    const short = generateSales("marigold", { endingOn: "2026-11-15", weeks: 2 });
    const longer = generateSales("marigold", { endingOn: "2026-11-29", weeks: 12 });
    for (const date of ["2026-11-08", "2026-11-15"]) {
      const pick = (g: GeneratedSales) => g.stockCounts.filter((c) => c.countedOn === date).map(({ kind: _k, ...rest }) => rest);
      expect(pick(short)).toEqual(pick(M));
      expect(pick(longer)).toEqual(pick(M));
    }
    const nov9Bills = (g: GeneratedSales) => g.vendorBills.filter((b) => b.billDate >= "2026-11-09" && b.billDate <= "2026-11-15");
    expect(nov9Bills(longer)).toEqual(nov9Bills(M));
    expect(longer.weeks.find((w) => w.weekStart === "2026-11-09")).toEqual(M.weeks.find((w) => w.weekStart === "2026-11-09"));
  });

  it.each(["marigold", "slice_yard"] as const)("%s stock identity holds outside the pinned weeks", (t) => {
    const g = generateSales(t, { endingOn: "2027-02-28", weeks: 12 });
    expect(g.stockCounts.filter((c) => c.kind === "opening").every((c) => c.countedOn === "2026-12-06")).toBe(true);
    for (const w of g.weeks) {
      for (const loc of w.byLocation) {
        for (const r of loc.stock.byCostGroup) {
          expect(r.usageMinor).toBe(r.openingStockMinor + r.purchasesMinor - r.closingStockMinor);
          expect(Math.min(r.usageMinor, r.purchasesMinor, r.openingStockMinor, r.closingStockMinor)).toBeGreaterThanOrEqual(0);
        }
        expect(sum(loc.stock.byCostGroup.filter((r) => r.costGroup !== "supplies").map((r) => r.usageMinor))).toBe(loc.costOfGoodsMinor);
      }
    }
  });

  it("more than eight weeks adds typical weeks at the start", () => {
    const g = generateSales("marigold", { weeks: 10 });
    expect(g.weeks).toHaveLength(10);
    expect(g.weeks.slice(2).map((w) => w.netSalesMinor)).toEqual(weekNet(M));
    for (const w of g.weeks.slice(0, 2)) expect(w.netSalesMinor).toBeGreaterThan(usd(78_000));
  });

  it.each(["marigold", "slice_yard"] as const)("%s weeks outside the pinned range follow the same rules, with no extra dip", (t) => {
    const g = generateSales(t, { endingOn: "2027-02-28", weeks: 12 });
    expect(g.weeks.every((w) => w.weekStart > "2026-11-09")).toBe(true);
    for (const d of g.days) {
      expect(d.netSalesMinor + d.salesTaxMinor + d.tipsMinor + d.giftCardsSoldMinor).toBe(sum(d.payments.map((p) => p.amountMinor)) + d.giftCardsRedeemedMinor);
      expect(sum(d.categories.map((c) => c.netMinor))).toBe(d.netSalesMinor);
    }
    const nets = g.weeks.map((w) => w.netSalesMinor);
    const mean = sum(nets) / nets.length;
    for (const n of nets) expect(Math.abs(n / mean - 1)).toBeLessThan(0.06);
    const prime = (sum(g.weeks.map((w) => w.costOfGoodsMinor)) + sum(g.weeks.map((w) => w.labourCostMinor))) / sum(nets);
    expect(Math.abs(prime - (t === "marigold" ? 0.61 : 0.55))).toBeLessThan(0.015);
    for (const w of g.weeks) {
      const days = [...new Set(g.days.filter((d) => d.weekStart === w.weekStart).map((d) => d.businessDate))].sort();
      const net = days.map((date) => sum(g.days.filter((d) => d.businessDate === date).map((d) => d.netSalesMinor)));
      expect(Math.min(net[4]!, net[5]!)).toBeGreaterThan(Math.max(...net.slice(0, 4)));
    }
  });
});

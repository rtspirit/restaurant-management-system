// Eight weeks of believable daily sales for a demo restaurant. PURE: no database, no clock,
// no Math.random. Same template and options, same numbers, to the cent.
//
// The weekly net sales are pinned to calendar weeks (Marigold's match the approved design
// sketches exactly: the week starting Mon 2026-11-09 is always $84,310, whatever range is asked
// for). Weeks outside the pinned range are typical weeks, generated with the same rules.
// Everything else is generated as proportions and then split with exact integer allocation,
// so each day, each location and each week lands on its target with no rounding drift.
//
// Shapes follow docs/plan/02-restaurant-domain.md sections 1.4 (one day of sales) and 1.5
// (delivery platforms). Money is whole cents (`...Minor`), currency USD.
import { type Rng, addDays, allocate, parseDate, rngFor, sum, weekdayIndex } from "./rng.js";
import {
  type CostGroup,
  type StockCount,
  type StockItem,
  type StockMovement,
  type VendorBill,
  FOOD_AND_DRINK,
  closingCount,
  costGroupsFor,
  stockItems,
  weekBills,
  weekUsage,
} from "./stock.js";
import { type DemoTemplate, type SalesGroup, templateSpec } from "./templates.js";

export type { CostGroup, StockCount, StockCountLine, StockItem, StockMovement, StockUnit, VendorBill, VendorBillLine } from "./stock.js";

export type PaymentType = "cash" | "visa" | "mastercard" | "amex" | "discover" | "delivery_platform";
export type LabourGroup = "front" | "back" | "management";

export type CategorySales = {
  category: string;
  salesGroup: SalesGroup;
  grossMinor: number;
  discountsMinor: number;
  compsMinor: number;
  /** gross - discounts - comps */
  netMinor: number;
};
export type ReasonAmount = { reason: string; amountMinor: number };
export type VoidLine = { reason: string; count: number; amountMinor: number };
export type PaymentLine = { type: PaymentType; label: string; platform?: string; amountMinor: number };
export type DeliverySales = { platform: string; label: string; netMinor: number; tipsMinor: number };
export type LabourLine = { group: LabourGroup; hours: number; costMinor: number };

/**
 * One business day at one location. The day balances, to the cent:
 *   netSales + salesTax + tips + giftCardsSold = sum(payments) + giftCardsRedeemed
 */
export type SalesDay = {
  businessDate: string;
  weekStart: string;
  locationKey: string;
  locationName: string;
  currency: "USD";
  guestCount: number;
  grossSalesMinor: number;
  discountsMinor: number;
  compsMinor: number;
  netSalesMinor: number;
  categories: CategorySales[];
  discounts: ReasonAmount[];
  comps: ReasonAmount[];
  /** Mistakes removed before payment. Never counted as sales. */
  voids: VoidLine[];
  /** Tax the restaurant collected and owes the state (a liability, not revenue). */
  salesTaxMinor: number;
  /** Tax on delivery app orders, collected and remitted by the platform. Not part of the day's balance. */
  marketplaceTaxMinor: number;
  /** Card tips plus delivery tips, owed to staff (a liability). */
  tipsMinor: number;
  giftCardsSoldMinor: number;
  giftCardsRedeemedMinor: number;
  payments: PaymentLine[];
  /** Delivery app orders included in net sales. Their payment line is the platform's. */
  deliverySales: DeliverySales[];
  costOfGoodsMinor: number;
  labour: LabourLine[];
  labourCostMinor: number;
  labourHours: number;
};

export type DeliveryPayoutLineType = "sales" | "tips" | "commission" | "marketing_fee" | "error_charge";
export type DeliveryPayout = {
  platform: string;
  label: string;
  locationKey: string;
  periodStart: string;
  periodEnd: string;
  payoutDate: string;
  /** `pending` when the payout date is after `endingOn`. */
  status: "paid" | "pending";
  currency: "USD";
  lines: { type: DeliveryPayoutLineType; description: string; amountMinor: number }[];
  /** Sum of the lines: what lands in the bank. */
  payoutMinor: number;
};

/**
 * Stock money for a week. The totals include supplies; `byCostGroup` shows each group,
 * and for every group usage = opening + purchases - closing.
 */
export type StockWeek = {
  openingStockMinor: number;
  purchasesMinor: number;
  closingStockMinor: number;
  /** All groups, supplies included. */
  usageMinor: number;
  byCostGroup: StockMovement[];
};

export type WeekSummary = {
  weekStart: string;
  weekEnd: string;
  netSalesMinor: number;
  /** Food and drink cost = usage of food, beverage and alcohol (opening + purchases - closing). Supplies excluded. */
  costOfGoodsMinor: number;
  labourCostMinor: number;
  stock: StockWeek;
  byLocation: { locationKey: string; netSalesMinor: number; costOfGoodsMinor: number; labourCostMinor: number; stock: StockWeek }[];
};

export type GeneratedSales = {
  template: DemoTemplate;
  restaurantName: string;
  currency: "USD";
  startsOn: string;
  endsOn: string;
  locations: { key: string; name: string }[];
  weeks: WeekSummary[];
  days: SalesDay[];
  deliveryPayouts: DeliveryPayout[];
  /** Purchases: every delivery in the range, per location. */
  vendorBills: VendorBill[];
  /** Stock items. The same list for every location. */
  items: StockItem[];
  /** Counts at close per location: the opening count the Sunday before the first week, then every week-ending Sunday. */
  stockCounts: StockCount[];
};

export type GenerateSalesOptions = {
  /** Number of Monday-to-Sunday weeks. Default 8. */
  weeks?: number;
  /** Last day, a Sunday (YYYY-MM-DD). Default 2026-11-15, the week on the design sketches. */
  endingOn?: string;
};

export const DEFAULT_SALES_END = "2026-11-15";

// ------------------------------------------------------------------ per-template sales profile

type Platform = { key: string; label: string; share: number; commissionBps: number; marketingBps: number };
type PinnedWeek = { days: readonly number[]; byLocation: Record<string, number>; costOfGoods: number; labour: number };

type SalesProfile = {
  /** Monday of the first pinned week. */
  firstWeek: string;
  /** Weekly net sales in cents for consecutive weeks from `firstWeek`, oldest first. */
  weeklyNet: readonly number[];
  /** Index into weeklyNet of the one slow week. */
  dipWeek: number;
  /** Index into weeklyNet of the week whose days, locations and costs are pinned exactly. */
  pinned?: { index: number } & PinnedWeek;
  /** Relative size of Monday..Sunday. */
  weekdayShape: readonly number[];
  locationShare: Record<string, number>;
  categoryShare: Record<string, number>;
  discountRate: number;
  compRate: number;
  discountReasons: readonly string[];
  compReasons: readonly string[];
  voidReasons: readonly string[];
  deliveryShare: number;
  platforms: readonly Platform[];
  cardTipRate: number;
  deliveryTipRate: number;
  tender: Record<Exclude<PaymentType, "delivery_platform">, number>;
  averageCheckMinor: number;
  cogsRate: number;
  labourRate: number;
  /** Labour does not fall as fast as sales, so the slow week runs a higher labour percentage. */
  dipLabourRate: number;
  labourGroups: Record<LabourGroup, { share: number; rateMinor: number }>;
  giftCardDenominations: readonly number[];
};

const usd = (dollars: number) => Math.round(dollars * 100);

const PROFILES: Record<DemoTemplate, SalesProfile> = {
  marigold: {
    firstWeek: "2026-09-21",
    weeklyNet: [81_940, 83_120, 82_560, 84_870, 61_480, 80_230, 83_790, 84_310].map(usd),
    dipWeek: 4,
    pinned: {
      index: 7,
      days: [8_140, 8_960, 9_870, 11_420, 15_830, 17_950, 12_140].map(usd),
      byLocation: { downtown: usd(51_870), riverside: usd(32_440) },
      costOfGoods: usd(25_460),
      labour: usd(26_220),
    },
    weekdayShape: [8_140, 8_960, 9_870, 11_420, 15_830, 17_950, 12_140],
    locationShare: { downtown: 0.615, riverside: 0.385 },
    categoryShare: { Starters: 0.16, Mains: 0.44, Sides: 0.07, Desserts: 0.07, "Soft Drinks and Coffee": 0.05, Bar: 0.21 },
    discountRate: 0.024,
    compRate: 0.011,
    discountReasons: ["Happy hour", "Loyalty reward", "Manager promotion", "Staff meal"],
    compReasons: ["Kitchen error", "Guest complaint", "Regular guest", "Birthday dessert"],
    voidReasons: ["Wrong item entered", "Guest changed order", "Rung in twice"],
    deliveryShare: 0.06,
    platforms: [
      { key: "ferrymeal", label: "Ferrymeal", share: 0.6, commissionBps: 2500, marketingBps: 300 },
      { key: "trolleybite", label: "Trolleybite", share: 0.4, commissionBps: 2200, marketingBps: 0 },
    ],
    cardTipRate: 0.19,
    deliveryTipRate: 0.1,
    tender: { cash: 0.09, visa: 0.45, mastercard: 0.29, amex: 0.14, discover: 0.03 },
    averageCheckMinor: 5_850,
    cogsRate: 0.3,
    labourRate: 0.31,
    dipLabourRate: 0.345,
    labourGroups: {
      front: { share: 0.44, rateMinor: 1_350 },
      back: { share: 0.41, rateMinor: 2_050 },
      management: { share: 0.15, rateMinor: 3_100 },
    },
    giftCardDenominations: [2_500, 5_000, 10_000],
  },
  slice_yard: {
    firstWeek: "2026-09-21",
    weeklyNet: [27_640, 28_110, 20_410, 28_480, 27_930, 27_520, 28_260, 28_750].map(usd),
    dipWeek: 2,
    weekdayShape: [2_900, 3_000, 3_300, 3_700, 5_600, 5_900, 4_400],
    locationShare: { mill_street: 1 },
    categoryShare: { Pizzas: 0.58, "Sides and Salads": 0.17, Drinks: 0.15, Desserts: 0.1 },
    discountRate: 0.03,
    compRate: 0.008,
    discountReasons: ["Lunch slice deal", "Student discount", "Staff meal"],
    compReasons: ["Burnt pie", "Guest complaint", "Order mix-up"],
    voidReasons: ["Wrong item entered", "Guest changed order"],
    deliveryShare: 0.32,
    platforms: [
      { key: "ferrymeal", label: "Ferrymeal", share: 0.55, commissionBps: 2500, marketingBps: 400 },
      { key: "trolleybite", label: "Trolleybite", share: 0.45, commissionBps: 2000, marketingBps: 200 },
    ],
    cardTipRate: 0.08,
    deliveryTipRate: 0.12,
    tender: { cash: 0.14, visa: 0.46, mastercard: 0.28, amex: 0.08, discover: 0.04 },
    averageCheckMinor: 1_650,
    cogsRate: 0.28,
    labourRate: 0.27,
    dipLabourRate: 0.31,
    labourGroups: {
      front: { share: 0.35, rateMinor: 1_550 },
      back: { share: 0.45, rateMinor: 1_900 },
      management: { share: 0.2, rateMinor: 2_500 },
    },
    giftCardDenominations: [2_500, 5_000],
  },
};

// ------------------------------------------------------------------ generation

/** Keyed by calendar week, so a week's numbers never depend on the range asked for. */
const weekRng = (template: DemoTemplate, weekStart: string, part: string): Rng => rngFor(`${template}|${weekStart}|${part}`);

const DAY_MS = 86_400_000;
const weeksBetween = (from: string, to: string): number => Math.round((parseDate(to).getTime() - parseDate(from).getTime()) / (7 * DAY_MS));

const values = <K extends string>(rec: Record<K, number>, keys: readonly K[]): number[] => keys.map((k) => rec[k]);

/**
 * Splits a week into a (location x day) grid of cents whose rows hit `byLocation` and whose
 * columns hit `days`, exactly. Each location's daily share wobbles a little around its usual share.
 */
const splitGrid = (days: readonly number[], byLocation: readonly number[], shares: readonly number[], rng: Rng): number[][] => {
  if (sum(days) !== sum(byLocation)) throw new Error("Grid targets do not agree");
  const remaining = [...days];
  const grid: number[][] = [];
  byLocation.forEach((target, l) => {
    if (l === byLocation.length - 1) {
      grid.push([...remaining]);
      return;
    }
    const share = shares[l] as number;
    const weights = remaining.map((d) => Math.max(d, 1) * share * rng.jitter(0.04));
    const row = allocate(target, weights);
    row.forEach((v, i) => {
      remaining[i] = (remaining[i] as number) - v;
      if ((remaining[i] as number) < 0) throw new Error("Grid split went negative");
    });
    grid.push(row);
  });
  return grid;
};

const roundQuarter = (x: number) => Math.round(x * 4) / 4;

const buildDay = (
  p: SalesProfile,
  rng: Rng,
  base: { businessDate: string; weekStart: string; locationKey: string; locationName: string },
  categories: readonly { name: string; salesGroup: SalesGroup }[],
  netSalesMinor: number,
  costOfGoodsMinor: number,
  labourCostMinor: number,
  taxBps: number,
): SalesDay => {
  // Net by category, then gross, discounts and comps worked back from it.
  const catNet = allocate(
    netSalesMinor,
    categories.map((c) => (p.categoryShare[c.name] ?? 0.01) * rng.jitter(0.08)),
  );
  const dRate = p.discountRate * rng.jitter(0.25);
  const cRate = p.compRate * rng.jitter(0.35);
  const catLines: CategorySales[] = categories.map((c, i) => {
    const net = catNet[i] as number;
    const gross = Math.round(net / (1 - dRate - cRate));
    const off = gross - net;
    const disc = Math.round((off * dRate) / (dRate + cRate));
    return { category: c.name, salesGroup: c.salesGroup, grossMinor: gross, discountsMinor: disc, compsMinor: off - disc, netMinor: net };
  });
  const discountsMinor = sum(catLines.map((c) => c.discountsMinor));
  const compsMinor = sum(catLines.map((c) => c.compsMinor));
  const reasonLines = (total: number, reasons: readonly string[]): ReasonAmount[] =>
    allocate(total, reasons.map(() => rng.between(0.4, 1.6)))
      .map((amountMinor, i) => ({ reason: reasons[i] as string, amountMinor }))
      .filter((r) => r.amountMinor > 0);

  const voidCount = rng.int(0, 4);
  const voids: VoidLine[] =
    voidCount === 0
      ? []
      : [{ reason: rng.pick(p.voidReasons), count: voidCount, amountMinor: voidCount * 100 * rng.int(8, 40) }];

  // Delivery app orders: part of net sales, paid by the platform, tax remitted by the platform.
  const deliveryNet = Math.round(netSalesMinor * p.deliveryShare * rng.jitter(0.15));
  const deliveryByPlatform = allocate(deliveryNet, p.platforms.map((x) => x.share * rng.jitter(0.1)));
  const deliverySales: DeliverySales[] = p.platforms.map((x, i) => {
    const net = deliveryByPlatform[i] as number;
    return { platform: x.key, label: x.label, netMinor: net, tipsMinor: Math.round(net * p.deliveryTipRate * rng.jitter(0.1)) };
  });
  const deliveryTips = sum(deliverySales.map((d) => d.tipsMinor));
  const marketplaceTaxMinor = Math.round((deliveryNet * taxBps) / 10_000);

  // In the room: tax, card tips, gift cards.
  const inStoreNet = netSalesMinor - deliveryNet;
  const salesTaxMinor = Math.round((inStoreNet * taxBps) / 10_000);
  const cardShare = 1 - p.tender.cash;
  const cardTips = Math.round(inStoreNet * cardShare * p.cardTipRate * rng.jitter(0.06));
  const giftCardsSoldMinor = sum(Array.from({ length: rng.int(0, 3) }, () => rng.pick(p.giftCardDenominations)));
  const giftCardsRedeemedMinor = sum(Array.from({ length: rng.int(0, 3) }, () => 100 * rng.int(12, 85)));

  // Payments: everything the room collected, split by tender; card tips ride on cards only.
  const tenderKeys = ["cash", "visa", "mastercard", "amex", "discover"] as const;
  const tenderLabels: Record<(typeof tenderKeys)[number], string> = { cash: "Cash", visa: "Visa", mastercard: "Mastercard", amex: "American Express", discover: "Discover" };
  const roomCollected = inStoreNet + salesTaxMinor + giftCardsSoldMinor - giftCardsRedeemedMinor;
  if (roomCollected < 0) throw new Error("Generated day cannot balance");
  const tenderWeights = tenderKeys.map((k) => p.tender[k] * rng.jitter(0.1));
  const byTender = allocate(roomCollected, tenderWeights);
  const tipsByCard = allocate(cardTips, tenderWeights.slice(1));
  const payments: PaymentLine[] = tenderKeys.map((k, i) => ({
    type: k,
    label: tenderLabels[k],
    amountMinor: (byTender[i] as number) + (i === 0 ? 0 : (tipsByCard[i - 1] as number)),
  }));
  for (const d of deliverySales) {
    payments.push({ type: "delivery_platform", label: d.label, platform: d.platform, amountMinor: d.netMinor + d.tipsMinor });
  }

  // Labour by job group, with hours from a typical rate.
  const groups = ["front", "back", "management"] as const;
  const labourCost = allocate(labourCostMinor, groups.map((g) => p.labourGroups[g].share * rng.jitter(0.05)));
  const labour: LabourLine[] = groups.map((g, i) => ({
    group: g,
    costMinor: labourCost[i] as number,
    hours: roundQuarter((labourCost[i] as number) / p.labourGroups[g].rateMinor),
  }));

  return {
    ...base,
    currency: "USD",
    guestCount: Math.max(1, Math.round(netSalesMinor / (p.averageCheckMinor * rng.jitter(0.05)))),
    grossSalesMinor: sum(catLines.map((c) => c.grossMinor)),
    discountsMinor,
    compsMinor,
    netSalesMinor,
    categories: catLines,
    discounts: reasonLines(discountsMinor, p.discountReasons),
    comps: reasonLines(compsMinor, p.compReasons),
    voids,
    salesTaxMinor,
    marketplaceTaxMinor,
    tipsMinor: cardTips + deliveryTips,
    giftCardsSoldMinor,
    giftCardsRedeemedMinor,
    payments,
    deliverySales,
    costOfGoodsMinor,
    labour,
    labourCostMinor,
    labourHours: sum(labour.map((l) => l.hours)),
  };
};

type BuiltWeek = {
  weekStart: string;
  weekEnd: string;
  weekNet: number;
  weekCogs: number;
  weekLabour: number;
  days: SalesDay[];
};

/** One calendar week of daily sales for every location. Depends only on the template and the date. */
const buildWeek = (template: DemoTemplate, weekStart: string): BuiltWeek => {
  const spec = templateSpec(template);
  const p = PROFILES[template];
  const locKeys = spec.locations.map((l) => l.key);
  const categories = spec.categories.map((c) => ({ name: c.name, salesGroup: c.salesGroup }));
  const typicalWeek = Math.round(sum(p.weeklyNet.filter((_, i) => i !== p.dipWeek)) / (p.weeklyNet.length - 1));
  const weekEnd = addDays(weekStart, 6);
  const idx = weeksBetween(p.firstWeek, weekStart);
  const profileIndex = idx >= 0 && idx < p.weeklyNet.length ? idx : -1;
  const r = weekRng(template, weekStart, "week");
  const pinned = p.pinned && p.pinned.index === profileIndex ? p.pinned : undefined;
  const isDip = profileIndex === p.dipWeek;

  // Weekly net: pinned for the profile's calendar weeks; any other week is a typical week, in tens of dollars.
  const weekNet = profileIndex >= 0 ? (p.weeklyNet[profileIndex] as number) : 1_000 * Math.round((typicalWeek * r.jitter(0.025)) / 1_000);

  const dayTotals = pinned ? [...pinned.days] : allocate(weekNet, p.weekdayShape.map((x) => x * r.jitter(0.04)));
  const locTotals = pinned
    ? locKeys.map((k) => pinned.byLocation[k] as number)
    : allocate(weekNet, values(p.locationShare, locKeys).map((s) => s * r.jitter(0.015)));
  if (sum(dayTotals) !== weekNet || sum(locTotals) !== weekNet) throw new Error("Pinned week does not add up");
  const grid = splitGrid(dayTotals, locTotals, values(p.locationShare, locKeys), r);

  // Food and drink cost (usage) follows sales closely. Labour is partly fixed, so it follows less closely.
  const weekCogs = pinned ? pinned.costOfGoods : 100 * Math.round((weekNet * p.cogsRate * r.jitter(0.025)) / 100);
  const weekLabour = pinned ? pinned.labour : 100 * Math.round((weekNet * (isDip ? p.dipLabourRate : p.labourRate) * r.jitter(0.02)) / 100);
  const cells = grid.flatMap((row, l) => row.map((net, d) => ({ l, d, net })));
  const cellCogs = allocate(weekCogs, cells.map((c) => c.net * r.jitter(0.03)));
  const locAvg = grid.map((row) => sum(row) / row.length);
  const cellLabour = allocate(weekLabour, cells.map((c) => (0.6 * c.net + 0.4 * (locAvg[c.l] as number)) * r.jitter(0.03)));

  const days: SalesDay[] = cells.map((c, i) => {
    const loc = spec.locations[c.l] as (typeof spec.locations)[number];
    return buildDay(
      p,
      weekRng(template, weekStart, `${loc.key}|${c.d}`),
      { businessDate: addDays(weekStart, c.d), weekStart, locationKey: loc.key, locationName: loc.name },
      categories,
      c.net,
      cellCogs[i] as number,
      cellLabour[i] as number,
      spec.salesTaxBps,
    );
  });
  days.sort((a, b) => a.businessDate.localeCompare(b.businessDate) || locKeys.indexOf(a.locationKey) - locKeys.indexOf(b.locationKey));
  return { weekStart, weekEnd, weekNet, weekCogs, weekLabour, days };
};

/** A location's usage by cost group for one built week. */
const usageFor = (template: DemoTemplate, week: BuiltWeek, locationKey: string): Record<CostGroup, number> => {
  const mine = week.days.filter((d) => d.locationKey === locationKey);
  const netBySalesGroup: Partial<Record<string, number>> = {};
  for (const d of mine) for (const c of d.categories) netBySalesGroup[c.salesGroup] = (netBySalesGroup[c.salesGroup] ?? 0) + c.netMinor;
  return weekUsage(template, {
    weekStart: week.weekStart,
    locationKey,
    netSalesMinor: sum(mine.map((d) => d.netSalesMinor)),
    netBySalesGroup,
    foodAndDrinkMinor: sum(mine.map((d) => d.costOfGoodsMinor)),
  });
};

const stockWeek = (rows: StockMovement[]): StockWeek => ({
  openingStockMinor: sum(rows.map((r) => r.openingStockMinor)),
  purchasesMinor: sum(rows.map((r) => r.purchasesMinor)),
  closingStockMinor: sum(rows.map((r) => r.closingStockMinor)),
  usageMinor: sum(rows.map((r) => r.usageMinor)),
  byCostGroup: rows,
});

/**
 * Daily sales per location for `weeks` Monday-to-Sunday weeks ending on `endingOn` (a Sunday),
 * plus Sunday stock counts and the purchases (vendor bills) between them.
 * Used by the Demo POS server (Wave 2). Pure and deterministic, keyed by calendar date.
 */
export const generateSales = (template: DemoTemplate, opts: GenerateSalesOptions = {}): GeneratedSales => {
  const spec = templateSpec(template);
  const p = PROFILES[template];
  const weeks = opts.weeks ?? 8;
  const endsOn = opts.endingOn ?? DEFAULT_SALES_END;
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > 104) throw new Error("weeks must be a whole number from 1 to 104");
  parseDate(endsOn);
  if (weekdayIndex(endsOn) !== 6) throw new Error("endingOn must be a Sunday");
  const startsOn = addDays(endsOn, -(7 * weeks - 1));
  const locKeys = spec.locations.map((l) => l.key);
  const groups = costGroupsFor(template);

  const days: SalesDay[] = [];
  const weekSummaries: WeekSummary[] = [];
  const deliveryPayouts: DeliveryPayout[] = [];
  const vendorBills: VendorBill[] = [];
  const stockCounts: StockCount[] = [];

  // The opening count is the previous week's closing count, built the same way from that week alone.
  const before = buildWeek(template, addDays(startsOn, -7));
  const lastCount = new Map<string, StockCount>();
  for (const k of locKeys) {
    const opening = closingCount(template, before.weekStart, k, usageFor(template, before, k), "opening");
    stockCounts.push(opening);
    lastCount.set(k, opening);
  }

  for (let w = 0; w < weeks; w++) {
    const week = buildWeek(template, addDays(startsOn, 7 * w));
    const { weekStart, weekEnd, days: weekDays } = week;
    days.push(...weekDays);

    const byLocation: WeekSummary["byLocation"] = locKeys.map((k, li) => {
      const mine = weekDays.filter((d) => d.locationKey === k);
      const usage = usageFor(template, week, k);
      const opening = lastCount.get(k) as StockCount;
      const closing = closingCount(template, weekStart, k, usage);
      stockCounts.push(closing);
      lastCount.set(k, closing);
      const value = (c: StockCount, g: CostGroup) => c.byCostGroup.find((x) => x.costGroup === g)?.valueMinor ?? 0;
      const purchases = { food: 0, beverage: 0, alcohol: 0, supplies: 0 } as Record<CostGroup, number>;
      const rows: StockMovement[] = groups.map((g) => {
        purchases[g] = usage[g] + value(closing, g) - value(opening, g);
        if (purchases[g] < 0) throw new Error("Generated purchases went negative");
        return { costGroup: g, openingStockMinor: value(opening, g), purchasesMinor: purchases[g], closingStockMinor: value(closing, g), usageMinor: usage[g] };
      });
      vendorBills.push(...weekBills(template, weekStart, k, li, purchases));
      const costOfGoodsMinor = sum(rows.filter((r) => FOOD_AND_DRINK.includes(r.costGroup)).map((r) => r.usageMinor));
      if (costOfGoodsMinor !== sum(mine.map((d) => d.costOfGoodsMinor))) throw new Error("Usage does not match cost of goods");
      return {
        locationKey: k,
        netSalesMinor: sum(mine.map((d) => d.netSalesMinor)),
        costOfGoodsMinor,
        labourCostMinor: sum(mine.map((d) => d.labourCostMinor)),
        stock: stockWeek(rows),
      };
    });

    const allRows: StockMovement[] = groups.map((g) => {
      const rows = byLocation.map((l) => l.stock.byCostGroup.find((r) => r.costGroup === g) as StockMovement);
      return {
        costGroup: g,
        openingStockMinor: sum(rows.map((r) => r.openingStockMinor)),
        purchasesMinor: sum(rows.map((r) => r.purchasesMinor)),
        closingStockMinor: sum(rows.map((r) => r.closingStockMinor)),
        usageMinor: sum(rows.map((r) => r.usageMinor)),
      };
    });
    weekSummaries.push({
      weekStart,
      weekEnd,
      netSalesMinor: week.weekNet,
      costOfGoodsMinor: week.weekCogs,
      labourCostMinor: week.weekLabour,
      stock: stockWeek(allRows),
      byLocation,
    });

    // One payout per platform per location per week, paid the following Wednesday.
    for (const k of locKeys) {
      for (const plat of p.platforms) {
        const pr = weekRng(template, weekStart, `payout|${k}|${plat.key}`);
        const mine = weekDays.filter((d) => d.locationKey === k).flatMap((d) => d.deliverySales.filter((s) => s.platform === plat.key));
        const sales = sum(mine.map((s) => s.netMinor));
        const tips = sum(mine.map((s) => s.tipsMinor));
        const lines: DeliveryPayout["lines"] = [
          { type: "sales", description: "Order subtotals", amountMinor: sales },
          { type: "tips", description: "Customer tips (passed through to staff)", amountMinor: tips },
          { type: "commission", description: `Commission at ${plat.commissionBps / 100}%`, amountMinor: -Math.round((sales * plat.commissionBps) / 10_000) },
        ];
        if (plat.marketingBps > 0) {
          lines.push({ type: "marketing_fee", description: "Sponsored listing", amountMinor: -Math.round((sales * plat.marketingBps) / 10_000) });
        }
        if (pr.next() < 0.35) {
          lines.push({ type: "error_charge", description: "Missing item refunded to customer", amountMinor: -100 * pr.int(6, 24) });
        }
        const payoutDate = addDays(weekEnd, 3);
        deliveryPayouts.push({
          platform: plat.key,
          label: plat.label,
          locationKey: k,
          periodStart: weekStart,
          periodEnd: weekEnd,
          payoutDate,
          status: payoutDate > endsOn ? "pending" : "paid",
          currency: "USD",
          lines,
          payoutMinor: sum(lines.map((l) => l.amountMinor)),
        });
      }
    }
  }

  return {
    template,
    restaurantName: spec.name,
    currency: "USD",
    startsOn,
    endsOn,
    locations: spec.locations.map((l) => ({ key: l.key, name: l.name })),
    weeks: weekSummaries,
    days,
    deliveryPayouts,
    vendorBills,
    items: stockItems(template),
    stockCounts,
  };
};

// The numbers a demo screen or answer must show, worked out HERE from the seed's raw records
// (each day's till totals, each Sunday's stock count, each supplier bill), never read back from
// the app and never from the seed's own weekly summary. If the app and this disagree, the app is
// wrong (or the seed changed: then the run-book must change too).
//
// Prime cost = food and drink cost + staff cost, over net sales.
// Food and drink cost = opening count + purchases - closing count, food, beverage and alcohol only
// (supplies are left out), counts taken on the Sunday before the week and the Sunday ending it.
import { generateSales } from "../../../packages/seed/dist/index.js";

const FOOD_AND_DRINK = new Set(["food", "beverage", "alcohol"]);

const addDays = (iso: string, n: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export type WeekFigures = {
  netSalesMinor: number;
  foodAndDrinkMinor: number;
  staffMinor: number;
  /** One decimal, as a screen shows it: "61.3%". */
  primeCost: string;
  /** Net sales per day, Monday first. */
  daily: number[];
};

/** Figures for the Monday-to-Sunday week starting `monday`, both (all) locations together. */
export const weekFigures = (template: "marigold" | "slice_yard", monday: string): WeekFigures => {
  const sunday = addDays(monday, 6);
  const sundayBefore = addDays(monday, -1);
  const g = generateSales(template);
  const inWeek = (d: string) => d >= monday && d <= sunday;

  const days = g.days.filter((d) => inWeek(d.businessDate));
  if (days.length === 0) throw new Error(`The seed has no sales for the week of ${monday}`);
  const netSalesMinor = days.reduce((s, d) => s + d.netSalesMinor, 0);
  const staffMinor = days.reduce((s, d) => s + d.labourCostMinor, 0);
  const daily = Array.from({ length: 7 }, (_, i) => days.filter((d) => d.businessDate === addDays(monday, i)).reduce((s, d) => s + d.netSalesMinor, 0));

  const countValue = (on: string) => {
    const counts = g.stockCounts.filter((c) => c.countedOn === on);
    if (counts.length !== g.locations.length) throw new Error(`The seed has no stock count on every location for ${on}`);
    return counts.flatMap((c) => c.lines).filter((l) => FOOD_AND_DRINK.has(l.costGroup)).reduce((s, l) => s + l.valueMinor, 0);
  };
  const purchases = g.vendorBills
    .filter((b) => inWeek(b.billDate))
    .flatMap((b) => b.lines)
    .filter((l) => FOOD_AND_DRINK.has(l.costGroup))
    .reduce((s, l) => s + l.amountMinor, 0);
  const foodAndDrinkMinor = countValue(sundayBefore) + purchases - countValue(sunday);

  const primeCost = `${(Math.round(((foodAndDrinkMinor + staffMinor) * 1000) / netSalesMinor) / 10).toFixed(1)}%`;
  return { netSalesMinor, foodAndDrinkMinor, staffMinor, primeCost, daily };
};

/** "$84,310.00" from 8431000. */
export const dollars = (minor: number): string =>
  `$${(minor / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The demo's "last week": Monday 9 November to Sunday 15 November 2026 (the seed ends on the 15th). */
export const LAST_WEEK = "2026-11-09";

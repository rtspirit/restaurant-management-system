// Stock items, Sunday stock counts and vendor bills (purchases) for the demo restaurants. PURE.
//
// Food and drink cost is real usage (docs/plan/02-restaurant-domain.md section 1.7):
//   usage for a week = opening stock + purchases - closing stock
// per location and per cost group. The week's usage is fixed first (it is the cost-of-goods figure
// the sales generator pins), each Sunday's closing count is set from that week alone, and the
// purchases are what makes the identity hold. Everything is keyed by calendar week.
//
// Exactness: every count line and bill line is value = round(quantity x unit cost). Each group
// has one "absorber" item, sold by weight or volume at under $10 per unit and counted to the
// thousandth, which takes the last few dollars so group totals land on their targets to the cent.
import { type Rng, addDays, allocate, rngFor, sum } from "./rng.js";
import type { DemoTemplate } from "./templates.js";

export type CostGroup = "food" | "beverage" | "alcohol" | "supplies";
/** Groups that count toward food and drink cost (cost of goods). Supplies do not. */
export const FOOD_AND_DRINK: readonly CostGroup[] = ["food", "beverage", "alcohol"];
export const COST_GROUPS: readonly CostGroup[] = ["food", "beverage", "alcohol", "supplies"];

export type StockUnit = "kg" | "l" | "each" | "case" | "bottle";

export type StockItem = {
  key: string;
  name: string;
  costGroup: CostGroup;
  unit: StockUnit;
  unitCostMinor: number;
  vendor: string;
};

export type StockCountLine = {
  itemKey: string;
  itemName: string;
  costGroup: CostGroup;
  quantity: number;
  unit: StockUnit;
  unitCostMinor: number;
  /** round(quantity x unitCost), whole cents. */
  valueMinor: number;
};

/** A final count at close on a Sunday. `opening` is the count the day before the first week. */
export type StockCount = {
  locationKey: string;
  countedOn: string;
  kind: "opening" | "week_end";
  lines: StockCountLine[];
  byCostGroup: { costGroup: CostGroup; valueMinor: number }[];
  totalValueMinor: number;
};

export type VendorBillLine = {
  itemKey: string;
  description: string;
  costGroup: CostGroup;
  quantity: number;
  unit: StockUnit;
  unitPriceMinor: number;
  /** round(quantity x unitPrice), whole cents. */
  amountMinor: number;
};
export type VendorBill = {
  vendor: string;
  billNumber: string;
  locationKey: string;
  /** Delivery date. */
  billDate: string;
  dueDate: string;
  currency: "USD";
  lines: VendorBillLine[];
  totalMinor: number;
};

/** One location's stock movement for one week and one cost group. usage = opening + purchases - closing. */
export type StockMovement = {
  costGroup: CostGroup;
  openingStockMinor: number;
  purchasesMinor: number;
  closingStockMinor: number;
  usageMinor: number;
};

// ------------------------------------------------------------------ fictional items and vendors

type ItemSpec = readonly [key: string, name: string, group: CostGroup, unit: StockUnit, unitCostMinor: number, vendor: string, weight: number, absorber?: true];
type VendorSpec = { name: string; code: string; deliveries: readonly (readonly [dayOffset: number, weight: number])[] };

const GREEN = "Lanterbury Greengrocers Co-op";
const MEAT = "Quillfield Meat and Seafood";
const FLOUR = "Quillfield Flour and Dairy";
const BEV = "Pellbrook Beverage Supply";
const PAPER = "Tidewell Paper and Cleaning";

const VENDORS: Record<string, VendorSpec> = {
  [GREEN]: { name: GREEN, code: "LGC", deliveries: [[0, 1], [2, 1.1], [4, 1.8]] },
  [MEAT]: { name: MEAT, code: "QMS", deliveries: [[1, 1], [4, 1.7]] },
  [FLOUR]: { name: FLOUR, code: "QFD", deliveries: [[1, 1], [4, 1.6]] },
  [BEV]: { name: BEV, code: "PBS", deliveries: [[1, 0.7], [3, 1.3]] },
  [PAPER]: { name: PAPER, code: "TPC", deliveries: [[0, 1]] },
};

const ITEMS: Record<DemoTemplate, readonly ItemSpec[]> = {
  marigold: [
    ["onions", "Yellow onions", "food", "kg", 180, GREEN, 0.15, true],
    ["baby_greens", "Mixed baby greens", "food", "case", 3_450, GREEN, 0.5],
    ["carrots", "Heirloom carrots", "food", "kg", 420, GREEN, 0.4],
    ["lemons", "Lemons", "food", "case", 4_100, GREEN, 0.3],
    ["mushrooms", "Wild mushrooms", "food", "kg", 2_900, GREEN, 0.6],
    ["potatoes", "Potatoes", "food", "kg", 150, GREEN, 0.2],
    ["butter", "Unsalted butter", "food", "kg", 1_100, GREEN, 0.5],
    ["cream", "Heavy cream", "food", "l", 650, GREEN, 0.4],
    ["parmesan", "Parmesan", "food", "kg", 2_400, GREEN, 0.4],
    ["arborio", "Arborio rice", "food", "kg", 520, GREEN, 0.2],
    ["flour", "All-purpose flour", "food", "kg", 110, GREEN, 0.1],
    ["chicken_bones", "Chicken bones for stock", "food", "kg", 350, MEAT, 0.15, true],
    ["hanger_steak", "Hanger steak", "food", "kg", 3_050, MEAT, 1.2],
    ["whole_chicken", "Whole chickens", "food", "each", 1_200, MEAT, 0.9],
    ["salmon", "Salmon fillet", "food", "kg", 3_400, MEAT, 1.0],
    ["short_rib", "Beef short rib", "food", "kg", 2_600, MEAT, 0.9],
    ["shrimp", "Gulf shrimp", "food", "kg", 2_850, MEAT, 0.6],
    ["pork_chops", "Pork chops", "food", "kg", 1_650, MEAT, 0.6],
    ["ground_beef", "Ground beef", "food", "kg", 1_100, MEAT, 0.5],
    ["orange_juice", "Orange juice", "beverage", "l", 420, BEV, 0.4, true],
    ["sparkling_water", "Sparkling water, case of 24", "beverage", "case", 2_600, BEV, 0.6],
    ["coffee_beans", "Coffee beans", "beverage", "kg", 2_200, BEV, 0.7],
    ["tea", "Black tea bags", "beverage", "case", 1_800, BEV, 0.2],
    ["lemonade_base", "Lemonade base", "beverage", "l", 380, BEV, 0.3],
    ["house_wine", "House wine, bag-in-box", "alcohol", "l", 850, BEV, 0.5, true],
    ["red_wine", "Red wine", "alcohol", "bottle", 1_200, BEV, 0.9],
    ["white_wine", "White wine", "alcohol", "bottle", 1_100, BEV, 0.8],
    ["bourbon", "Bourbon", "alcohol", "bottle", 3_150, BEV, 0.5],
    ["gin", "Gin", "alcohol", "bottle", 2_800, BEV, 0.4],
    ["tequila", "Tequila", "alcohol", "bottle", 2_900, BEV, 0.4],
    ["ipa_keg", "IPA keg, half barrel", "alcohol", "each", 21_500, BEV, 0.6],
    ["dish_detergent", "Dish detergent", "supplies", "l", 520, PAPER, 0.3, true],
    ["napkins", "Napkins", "supplies", "case", 3_800, PAPER, 0.4],
    ["to_go", "To-go containers", "supplies", "case", 4_600, PAPER, 0.4],
    ["gloves", "Kitchen gloves", "supplies", "case", 2_100, PAPER, 0.3],
  ],
  slice_yard: [
    ["flour_00", "Tipo 00 flour", "food", "kg", 95, FLOUR, 0.6, true],
    ["mozzarella", "Low-moisture mozzarella", "food", "kg", 920, FLOUR, 1.5],
    ["ricotta", "Ricotta", "food", "kg", 780, FLOUR, 0.3],
    ["pepperoni", "Pepperoni", "food", "kg", 1_520, FLOUR, 0.6],
    ["parmesan", "Parmesan", "food", "kg", 2_400, FLOUR, 0.3],
    ["tomatoes", "Whole peeled tomatoes", "food", "kg", 380, GREEN, 0.6, true],
    ["arugula", "Arugula", "food", "kg", 1_300, GREEN, 0.2],
    ["basil", "Basil", "food", "kg", 2_600, GREEN, 0.1],
    ["garlic", "Garlic", "food", "kg", 900, GREEN, 0.1],
    ["wings", "Chicken wings", "food", "kg", 880, GREEN, 0.4],
    ["soda_syrup", "Soda syrup", "beverage", "l", 800, BEV, 0.6, true],
    ["bottled_water", "Bottled water, case of 24", "beverage", "case", 900, BEV, 0.4],
    ["tea_concentrate", "Iced tea concentrate", "beverage", "l", 650, BEV, 0.3],
    ["dish_detergent", "Dish detergent", "supplies", "l", 520, PAPER, 0.3, true],
    ["pizza_boxes", "Pizza boxes, 16 inch", "supplies", "case", 3_600, PAPER, 0.8],
    ["napkins", "Napkins", "supplies", "case", 3_800, PAPER, 0.3],
  ],
};

/** Food cost runs higher than drink cost, so usage is split by sales weighted by these. */
const GROUP_COST_RATE: Record<"food" | "beverage" | "alcohol", number> = { food: 0.33, beverage: 0.2, alcohol: 0.24 };
/** Supplies used per dollar of net sales (not part of food and drink cost). */
const SUPPLIES_RATE: Record<DemoTemplate, number> = { marigold: 0.018, slice_yard: 0.035 };

type Item = StockItem & { weight: number; absorber: boolean };

const itemsFor = (template: DemoTemplate): Item[] =>
  ITEMS[template].map(([key, name, costGroup, unit, unitCostMinor, vendor, weight, absorber]) => ({
    key, name, costGroup, unit, unitCostMinor, vendor, weight, absorber: absorber === true,
  }));

/** The stock item list for a template. The same list for every location. */
export const stockItems = (template: DemoTemplate): StockItem[] =>
  itemsFor(template).map(({ key, name, costGroup, unit, unitCostMinor, vendor }) => ({ key, name, costGroup, unit, unitCostMinor, vendor }));

export const costGroupsFor = (template: DemoTemplate): CostGroup[] =>
  COST_GROUPS.filter((g) => itemsFor(template).some((i) => i.costGroup === g));

// ------------------------------------------------------------------ exact valued lines

type ValuedLine = { item: Item; quantity: number; valueMinor: number };

/**
 * Lines whose values add up to exactly `total` cents. Each item gets its share of the total,
 * rounded to a sensible quantity (tenths for kg and l, whole units otherwise); the group's
 * absorber item takes its own share plus the rounding, counted to the thousandth.
 */
const exactLines = (total: number, items: readonly Item[], rng: Rng, zeroChance: number): ValuedLine[] => {
  const absorber = items.find((i) => i.absorber);
  if (!absorber || absorber.unitCostMinor >= 1_000 || (absorber.unit !== "kg" && absorber.unit !== "l")) {
    throw new Error("Each stock group needs one weighed or measured item under $10 a unit");
  }
  if (total === 0) return items.map((item) => ({ item, quantity: 0, valueMinor: 0 }));
  const others = items.filter((i) => i !== absorber);
  const zero = new Set(others.filter(() => rng.next() < zeroChance));
  const active = [absorber, ...others.filter((i) => !zero.has(i))];
  const targets = allocate(total, active.map((i) => i.weight * rng.jitter(0.25)));
  const step = (i: Item) => (i.unit === "kg" || i.unit === "l" ? 10 : 1); // steps per unit
  // Quantities in steps (tenths or whole units), so arithmetic stays exact.
  const steps = new Map<Item, number>();
  active.slice(1).forEach((item, n) => steps.set(item, Math.round(((targets[n + 1] as number) * step(item)) / item.unitCostMinor)));
  const valueOf = (item: Item) => Math.round(((steps.get(item) ?? 0) * item.unitCostMinor) / step(item));
  let rest = total - sum(others.map(valueOf));
  // Rounding up can overshoot: take single steps off the largest lines until the absorber has room.
  while (rest < 0) {
    const biggest = others.filter((i) => (steps.get(i) ?? 0) > 0).sort((x, y) => valueOf(y) - valueOf(x))[0];
    if (!biggest) throw new Error("Stock lines did not land on their total");
    steps.set(biggest, (steps.get(biggest) as number) - 1);
    rest = total - sum(others.map(valueOf));
  }
  const thousandths = Math.round((rest * 1_000) / absorber.unitCostMinor);
  const absValue = Math.round((thousandths * absorber.unitCostMinor) / 1_000);
  if (absValue !== rest) throw new Error("Stock lines did not land on their total");
  return [
    { item: absorber, quantity: thousandths / 1_000, valueMinor: absValue },
    ...others.map((item) => ({ item, quantity: (steps.get(item) ?? 0) / step(item), valueMinor: valueOf(item) })),
  ];
};

// ------------------------------------------------------------------ per week

/** What one location used in one week, by cost group. Food and drink add up to `foodAndDrinkMinor`. */
export type WeekUsageInput = {
  weekStart: string;
  locationKey: string;
  netSalesMinor: number;
  /** Net sales by sales group, to split food and drink usage. */
  netBySalesGroup: Partial<Record<string, number>>;
  /** The week's food and drink usage (the pinned cost of goods), cents. */
  foodAndDrinkMinor: number;
};

const key = (template: DemoTemplate, weekStart: string, part: string) => rngFor(`${template}|stock|${weekStart}|${part}`);

/** Usage by cost group. Food, beverage and alcohol add up exactly to the cost-of-goods figure. */
export const weekUsage = (template: DemoTemplate, w: WeekUsageInput): Record<CostGroup, number> => {
  const groups = costGroupsFor(template);
  const r = key(template, w.weekStart, `usage|${w.locationKey}`);
  const fd = FOOD_AND_DRINK.filter((g) => groups.includes(g) && (w.netBySalesGroup[g] ?? 0) > 0) as ("food" | "beverage" | "alcohol")[];
  const split = allocate(w.foodAndDrinkMinor, fd.map((g) => (w.netBySalesGroup[g] as number) * GROUP_COST_RATE[g] * r.jitter(0.05)));
  const out: Record<CostGroup, number> = { food: 0, beverage: 0, alcohol: 0, supplies: 0 };
  fd.forEach((g, i) => (out[g] = split[i] as number));
  if (groups.includes("supplies")) out.supplies = Math.round(w.netSalesMinor * SUPPLIES_RATE[template] * r.jitter(0.1));
  return out;
};

/** The count at close on the Sunday ending `weekStart`'s week: about 1.25 to 1.45 weeks of that week's usage. */
export const closingCount = (template: DemoTemplate, weekStart: string, locationKey: string, usage: Record<CostGroup, number>, kind: StockCount["kind"] = "week_end"): StockCount => {
  const items = itemsFor(template);
  const r = key(template, weekStart, `count|${locationKey}`);
  const lines: StockCountLine[] = [];
  const byCostGroup = costGroupsFor(template).map((g) => {
    const target = Math.round(usage[g] * r.between(1.25, 1.45));
    const valued = exactLines(target, items.filter((i) => i.costGroup === g), r, 0.06);
    for (const v of valued) {
      lines.push({ itemKey: v.item.key, itemName: v.item.name, costGroup: g, quantity: v.quantity, unit: v.item.unit, unitCostMinor: v.item.unitCostMinor, valueMinor: v.valueMinor });
    }
    return { costGroup: g, valueMinor: target };
  });
  const order = new Map(items.map((i, n) => [i.key, n]));
  lines.sort((a, b) => (order.get(a.itemKey) as number) - (order.get(b.itemKey) as number));
  return { locationKey, countedOn: addDays(weekStart, 6), kind, lines, byCostGroup, totalValueMinor: sum(byCostGroup.map((g) => g.valueMinor)) };
};

/** Bills that deliver exactly `purchases` per cost group: a few deliveries a week, bigger before the weekend. */
export const weekBills = (template: DemoTemplate, weekStart: string, locationKey: string, locationIndex: number, purchases: Record<CostGroup, number>): VendorBill[] => {
  const items = itemsFor(template);
  const r = key(template, weekStart, `bills|${locationKey}`);
  // (vendor, delivery day) -> group -> amount
  const slots = new Map<string, { vendor: VendorSpec; day: number; amounts: Partial<Record<CostGroup, number>> }>();
  for (const g of costGroupsFor(template)) {
    const vendors = [...new Set(items.filter((i) => i.costGroup === g).map((i) => i.vendor))];
    const byVendor = allocate(purchases[g], vendors.map((v) => sum(items.filter((i) => i.vendor === v && i.costGroup === g).map((i) => i.weight)) * r.jitter(0.1)));
    vendors.forEach((v, vi) => {
      const spec = VENDORS[v] as VendorSpec;
      const byDay = allocate(byVendor[vi] as number, spec.deliveries.map(([, wgt]) => wgt * r.jitter(0.15)));
      spec.deliveries.forEach(([day], di) => {
        const id = `${spec.code}|${day}`;
        const slot = slots.get(id) ?? { vendor: spec, day, amounts: {} };
        slot.amounts[g] = (slot.amounts[g] ?? 0) + (byDay[di] as number);
        slots.set(id, slot);
      });
    });
  }
  const bills: VendorBill[] = [];
  for (const slot of [...slots.values()].sort((a, b) => a.day - b.day || a.vendor.code.localeCompare(b.vendor.code))) {
    const lines: VendorBillLine[] = [];
    for (const g of COST_GROUPS) {
      const amount = slot.amounts[g] ?? 0;
      if (amount === 0) continue;
      const valued = exactLines(amount, items.filter((i) => i.costGroup === g && i.vendor === slot.vendor.name), r, 0.3);
      for (const v of valued) {
        if (v.quantity === 0) continue;
        lines.push({ itemKey: v.item.key, description: v.item.name, costGroup: g, quantity: v.quantity, unit: v.item.unit, unitPriceMinor: v.item.unitCostMinor, amountMinor: v.valueMinor });
      }
    }
    if (lines.length === 0) continue;
    const billDate = addDays(weekStart, slot.day);
    bills.push({
      vendor: slot.vendor.name,
      billNumber: `${slot.vendor.code}-${billDate.replaceAll("-", "").slice(2)}-${locationIndex + 1}`,
      locationKey,
      billDate,
      dueDate: addDays(billDate, 14),
      currency: "USD",
      lines,
      totalMinor: sum(lines.map((l) => l.amountMinor)),
    });
  }
  return bills;
};

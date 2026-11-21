// What the Demo POS answers: slices of the seed's generated numbers for ONE demo template.
// Pure. No database, no token, no request: the server decides the template from the verified
// token and passes only that in. A restaurant that is not a demo template gets `null` here,
// and every list comes back empty.
import { DEMO_POS_TOOLS, type DemoPosRangeInput, type DemoPosToolName } from "@rms/contracts";
import { DEMO_TEMPLATES, type DemoTemplate, type GeneratedSales, TEMPLATES, generateSales } from "@rms/seed";

/** The demo template a restaurant's numbers come from, worked out from its own name. Null for any other restaurant. */
export const templateForName = (restaurantName: string): DemoTemplate | null =>
  DEMO_TEMPLATES.find((t) => TEMPLATES[t].name === restaurantName) ?? null;

// The numbers are deterministic, so each template is generated once per process.
const cache = new Map<DemoTemplate, GeneratedSales>();
const salesFor = (template: DemoTemplate): GeneratedSales => {
  let sales = cache.get(template);
  if (!sales) {
    sales = generateSales(template);
    cache.set(template, sales);
  }
  return sales;
};

const inRange = (date: string, r: DemoPosRangeInput) => date >= r.from && date <= r.to;
const atLocation = (key: string, r: DemoPosRangeInput) => r.location === undefined || r.location === key;

/**
 * One tool's answer for one template, parsed with the tool's own output shape (so nothing
 * outside the contract is ever sent). `input` must already have passed the tool's input shape.
 */
export const demoPosAnswer = (template: DemoTemplate | null, tool: DemoPosToolName, input: unknown): unknown => {
  const spec = DEMO_POS_TOOLS[tool];
  const args = spec.input.parse(input);
  const s = template ? salesFor(template) : null;
  const range = args as DemoPosRangeInput;
  const days = s ? s.days.filter((d) => inRange(d.businessDate, range) && atLocation(d.locationKey, range)) : [];
  const key = (d: { businessDate: string; locationKey: string }) => ({ businessDate: d.businessDate, locationKey: d.locationKey });

  let answer: unknown;
  switch (tool) {
    case "list_locations":
      answer = { locations: (s?.locations ?? []).map((l) => ({ key: l.key, name: l.name })) };
      break;
    case "get_daily_sales":
      answer = {
        days: days.map((d) => ({
          ...key(d), locationName: d.locationName, currency: d.currency, guestCount: d.guestCount, grossSalesMinor: d.grossSalesMinor,
          discountsMinor: d.discountsMinor, compsMinor: d.compsMinor, netSalesMinor: d.netSalesMinor, salesTaxMinor: d.salesTaxMinor,
          marketplaceTaxMinor: d.marketplaceTaxMinor, tipsMinor: d.tipsMinor, giftCardsSoldMinor: d.giftCardsSoldMinor,
          giftCardsRedeemedMinor: d.giftCardsRedeemedMinor, categories: d.categories, deliverySales: d.deliverySales,
        })),
      };
      break;
    case "get_payments":
      answer = { days: days.map((d) => ({ ...key(d), payments: d.payments })) };
      break;
    case "get_adjustments":
      answer = { days: days.map((d) => ({ ...key(d), discounts: d.discounts, comps: d.comps, voids: d.voids })) };
      break;
    case "get_labour":
      answer = { days: days.map((d) => ({ ...key(d), labour: d.labour, labourCostMinor: d.labourCostMinor, labourHours: d.labourHours })) };
      break;
    case "get_delivery_payouts":
      answer = { payouts: (s?.deliveryPayouts ?? []).filter((p) => inRange(p.periodEnd, range) && atLocation(p.locationKey, range)) };
      break;
    case "get_vendor_bills":
      answer = { bills: (s?.vendorBills ?? []).filter((b) => inRange(b.billDate, range) && atLocation(b.locationKey, range)) };
      break;
    case "get_stock_items":
      answer = { items: s?.items ?? [] };
      break;
    case "get_stock_counts":
      answer = { counts: (s?.stockCounts ?? []).filter((c) => inRange(c.countedOn, range) && atLocation(c.locationKey, range)) };
      break;
  }
  return spec.output.parse(answer);
};

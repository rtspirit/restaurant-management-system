// Proves the Demo POS tool shapes in @rms/contracts match what the seed really produces.
// Lead-owned test. If it fails, the contract or the seed changed: tell the lead, do not loosen it.
import { describe, expect, it } from "vitest";
import {
  DEMO_POS_TOOLS,
  DemoPosAdjustments,
  DemoPosDailySales,
  DemoPosDeliveryPayouts,
  DemoPosLabour,
  DemoPosLocations,
  DemoPosPayments,
  DemoPosStockCounts,
  DemoPosStockItems,
  DemoPosVendorBills,
} from "@rms/contracts";
import { type DemoTemplate, generateSales } from "@rms/seed";

const strict = <T extends { strict: () => { parse: (v: unknown) => unknown } }>(shape: T, value: unknown) => shape.strict().parse(value);

describe.each(["marigold", "slice_yard"] as DemoTemplate[])("Demo POS shapes fit the seeded data for %s", (template) => {
  const sales = generateSales(template);

  it("locations", () => {
    expect(() => DemoPosLocations.parse({ locations: sales.locations })).not.toThrow();
  });

  it("daily sales, payments, adjustments and labour are slices of a seeded day", () => {
    expect(sales.days.length).toBeGreaterThan(50);
    for (const d of sales.days) {
      const key = { businessDate: d.businessDate, locationKey: d.locationKey };
      DemoPosDailySales.parse({
        days: [{
          ...key, locationName: d.locationName, currency: d.currency, guestCount: d.guestCount, grossSalesMinor: d.grossSalesMinor, discountsMinor: d.discountsMinor,
          compsMinor: d.compsMinor, netSalesMinor: d.netSalesMinor, salesTaxMinor: d.salesTaxMinor, marketplaceTaxMinor: d.marketplaceTaxMinor, tipsMinor: d.tipsMinor,
          giftCardsSoldMinor: d.giftCardsSoldMinor, giftCardsRedeemedMinor: d.giftCardsRedeemedMinor, categories: d.categories, deliverySales: d.deliverySales,
        }],
      });
      DemoPosPayments.parse({ days: [{ ...key, payments: d.payments }] });
      DemoPosAdjustments.parse({ days: [{ ...key, discounts: d.discounts, comps: d.comps, voids: d.voids }] });
      DemoPosLabour.parse({ days: [{ ...key, labour: d.labour, labourCostMinor: d.labourCostMinor, labourHours: d.labourHours }] });
    }
  });

  it("delivery payouts, vendor bills, stock items and stock counts fit as they are, with no field left over", () => {
    for (const p of sales.deliveryPayouts) strict(DemoPosDeliveryPayouts.shape.payouts.element, p);
    for (const b of sales.vendorBills) strict(DemoPosVendorBills.shape.bills.element, b);
    for (const i of sales.items) strict(DemoPosStockItems.shape.items.element, i);
    for (const c of sales.stockCounts) strict(DemoPosStockCounts.shape.counts.element, c);
    expect(sales.vendorBills.length).toBeGreaterThan(0);
    expect(sales.stockCounts.length).toBeGreaterThan(0);
  });
});

describe("the tool list", () => {
  it("every tool has a description, an input shape and an output shape", () => {
    for (const [name, tool] of Object.entries(DEMO_POS_TOOLS)) {
      expect(tool.description.length, name).toBeGreaterThan(10);
      expect(typeof tool.input.safeParse, name).toBe("function");
      expect(typeof tool.output.safeParse, name).toBe("function");
    }
  });
});

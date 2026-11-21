// What the delivery apps keep, in the books (ADR 0011).
//
// A delivery app never sends a bill. It takes its commission and fees out of the weekly payout,
// and they show only on the payout statement (docs/plan/02 section 1.5). Until that cost is in
// the books, the profit and loss shows more profit than there is. So every payout statement also
// becomes one "statement" from the delivery company: a vendor bill whose lines are exactly what
// the app kept that week, coded to the delivery commissions account, and posted with
// `post_vendor_bill` like any other bill. No new model and no new action.
//
// Nothing here is generated. The amounts are read off the payout statements `generateSales`
// already makes from each day's delivery orders, so the books, the payout check and the till
// agree to the cent, and a slow week has lower commissions because it had fewer orders.
//
// The cost counts in the week the orders were sold (the statement's last day), not in the week
// the payout lands. It is a running cost: it lowers net profit and never touches prime cost.
//
// A statement is never waiting to be paid: the app has already kept the money. So every one is
// recorded as paid, on the day of its payout, and can never show up as a bill to pay or overdue.
import { DEFAULT_CHART_OF_ACCOUNTS } from "@rms/models";
import type { DeliveryPayoutLineType, GeneratedSales } from "./sales.js";

/** The account number in the standard chart for what delivery apps keep. */
export const DELIVERY_COMMISSIONS_ACCOUNT_CODE = "7500";

/** The payout lines that are money the delivery app kept. Sales and tips are what it passed on. */
const KEPT: readonly DeliveryPayoutLineType[] = ["commission", "marketing_fee", "error_charge"];

export type DeliveryStatementLine = { kind: DeliveryPayoutLineType; description: string; amountMinor: number };

/** One week of what one delivery company kept from one location's orders. */
export type DeliveryStatement = {
  /** The delivery company, as the vendor the statement is from. */
  company: string;
  platform: string;
  locationKey: string;
  /** Unique per company. */
  statementNumber: string;
  periodStart: string;
  /** The last day covered. Also the business date the cost counts in. */
  periodEnd: string;
  /** The day of the payout these amounts were taken out of. Nothing is left to pay after it. */
  paidOn: string;
  currency: "USD";
  /** Order subtotals on the same payout statement: what the commission was charged on. */
  deliverySalesMinor: number;
  /** Positive amounts: each is a cost to the restaurant. */
  lines: DeliveryStatementLine[];
  totalMinor: number;
};

/**
 * One statement per delivery company, location and week, in the order of the payouts. PURE.
 * A payout with nothing taken out makes no statement.
 */
export const deliveryStatements = (sales: Pick<GeneratedSales, "deliveryPayouts" | "locations">): DeliveryStatement[] => {
  const locationNumber = new Map(sales.locations.map((l, i) => [l.key, i + 1]));
  const out: DeliveryStatement[] = [];
  for (const p of sales.deliveryPayouts) {
    const lines = p.lines.filter((l) => KEPT.includes(l.type) && l.amountMinor !== 0).map((l) => ({ kind: l.type, description: l.description, amountMinor: -l.amountMinor }));
    if (lines.length === 0) continue;
    if (lines.some((l) => l.amountMinor < 0)) throw new Error("A delivery app cannot keep a negative amount");
    const number = locationNumber.get(p.locationKey);
    if (!number) throw new Error(`Delivery payout for an unknown location: ${p.locationKey}`);
    out.push({
      company: p.label,
      platform: p.platform,
      locationKey: p.locationKey,
      statementNumber: `${p.platform.slice(0, 3).toUpperCase()}-${p.periodEnd.replaceAll("-", "").slice(2)}-${number}`,
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
      paidOn: p.payoutDate,
      currency: p.currency,
      deliverySalesMinor: p.lines.filter((l) => l.type === "sales").reduce((a, l) => a + l.amountMinor, 0),
      lines,
      totalMinor: lines.reduce((a, l) => a + l.amountMinor, 0),
    });
  }
  return out;
};

type Upsert = { sourceId: string; values: Record<string, unknown> };

/** The pieces of `loadDemoBooks` this step borrows, so rows are keyed, counted and posted the same way. */
export type BooksLoader = {
  upsert: (model: string, items: readonly Upsert[]) => Promise<string[]>;
  upsertKeyed: (model: string, items: readonly (Upsert & { key: string })[]) => Promise<Map<string, string>>;
  act: (action: string, params: Record<string, string>) => Promise<number>;
  /** A location's id, from its key in the template. */
  loc: (key: string) => string;
  accountByCode: ReadonlyMap<string, string>;
  /** Post each statement to the ledger. */
  post: boolean;
  /** Statements are vendor bills, so they are counted with them. */
  posted: { vendorBills: number };
};

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
const need = (map: ReadonlyMap<string, string>, key: string, what: string): string => {
  const id = map.get(key);
  if (!id) throw new Error(`Loading the demo numbers: no ${what} called "${key}"`);
  return id;
};

/**
 * Records every delivery statement as a vendor bill from the delivery company and posts it.
 * Repeatable: rows are keyed by where they came from, and `post_vendor_bill` skips a bill that is
 * already in the books.
 */
export const loadDeliveryStatements = async (sales: Pick<GeneratedSales, "deliveryPayouts" | "locations">, books: BooksLoader): Promise<void> => {
  const statements = deliveryStatements(sales);
  if (statements.length === 0) return;

  const inChart = DEFAULT_CHART_OF_ACCOUNTS.find((a) => a.code === DELIVERY_COMMISSIONS_ACCOUNT_CODE);
  if (inChart?.type !== "expense" || inChart.reportSection !== "controllable") throw new Error("The standard chart has no running-cost account for delivery commissions");
  const account = books.accountByCode.get(DELIVERY_COMMISSIONS_ACCOUNT_CODE);
  if (!account) throw new Error("Loading the demo numbers: the restaurant has no delivery commissions account");

  const companies = [...new Set(statements.map((s) => s.company))];
  const vendorId = await books.upsertKeyed(
    "vendor",
    companies.map((name) => ({
      key: name,
      sourceId: slug(name),
      values: { name, terms_days: 0, default_account: account, active: true, note: "Delivery app. It keeps its commission and fees out of each weekly payout, so there is never a bill to pay." },
    })),
  );

  const key = (s: DeliveryStatement) => `delivery/${s.locationKey}/${s.platform}/${s.periodStart}`;
  const billId = await books.upsertKeyed(
    "vendor_bill",
    statements.map((s) => ({
      key: key(s),
      sourceId: key(s),
      values: {
        location_id: books.loc(s.locationKey), vendor: need(vendorId, s.company, "delivery company"), bill_number: s.statementNumber, business_date: s.periodEnd, due_date: s.paidOn,
        total_amount: s.totalMinor, status: "paid", note: `Kept out of the payout of ${s.paidOn}, for orders from ${s.periodStart} to ${s.periodEnd}. Nothing to pay.`,
      },
    })),
  );
  await books.upsert(
    "vendor_bill_line",
    statements.flatMap((s) =>
      s.lines.map((l, i) => ({
        sourceId: `${key(s)}/${i + 1}`,
        values: { location_id: books.loc(s.locationKey), vendor_bill: need(billId, key(s), "delivery statement"), line_number: i + 1, description: l.description, account, amount: l.amountMinor },
      })),
    ),
  );

  if (!books.post) return;
  for (const id of billId.values()) if ((await books.act("post_vendor_bill", { vendor_bill_id: id })) > 0) books.posted.vendorBills++;
};

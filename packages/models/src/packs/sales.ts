import { ACCESS, and, businessDate, check, date, eq, f, gt, gte, integer, isIn, lit, lte, money, not, oneOf, or, parentRef, ref, sub, text, timestamp } from "./helpers.js";
import type { ModelInput } from "./helpers.js";

/**
 * Sales pack: what one day of trading turns into (docs/plan/02-restaurant-domain.md 1.4 and 1.5).
 *
 * The day must add up:
 *   net sales + sales tax + tips + service charges + gift cards sold
 *     = payments by type + gift cards redeemed
 * `post_sales_day` turns exactly these rows into one balanced journal entry, so a day that does
 * not add up cannot be posted.
 */

const SALES_CHANNELS = ["all", "dine_in", "takeout", "delivery", "catering", "online"];

/**
 * Payout line kinds. `amount` is signed: what the platform adds is positive, what it takes is
 * negative, so the payout is the plain sum of its lines. `tax_remitted_by_platform` is the one
 * kind that is recorded but left out of every sum (domain rule 6).
 */
export const PAYOUT_ADDS = ["sales", "tip", "sales_tax"];
export const PAYOUT_TAKES = ["commission", "marketing_fee", "service_fee", "error_charge", "refund"];
export const PAYOUT_MEMO_ONLY = "tax_remitted_by_platform";
const PAYOUT_LINE_KINDS = [...PAYOUT_ADDS, ...PAYOUT_TAKES, "adjustment", PAYOUT_MEMO_ONLY];

const salesDay: ModelInput = {
  key: "sales_day",
  pack: "sales",
  version: 1,
  name: "Daily sales",
  description:
    "The sales totals for one location on one business date, as the till reports them: gross sales, discounts, comps, net sales, sales tax, tips, service charges, guests and checks. The starting point for the daily sales summary and the books.",
  locationScoped: true,
  defaultAccess: ACCESS.ownerWritesStaffReads,
  unique: [["location_id", "business_date", "channel"]],
  indexes: [["business_date"]],
  fields: [
    businessDate("The restaurant day these sales belong to. A day runs until the location's closing cutoff, not midnight."),
    oneOf("channel", "Channel", SALES_CHANNELS, {
      required: true,
      description: "How the orders came in. Use all when the till gives one total for the day. Never record both an all row and split rows for the same day.",
    }),
    money("gross_sales", "Gross sales", { required: true, description: "Sales before discounts and comps. Voided items are not in this number: a void was never a sale." }),
    money("discounts", "Discounts", { required: true, description: "Price reductions. The reasons are in the daily adjustments." }),
    money("comps", "Comps", { required: true, description: "Items given away. The reasons are in the daily adjustments." }),
    money("voids", "Voids", { description: "Mistakes removed from checks. Kept for the record only. Never part of gross or net sales." }),
    money("net_sales", "Net sales", { required: true, description: "Gross sales minus discounts and comps. This is the restaurant's revenue for the day." }),
    money("sales_tax", "Sales tax collected", { required: true, description: "Tax collected that the restaurant itself must pay over. Held for the government, never revenue." }),
    money("tax_remitted_by_platform", "Tax paid over by delivery platforms", {
      description: "Tax a delivery platform collected and pays to the government itself. Recorded only. Never added to what the restaurant owes and never posted to the books.",
    }),
    money("tips", "Tips", { required: true, description: "Tips collected for staff through the till. Owed to staff, never revenue." }),
    money("service_charges", "Service charges", { description: "Automatic gratuity or fees added to checks. Whether this is revenue or owed to staff is a posting rule." }),
    integer("guests", "Guests"),
    integer("checks", "Checks"),
    text("note", "Note", { maxLength: 500 }),
  ],
  rules: [
    check("sales_day_net_is_gross_less_reductions", eq(f("net_sales"), sub(sub(f("gross_sales"), f("discounts")), f("comps"))), "Net sales must equal gross sales minus discounts and comps. Voids are never part of sales."),
    check("sales_day_reductions_not_negative", and(gte(f("discounts"), lit(0)), gte(f("comps"), lit(0))), "Discounts and comps cannot be negative."),
    check("sales_day_voids_not_negative", gte(f("voids"), lit(0)), "Voids cannot be negative."),
    check("sales_day_tips_not_negative", gte(f("tips"), lit(0)), "Tips cannot be negative."),
  ],
};

const salesCategoryDay: ModelInput = {
  key: "sales_category_day",
  pack: "sales",
  version: 1,
  name: "Daily sales by category",
  description: "One day's sales for one sales category, such as food, beer or wine: net sales and, when the till reports them, gross sales, discounts and comps. The category rows of a day add up to that day's net sales.",
  locationScoped: true,
  defaultAccess: ACCESS.ownerWritesStaffReads,
  unique: [["sales_day", "sales_category"]],
  indexes: [["sales_category"]],
  fields: [
    ref("sales_day", "Daily sales", "sales_day", { required: true, description: "The day these numbers belong to. The business date comes from it." }),
    ref("sales_category", "Sales category", "sales_category", { required: true }),
    money("gross_sales", "Gross sales"),
    money("discounts", "Discounts"),
    money("comps", "Comps"),
    money("net_sales", "Net sales", { required: true, description: "Gross minus discounts and comps for this category. Posted to the books as revenue." }),
    integer("items_sold", "Items sold"),
  ],
  rules: [
    check(
      "sales_category_day_net_is_gross_less_reductions",
      eq(f("net_sales"), sub(sub(f("gross_sales"), f("discounts")), f("comps"))),
      "When gross sales, discounts and comps are given, net sales must equal gross minus discounts and comps.",
    ),
  ],
};

const paymentDay: ModelInput = {
  key: "payment_day",
  pack: "sales",
  version: 1,
  name: "Daily payments by type",
  description: "What was collected on one day by one payment type: cash, each card type, house accounts and each delivery platform. The amount includes the tax and tips paid that way. Gift card redemptions are not here: they are gift card activity.",
  locationScoped: true,
  defaultAccess: ACCESS.ownerWritesStaffReads,
  unique: [["sales_day", "payment_type"]],
  indexes: [["payment_type"]],
  fields: [
    ref("sales_day", "Daily sales", "sales_day", { required: true, description: "The day this was collected on. The business date comes from it." }),
    ref("payment_type", "Payment type", "payment_type", { required: true }),
    money("amount", "Amount collected", { required: true, description: "Everything paid this way that day, including tax and tips." }),
    money("tips", "Tips included", { description: "The part of the amount that is tips. For the record only: it is already inside the amount." }),
    integer("payment_count", "Number of payments"),
  ],
};

const adjustmentDay: ModelInput = {
  key: "adjustment_day",
  pack: "sales",
  version: 1,
  name: "Daily discounts, comps and voids",
  description: "One day's discounts, comps or voids for one reason, such as staff meal, manager comp or wrong item. Discounts, comps and voids are kept apart, and each carries its reason. Voids are a record of mistakes and never count as sales.",
  locationScoped: true,
  defaultAccess: ACCESS.ownerWritesStaffReads,
  unique: [["sales_day", "kind", "reason"]],
  fields: [
    ref("sales_day", "Daily sales", "sales_day", { required: true, description: "The day this happened on. The business date comes from it." }),
    oneOf("kind", "Kind", ["discount", "comp", "void"], { required: true, description: "discount: a price reduction. comp: an item given away. void: a mistake removed, which was never a sale." }),
    ref("reason", "Reason", "reason_code", { required: true }),
    money("amount", "Amount", { required: true }),
    integer("item_count", "How many times"),
    text("note", "Note", { maxLength: 500 }),
  ],
  rules: [
    check("adjustment_day_amount_not_negative", gte(f("amount"), lit(0)), "The amount cannot be negative."),
    { kind: "ref_value_in", name: "adjustment_day_discount_reason", field: "reason", refField: "kind", allowed: ["discount", "other"], when: eq(f("kind"), lit("discount")), message: "A discount needs a discount reason." },
    { kind: "ref_value_in", name: "adjustment_day_comp_reason", field: "reason", refField: "kind", allowed: ["comp", "other"], when: eq(f("kind"), lit("comp")), message: "A comp needs a comp reason." },
    { kind: "ref_value_in", name: "adjustment_day_void_reason", field: "reason", refField: "kind", allowed: ["void", "other"], when: eq(f("kind"), lit("void")), message: "A void needs a void reason." },
  ],
};

const giftCardActivity: ModelInput = {
  key: "gift_card_activity",
  pack: "sales",
  version: 1,
  name: "Gift card activity",
  description:
    "Gift cards sold and gift cards used to pay on one day. Money taken for a gift card is owed to the guest until the card is used, so it is never sales. Selling a card adds to what is owed, and paying with one reduces it.",
  locationScoped: true,
  defaultAccess: ACCESS.ownerWritesStaffReads,
  unique: [["sales_day"]],
  fields: [
    ref("sales_day", "Daily sales", "sales_day", { required: true, description: "The day this happened on. The business date comes from it." }),
    money("sold_amount", "Gift cards sold", { required: true, description: "Money taken for new or topped-up gift cards. Owed to guests, never revenue." }),
    money("redeemed_amount", "Gift cards redeemed", { required: true, description: "Checks paid with gift cards. Record it here only, not also as a payment type." }),
    integer("cards_sold", "Cards sold"),
    money("outstanding_balance", "Unused balance at end of day", { description: "The total still on guests' cards, when the gift card system reports it." }),
  ],
  rules: [check("gift_card_activity_not_negative", and(gte(f("sold_amount"), lit(0)), gte(f("redeemed_amount"), lit(0))), "Gift card amounts cannot be negative.")],
};

const deliveryPayout: ModelInput = {
  key: "delivery_payout",
  pack: "sales",
  version: 1,
  name: "Delivery platform payout",
  description:
    "One payment a delivery platform makes to the restaurant for a stretch of days: the sales it took, minus its commission, fees, refunds and error charges, plus tips. The breakdown is in the payout lines. Used to check each payout against the till.",
  locationScoped: true,
  defaultAccess: ACCESS.ownerOnly,
  indexes: [["platform", "period_start"], ["business_date"]],
  fields: [
    ref("platform", "Delivery platform", "payment_type", { required: true, description: "The platform, as the payment type its orders are rung up under." }),
    date("period_start", "First day covered", { required: true }),
    date("period_end", "Last day covered", { required: true }),
    businessDate("The business day the payout was paid or is due."),
    money("net_amount", "Amount paid out", { required: true, description: "What the platform says it paid. Should equal the sum of the payout lines, leaving out tax the platform pays over itself." }),
    oneOf("status", "Status", ["expected", "received", "reconciled"], { required: true }),
    text("reference", "Statement reference", { maxLength: 120, sensitivity: "financial" }),
    text("note", "Note", { maxLength: 500 }),
  ],
  rules: [
    check("delivery_payout_dates_in_order", gte(f("period_end"), f("period_start")), "The last day covered cannot be before the first."),
    { kind: "ref_value_in", name: "delivery_payout_platform_kind", field: "platform", refField: "kind", allowed: ["delivery_platform"], message: "A payout must name a delivery platform." },
  ],
};

const deliveryPayoutLine: ModelInput = {
  key: "delivery_payout_line",
  pack: "sales",
  version: 1,
  name: "Delivery payout line",
  description:
    "One line of a delivery platform's payout statement: sales, tips, tax passed to the restaurant, commission, marketing and service fees, error charges, refunds or adjustments. Tax the platform pays to the government itself is recorded but never counted as owed by the restaurant.",
  locationScoped: true,
  defaultAccess: ACCESS.ownerOnly,
  indexes: [["payout"]],
  fields: [
    ref("payout", "Payout", "delivery_payout", { required: true, description: "The payout this line belongs to. The business date comes from it." }),
    oneOf("kind", "Kind", PAYOUT_LINE_KINDS, {
      required: true,
      description: "sales_tax: tax the platform passed on for the restaurant to pay over. tax_remitted_by_platform: tax the platform pays over itself, recorded only and left out of the payout total.",
    }),
    money("amount", "Amount", { required: true, description: "What the platform adds is positive (sales, tips, tax passed on). What it takes is negative (commission, fees, error charges, refunds)." }),
    integer("order_count", "Orders"),
    text("description", "Description", { maxLength: 200 }),
  ],
  rules: [
    check("delivery_payout_line_adds_not_negative", or(not(isIn(f("kind"), [...PAYOUT_ADDS, PAYOUT_MEMO_ONLY])), gte(f("amount"), lit(0))), "Sales, tips and tax lines cannot be negative."),
    check("delivery_payout_line_takes_not_positive", or(not(isIn(f("kind"), PAYOUT_TAKES)), lte(f("amount"), lit(0))), "Commission, fees, error charges and refunds are entered as negative amounts."),
  ],
};

const cashCount: ModelInput = {
  key: "cash_count",
  pack: "sales",
  version: 1,
  name: "Cash count",
  description: "A count of the cash in a drawer or the safe at opening, mid-shift or closing: what should be there, what was counted, and the difference (over or short).",
  locationScoped: true,
  defaultAccess: ACCESS.everyoneWrites,
  indexes: [["business_date"]],
  fields: [
    businessDate("The restaurant day the count belongs to."),
    oneOf("count_type", "When", ["opening", "mid_shift", "closing"], { required: true }),
    text("drawer", "Drawer or safe", { maxLength: 60 }),
    timestamp("counted_at", "Counted at"),
    money("expected_amount", "Expected", { required: true }),
    money("counted_amount", "Counted", { required: true }),
    money("over_short", "Over or short", { required: true, description: "Counted minus expected. Positive is over, negative is short." }),
    parentRef("counted_by", "Counted by", "staff", { sensitivity: "personal" }),
    text("note", "Note", { maxLength: 500 }),
  ],
  rules: [check("cash_count_over_short_is_difference", eq(f("over_short"), sub(f("counted_amount"), f("expected_amount"))), "Over or short must equal counted minus expected.")],
};

const paidInOut: ModelInput = {
  key: "paid_in_out",
  pack: "sales",
  version: 1,
  name: "Cash paid in or out",
  description: "Cash put into or taken out of the drawer that is not a sale, such as buying ice with drawer cash or adding change, with the reason. Explains why the drawer does not match the cash sales.",
  locationScoped: true,
  defaultAccess: ACCESS.everyoneWrites,
  indexes: [["business_date"]],
  fields: [
    businessDate("The restaurant day the cash moved."),
    oneOf("direction", "Direction", ["paid_in", "paid_out"], { required: true }),
    money("amount", "Amount", { required: true }),
    ref("reason", "Reason", "reason_code", { required: true }),
    text("description", "What it was for", { maxLength: 200 }),
    parentRef("recorded_by", "Recorded by", "staff", { sensitivity: "personal" }),
  ],
  rules: [
    check("paid_in_out_amount_positive", gt(f("amount"), lit(0)), "The amount must be more than zero. The direction says which way the cash moved."),
    { kind: "ref_value_in", name: "paid_in_out_paid_in_reason", field: "reason", refField: "kind", allowed: ["paid_in", "other"], when: eq(f("direction"), lit("paid_in")), message: "Cash paid in needs a paid-in reason." },
    { kind: "ref_value_in", name: "paid_in_out_paid_out_reason", field: "reason", refField: "kind", allowed: ["paid_out", "other"], when: eq(f("direction"), lit("paid_out")), message: "Cash paid out needs a paid-out reason." },
  ],
};

const deposit: ModelInput = {
  key: "deposit",
  pack: "sales",
  version: 1,
  name: "Bank deposit",
  description: "Cash taken from the restaurant to the bank: which business day it came from, how much, when it was banked and the slip reference. Used to check that the cash counted reached the bank.",
  locationScoped: true,
  defaultAccess: ACCESS.everyoneWrites,
  indexes: [["business_date"]],
  fields: [
    businessDate("The restaurant day the cash was taken in."),
    date("deposited_on", "Banked on"),
    money("amount", "Amount", { required: true }),
    oneOf("status", "Status", ["prepared", "deposited", "confirmed"], { required: true, description: "confirmed: seen on the bank statement." }),
    text("reference", "Deposit slip reference", { maxLength: 120, sensitivity: "financial" }),
    text("note", "Note", { maxLength: 500 }),
  ],
  rules: [check("deposit_amount_positive", gt(f("amount"), lit(0)), "A deposit must be more than zero.")],
};

export const sales: ModelInput[] = [salesDay, salesCategoryDay, paymentDay, adjustmentDay, giftCardActivity, deliveryPayout, deliveryPayoutLine, cashCount, paidInOut, deposit];

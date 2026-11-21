import { ACCESS, add, and, boolean, businessDate, check, decimal, eq, f, gt, gte, integer, isIn, isNull, lit, money, ne, not, oneOf, or, ref, text } from "./helpers.js";
import type { ModelInput } from "./helpers.js";
import { PAYMENT_KINDS, SALES_GROUPS } from "./foundation.js";

/**
 * Finance pack: the chart of accounts, the ledger, and the rules that turn daily numbers into
 * ledger entries (docs/plan/02-restaurant-domain.md 1.1, 1.4 and section 4).
 */

export const ACCOUNT_TYPES = ["asset", "liability", "equity", "revenue", "expense"];

/**
 * Where an account sits on the profit and loss report. Prime cost is cost_of_goods + labour,
 * as a share of the sales section. Asset, liability and equity accounts are balance_sheet.
 */
export const REPORT_SECTIONS = ["sales", "cost_of_goods", "labour", "controllable", "occupancy", "other_income", "other_expense", "balance_sheet"];
const REVENUE_SECTIONS = ["sales", "other_income"];
const EXPENSE_SECTIONS = ["cost_of_goods", "labour", "controllable", "occupancy", "other_expense"];

export const JOB_GROUPS = ["front_of_house", "back_of_house", "management"];

/**
 * The pieces of the daily numbers that posting rules map to accounts.
 *   net_sales            credit, chosen by sales category or its broad group
 *   sales_tax            credit, money held for the government
 *   tips                 credit, money owed to staff
 *   gift_cards           credit when sold, debit when redeemed: money owed to guests
 *   service_charges      credit, revenue or owed to staff (the restaurant's choice)
 *   payment              debit, chosen by payment type or its kind
 *   vendor_bill_payable  credit, what is owed to vendors
 *   labour_cost          debit, chosen by job group
 *   labour_payable       credit, wages owed
 */
export const POSTING_PARTS = ["net_sales", "sales_tax", "tips", "gift_cards", "service_charges", "payment", "vendor_bill_payable", "labour_cost", "labour_payable"];

/** Domain rule 4: these can only ever be posted to a liability account. Never revenue. */
export const LIABILITY_ONLY_PARTS = ["sales_tax", "tips", "gift_cards"];

const account: ModelInput = {
  key: "account",
  pack: "finance",
  version: 1,
  name: "Account",
  description:
    "One line of the restaurant's chart of accounts, such as Food sales, Food cost, Front of house wages, Sales tax owed or Rent. Its type and report section decide where it shows on the profit and loss report and whether it counts toward prime cost.",
  locationScoped: false,
  defaultAccess: ACCESS.ownerWritesStaffReads,
  labelField: "name",
  unique: [["code"]],
  indexes: [["type", "report_section"]],
  fields: [
    text("code", "Account number", { required: true, maxLength: 12 }),
    text("name", "Name", { required: true, maxLength: 80 }),
    oneOf("type", "Type", ACCOUNT_TYPES, {
      required: true,
      description: "asset: what the restaurant has. liability: what it owes, including sales tax, tips and unused gift cards. equity: the owner's stake. revenue: what it earns. expense: what it spends.",
    }),
    oneOf("report_section", "Report section", REPORT_SECTIONS, {
      required: true,
      description: "Where the account shows on the profit and loss report. Prime cost is cost_of_goods plus labour. Asset, liability and equity accounts are balance_sheet.",
    }),
    text("description", "What it is for", { maxLength: 280 }),
    boolean("active", "In use", { required: true }),
  ],
  rules: [
    check(
      "account_section_matches_type",
      or(
        and(isIn(f("type"), ["asset", "liability", "equity"]), eq(f("report_section"), lit("balance_sheet"))),
        and(eq(f("type"), lit("revenue")), isIn(f("report_section"), REVENUE_SECTIONS)),
        and(eq(f("type"), lit("expense")), isIn(f("report_section"), EXPENSE_SECTIONS)),
      ),
      "The report section must fit the account type: sales and other income are revenue, costs are expenses, everything else is on the balance sheet.",
    ),
  ],
};

const journalEntry: ModelInput = {
  key: "journal_entry",
  pack: "finance",
  version: 1,
  name: "Journal entry",
  description:
    "One entry in the restaurant's books, such as a day of sales, a vendor bill or a day of staff cost. Its lines must balance: money in equals money out. Entries are never edited or deleted. A mistake is fixed with a new entry that reverses the old one.",
  locationScoped: true,
  appendOnly: true,
  softDelete: false,
  defaultAccess: ACCESS.ownerOnly,
  labelField: "memo",
  unique: [["reverses"]],
  indexes: [["business_date"], ["origin", "origin_id"]],
  fields: [
    businessDate("The restaurant day the entry counts in. Its week and period come from the fiscal calendar. Nothing can be dated in a closed period."),
    text("memo", "What it is", { required: true, maxLength: 200 }),
    oneOf("origin", "Made from", ["manual", "sales_day", "vendor_bill", "labour_day", "reversal", "opening_balance", "other"], {
      required: true,
      description: "What the entry records. Entries made by posting a day of sales, a bill or a day of staff cost say so here.",
    }),
    text("origin_id", "Made from record", { maxLength: 64, description: "The id of the daily sales, vendor bill or staff cost row this entry was posted from." }),
    ref("reverses", "Reverses entry", "journal_entry", { description: "The earlier entry this one cancels. Each entry can be reversed once." }),
  ],
  rules: [
    { kind: "balanced", name: "journal_entry_balanced", lineModel: "journal_line", lineRef: "entry", debit: "debit", credit: "credit" },
    { kind: "open_period_only", name: "journal_entry_open_period", dateField: "business_date" },
    check(
      "journal_entry_reversal_names_entry",
      or(and(eq(f("origin"), lit("reversal")), not(isNull(f("reverses")))), and(ne(f("origin"), lit("reversal")), isNull(f("reverses")))),
      "A reversing entry must name the entry it reverses, and only a reversing entry may.",
    ),
  ],
};

const journalLine: ModelInput = {
  key: "journal_line",
  pack: "finance",
  version: 1,
  name: "Journal line",
  description:
    "One line of a journal entry: an account and an amount on the debit side or the credit side. The profit and loss report and prime cost are sums of these lines. Lines are never edited or deleted.",
  locationScoped: true,
  appendOnly: true,
  softDelete: false,
  defaultAccess: ACCESS.ownerOnly,
  unique: [["entry", "line_number"]],
  indexes: [["account"], ["entry"]],
  fields: [
    ref("entry", "Journal entry", "journal_entry", { required: true, description: "The entry this line belongs to. The business date comes from it." }),
    integer("line_number", "Line", { required: true }),
    ref("account", "Account", "account", { required: true }),
    money("debit", "Debit", { required: true, description: "Zero when the line is a credit." }),
    money("credit", "Credit", { required: true, description: "Zero when the line is a debit." }),
    text("memo", "What it is", { maxLength: 200 }),
  ],
  rules: [
    check("journal_line_amounts_not_negative", and(gte(f("debit"), lit(0)), gte(f("credit"), lit(0))), "Debits and credits cannot be negative."),
    check("journal_line_one_side_only", or(eq(f("debit"), lit(0)), eq(f("credit"), lit(0))), "A line is either a debit or a credit, not both."),
    check("journal_line_not_empty", gt(add(f("debit"), f("credit")), lit(0)), "A line needs an amount."),
  ],
};

const onlyFor = (part: string, ...selectors: string[]) => or(eq(f("part"), lit(part)), selectors.length === 1 ? isNull(f(selectors[0] as string)) : and(...selectors.map((s) => isNull(f(s)))));

const accountTypeFor = (name: string, parts: string[], allowed: string[], message: string): NonNullable<ModelInput["rules"]>[number] => ({
  kind: "ref_value_in",
  name,
  field: "account",
  refField: "type",
  allowed,
  when: isIn(f("part"), parts),
  message,
});

const postingRule: ModelInput = {
  key: "posting_rule",
  pack: "finance",
  version: 1,
  name: "Posting rule",
  description:
    "Says which account each part of the daily numbers goes to: net sales by category, sales tax, tips, gift cards, service charges, each kind of payment, vendor bills and staff cost. Sales tax, tips and gift cards can only go to accounts for money owed, never to sales.",
  locationScoped: false,
  defaultAccess: ACCESS.ownerOnly,
  indexes: [["part"]],
  fields: [
    oneOf("part", "What is being posted", POSTING_PARTS, {
      required: true,
      description: "net_sales, sales_tax, tips, gift_cards, service_charges and the payable parts are credits. payment and labour_cost are debits. gift_cards is a credit when sold and a debit when redeemed.",
    }),
    ref("sales_category", "Only for this sales category", "sales_category", { description: "For net_sales. A rule for one category wins over a rule for its broad group." }),
    oneOf("sales_group", "Only for this broad sales group", SALES_GROUPS, { description: "For net_sales. Leave both this and the category empty for the catch-all rule." }),
    ref("payment_type", "Only for this payment type", "payment_type", { description: "For payment. A rule for one payment type wins over a rule for its kind." }),
    oneOf("payment_kind", "Only for this kind of payment", PAYMENT_KINDS, { description: "For payment. Leave both this and the payment type empty for the catch-all rule." }),
    oneOf("job_group", "Only for this job group", JOB_GROUPS, { description: "For labour_cost. Leave empty for the catch-all rule." }),
    ref("account", "Account", "account", { required: true }),
    boolean("active", "In use", { required: true }),
    text("note", "Note", { maxLength: 280 }),
  ],
  rules: [
    check("posting_rule_sales_selectors", onlyFor("net_sales", "sales_category", "sales_group"), "A sales category or sales group can only be set on a net sales rule."),
    check("posting_rule_payment_selectors", onlyFor("payment", "payment_type", "payment_kind"), "A payment type or kind can only be set on a payment rule."),
    check("posting_rule_job_selector", onlyFor("labour_cost", "job_group"), "A job group can only be set on a staff cost rule."),
    // Domain rule 4. Tips, sales tax and unredeemed gift cards are money owed. Never revenue.
    accountTypeFor("posting_rule_owed_money_is_liability", LIABILITY_ONLY_PARTS, ["liability"], "Sales tax, tips and gift cards are money the restaurant owes. They can only be posted to a liability account, never to sales."),
    accountTypeFor("posting_rule_net_sales_is_revenue", ["net_sales"], ["revenue"], "Net sales must be posted to a revenue account."),
    accountTypeFor("posting_rule_service_charge_account", ["service_charges"], ["revenue", "liability"], "Service charges are either revenue or money owed to staff."),
    accountTypeFor("posting_rule_payment_is_asset", ["payment"], ["asset"], "Payments must be posted to an asset account such as cash or card payments in transit."),
    accountTypeFor("posting_rule_payables_are_liabilities", ["vendor_bill_payable", "labour_payable"], ["liability"], "Bills and wages owed must be posted to a liability account."),
    accountTypeFor("posting_rule_labour_is_expense", ["labour_cost"], ["expense"], "Staff cost must be posted to an expense account."),
  ],
};

const budget: ModelInput = {
  key: "budget",
  pack: "finance",
  version: 1,
  name: "Budget",
  description: "The target for one account at one location in one fiscal period, as an amount, as a share of net sales, or both. For example food cost at 30% of sales. Reports compare actual numbers with these targets.",
  locationScoped: true,
  defaultAccess: ACCESS.ownerOnly,
  unique: [["location_id", "account", "period"]],
  fields: [
    ref("account", "Account", "account", { required: true }),
    ref("period", "Fiscal period", "fiscal_period", { required: true }),
    money("amount", "Target amount"),
    decimal("pct_of_sales", "Target share of net sales (%)", { scale: 1, sensitivity: "financial", description: "30.0 means 30% of net sales." }),
    text("note", "Note", { maxLength: 280 }),
  ],
  rules: [check("budget_has_a_target", not(and(isNull(f("amount")), isNull(f("pct_of_sales")))), "A budget needs a target amount, a target share of sales, or both.")],
};

export const finance: ModelInput[] = [account, journalEntry, journalLine, postingRule, budget];

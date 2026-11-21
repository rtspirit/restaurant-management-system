// A small pack for the compiler and store tests only. NOT the library: the real packs live in
// src/packs and are written by the domain modeller. Every shape the compiler handles is here once.
import { ModelDefinition, NamedActionDefinition, NamedQueryDefinition } from "@rms/contracts";

const access = { owner: "write", staff: "read" } as const;

const models = [
  {
    key: "fiscal_period",
    version: 1,
    pack: "foundation",
    name: "Fiscal period",
    description: "A period of the restaurant's own calendar. A closed period accepts nothing new.",
    locationScoped: false,
    fields: [
      { key: "name", label: "Name", type: "text", required: true, maxLength: 40 },
      { key: "start_date", label: "Starts", type: "date", required: true },
      { key: "end_date", label: "Ends", type: "date", required: true },
      { key: "status", label: "Status", type: "enum", values: ["open", "closed"], required: true },
    ],
    rules: [{ kind: "check", name: "ends_after_start", expr: { op: "gte", args: [{ field: "end_date" }, { field: "start_date" }] }, message: "A period cannot end before it starts." }],
    unique: [["start_date"]],
    defaultAccess: access,
    labelField: "name",
  },
  {
    key: "account",
    version: 1,
    pack: "finance",
    name: "Account",
    description: "One line of the chart of accounts, such as food sales or tips owed to staff.",
    locationScoped: false,
    fields: [
      { key: "code", label: "Code", type: "text", required: true, maxLength: 20 },
      { key: "name", label: "Name", type: "text", required: true },
      { key: "type", label: "Type", type: "enum", values: ["asset", "liability", "equity", "revenue", "expense"], required: true },
    ],
    unique: [["code"]],
    defaultAccess: access,
    labelField: "name",
  },
  {
    key: "journal_entry",
    version: 1,
    pack: "finance",
    name: "Journal entry",
    description: "The header of one ledger entry. Its lines must balance. Never edited.",
    appendOnly: true,
    fields: [
      { key: "entry_date", label: "Date", type: "business_date", required: true },
      { key: "memo", label: "Memo", type: "text", maxLength: 200 },
      // A model that points at itself, like the real ledger: a reversing entry names the entry it cancels.
      { key: "reverses", label: "Reverses", type: "ref", model: "journal_entry" },
    ],
    unique: [["reverses"]],
    indexes: [["entry_date"]],
    rules: [
      { kind: "balanced", name: "entry_balances", lineModel: "journal_line", lineRef: "entry", debit: "debit", credit: "credit" },
      { kind: "open_period_only", name: "period_is_open", dateField: "entry_date" },
    ],
    defaultAccess: { owner: "write", staff: "none" },
  },
  {
    key: "journal_line",
    version: 1,
    pack: "finance",
    name: "Journal line",
    description: "One debit or credit of a ledger entry, against one account. Never edited.",
    appendOnly: true,
    fields: [
      { key: "entry", label: "Entry", type: "ref", model: "journal_entry", required: true },
      { key: "account", label: "Account", type: "ref", model: "account", required: true },
      { key: "debit", label: "Debit", type: "money", required: true, sensitivity: "financial" },
      { key: "credit", label: "Credit", type: "money", required: true, sensitivity: "financial" },
    ],
    rules: [
      {
        kind: "check",
        name: "one_side_only",
        expr: {
          op: "and",
          args: [
            { op: "gte", args: [{ field: "debit" }, { lit: 0 }] },
            { op: "gte", args: [{ field: "credit" }, { lit: 0 }] },
            { op: "or", args: [{ op: "eq", args: [{ field: "debit" }, { lit: 0 }] }, { op: "eq", args: [{ field: "credit" }, { lit: 0 }] }] },
          ],
        },
        message: "A line is a debit or a credit, not both.",
      },
    ],
    defaultAccess: { owner: "write", staff: "none" },
  },
  {
    key: "posting_rule",
    version: 1,
    pack: "finance",
    name: "Posting rule",
    description: "Says which account each part of a day of sales is posted to.",
    locationScoped: false,
    fields: [
      { key: "part", label: "Part", type: "enum", values: ["net_sales", "sales_tax", "tips", "gift_cards_sold"], required: true },
      { key: "account", label: "Account", type: "ref", model: "account", required: true },
    ],
    unique: [["part"]],
    rules: [
      {
        kind: "ref_value_in",
        name: "owed_money_is_a_liability",
        field: "account",
        refField: "type",
        allowed: ["liability"],
        when: { op: "in", arg: { field: "part" }, values: ["sales_tax", "tips", "gift_cards_sold"] },
        message: "Tips, sales tax and gift cards sold are money owed. They cannot be posted as sales.",
      },
    ],
    defaultAccess: access,
  },
  {
    key: "paid_out",
    version: 1,
    pack: "sales",
    name: "Paid out",
    description: "Cash taken from the drawer at one location to pay for something small.",
    fields: [
      { key: "amount", label: "Amount", type: "money", required: true },
      { key: "account", label: "Account", type: "ref", model: "account", required: true },
    ],
    // Location-scoped, with no `when`: the target-side check must see rows at every location.
    rules: [{ kind: "ref_value_in", name: "paid_from_an_expense", field: "account", refField: "type", allowed: ["expense"], message: "Cash paid out must go to an expense account." }],
    defaultAccess: access,
  },
  {
    key: "sales_day",
    version: 1,
    pack: "sales",
    name: "Sales day",
    description: "One row per location, business date and channel with that day's sales totals.",
    fields: [
      { key: "business_date", label: "Business date", type: "business_date", required: true },
      { key: "channel", label: "Channel", type: "enum", values: ["dine_in", "takeout", "delivery"], required: true },
      { key: "net_sales", label: "Net sales", type: "money", required: true, sensitivity: "financial" },
      { key: "guests", label: "Guests", type: "integer" },
      { key: "notes", label: "Notes", type: "text", maxLength: 500 },
    ],
    unique: [["location_id", "business_date", "channel"]],
    rules: [{ kind: "check", name: "net_sales_not_negative", expr: { op: "gte", args: [{ field: "net_sales" }, { lit: 0 }] }, message: "Net sales cannot be below zero." }],
    defaultAccess: access,
  },
  {
    key: "vendor",
    version: 1,
    pack: "inventory",
    name: "Vendor",
    description: "A supplier the restaurant buys from, such as a produce or meat company.",
    locationScoped: false,
    fields: [{ key: "name", label: "Name", type: "text", required: true, maxLength: 120 }],
    defaultAccess: access,
    labelField: "name",
  },
  {
    key: "prep_item",
    version: 1,
    pack: "inventory",
    name: "Prep item",
    description: "Something the kitchen keeps on hand, with how much is there and who supplies it.",
    fields: [
      { key: "name", label: "Name", type: "text", required: true },
      { key: "category", label: "Category", type: "enum", values: ["produce", "meat", "dairy", "dry_goods"] },
      { key: "vendor", label: "Vendor", type: "ref", model: "vendor", onDelete: "set_null" },
      { key: "menu_item", label: "Menu item", type: "parent_ref", parentModel: "menu_items" },
      { key: "on_hand", label: "On hand", type: "quantity" },
      { key: "unit_cost", label: "Unit cost", type: "decimal", scale: 4 },
      { key: "active", label: "Active", type: "boolean", required: true },
      { key: "counted_at", label: "Counted at", type: "timestamp" },
      { key: "details", label: "Details", type: "json" },
    ],
    indexes: [["category", "name"]],
    defaultAccess: access,
    labelField: "name",
  },
  {
    key: "labour_day",
    version: 1,
    pack: "labour",
    name: "Labour day",
    description: "Hours worked and wages for one job at one location on one business date.",
    fields: [
      { key: "business_date", label: "Business date", type: "business_date", required: true },
      { key: "job", label: "Job", type: "parent_ref", parentModel: "jobs", required: true },
      { key: "hours", label: "Hours", type: "decimal", scale: 2, required: true },
      { key: "wages", label: "Wages", type: "money", sensitivity: "payroll", readableBy: ["owner"] },
    ],
    defaultAccess: access,
  },
] as const;

const namedQueries = [
  {
    key: "sales_by_day",
    pack: "sales",
    name: "Sales by day",
    description: "Net sales for each business date in a range, across the caller's locations.",
    reads: ["sales_day"],
    params: [
      { key: "from", type: "business_date" },
      { key: "to", type: "business_date" },
    ],
    sql: "select business_date, sum(net_sales) as net_sales from {{sales_day}} where business_date between :from and :to group by business_date order by business_date",
    columns: [
      { key: "business_date", label: "Business date", type: "business_date" },
      { key: "net_sales", label: "Net sales", type: "money", sensitivity: "financial" },
    ],
  },
] as const;

const namedActions = [
  {
    key: "close_period",
    pack: "foundation",
    name: "Close a period",
    description: "Marks one fiscal period as closed so that nothing new can be posted to it.",
    reads: ["fiscal_period"],
    writes: ["fiscal_period"],
    params: [{ key: "period", type: "uuid" }],
    sql: "update {{fiscal_period}} set status = 'closed' where id = :period and status <> 'closed'",
    idempotent: true,
  },
] as const;

/** Raw, as a pack file would export them. */
export const fixturePack = { models, namedQueries, namedActions };

/** Parsed with the contract's schemas. */
export const fixtureModels: ModelDefinition[] = models.map((m) => ModelDefinition.parse(m));
export const fixtureQueries: NamedQueryDefinition[] = namedQueries.map((q) => NamedQueryDefinition.parse(q));
export const fixtureActions: NamedActionDefinition[] = namedActions.map((a) => NamedActionDefinition.parse(a));

export const fixtureModel = (key: string): ModelDefinition => {
  const m = fixtureModels.find((x) => x.key === key);
  if (!m) throw new Error(`No fixture model ${key}`);
  return m;
};

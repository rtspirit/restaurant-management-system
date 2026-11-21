import { sql } from "./helpers.js";
import type { NamedActionInput } from "./helpers.js";

/**
 * Named actions: the writes that set a restaurant's books up and turn daily numbers into ledger
 * entries.
 *
 * Template rules (packages/contracts/src/models.ts): tables only as {{model_ref}}, parameters
 * only as :key, one statement, inserts only into the models listed in `writes`. On top of that:
 *   - a write target is always written exactly `insert into {{model}} (`,
 *   - every read of a {{model_ref}} has an alias,
 *   - `cast(:key as type)`, never `::`, and no colon inside a quoted string,
 *   - no comments, no semicolon, no update and no delete (the ledger is append-only).
 *
 * How the four posting actions stay safe:
 *   - Idempotent by source id. The entry is inserted with `source_id = '<model>/<row id>'` and
 *     `on conflict do nothing`, so the unique (source, source_id) index the compiler adds makes
 *     a second run insert nothing. Lines are only inserted for an entry inserted by this run.
 *   - Balanced by construction, and checked again by the `balanced` rule at commit. If the
 *     numbers do not add up, the entry does not balance and the commit fails.
 *   - Refusals. Anything that must not be posted becomes a "guard" part: a line with NO account
 *     whose text says what is wrong. `journal_line.account` is required, so the whole statement
 *     fails and nothing is half-posted. A missing posting rule fails the same way. A row that
 *     does not exist (or is outside the caller's locations) fails too, on the entry itself.
 *   - So the result means: more than 0 = posted now. 0 = already posted, or there was nothing
 *     to post (every amount was zero). Anything wrong is an error, never a quiet 0.
 *   - Accounts come only from `posting_rule`, whose own rules stop tips, sales tax and gift
 *     cards from ever being pointed at a revenue account (domain rule 4).
 *
 * System columns the template sets itself, because a named action is plain SQL run as the
 * restaurant's role: `id` (gen_random_uuid(): application code normally makes uuid v7),
 * `source` ('app', the contract's value for rows written by a named action), `created_by` and
 * `updated_by` (rms.current_actor(), which the Data API sets per transaction), `location_id`
 * and `currency` (copied from the row being posted).
 */

// ---------------------------------------------------------------- chart of accounts template

type AccountType = "asset" | "liability" | "equity" | "revenue" | "expense";
type ReportSection = "sales" | "cost_of_goods" | "labour" | "controllable" | "occupancy" | "other_income" | "other_expense" | "balance_sheet";

export type DefaultAccount = { code: string; name: string; type: AccountType; reportSection: ReportSection };

/**
 * A restaurant chart of accounts in everyday words. Layout follows docs/plan/02 section 1.1.
 *
 * 7500 is where what delivery apps keep (commission and fees) goes. It is a running cost in the
 * controllable section, so it lowers net profit and never touches prime cost (ADR 0011).
 */
export const DEFAULT_CHART_OF_ACCOUNTS: DefaultAccount[] = [
  { code: "1000", name: "Cash on hand", type: "asset", reportSection: "balance_sheet" },
  { code: "1010", name: "Bank account", type: "asset", reportSection: "balance_sheet" },
  { code: "1100", name: "Card payments in transit", type: "asset", reportSection: "balance_sheet" },
  { code: "1110", name: "Delivery platform payouts due", type: "asset", reportSection: "balance_sheet" },
  { code: "1120", name: "House accounts owed to us", type: "asset", reportSection: "balance_sheet" },
  { code: "1190", name: "Other payments in transit", type: "asset", reportSection: "balance_sheet" },
  { code: "1200", name: "Stock on hand", type: "asset", reportSection: "balance_sheet" },
  { code: "2000", name: "Bills owed to vendors", type: "liability", reportSection: "balance_sheet" },
  { code: "2100", name: "Sales tax owed", type: "liability", reportSection: "balance_sheet" },
  { code: "2200", name: "Tips owed to staff", type: "liability", reportSection: "balance_sheet" },
  { code: "2300", name: "Gift cards not yet used", type: "liability", reportSection: "balance_sheet" },
  { code: "2400", name: "Wages owed", type: "liability", reportSection: "balance_sheet" },
  { code: "3000", name: "Owner equity", type: "equity", reportSection: "balance_sheet" },
  { code: "3900", name: "Profit kept in the business", type: "equity", reportSection: "balance_sheet" },
  { code: "4000", name: "Food sales", type: "revenue", reportSection: "sales" },
  { code: "4100", name: "Soft drink and coffee sales", type: "revenue", reportSection: "sales" },
  { code: "4200", name: "Beer, wine and spirits sales", type: "revenue", reportSection: "sales" },
  { code: "4300", name: "Merchandise sales", type: "revenue", reportSection: "sales" },
  { code: "4400", name: "Other sales", type: "revenue", reportSection: "sales" },
  { code: "4900", name: "Service charge income", type: "revenue", reportSection: "other_income" },
  { code: "5000", name: "Food cost", type: "expense", reportSection: "cost_of_goods" },
  { code: "5100", name: "Soft drink and coffee cost", type: "expense", reportSection: "cost_of_goods" },
  { code: "5200", name: "Beer, wine and spirits cost", type: "expense", reportSection: "cost_of_goods" },
  { code: "5300", name: "Merchandise cost", type: "expense", reportSection: "cost_of_goods" },
  { code: "6000", name: "Front of house wages", type: "expense", reportSection: "labour" },
  { code: "6100", name: "Back of house wages", type: "expense", reportSection: "labour" },
  { code: "6200", name: "Management wages", type: "expense", reportSection: "labour" },
  { code: "6300", name: "Payroll taxes", type: "expense", reportSection: "labour" },
  { code: "6400", name: "Staff benefits", type: "expense", reportSection: "labour" },
  { code: "7000", name: "Kitchen and restaurant supplies", type: "expense", reportSection: "controllable" },
  { code: "7100", name: "Repairs and maintenance", type: "expense", reportSection: "controllable" },
  { code: "7200", name: "Marketing", type: "expense", reportSection: "controllable" },
  { code: "7300", name: "Utilities", type: "expense", reportSection: "controllable" },
  { code: "7400", name: "Card processing fees", type: "expense", reportSection: "controllable" },
  { code: "7500", name: "Delivery platform commissions and fees", type: "expense", reportSection: "controllable" },
  { code: "7600", name: "Cash over and short", type: "expense", reportSection: "controllable" },
  { code: "8000", name: "Rent", type: "expense", reportSection: "occupancy" },
  { code: "8100", name: "Property tax", type: "expense", reportSection: "occupancy" },
  { code: "8200", name: "Insurance", type: "expense", reportSection: "occupancy" },
  { code: "9000", name: "Depreciation", type: "expense", reportSection: "other_expense" },
  { code: "9100", name: "Interest", type: "expense", reportSection: "other_expense" },
];

export type DefaultPostingRule = {
  /** Stable name for the rule. Becomes its source id, so seeding twice adds nothing. */
  ruleKey: string;
  part: "net_sales" | "sales_tax" | "tips" | "gift_cards" | "service_charges" | "payment" | "vendor_bill_payable" | "labour_cost" | "labour_payable" | "stock_on_hand" | "stock_cost" | "stock_opening";
  salesGroup?: "food" | "beverage" | "alcohol" | "merchandise" | "other";
  paymentKind?: "cash" | "card" | "delivery_platform" | "house_account" | "other";
  jobGroup?: "front_of_house" | "back_of_house" | "management";
  costGroup?: "food" | "beverage" | "alcohol" | "supplies";
  accountCode: string;
};

/** Where each part of the daily numbers goes until the owner says otherwise. */
export const DEFAULT_POSTING_RULES: DefaultPostingRule[] = [
  { ruleKey: "net_sales/food", part: "net_sales", salesGroup: "food", accountCode: "4000" },
  { ruleKey: "net_sales/beverage", part: "net_sales", salesGroup: "beverage", accountCode: "4100" },
  { ruleKey: "net_sales/alcohol", part: "net_sales", salesGroup: "alcohol", accountCode: "4200" },
  { ruleKey: "net_sales/merchandise", part: "net_sales", salesGroup: "merchandise", accountCode: "4300" },
  { ruleKey: "net_sales/other", part: "net_sales", salesGroup: "other", accountCode: "4400" },
  { ruleKey: "net_sales/any", part: "net_sales", accountCode: "4400" },
  { ruleKey: "sales_tax", part: "sales_tax", accountCode: "2100" },
  { ruleKey: "tips", part: "tips", accountCode: "2200" },
  { ruleKey: "gift_cards", part: "gift_cards", accountCode: "2300" },
  { ruleKey: "service_charges", part: "service_charges", accountCode: "4900" },
  { ruleKey: "payment/cash", part: "payment", paymentKind: "cash", accountCode: "1000" },
  { ruleKey: "payment/card", part: "payment", paymentKind: "card", accountCode: "1100" },
  { ruleKey: "payment/delivery_platform", part: "payment", paymentKind: "delivery_platform", accountCode: "1110" },
  { ruleKey: "payment/house_account", part: "payment", paymentKind: "house_account", accountCode: "1120" },
  { ruleKey: "payment/other", part: "payment", paymentKind: "other", accountCode: "1190" },
  { ruleKey: "payment/any", part: "payment", accountCode: "1190" },
  { ruleKey: "vendor_bill_payable", part: "vendor_bill_payable", accountCode: "2000" },
  { ruleKey: "labour_cost/front_of_house", part: "labour_cost", jobGroup: "front_of_house", accountCode: "6000" },
  { ruleKey: "labour_cost/back_of_house", part: "labour_cost", jobGroup: "back_of_house", accountCode: "6100" },
  { ruleKey: "labour_cost/management", part: "labour_cost", jobGroup: "management", accountCode: "6200" },
  { ruleKey: "labour_payable", part: "labour_payable", accountCode: "2400" },
  { ruleKey: "stock_on_hand", part: "stock_on_hand", accountCode: "1200" },
  { ruleKey: "stock_cost/food", part: "stock_cost", costGroup: "food", accountCode: "5000" },
  { ruleKey: "stock_cost/beverage", part: "stock_cost", costGroup: "beverage", accountCode: "5100" },
  { ruleKey: "stock_cost/alcohol", part: "stock_cost", costGroup: "alcohol", accountCode: "5200" },
  { ruleKey: "stock_cost/supplies", part: "stock_cost", costGroup: "supplies", accountCode: "7000" },
  { ruleKey: "stock_opening", part: "stock_opening", accountCode: "3000" },
];

/**
 * Writes one of OUR OWN constants as a SQL string. Not a general escaper: it refuses anything
 * but plain words, so nothing surprising can reach the template (no quote, colon, brace,
 * semicolon or dash-dash).
 */
const quoted = (value: string): string => {
  if (!/^[A-Za-z0-9 ,/_]{1,80}$/.test(value)) throw new Error(`Not a plain word list: ${value}`);
  return `'${value}'`;
};
const quotedOrNull = (value: string | undefined): string => (value === undefined ? "cast(null as text)" : quoted(value));

const chartValues = DEFAULT_CHART_OF_ACCOUNTS.map((a) => `(${[a.code, a.name, a.type, a.reportSection].map(quoted).join(", ")})`).join(",\n");
const ruleValues = DEFAULT_POSTING_RULES.map(
  (r) => `(${[quoted(r.ruleKey), quoted(r.part), quotedOrNull(r.salesGroup), quotedOrNull(r.paymentKind), quotedOrNull(r.jobGroup), quotedOrNull(r.costGroup), quoted(r.accountCode)].join(", ")})`,
).join(",\n");

const seedChartOfAccounts: NamedActionInput = {
  key: "seed_chart_of_accounts",
  pack: "finance",
  name: "Set up the chart of accounts",
  description:
    "Adds a standard restaurant chart of accounts and the default posting rules (which account each part of daily sales, bills, staff cost and stock counts goes to). Safe to run again: accounts and rules that already exist are left exactly as they are.",
  reads: ["account"],
  writes: ["account", "posting_rule"],
  params: [],
  idempotent: true,
  sql: sql`
    with chart (code, name, type, report_section) as (
      values
        ${chartValues}
    ),
    new_accounts as (
      insert into {{account}} (id, code, name, type, report_section, active, source, source_id, created_by, updated_by)
      select gen_random_uuid(), c.code, c.name, c.type, c.report_section, true, 'app', 'chart/' || c.code, rms.current_actor(), rms.current_actor()
      from chart as c
      on conflict do nothing
      returning id, code
    ),
    all_accounts as (
      select n.id, n.code from new_accounts as n
      union all
      select a.id, a.code from {{account}} as a
    ),
    default_rules (rule_key, part, sales_group, payment_kind, job_group, cost_group, account_code) as (
      values
        ${ruleValues}
    ),
    new_rules as (
      insert into {{posting_rule}} (id, part, sales_group, payment_kind, job_group, cost_group, account, active, source, source_id, created_by, updated_by)
      select gen_random_uuid(), d.part, d.sales_group, d.payment_kind, d.job_group, d.cost_group, aa.id, true, 'app', 'default_rule/' || d.rule_key, rms.current_actor(), rms.current_actor()
      from default_rules as d
      join all_accounts as aa on aa.code = d.account_code
      on conflict do nothing
      returning id
    )
    select (select count(*) from new_accounts) + (select count(*) from new_rules) as affected
  `,
};

// ---------------------------------------------------------------- fiscal calendar

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthNames = `array[${MONTHS.map(quoted).join(", ")}]`;
const shortMonthNames = `array[${MONTHS.map((m) => quoted(m.slice(0, 3))).join(", ")}]`;

/**
 * One calendar, always the same one (found by its name), with Monday-start weeks and calendar
 * months as periods. Everything about a week is worked out from its Monday alone (ISO week
 * number and ISO year), so running the action for another date range gives the same week the
 * same number, and a week that already exists is simply left alone. A week belongs to the month
 * that holds its Thursday, which is the month most of its days fall in.
 */
export const STANDARD_CALENDAR_NAME = "Standard calendar";

const seedFiscalCalendar: NamedActionInput = {
  key: "seed_fiscal_calendar",
  pack: "foundation",
  name: "Set up the fiscal calendar",
  description:
    "Makes sure the standard fiscal calendar exists (weeks start on Monday, periods are calendar months) and has a week and a period for every day between two dates. Safe to run again, and for a longer range later: weeks and periods that already exist are left exactly as they are.",
  reads: ["fiscal_calendar", "fiscal_period"],
  writes: ["fiscal_calendar", "fiscal_period", "fiscal_week"],
  params: [
    { key: "from_date", type: "date" },
    { key: "to_date", type: "date" },
  ],
  idempotent: true,
  sql: sql`
    with bounds as (
      select cast(:from_date as date) - (cast(extract(isodow from cast(:from_date as date)) as integer) - 1) as first_monday,
             cast(:to_date as date) - (cast(extract(isodow from cast(:to_date as date)) as integer) - 1) as last_monday
    ),
    week_list as (
      select b.first_monday + 7 * g.n as start_date,
             b.first_monday + 7 * g.n + 6 as end_date,
             b.first_monday + 7 * g.n + 3 as thursday
      from bounds as b
      cross join lateral generate_series(0, (b.last_monday - b.first_monday) / 7) as g(n)
    ),
    month_list as (
      select k.n / 12 as year_number,
             mod(k.n, 12) + 1 as month_number,
             make_date(k.n / 12, mod(k.n, 12) + 1, 1) as start_date,
             make_date((k.n + 1) / 12, mod(k.n + 1, 12) + 1, 1) - 1 as end_date
      from bounds as b
      cross join lateral generate_series(
        cast(extract(year from b.first_monday) as integer) * 12 + cast(extract(month from b.first_monday) as integer) - 1,
        cast(extract(year from b.last_monday + 6) as integer) * 12 + cast(extract(month from b.last_monday + 6) as integer) - 1
      ) as k(n)
    ),
    new_calendar as (
      insert into {{fiscal_calendar}} (id, name, kind, week_starts_on, active, source, source_id, created_by, updated_by)
      select gen_random_uuid(), ${quoted(STANDARD_CALENDAR_NAME)}, 'calendar_months', 'monday', true, 'app', 'fiscal_calendar/standard', rms.current_actor(), rms.current_actor()
      where not exists (select 1 from {{fiscal_calendar}} as fc where fc.name = ${quoted(STANDARD_CALENDAR_NAME)})
      on conflict do nothing
      returning id
    ),
    chosen as (
      select n.id from new_calendar as n
      union all
      select fc.id from {{fiscal_calendar}} as fc where fc.name = ${quoted(STANDARD_CALENDAR_NAME)}
    ),
    new_periods as (
      insert into {{fiscal_period}} (id, calendar, fiscal_year, period_number, name, start_date, end_date, status, source, source_id, created_by, updated_by)
      select gen_random_uuid(), c.id, m.year_number, m.month_number, (${monthNames})[m.month_number] || ' ' || cast(m.year_number as text), m.start_date, m.end_date, 'open', 'app', 'fiscal_period/' || cast(m.year_number as text) || '/' || cast(m.month_number as text), rms.current_actor(), rms.current_actor()
      from month_list as m
      cross join chosen as c
      on conflict do nothing
      returning id, start_date, end_date
    ),
    all_periods as (
      select n.id, n.start_date, n.end_date from new_periods as n
      union all
      select fp.id, fp.start_date, fp.end_date
      from {{fiscal_period}} as fp
      join chosen as c on c.id = fp.calendar
    ),
    new_weeks as (
      insert into {{fiscal_week}} (id, calendar, period, fiscal_year, week_number, name, start_date, end_date, source, source_id, created_by, updated_by)
      select gen_random_uuid(), c.id, p.id, cast(extract(isoyear from w.start_date) as integer), cast(extract(week from w.start_date) as integer), 'Week of ' || (${shortMonthNames})[cast(extract(month from w.start_date) as integer)] || ' ' || cast(cast(extract(day from w.start_date) as integer) as text) || ', ' || cast(cast(extract(year from w.start_date) as integer) as text), w.start_date, w.end_date, 'app', 'fiscal_week/' || cast(cast(extract(isoyear from w.start_date) as integer) as text) || '/' || cast(cast(extract(week from w.start_date) as integer) as text), rms.current_actor(), rms.current_actor()
      from week_list as w
      cross join chosen as c
      join all_periods as p on w.thursday between p.start_date and p.end_date
      on conflict do nothing
      returning id
    )
    select (select count(*) from new_calendar) + (select count(*) from new_periods) + (select count(*) from new_weeks) as affected
  `,
};

// ---------------------------------------------------------------- posting

/** The one rule for each part that has no selectors (lowest id wins if there are several). */
const SIMPLE_RULES = `simple_rule as (
  select distinct on (pr.part) pr.part, pr.account
  from {{posting_rule}} as pr
  where pr.active
  order by pr.part, pr.id
)`;

/**
 * A guard: a part with no account. If its condition holds, the line cannot be inserted and the
 * whole statement fails. The text is what an engineer reads in the database error.
 */
const guard = (message: string, from: string, amount = "1"): string => `select 0, ${quoted(message)}, cast(null as uuid), ${amount}\n${from}`;

/**
 * Turns the signed parts into the entry and its lines. `signed` is positive for a debit and
 * negative for a credit, so a negative amount (a refund day, a credit note, stock going down)
 * simply lands on the other side. Zero parts are left out, and no entry is made when there is
 * nothing to post.
 *
 * `from` is the row being posted (at most one row). When it is missing, the left join still
 * yields one row of nulls, so the insert is attempted and fails: an id that does not exist is an
 * error, not a quiet 0.
 */
const entryAndLines = (o: { from: string; memo: string; origin: string }) => `entry as (
  insert into {{journal_entry}} (id, location_id, business_date, memo, origin, origin_id, source, source_id, created_by, updated_by)
  select gen_random_uuid(), src.location_id, src.business_date, ${o.memo}, '${o.origin}', cast(src.id as text), 'app', '${o.origin}/' || cast(src.id as text), rms.current_actor(), rms.current_actor()
  from (select 1 as asked) as request
  left join ${o.from} as src on true
  where src.id is null or exists (select 1 from parts as p where p.signed <> 0)
  on conflict do nothing
  returning id, location_id
),
lines as (
  insert into {{journal_line}} (id, location_id, currency, entry, line_number, account, debit, credit, memo, source, created_by, updated_by)
  select gen_random_uuid(), e.location_id, src.currency, e.id, row_number() over (order by p.line_order, p.memo), p.account, greatest(p.signed, 0), greatest(-p.signed, 0), p.memo, 'app', rms.current_actor(), rms.current_actor()
  from entry as e
  cross join ${o.from} as src
  cross join parts as p
  where p.signed <> 0
  returning id
)
select (select count(*) from entry) + (select count(*) from lines) as affected`;

const postSalesDay: NamedActionInput = {
  key: "post_sales_day",
  pack: "finance",
  name: "Post a day of sales to the books",
  description:
    "Turns one day of sales and its breakdown rows into one balanced journal entry, using the posting rules: net sales by category, sales tax, tips, service charges and gift cards on one side, payments by type on the other. Refuses a day that does not add up, whose categories do not add up to its net sales, or that has both an all row and rows per channel. Posting the same day again changes nothing.",
  reads: ["sales_day", "sales_category_day", "sales_category", "payment_day", "payment_type", "gift_card_activity", "posting_rule"],
  writes: ["journal_entry", "journal_line"],
  params: [{ key: "sales_day_id", type: "uuid" }],
  idempotent: true,
  sql: sql`
    with sd as (
      select s.id, s.location_id, s.currency, s.business_date, s.channel, s.net_sales, s.sales_tax, s.tips, coalesce(s.service_charges, 0) as service_charges
      from {{sales_day}} as s
      where s.id = cast(:sales_day_id as uuid)
    ),
    ${SIMPLE_RULES},
    parts as (
      select 10 as line_order, sc.name as memo, r.account as account, -scd.net_sales as signed
      from sd
      join {{sales_category_day}} as scd on scd.sales_day = sd.id
      join {{sales_category}} as sc on sc.id = scd.sales_category
      left join lateral (
        select pr.account
        from {{posting_rule}} as pr
        where pr.active
          and pr.part = 'net_sales'
          and (pr.sales_category = sc.id or (pr.sales_category is null and (pr.sales_group = sc.sales_group or pr.sales_group is null)))
        order by (pr.sales_category is null), (pr.sales_group is null), pr.id
        limit 1
      ) as r on true
      union all
      ${guard(
        "The category rows do not add up to the net sales of the day",
        `from sd
cross join lateral (
  select cast(sum(x.net_sales) as bigint) as total, count(*) as row_count
  from {{sales_category_day}} as x
  where x.sales_day = sd.id
) as c
where c.row_count > 0`,
        "sd.net_sales - c.total",
      )}
      union all
      ${guard(
        "This day has both an all row and rows per channel",
        `from sd
where exists (
  select 1
  from {{sales_day}} as other
  where other.location_id = sd.location_id
    and other.business_date = sd.business_date
    and other.id <> sd.id
    and (other.channel = 'all') <> (sd.channel = 'all')
)`,
      )}
      union all
      select 11, 'Net sales', r.account, -sd.net_sales
      from sd
      left join lateral (
        select pr.account
        from {{posting_rule}} as pr
        where pr.active and pr.part = 'net_sales' and pr.sales_category is null and pr.sales_group is null
        order by pr.id
        limit 1
      ) as r on true
      where not exists (select 1 from {{sales_category_day}} as x where x.sales_day = sd.id)
      union all
      select 20, 'Sales tax collected', r.account, -sd.sales_tax
      from sd
      left join simple_rule as r on r.part = 'sales_tax'
      union all
      select 30, 'Tips owed to staff', r.account, -sd.tips
      from sd
      left join simple_rule as r on r.part = 'tips'
      union all
      select 40, 'Service charges', r.account, -sd.service_charges
      from sd
      left join simple_rule as r on r.part = 'service_charges'
      union all
      select 50, 'Gift cards sold', r.account, -g.sold_amount
      from sd
      join {{gift_card_activity}} as g on g.sales_day = sd.id
      left join simple_rule as r on r.part = 'gift_cards'
      union all
      select 51, 'Gift cards redeemed', r.account, g.redeemed_amount
      from sd
      join {{gift_card_activity}} as g on g.sales_day = sd.id
      left join simple_rule as r on r.part = 'gift_cards'
      union all
      select 60, pt.name, r.account, pd.amount
      from sd
      join {{payment_day}} as pd on pd.sales_day = sd.id
      join {{payment_type}} as pt on pt.id = pd.payment_type
      left join lateral (
        select pr.account
        from {{posting_rule}} as pr
        where pr.active
          and pr.part = 'payment'
          and (pr.payment_type = pt.id or (pr.payment_type is null and (pr.payment_kind = pt.kind or pr.payment_kind is null)))
        order by (pr.payment_type is null), (pr.payment_kind is null), pr.id
        limit 1
      ) as r on true
    ),
    ${entryAndLines({ from: "sd", memo: "'Daily sales'", origin: "sales_day" })}
  `,
};

const postVendorBill: NamedActionInput = {
  key: "post_vendor_bill",
  pack: "finance",
  name: "Post a vendor bill to the books",
  description:
    "Turns one vendor bill into one balanced journal entry: each bill line to its cost account, and the total to bills owed to vendors. Refuses a void bill and a bill whose lines do not add up to its total. Also used for a delivery app's statement of the commission and fees it kept. A result of 0 means the bill is already in the books. Posting the same bill again changes nothing.",
  reads: ["vendor_bill", "vendor_bill_line", "vendor", "posting_rule"],
  writes: ["journal_entry", "journal_line"],
  params: [{ key: "vendor_bill_id", type: "uuid" }],
  idempotent: true,
  sql: sql`
    with vb as (
      select b.id, b.location_id, b.currency, b.business_date, b.status, b.total_amount, coalesce(v.name, 'vendor') as vendor_name
      from {{vendor_bill}} as b
      left join {{vendor}} as v on v.id = b.vendor
      where b.id = cast(:vendor_bill_id as uuid)
    ),
    ${SIMPLE_RULES},
    parts as (
      select 10 + coalesce(l.line_number, 0) as line_order, l.description as memo, l.account as account, l.amount as signed
      from vb
      join {{vendor_bill_line}} as l on l.vendor_bill = vb.id
      union all
      ${guard("This bill is void, so it cannot be posted", "from vb\nwhere vb.status = 'void'")}
      union all
      select 1000000, 'Owed to ' || vb.vendor_name, r.account, -vb.total_amount
      from vb
      left join simple_rule as r on r.part = 'vendor_bill_payable'
    ),
    ${entryAndLines({ from: "vb", memo: "'Vendor bill from ' || coalesce(src.vendor_name, 'vendor')", origin: "vendor_bill" })}
  `,
};

const postLabourDay: NamedActionInput = {
  key: "post_labour_day",
  pack: "finance",
  name: "Post a day of staff cost to the books",
  description:
    "Turns one row of daily staff cost into one balanced journal entry: the cost to the wages account for its job group, and the same amount to wages owed. Posting the same row again changes nothing.",
  reads: ["labour_day", "posting_rule"],
  writes: ["journal_entry", "journal_line"],
  params: [{ key: "labour_day_id", type: "uuid" }],
  idempotent: true,
  sql: sql`
    with ld as (
      select d.id, d.location_id, d.currency, d.business_date, d.job_group, d.labour_cost
      from {{labour_day}} as d
      where d.id = cast(:labour_day_id as uuid)
    ),
    ${SIMPLE_RULES},
    parts as (
      select 10 as line_order, 'Staff cost, ' || replace(ld.job_group, '_', ' ') as memo, r.account as account, ld.labour_cost as signed
      from ld
      left join lateral (
        select pr.account
        from {{posting_rule}} as pr
        where pr.active
          and pr.part = 'labour_cost'
          and (pr.job_group = ld.job_group or pr.job_group is null)
        order by (pr.job_group is null), pr.id
        limit 1
      ) as r on true
      union all
      select 20, 'Wages owed', r.account, -ld.labour_cost
      from ld
      left join simple_rule as r on r.part = 'labour_payable'
    ),
    ${entryAndLines({ from: "ld", memo: "'Staff cost'", origin: "labour_day" })}
  `,
};

/**
 * Stock counts turn purchases into what was really used (docs/plan/02 section 1.7).
 *
 * Bills post every purchase straight to its cost account. A final stock count then posts the
 * CHANGE in stock value since the last count that is in the books, for each stock group:
 *   stock went up by X    debit Stock on hand X, credit that group's cost account X
 *   stock went down by X  debit that group's cost account X, credit Stock on hand X
 * so over the days between two counts the cost account shows
 *   opening stock + purchases - closing stock.
 *
 * The very first final count of a location has nothing before it. It sets the opening value:
 * debit Stock on hand, credit the opening stock (equity) account. It does not touch cost.
 *
 * What it compares with: the latest EARLIER final count of the same location that already has a
 * journal entry. That keeps the books right even if a count in between was never posted or
 * changed nothing (a count with no change makes no entry). Three things are refused:
 *   - a count that is not final,
 *   - a count dated before a count that is already in the books (it would be counted twice),
 *   - a count with nothing in the books before it while an earlier final count with stock
 *     exists (post the earlier one first, or its stock would be booked as a cost saving).
 */
const postStockCount: NamedActionInput = {
  key: "post_stock_count",
  pack: "finance",
  name: "Post a stock count to the books",
  description:
    "Posts one final stock count as one balanced journal entry: the change in stock value since the last posted count, for each stock group, between the stock account and that group's cost account. This turns purchases into what was really used. A location's first count sets its opening stock. Refuses a count that is not final or is out of order. Posting it again changes nothing.",
  reads: ["stock_count", "stock_count_line", "item", "journal_entry", "posting_rule"],
  writes: ["journal_entry", "journal_line"],
  params: [{ key: "stock_count_id", type: "uuid" }],
  idempotent: true,
  sql: sql`
    with sc as (
      select c.id, c.location_id, c.counted_on, c.status
      from {{stock_count}} as c
      where c.id = cast(:stock_count_id as uuid)
    ),
    in_books as (
      select o.id, o.counted_on
      from sc
      join {{stock_count}} as o on o.location_id = sc.location_id and o.status = 'final' and o.id <> sc.id
      join {{journal_entry}} as je on je.origin = 'stock_count' and je.origin_id = cast(o.id as text)
    ),
    base as (
      select ib.id
      from in_books as ib
      cross join sc
      where ib.counted_on < sc.counted_on
      order by ib.counted_on desc
      limit 1
    ),
    situation as (
      select not exists (
               select 1
               from {{stock_count}} as earlier
               where earlier.location_id = sc.location_id and earlier.status = 'final' and earlier.counted_on < sc.counted_on
             ) as is_first
      from sc
    ),
    by_group as (
      select i.cost_group,
             cast(sum(case when l.stock_count = sc.id then l.value else 0 end) as bigint) as value_now,
             cast(sum(case when l.stock_count = sc.id then 0 else l.value end) as bigint) as value_before,
             max(l.currency) as currency
      from sc
      join {{stock_count_line}} as l on l.stock_count = sc.id or l.stock_count = (select b.id from base as b)
      join {{item}} as i on i.id = l.item
      group by i.cost_group
    ),
    doc as (
      select sc.id, sc.location_id, sc.counted_on as business_date, (select max(g.currency) from by_group as g) as currency
      from sc
    ),
    ${SIMPLE_RULES},
    parts as (
      select 10 as line_order, 'Stock on hand, ' || g.cost_group as memo, r.account as account, g.value_now - g.value_before as signed
      from by_group as g
      cross join situation as s
      left join simple_rule as r on r.part = 'stock_on_hand'
      where not s.is_first
      union all
      select 20, 'Stock change, ' || g.cost_group, r.account, g.value_before - g.value_now
      from by_group as g
      cross join situation as s
      left join lateral (
        select pr.account
        from {{posting_rule}} as pr
        where pr.active
          and pr.part = 'stock_cost'
          and (pr.cost_group = g.cost_group or pr.cost_group is null)
        order by (pr.cost_group is null), pr.id
        limit 1
      ) as r on true
      where not s.is_first
      union all
      select 30, 'Opening stock on hand, ' || g.cost_group, r.account, g.value_now
      from by_group as g
      cross join situation as s
      left join simple_rule as r on r.part = 'stock_on_hand'
      where s.is_first
      union all
      select 31, 'Opening stock, ' || g.cost_group, r.account, -g.value_now
      from by_group as g
      cross join situation as s
      left join simple_rule as r on r.part = 'stock_opening'
      where s.is_first
      union all
      ${guard("This stock count is not final, so it cannot be posted", "from sc\nwhere sc.status <> 'final'")}
      union all
      ${guard(
        "A later stock count is already in the books",
        `from sc
where exists (select 1 from in_books as ib where ib.counted_on > sc.counted_on)`,
      )}
      union all
      ${guard(
        "An earlier stock count has to be posted first",
        `from sc
where not exists (select 1 from base)
  and exists (
    select 1
    from {{stock_count}} as earlier
    join {{stock_count_line}} as earlier_line on earlier_line.stock_count = earlier.id
    where earlier.location_id = sc.location_id and earlier.status = 'final' and earlier.counted_on < sc.counted_on and earlier_line.value <> 0
  )`,
      )}
    ),
    ${entryAndLines({ from: "doc", memo: "'Stock count'", origin: "stock_count" })}
  `,
};

export const namedActionInputs: NamedActionInput[] = [postSalesDay, postVendorBill, postLabourDay, postStockCount, seedChartOfAccounts, seedFiscalCalendar];


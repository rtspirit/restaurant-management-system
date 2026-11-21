import { sql } from "./helpers.js";
import type { NamedQueryInput } from "./helpers.js";
import { FOOD_AND_DRINK_GROUPS } from "./finance.js";
import { PAYOUT_MEMO_ONLY } from "./sales.js";

/**
 * The standard reports, as named queries on the model layer (docs/plan/02 section 4, last line).
 *
 * Template rules (packages/contracts/src/models.ts): tables only as {{model_ref}}, parameters
 * only as :key, one SELECT statement. On top of that these templates:
 *   - always give a {{model_ref}} an alias (`from {{sales_day}} as sd`),
 *   - use `cast(:key as type)` and never `::`, and never put a colon in a quoted string,
 *   - have no comments and no semicolon,
 *   - treat a missing optional parameter as null (`cast(:location_id as uuid) is null`),
 *   - cast money sums back to bigint, so money stays whole minor units.
 *
 * Money in one report is assumed to be in one currency (one restaurant, one currency today).
 *
 * Weeks always come from the fiscal calendar (domain rule 2): the calendar that is in use, and
 * if more than one is in use, the one with the lowest id, so numbers are never counted twice.
 *
 * Food and drink cost is what was USED (docs/plan/02 section 1.7): opening stock + purchases -
 * closing stock. The reports read it from the books, the one source of truth: bills post
 * purchases to the cost accounts and each final stock count posts the change in stock value
 * (`post_stock_count`). Until a stock count has been posted in a week, that week's figure is
 * only purchases, so every report that shows it also returns `stock_counted`. When it is false
 * the screen must say there is no stock count yet for that week.
 */

type Column = NamedQueryInput["columns"][number];
const col = (key: string, label: string, type: Column["type"], extra: Partial<Column> = {}): Column => ({ key, label, type, ...extra });
const moneyCol = (key: string, label: string): Column => col(key, label, "money", { sensitivity: "financial" });
/** Staff cost, and anything staff cost can be worked out from, is payroll and owner-only. */
const payrollCol = (key: string, label: string, type: Column["type"] = "money"): Column => col(key, label, type, { sensitivity: "payroll", readableBy: ["owner"] });

/**
 * A day is recorded either as one `all` row or as rows per channel. If both exist by mistake the
 * day is counted once, by its `all` row (and `post_sales_day` refuses to post it).
 */
const countedOnce = (alias: string): string => `(${alias}.channel = 'all' or not exists (
  select 1
  from {{sales_day}} as whole_day
  where whole_day.location_id = ${alias}.location_id
    and whole_day.business_date = ${alias}.business_date
    and whole_day.channel = 'all'
))`;

/** The fiscal weeks that touch the asked date range. Needs `cal`. */
const WEEKS_IN_RANGE = `weeks as (
  select fw.fiscal_year, fw.week_number, fw.start_date, fw.end_date
  from {{fiscal_week}} as fw
  where fw.calendar = (select cal.id from cal)
    and (cast(:from_date as date) is null or fw.end_date >= cast(:from_date as date))
    and (cast(:to_date as date) is null or fw.start_date <= cast(:to_date as date))
)`;

/** The weeks and locations in which a stock count has been posted to the books. Needs `weeks`. */
const COUNTED_WEEKS = `counted as (
  select wk.start_date, je.location_id
  from weeks as wk
  join {{journal_entry}} as je on je.business_date between wk.start_date and wk.end_date
  where je.origin = 'stock_count'
  group by wk.start_date, je.location_id
)`;

const FOOD_AND_DRINK = FOOD_AND_DRINK_GROUPS.map((g) => `'${g}'`).join(", ");

const CALENDAR_IN_USE = `cal as (
  select fc.id
  from {{fiscal_calendar}} as fc
  where fc.active
  order by fc.id
  limit 1
)`;

const dailySalesSummary: NamedQueryInput = {
  key: "daily_sales_summary",
  pack: "sales",
  name: "Daily sales summary",
  description:
    "One business date, one row per location: gross sales, discounts, comps, voids, net sales, sales tax, tips, service charges, gift cards, what was collected, and whether the day adds up (difference should be zero).",
  reads: ["sales_day", "payment_day", "gift_card_activity", "parent.locations"],
  params: [
    { key: "business_date", type: "business_date" },
    { key: "location_id", type: "uuid", required: false },
  ],
  sql: sql`
    with days as (
      select sd.location_id,
             sd.business_date,
             sum(sd.gross_sales) as gross_sales,
             sum(sd.discounts) as discounts,
             sum(sd.comps) as comps,
             sum(coalesce(sd.voids, 0)) as voids,
             sum(sd.net_sales) as net_sales,
             sum(sd.sales_tax) as sales_tax,
             sum(sd.tips) as tips,
             sum(coalesce(sd.service_charges, 0)) as service_charges,
             sum(coalesce(sd.guests, 0)) as guests,
             sum(coalesce(sd.checks, 0)) as checks
      from {{sales_day}} as sd
      where sd.business_date = cast(:business_date as date)
        and (cast(:location_id as uuid) is null or sd.location_id = cast(:location_id as uuid))
        and ${countedOnce("sd")}
      group by sd.location_id, sd.business_date
    ),
    pay as (
      select sd.location_id, sum(pd.amount) as payments
      from {{payment_day}} as pd
      join {{sales_day}} as sd on sd.id = pd.sales_day
      where sd.business_date = cast(:business_date as date)
        and ${countedOnce("sd")}
      group by sd.location_id
    ),
    gift as (
      select sd.location_id, sum(g.sold_amount) as sold, sum(g.redeemed_amount) as redeemed
      from {{gift_card_activity}} as g
      join {{sales_day}} as sd on sd.id = g.sales_day
      where sd.business_date = cast(:business_date as date)
        and ${countedOnce("sd")}
      group by sd.location_id
    )
    select cast(d.location_id as text) as location_id,
           loc.name as location_name,
           d.business_date as business_date,
           cast(d.gross_sales as bigint) as gross_sales,
           cast(d.discounts as bigint) as discounts,
           cast(d.comps as bigint) as comps,
           cast(d.voids as bigint) as voids,
           cast(d.net_sales as bigint) as net_sales,
           cast(d.sales_tax as bigint) as sales_tax,
           cast(d.tips as bigint) as tips,
           cast(d.service_charges as bigint) as service_charges,
           cast(coalesce(gc.sold, 0) as bigint) as gift_cards_sold,
           cast(coalesce(gc.redeemed, 0) as bigint) as gift_cards_redeemed,
           cast(coalesce(p.payments, 0) as bigint) as payments,
           cast(d.net_sales + d.sales_tax + d.tips + d.service_charges + coalesce(gc.sold, 0) as bigint) as to_account_for,
           cast(coalesce(p.payments, 0) + coalesce(gc.redeemed, 0) as bigint) as collected,
           cast(coalesce(p.payments, 0) + coalesce(gc.redeemed, 0)
                - (d.net_sales + d.sales_tax + d.tips + d.service_charges + coalesce(gc.sold, 0)) as bigint) as difference,
           cast(d.guests as bigint) as guests,
           cast(d.checks as bigint) as checks,
           cast(round(d.net_sales / nullif(d.checks, 0)) as bigint) as average_check
    from days as d
    left join pay as p on p.location_id = d.location_id
    left join gift as gc on gc.location_id = d.location_id
    left join {{parent.locations}} as loc on loc.id = d.location_id
    order by loc.name, d.location_id
  `,
  columns: [
    col("location_id", "Location id", "text"),
    col("location_name", "Location", "text"),
    col("business_date", "Business date", "business_date"),
    moneyCol("gross_sales", "Gross sales"),
    moneyCol("discounts", "Discounts"),
    moneyCol("comps", "Comps"),
    moneyCol("voids", "Voids (not sales)"),
    moneyCol("net_sales", "Net sales"),
    moneyCol("sales_tax", "Sales tax collected"),
    moneyCol("tips", "Tips"),
    moneyCol("service_charges", "Service charges"),
    moneyCol("gift_cards_sold", "Gift cards sold"),
    moneyCol("gift_cards_redeemed", "Gift cards redeemed"),
    moneyCol("payments", "Payments"),
    moneyCol("to_account_for", "To account for"),
    moneyCol("collected", "Collected"),
    moneyCol("difference", "Difference"),
    col("guests", "Guests", "integer"),
    col("checks", "Checks", "integer"),
    moneyCol("average_check", "Average check"),
  ],
};

const salesByDay: NamedQueryInput = {
  key: "sales_by_day",
  pack: "sales",
  name: "Sales by day",
  description: "One fiscal week, day by day: net sales, gross sales, discounts, comps, sales tax, tips, guests and checks for each business date. For one location or all locations together. Days with no sales recorded are left out.",
  reads: ["sales_day", "fiscal_calendar", "fiscal_week"],
  params: [
    { key: "week_of", type: "date" },
    { key: "location_id", type: "uuid", required: false },
  ],
  sql: sql`
    with ${CALENDAR_IN_USE},
    wk as (
      select fw.start_date, fw.end_date
      from {{fiscal_week}} as fw
      where fw.calendar = (select cal.id from cal)
        and cast(:week_of as date) between fw.start_date and fw.end_date
    )
    select sd.business_date as business_date,
           cast(sum(sd.net_sales) as bigint) as net_sales,
           cast(sum(sd.gross_sales) as bigint) as gross_sales,
           cast(sum(sd.discounts) as bigint) as discounts,
           cast(sum(sd.comps) as bigint) as comps,
           cast(sum(sd.sales_tax) as bigint) as sales_tax,
           cast(sum(sd.tips) as bigint) as tips,
           cast(sum(coalesce(sd.guests, 0)) as bigint) as guests,
           cast(sum(coalesce(sd.checks, 0)) as bigint) as checks
    from {{sales_day}} as sd
    join wk on sd.business_date between wk.start_date and wk.end_date
    where (cast(:location_id as uuid) is null or sd.location_id = cast(:location_id as uuid))
      and ${countedOnce("sd")}
    group by sd.business_date
    order by sd.business_date
  `,
  columns: [
    col("business_date", "Business date", "business_date"),
    moneyCol("net_sales", "Net sales"),
    moneyCol("gross_sales", "Gross sales"),
    moneyCol("discounts", "Discounts"),
    moneyCol("comps", "Comps"),
    moneyCol("sales_tax", "Sales tax collected"),
    moneyCol("tips", "Tips"),
    col("guests", "Guests", "integer"),
    col("checks", "Checks", "integer"),
  ],
};

const salesByLocation: NamedQueryInput = {
  key: "sales_by_location",
  pack: "sales",
  name: "Sales by location",
  description: "Net sales, gross sales, discounts, comps, guests and checks for each location between two business dates (both included), with each location's share of the total.",
  reads: ["sales_day", "parent.locations"],
  params: [
    { key: "from_date", type: "business_date" },
    { key: "to_date", type: "business_date" },
  ],
  sql: sql`
    select cast(sd.location_id as text) as location_id,
           loc.name as location_name,
           cast(sum(sd.net_sales) as bigint) as net_sales,
           cast(sum(sd.gross_sales) as bigint) as gross_sales,
           cast(sum(sd.discounts) as bigint) as discounts,
           cast(sum(sd.comps) as bigint) as comps,
           cast(sum(coalesce(sd.guests, 0)) as bigint) as guests,
           cast(sum(coalesce(sd.checks, 0)) as bigint) as checks,
           round(100.0 * sum(sd.net_sales) / nullif(sum(sum(sd.net_sales)) over (), 0), 1) as share_pct
    from {{sales_day}} as sd
    left join {{parent.locations}} as loc on loc.id = sd.location_id
    where sd.business_date between cast(:from_date as date) and cast(:to_date as date)
      and ${countedOnce("sd")}
    group by sd.location_id, loc.name
    order by loc.name, sd.location_id
  `,
  columns: [
    col("location_id", "Location id", "text"),
    col("location_name", "Location", "text"),
    moneyCol("net_sales", "Net sales"),
    moneyCol("gross_sales", "Gross sales"),
    moneyCol("discounts", "Discounts"),
    moneyCol("comps", "Comps"),
    col("guests", "Guests", "integer"),
    col("checks", "Checks", "integer"),
    col("share_pct", "Share of net sales (%)", "decimal", { sensitivity: "financial" }),
  ],
};

const primeCostByWeek: NamedQueryInput = {
  key: "prime_cost_by_week",
  pack: "finance",
  name: "Prime cost by week",
  description:
    "Prime cost for each fiscal week, from the books: net sales, food and drink cost (what was used: opening stock plus purchases minus closing stock), staff cost, and prime cost as a share of net sales. One row per location and one for all locations. When no stock count has been posted in a week, stock counted is false and the food and drink cost is only purchases.",
  reads: ["journal_line", "journal_entry", "account", "fiscal_calendar", "fiscal_week", "parent.locations"],
  params: [
    { key: "from_date", type: "date", required: false },
    { key: "to_date", type: "date", required: false },
    { key: "location_id", type: "uuid", required: false },
  ],
  sql: sql`
    with ${CALENDAR_IN_USE},
    ${WEEKS_IN_RANGE},
    ${COUNTED_WEEKS},
    by_location as (
      select wk.fiscal_year,
             wk.week_number,
             wk.start_date,
             wk.end_date,
             je.location_id,
             sum(case when a.report_section = 'sales' then jl.credit - jl.debit else 0 end) as net_sales,
             sum(case when a.report_section = 'cost_of_goods' then jl.debit - jl.credit else 0 end) as cost_of_goods,
             sum(case when a.report_section = 'labour' then jl.debit - jl.credit else 0 end) as labour
      from weeks as wk
      join {{journal_entry}} as je on je.business_date between wk.start_date and wk.end_date
      join {{journal_line}} as jl on jl.entry = je.id
      join {{account}} as a on a.id = jl.account
      where a.report_section in ('sales', 'cost_of_goods', 'labour')
        and (cast(:location_id as uuid) is null or je.location_id = cast(:location_id as uuid))
      group by wk.fiscal_year, wk.week_number, wk.start_date, wk.end_date, je.location_id
    ),
    scoped as (
      select 'location' as scope, b.fiscal_year, b.week_number, b.start_date, b.end_date, b.location_id,
             b.net_sales, b.cost_of_goods, b.labour, (k.location_id is not null) as stock_counted
      from by_location as b
      left join counted as k on k.start_date = b.start_date and k.location_id = b.location_id
      union all
      select 'all_locations' as scope, b.fiscal_year, b.week_number, b.start_date, b.end_date, cast(null as uuid) as location_id,
             sum(b.net_sales) as net_sales, sum(b.cost_of_goods) as cost_of_goods, sum(b.labour) as labour, bool_and(k.location_id is not null) as stock_counted
      from by_location as b
      left join counted as k on k.start_date = b.start_date and k.location_id = b.location_id
      where cast(:location_id as uuid) is null
      group by b.fiscal_year, b.week_number, b.start_date, b.end_date
    )
    select s.start_date as week_start,
           s.end_date as week_end,
           s.fiscal_year as fiscal_year,
           s.week_number as week_number,
           s.scope as scope,
           cast(s.location_id as text) as location_id,
           loc.name as location_name,
           cast(s.net_sales as bigint) as net_sales,
           cast(s.cost_of_goods as bigint) as cost_of_goods,
           s.stock_counted as stock_counted,
           cast(s.labour as bigint) as labour,
           cast(s.cost_of_goods + s.labour as bigint) as prime_cost,
           round(100.0 * s.cost_of_goods / nullif(s.net_sales, 0), 1) as cost_of_goods_pct,
           round(100.0 * s.labour / nullif(s.net_sales, 0), 1) as labour_pct,
           round(100.0 * (s.cost_of_goods + s.labour) / nullif(s.net_sales, 0), 1) as prime_cost_pct
    from scoped as s
    left join {{parent.locations}} as loc on loc.id = s.location_id
    order by s.start_date, s.scope, loc.name, s.location_id
  `,
  columns: [
    col("week_start", "Week starting", "date"),
    col("week_end", "Week ending", "date"),
    col("fiscal_year", "Fiscal year", "integer"),
    col("week_number", "Week number", "integer"),
    col("scope", "Row covers (location or all_locations)", "text"),
    col("location_id", "Location id", "text"),
    col("location_name", "Location", "text"),
    moneyCol("net_sales", "Net sales"),
    moneyCol("cost_of_goods", "Food and drink cost"),
    col("stock_counted", "Stock counted this week", "boolean"),
    payrollCol("labour", "Staff cost"),
    payrollCol("prime_cost", "Prime cost"),
    col("cost_of_goods_pct", "Food and drink cost (% of net sales)", "decimal", { sensitivity: "financial" }),
    payrollCol("labour_pct", "Staff cost (% of net sales)", "decimal"),
    payrollCol("prime_cost_pct", "Prime cost (% of net sales)", "decimal"),
  ],
};

const costOfGoodsByWeek: NamedQueryInput = {
  key: "cost_of_goods_by_week",
  pack: "finance",
  name: "Food and drink cost by week",
  description:
    "Shows how each fiscal week's food and drink cost is made up: opening stock, plus purchases, minus closing stock, equals what was used. One row per location and one for all locations. Closing stock is empty and stock counted is false when no stock count has been posted in the week: the cost shown is then only purchases.",
  reads: ["journal_line", "journal_entry", "account", "fiscal_calendar", "fiscal_week", "stock_count", "stock_count_line", "item", "parent.locations"],
  params: [
    { key: "from_date", type: "date", required: false },
    { key: "to_date", type: "date", required: false },
    { key: "location_id", type: "uuid", required: false },
  ],
  sql: sql`
    with ${CALENDAR_IN_USE},
    ${WEEKS_IN_RANGE},
    ${COUNTED_WEEKS},
    count_value as (
      select c.id,
             c.location_id,
             c.counted_on,
             coalesce(sum(l.value) filter (where i.cost_group in (${FOOD_AND_DRINK})), 0) as stock_value
      from {{stock_count}} as c
      left join {{stock_count_line}} as l on l.stock_count = c.id
      left join {{item}} as i on i.id = l.item
      where c.status = 'final'
      group by c.id, c.location_id, c.counted_on
    ),
    ledger as (
      select wk.fiscal_year,
             wk.week_number,
             wk.start_date,
             wk.end_date,
             je.location_id,
             sum(case when je.origin = 'stock_count' then 0 else jl.debit - jl.credit end) as purchases,
             sum(jl.debit - jl.credit) as used
      from weeks as wk
      join {{journal_entry}} as je on je.business_date between wk.start_date and wk.end_date
      join {{journal_line}} as jl on jl.entry = je.id
      join {{account}} as a on a.id = jl.account
      where a.report_section = 'cost_of_goods'
        and (cast(:location_id as uuid) is null or je.location_id = cast(:location_id as uuid))
      group by wk.fiscal_year, wk.week_number, wk.start_date, wk.end_date, je.location_id
    ),
    by_location as (
      select g.fiscal_year, g.week_number, g.start_date, g.end_date, g.location_id, g.purchases, g.used,
             opening.stock_value as opening_value,
             closing.stock_value as closing_value,
             (k.location_id is not null) as stock_counted
      from ledger as g
      left join lateral (
        select v.stock_value
        from count_value as v
        where v.location_id = g.location_id and v.counted_on < g.start_date
        order by v.counted_on desc
        limit 1
      ) as opening on true
      left join lateral (
        select v.stock_value
        from count_value as v
        where v.location_id = g.location_id and v.counted_on between g.start_date and g.end_date
        order by v.counted_on desc
        limit 1
      ) as closing on true
      left join counted as k on k.start_date = g.start_date and k.location_id = g.location_id
    ),
    scoped as (
      select 'location' as scope, b.fiscal_year, b.week_number, b.start_date, b.end_date, b.location_id,
             b.opening_value, b.purchases, b.closing_value, b.used, b.stock_counted
      from by_location as b
      union all
      select 'all_locations' as scope, b.fiscal_year, b.week_number, b.start_date, b.end_date, cast(null as uuid) as location_id,
             case when bool_and(b.opening_value is not null) then sum(b.opening_value) end as opening_value,
             sum(b.purchases) as purchases,
             case when bool_and(b.closing_value is not null) then sum(b.closing_value) end as closing_value,
             sum(b.used) as used,
             bool_and(b.stock_counted) as stock_counted
      from by_location as b
      where cast(:location_id as uuid) is null
      group by b.fiscal_year, b.week_number, b.start_date, b.end_date
    )
    select s.start_date as week_start,
           s.end_date as week_end,
           s.fiscal_year as fiscal_year,
           s.week_number as week_number,
           s.scope as scope,
           cast(s.location_id as text) as location_id,
           loc.name as location_name,
           cast(s.opening_value as bigint) as opening_value,
           cast(s.purchases as bigint) as purchases,
           cast(s.closing_value as bigint) as closing_value,
           cast(s.used as bigint) as usage,
           s.stock_counted as stock_counted
    from scoped as s
    left join {{parent.locations}} as loc on loc.id = s.location_id
    order by s.start_date, s.scope, loc.name, s.location_id
  `,
  columns: [
    col("week_start", "Week starting", "date"),
    col("week_end", "Week ending", "date"),
    col("fiscal_year", "Fiscal year", "integer"),
    col("week_number", "Week number", "integer"),
    col("scope", "Row covers (location or all_locations)", "text"),
    col("location_id", "Location id", "text"),
    col("location_name", "Location", "text"),
    moneyCol("opening_value", "Opening stock"),
    moneyCol("purchases", "Purchases"),
    moneyCol("closing_value", "Closing stock"),
    moneyCol("usage", "Food and drink cost (used)"),
    col("stock_counted", "Stock counted this week", "boolean"),
  ],
};

const stockOnHand: NamedQueryInput = {
  key: "stock_on_hand",
  pack: "inventory",
  name: "Stock on hand",
  description: "What the stock was worth at each location's latest final stock count, with the date of that count: the value of food, beverage, alcohol and supplies, food and drink together, and the total.",
  reads: ["stock_count", "stock_count_line", "item", "parent.locations"],
  params: [{ key: "location_id", type: "uuid", required: false }],
  sql: sql`
    with latest as (
      select distinct on (c.location_id) c.id, c.location_id, c.counted_on
      from {{stock_count}} as c
      where c.status = 'final'
        and (cast(:location_id as uuid) is null or c.location_id = cast(:location_id as uuid))
      order by c.location_id, c.counted_on desc
    )
    select cast(n.location_id as text) as location_id,
           loc.name as location_name,
           n.counted_on as counted_on,
           cast(coalesce(sum(l.value) filter (where i.cost_group = 'food'), 0) as bigint) as food_value,
           cast(coalesce(sum(l.value) filter (where i.cost_group = 'beverage'), 0) as bigint) as beverage_value,
           cast(coalesce(sum(l.value) filter (where i.cost_group = 'alcohol'), 0) as bigint) as alcohol_value,
           cast(coalesce(sum(l.value) filter (where i.cost_group = 'supplies'), 0) as bigint) as supplies_value,
           cast(coalesce(sum(l.value) filter (where i.cost_group in (${FOOD_AND_DRINK})), 0) as bigint) as food_and_drink_value,
           cast(coalesce(sum(l.value), 0) as bigint) as total_value
    from latest as n
    left join {{stock_count_line}} as l on l.stock_count = n.id
    left join {{item}} as i on i.id = l.item
    left join {{parent.locations}} as loc on loc.id = n.location_id
    group by n.location_id, loc.name, n.counted_on
    order by loc.name, n.location_id
  `,
  columns: [
    col("location_id", "Location id", "text"),
    col("location_name", "Location", "text"),
    col("counted_on", "Counted on", "business_date"),
    moneyCol("food_value", "Food"),
    moneyCol("beverage_value", "Beverage"),
    moneyCol("alcohol_value", "Alcohol"),
    moneyCol("supplies_value", "Supplies"),
    moneyCol("food_and_drink_value", "Food and drink"),
    moneyCol("total_value", "All stock"),
  ],
};

const weeklyPnl: NamedQueryInput = {
  key: "weekly_pnl",
  pack: "finance",
  name: "Weekly profit and loss",
  description:
    "The profit and loss report for one fiscal week, from the books: each account with its amount and share of net sales, section totals, and lines for gross profit, prime cost and net profit. Food and drink cost is what was used (opening stock plus purchases minus closing stock) once a stock count is posted in the week. Until then stock counted is false. No rows if the week is not in the calendar.",
  reads: ["journal_line", "journal_entry", "account", "fiscal_calendar", "fiscal_week"],
  params: [
    { key: "week_of", type: "date" },
    { key: "location_id", type: "uuid", required: false },
  ],
  sql: sql`
    with ${CALENDAR_IN_USE},
    wk as (
      select fw.start_date, fw.end_date
      from {{fiscal_week}} as fw
      where fw.calendar = (select cal.id from cal)
        and cast(:week_of as date) between fw.start_date and fw.end_date
    ),
    activity as (
      select a.report_section as section,
             a.code as account_code,
             a.name as account_name,
             sum(case when a.type = 'revenue' then jl.credit - jl.debit else jl.debit - jl.credit end) as amount
      from {{journal_line}} as jl
      join {{journal_entry}} as je on je.id = jl.entry
      join {{account}} as a on a.id = jl.account
      join wk on je.business_date between wk.start_date and wk.end_date
      where a.type in ('revenue', 'expense')
        and (cast(:location_id as uuid) is null or je.location_id = cast(:location_id as uuid))
      group by a.report_section, a.code, a.name
    ),
    totals as (
      select coalesce(sum(x.amount) filter (where x.section = 'sales'), 0) as net_sales,
             coalesce(sum(x.amount) filter (where x.section = 'cost_of_goods'), 0) as cost_of_goods,
             coalesce(sum(x.amount) filter (where x.section = 'labour'), 0) as labour,
             coalesce(sum(x.amount) filter (where x.section in ('sales', 'other_income')), 0) as income,
             coalesce(sum(x.amount) filter (where x.section not in ('sales', 'other_income')), 0) as expenses
      from activity as x
    ),
    counted as (
      select coalesce(bool_and(per_location.has_count), false) as stock_counted
      from (
        select je.location_id, bool_or(je.origin = 'stock_count') as has_count
        from {{journal_entry}} as je
        join wk on je.business_date between wk.start_date and wk.end_date
        where (cast(:location_id as uuid) is null or je.location_id = cast(:location_id as uuid))
        group by je.location_id
      ) as per_location
    ),
    report as (
      select 'account' as line_kind, x.section as section, x.account_code as account_code, x.account_name as account_name, x.amount as amount
      from activity as x
      union all
      select 'section_total', x.section, cast(null as text), cast(null as text), sum(x.amount)
      from activity as x
      group by x.section
      union all
      select 'summary', 'gross_profit', cast(null as text), cast(null as text), t.net_sales - t.cost_of_goods
      from totals as t
      union all
      select 'summary', 'prime_cost', cast(null as text), cast(null as text), t.cost_of_goods + t.labour
      from totals as t
      union all
      select 'summary', 'net_profit', cast(null as text), cast(null as text), t.income - t.expenses
      from totals as t
    )
    select case r.section
             when 'sales' then 10
             when 'cost_of_goods' then 20
             when 'gross_profit' then 30
             when 'labour' then 40
             when 'prime_cost' then 50
             when 'controllable' then 60
             when 'occupancy' then 70
             when 'other_income' then 80
             when 'other_expense' then 90
             else 100
           end + case r.line_kind when 'account' then 0 else 1 end as sort_order,
           r.line_kind as line_kind,
           r.section as section,
           r.account_code as account_code,
           r.account_name as account_name,
           cast(r.amount as bigint) as amount,
           round(100.0 * r.amount / nullif(t.net_sales, 0), 1) as pct_of_net_sales,
           k.stock_counted as stock_counted
    from report as r
    cross join totals as t
    cross join counted as k
    where exists (select 1 from wk as asked_week)
    order by 1, r.account_code
  `,
  columns: [
    col("sort_order", "Order on the report", "integer"),
    col("line_kind", "Line kind (account, section_total or summary)", "text"),
    col("section", "Section", "text"),
    col("account_code", "Account number", "text"),
    col("account_name", "Account", "text"),
    col("amount", "Amount", "money", { sensitivity: "financial", readableBy: ["owner"] }),
    col("pct_of_net_sales", "Share of net sales (%)", "decimal", { sensitivity: "financial", readableBy: ["owner"] }),
    col("stock_counted", "Stock counted this week", "boolean"),
  ],
};

const deliveryPayoutReconciliation: NamedQueryInput = {
  key: "delivery_payout_reconciliation",
  pack: "sales",
  name: "Delivery payout reconciliation",
  description:
    "Checks each delivery platform payout against the till: what the till says the platform collected, what the statement says, the commission, fees, refunds and tips, the tax the platform pays over itself (shown, never owed by the restaurant), and whether the amount paid matches the statement lines.",
  reads: ["delivery_payout", "delivery_payout_line", "payment_type", "payment_day", "sales_day", "parent.locations"],
  params: [
    { key: "from_date", type: "date", required: false },
    { key: "to_date", type: "date", required: false },
    { key: "location_id", type: "uuid", required: false },
  ],
  sql: sql`
    with statement_lines as (
      select l.payout,
             sum(case when l.kind in ('sales', 'sales_tax', 'tip') then l.amount else 0 end) as statement_collected,
             sum(case when l.kind = 'sales' then l.amount else 0 end) as statement_sales,
             sum(case when l.kind = 'tip' then l.amount else 0 end) as tips,
             sum(case when l.kind = 'sales_tax' then l.amount else 0 end) as tax_passed_to_restaurant,
             sum(case when l.kind = 'commission' then l.amount else 0 end) as commission,
             sum(case when l.kind in ('marketing_fee', 'service_fee') then l.amount else 0 end) as fees,
             sum(case when l.kind in ('refund', 'error_charge') then l.amount else 0 end) as refunds_and_errors,
             sum(case when l.kind = 'adjustment' then l.amount else 0 end) as adjustments,
             sum(case when l.kind = '${PAYOUT_MEMO_ONLY}' then l.amount else 0 end) as tax_remitted_by_platform,
             sum(case when l.kind <> '${PAYOUT_MEMO_ONLY}' then l.amount else 0 end) as expected_net
      from {{delivery_payout_line}} as l
      group by l.payout
    ),
    till as (
      select dp.id as payout, sum(pd.amount) as till_collected
      from {{delivery_payout}} as dp
      join {{sales_day}} as sd on sd.location_id = dp.location_id and sd.business_date between dp.period_start and dp.period_end
      join {{payment_day}} as pd on pd.sales_day = sd.id and pd.payment_type = dp.platform
      where ${countedOnce("sd")}
      group by dp.id
    )
    select cast(dp.id as text) as payout_id,
           cast(dp.location_id as text) as location_id,
           loc.name as location_name,
           pt.name as platform,
           dp.period_start as period_start,
           dp.period_end as period_end,
           dp.business_date as paid_on,
           dp.status as status,
           cast(coalesce(t.till_collected, 0) as bigint) as till_collected,
           cast(coalesce(s.statement_collected, 0) as bigint) as statement_collected,
           cast(coalesce(s.statement_collected, 0) - coalesce(t.till_collected, 0) as bigint) as collected_difference,
           cast(coalesce(s.statement_sales, 0) as bigint) as statement_sales,
           cast(coalesce(s.tips, 0) as bigint) as tips,
           cast(coalesce(s.tax_passed_to_restaurant, 0) as bigint) as tax_passed_to_restaurant,
           cast(coalesce(s.commission, 0) as bigint) as commission,
           cast(coalesce(s.fees, 0) as bigint) as fees,
           cast(coalesce(s.refunds_and_errors, 0) as bigint) as refunds_and_errors,
           cast(coalesce(s.adjustments, 0) as bigint) as adjustments,
           cast(coalesce(s.tax_remitted_by_platform, 0) as bigint) as tax_remitted_by_platform,
           cast(coalesce(s.expected_net, 0) as bigint) as expected_net,
           dp.net_amount as net_paid,
           cast(dp.net_amount - coalesce(s.expected_net, 0) as bigint) as net_difference
    from {{delivery_payout}} as dp
    join {{payment_type}} as pt on pt.id = dp.platform
    left join statement_lines as s on s.payout = dp.id
    left join till as t on t.payout = dp.id
    left join {{parent.locations}} as loc on loc.id = dp.location_id
    where (cast(:from_date as date) is null or dp.period_end >= cast(:from_date as date))
      and (cast(:to_date as date) is null or dp.period_start <= cast(:to_date as date))
      and (cast(:location_id as uuid) is null or dp.location_id = cast(:location_id as uuid))
    order by dp.period_start, pt.name, dp.id
  `,
  columns: [
    col("payout_id", "Payout id", "text"),
    col("location_id", "Location id", "text"),
    col("location_name", "Location", "text"),
    col("platform", "Delivery platform", "text"),
    col("period_start", "First day covered", "date"),
    col("period_end", "Last day covered", "date"),
    col("paid_on", "Paid on", "business_date"),
    col("status", "Status", "text"),
    moneyCol("till_collected", "Collected, by the till"),
    moneyCol("statement_collected", "Collected, by the statement"),
    moneyCol("collected_difference", "Statement minus till"),
    moneyCol("statement_sales", "Sales on the statement"),
    moneyCol("tips", "Tips"),
    moneyCol("tax_passed_to_restaurant", "Tax passed to the restaurant"),
    moneyCol("commission", "Commission"),
    moneyCol("fees", "Marketing and service fees"),
    moneyCol("refunds_and_errors", "Refunds and error charges"),
    moneyCol("adjustments", "Adjustments"),
    moneyCol("tax_remitted_by_platform", "Tax the platform pays over (not owed by us)"),
    moneyCol("expected_net", "Payout the lines add up to"),
    moneyCol("net_paid", "Amount paid out"),
    moneyCol("net_difference", "Paid minus expected"),
  ],
};

export const namedQueryInputs: NamedQueryInput[] = [dailySalesSummary, weeklyPnl, primeCostByWeek, costOfGoodsByWeek, stockOnHand, salesByDay, salesByLocation, deliveryPayoutReconciliation];

# Restaurant Domain Research and the Standard Model Library (v1)

Companion to [00-implementation-plan.md](./00-implementation-plan.md) and [01-data-model.md](./01-data-model.md). Status: **PROPOSED**.

This file answers one question: what data shapes do restaurants actually need, so that mini-apps can share them instead of each inventing its own.

---

## 0. Read first

1. **This is a starting library, not a finished one.** It covers what the research shows almost every restaurant needs. It grows from real use: when many restaurants create the same custom model, we add it here.
2. **We prepare numbers. We do not file anything.** Payroll tax, sales tax returns and tip reporting forms stay with the restaurant's payroll provider and accountant. Mini-apps produce the inputs and exports for them.
3. **Labour and tax rules differ by state and city.** Models store the facts (hours, tips, rates). Rules that depend on location are settings, never hard-coded.

---

## 1. How restaurants account

### 1.1 Chart of accounts

Restaurants use the usual five groups (assets, liabilities, equity, revenue, expenses) with far more detail in three places. The industry reference is the Uniform System of Accounts for Restaurants.

| Area | Restaurant-specific detail |
|---|---|
| Sales | Split by food, beverage (often liquor, beer, wine, non-alcoholic), merchandise, catering, delivery |
| Cost of goods sold | Mirrors the sales split, and food is often broken down further (meat, seafood, produce, dairy, dry goods) |
| Labour | Front of house, back of house, management, plus payroll taxes and benefits |
| Controllable costs | Supplies, repairs, marketing, utilities, card processing, delivery commissions |
| Occupancy and other | Rent, property tax, insurance, depreciation, interest |

**Prime cost** = cost of goods sold + total labour. It is the number operators watch most, as a share of sales. The library must be able to produce it per location per week without custom work.

### 1.2 Periods

Calendar months are poor for restaurants because a month with five Saturdays looks better than one with four. Many use a **4-4-5 calendar** or **13 four-week periods**, built from whole weeks. Weekly P&L is common.

What this means for the models: a fiscal calendar is data, not an assumption. Every dated financial row carries a business date. Week and period come from the restaurant's calendar table.

### 1.3 The business day

A restaurant day does not end at midnight. Point-of-sale systems close the day at a set hour, commonly 4am. All sales, labour and cash records attach to a **business date**, worked out from the location's timezone and cutoff.

### 1.4 What one day of sales turns into

The point of sale reports a day roughly like this. Each line lands in a different kind of account, which is why a generic "revenue" field is not enough.

| Line | What it is | Where it goes |
|---|---|---|
| Gross sales by category | Before anything is removed | Starting point only |
| Discounts | Price reductions, tracked with a reason | Reduces sales, or a marketing cost |
| Comps | Items given away, tracked with a reason | Reduces sales, or a cost by reason |
| Voids | Mistakes removed | Never counted as sales |
| **Net sales by category** | Gross minus discounts and comps | **Revenue** |
| Sales tax collected | Held for the state | **Liability**, not revenue |
| Tips on cards | Owed to staff | **Liability**, not revenue |
| Service charges | Auto-gratuity or fees | Revenue or liability, depending on who gets it. A setting |
| Gift cards sold | Money taken for a future meal | **Liability** until redeemed |
| Gift cards redeemed | A way of paying | Reduces that liability |
| Payments by type | Cash, each card type, gift card, house account, delivery platform | Cash, or money owed to the restaurant |
| Paid in, paid out | Cash added to or taken from the drawer | Cash, with an expense or reason |
| Cash counted vs expected | Difference is "over/short" | A small expense or income line |
| Deposit | What went to the bank | Moves cash to the bank account |

The daily entry must balance: what was sold plus what is owed to others equals what was collected.

### 1.5 Delivery platforms

Sales through delivery apps are the hardest part to reconcile.

- The platform pays a **net payout** days later: sales, minus commission, minus marketing fees, minus error charges and refunds, plus pass-through tips.
- Commissions and fees do **not** appear in the point of sale. They only appear on the payout statement.
- In most US states the platform collects and remits the sales tax itself (marketplace facilitator rules). Restaurants that also report that tax pay it twice.

What this means for the models: delivery sales are tracked per platform, each payout has lines by type, and tax carries a flag for who remits it.

### 1.6 Money owed in both directions

- **Owed to the restaurant**: catering invoices and house accounts. Needs customers, invoices, payments received.
- **Owed by the restaurant**: vendor bills, often several a day, with credits for short or damaged deliveries. Needs vendors, bills with lines coded to cost categories, payments.

### 1.7 Inventory and food cost

- **Actual cost** for a period = opening stock + purchases − closing stock.
- **Theoretical cost** = what the recipes say should have been used, given what was sold.
- The gap between them is the variance: waste, over-portioning, theft, bad counts, or stale recipe data.

This needs: items with units and conversions (a case of 6 cans, a can of 3 kg, a recipe using grams), vendor prices over time, recipes with yields, stock counts, a waste log, and item sales from the point of sale.

### 1.8 Labour and tips

- Staff hold **jobs** with pay rates. One person can hold two jobs at different rates.
- Time is recorded as clock in, clock out and breaks. Overtime is worked out per work week.
- Tipped staff may be paid a lower cash wage with a **tip credit**, as long as wages plus tips reach minimum wage. Rules vary by state.
- **Tip pools** share tips among eligible staff. Managers and supervisors cannot take part.
- Employers must keep records that identify tipped employees and their tips.

What this means for the models: hours, jobs, rates and tips are stored as facts per person per business date. Pool rules are settings. The output is a payroll-ready export, not a payroll calculation.

### 1.9 Franchises

A franchisee usually pays a royalty and a marketing fee, each a percentage of net sales, reported weekly or per period. Net sales definitions matter (delivery commissions and discounts are common disputes). The parent's copy of this data is the nightly copy described in the data model.

---

## 2. What source systems look like

Point-of-sale data follows the same outline across vendors, which is what makes a shared shape possible.

| Concept | Shape |
|---|---|
| Order | Has one or more checks. Split bills create several checks |
| Check | Holds the items, discounts, taxes and payments |
| Item line | A menu item with modifiers, quantity, price, a sales category, and a void flag with a reason |
| Payment | Amount, tip amount, type, card details, refund state |
| Context | Dining option (dine in, takeout, delivery), revenue centre (bar, patio), server, table, guest count |
| Dates | Opened, closed, paid, and the business date |
| Labour | Employees, jobs, scheduled shifts, time entries with breaks, declared cash tips |
| Cash | Drawer entries, paid in and out, deposits |

Every imported record keeps the source system's id, so importing the same record twice changes nothing.

---

## 3. Standard model packs

A **pack** is a group of models that belong together. A restaurant gets a model the first time one of its mini-apps needs it, and every later mini-app reuses the same one.

Every model has `id`, `location_id` where it applies, audit columns, and a `source` (manual, import, connection, app).

### Foundation

| Model | Purpose |
|---|---|
| `unit`, `unit_conversion` | Each, case, kg, litre, and how they convert per item |
| `tax_rate` | Name, rate, what it applies to, who remits |
| `fiscal_calendar`, `fiscal_period`, `fiscal_week` | Calendar months, 4-4-5 or 13 periods |
| `day_part` | Breakfast, lunch, dinner, late |
| `revenue_centre`, `sales_category`, `payment_type`, `reason_code` | The lists the daily numbers are grouped by |

### Sales

| Model | Purpose |
|---|---|
| `sales_day` | One row per location, business date and channel: gross, discounts, comps, net, tax, tips, service charges, guests, checks |
| `sales_category_day` | Net sales by category for that day |
| `payment_day` | Collected by payment type |
| `adjustment_day` | Discounts, comps and voids by reason |
| `order`, `order_line`, `payment` | Check-level detail, for restaurants that want it |
| `cash_count`, `paid_in_out`, `deposit` | Drawer counts, cash movements, bank deposits |
| `gift_card_activity` | Sold, redeemed, balance |
| `delivery_payout`, `delivery_payout_line` | Per platform payout: sales, commission, fees, refunds, tips, tax handled by platform, net |

### Menu and recipes

| Model | Purpose |
|---|---|
| `menu_item_costing` | Extends the parent's menu item with target cost and current cost |
| `recipe`, `recipe_line` | Ingredients with quantity, unit and yield |
| `prep_item` | Things made in-house and used in other recipes |

### Inventory and purchasing

| Model | Purpose |
|---|---|
| `vendor` | Who the restaurant buys from, terms, contact |
| `item` | Anything stocked, with category and base unit |
| `item_vendor` | Vendor's code, pack size and price, with history |
| `storage_area`, `par_level` | Where items live and how much to keep |
| `purchase_order`, `purchase_order_line` | What was ordered |
| `receipt` | What actually arrived |
| `vendor_bill`, `vendor_bill_line`, `vendor_credit` | What is owed, coded to cost categories |
| `stock_count`, `stock_count_line` | Physical counts |
| `stock_movement` | Append-only record of every change: received, used, wasted, transferred, adjusted |
| `waste_entry` | What was thrown away and why |

### Labour

| Model | Purpose |
|---|---|
| `job` | Role, front or back of house, tipped or not |
| `pay_rate` | Person, job, rate, start date |
| `shift` | Scheduled work |
| `time_entry` | Clock in, clock out, breaks, declared cash tips |
| `availability`, `time_off` | For scheduling |
| `tip_pool`, `tip_distribution` | Pool rules and who received what |
| `labour_day` | Hours and cost by job group per location and business date |

### Finance

| Model | Purpose |
|---|---|
| `account` | Chart of accounts, seeded from a restaurant template |
| `journal_entry`, `journal_line` | The ledger. Balanced, append-only |
| `posting_rule` | Maps each part of `sales_day`, bills and payroll to accounts |
| `bank_account`, `bank_transaction`, `reconciliation` | Matching deposits and payouts to the bank |
| `customer`, `invoice`, `invoice_line`, `payment_received` | Catering and house accounts |
| `bill_payment` | Paying vendors |
| `budget` | Targets per account per period |
| `royalty_statement` | Franchise royalty and marketing fee per period |

### Guests

| Model | Purpose |
|---|---|
| `guest`, `reservation`, `waitlist_entry` | Front door |
| `catering_order` | Event orders that become invoices |
| `feedback` | Reviews and complaints |

### Operations

| Model | Purpose |
|---|---|
| `checklist`, `checklist_run` | Opening, closing, cleaning |
| `temperature_log` | Food safety records |
| `equipment`, `maintenance_ticket` | Repairs |
| `licence` | Permits and expiry dates |
| `incident` | Accidents and complaints |

---

## 4. Rules built into the models

These are enforced by the platform, so no mini-app can get them wrong.

1. Money is whole minor units with a currency. Quantities always carry a unit.
2. Every operational row has a business date. Week and period come from the fiscal calendar.
3. The ledger always balances. Entries are never edited. A correction is a reversing entry. A closed period accepts nothing new.
4. Tips, sales tax and unredeemed gift cards are liabilities. They can never be posted as revenue.
5. Voids never count as sales. Discounts and comps are separate and carry a reason.
6. Tax remitted by a delivery platform is recorded but never added to what the restaurant owes.
7. Stock only changes through `stock_movement`. On-hand is a sum, never a stored number someone can overwrite.
8. Imported records keep their source id. Re-importing is harmless.
9. Fields tagged personal, payroll or financial are masked in sample data, in logs, and in anything shared outside the restaurant.

Standard reports that come with the packs: prime cost, weekly and period P&L, daily sales summary, cash over/short, actual vs theoretical food cost, labour as a share of sales, delivery payout reconciliation, aged bills and invoices.

---

## 5. How this serves the accounts mini-app

The accounts mini-app planned for the pilot needs only Foundation, Sales and Finance:

1. Daily sales arrive (typed in, uploaded, or pulled from a connected point of sale) as `sales_day` and its breakdown rows.
2. `posting_rule` turns each day into one balanced `journal_entry`.
3. Vendor bills and labour totals post the cost side.
4. P&L and prime cost are queries over `journal_line`, grouped by the fiscal calendar.

An inventory mini-app built later adds the Inventory pack and reuses `vendor`, `vendor_bill` and `account` that the accounts mini-app already created. Nothing is duplicated.

---

## 6. Sources

- Chart of accounts and prime cost: https://www.restaurant365.com/blog/restaurant-chart-of-accounts/ , https://pos.toasttab.com/blog/on-the-line/restaurant-chart-of-accounts , https://www.marketman.com/blog/restaurant-chart-of-accounts
- Fiscal calendars: https://docs.restaurant365.com/docs/calendar-setup , https://docs.oracle.com/en/industries/food-beverage/back-office/rause/c_calendar_accountingcycle.htm
- Daily operations reports: https://docs.restaurant365.com/docs/daily-operations-report , https://docs.oracle.com/en/industries/food-beverage/reporting-and-analytics/rarrg/c_daily_op_tsr_vat.htm , https://squareup.com/help/us/en/article/8579-surcharging-card-payments
- Point-of-sale data shape and business date: https://doc.toasttab.com/doc/devguide/portalOrdersApiOverview.html , https://doc.toasttab.com/doc/cookbook/apiHowToReporting.html , https://doc.toasttab.com/doc/devguide/apiOverview.html
- Food cost variance: https://support.toasttab.com/en/article/xtraCHEF-Inventory-Analytics , https://docs.restaurant365.com/docs/actual-vs-theoretical-analysis
- Delivery payouts and tax: https://merchants.doordash.com/en-ca/learning-center/payout-and-monthly-statement , https://www.bdo.com/insights/tax/marketplace-facilitators-third-party-delivery-platforms-and-retail-delivery-fees-key-sales-tax
- Tips and labour records: https://www.dol.gov/agencies/whd/fact-sheets/15-tipped-employees-flsa , https://www.law.cornell.edu/cfr/text/29/516.28

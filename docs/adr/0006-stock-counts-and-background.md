# 0006: Stock counts are in scope, and the background moves to a distinct tint

Date: 2026-11-21. Status: decided by Rahul.

## 1. Stock counts ("include stock counts")

The first cut reported "cost of goods" as vendor bills dated in the week. That is purchases, not usage: a large Saturday delivery inflates that week. Rahul asked for stock counts to be included.

- Food and drink cost = opening stock + purchases - closing stock, per location and week.
- New library models (pack `inventory`): `item`, `stock_count`, `stock_count_line`, and a cost group on vendor bill lines.
- New named action `post_stock_count`: posts the change in stock value against cost of goods, so the ledger shows usage. New queries `stock_on_hand` and `cost_of_goods_by_week`.
- The seed adds stock items and a count every Sunday at close for each location, plus an opening count. Purchases become lumpy. Marigold's usage for the week of 2026-11-09 stays exactly $25,460, so prime cost stays 61.3%.
- A week with no closing count says so. It never shows purchases as if it were usage.

This widens today's scope past the three packs in `03-demo-build.md` section 3. Still out: recipes, theoretical cost, waste log, par levels, purchase orders.

## 2. Background tint ("make the background colour a more distinct tint")

The approved Front of House sketch used a warm off-white ground (`#F4EEE6`), which the design check flags as the default look of AI-made screens. Rahul chose to move it to a more distinct tint. Everything else about Front of House stays. The designer picks the hue, shows a comparison on the gallery page, and Rahul confirms it at C1.

The C0 sketch files keep the old ground as a record of what was picked from.

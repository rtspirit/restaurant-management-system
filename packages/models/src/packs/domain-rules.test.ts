import { describe, expect, it } from "vitest";
import type { Expr, FieldDef, ModelDefinition, ModelRule } from "@rms/contracts";
import { DEFAULT_CHART_OF_ACCOUNTS, DEFAULT_POSTING_RULES, STANDARD_CALENDAR_NAME, models, namedActions, namedQueries } from "./index.js";

/**
 * The rules of docs/plan/02-restaurant-domain.md section 4, as far as they can be checked
 * without a database. Rule 7 there (stock only changes through stock_movement) belongs to the
 * Inventory pack, which is not built today. Rules 8 and 9 there are "rule 7" and "rule 8" in the
 * domain modeller's brief.
 *
 * The database half of each rule (the balanced trigger, append-only grants, closed periods) is
 * enforced by the compiler from the same definitions and tested there.
 */

const model = (key: string): ModelDefinition => {
  const m = models.find((x) => x.key === key);
  if (!m) throw new Error(`No model "${key}"`);
  return m;
};
const field = (m: ModelDefinition, key: string): FieldDef | undefined => m.fields.find((f) => f.key === key);
const action = (key: string) => {
  const a = namedActions.find((x) => x.key === key);
  if (!a) throw new Error(`No action "${key}"`);
  return a;
};
const query = (key: string) => {
  const q = namedQueries.find((x) => x.key === key);
  if (!q) throw new Error(`No query "${key}"`);
  return q;
};

// ---------------------------------------------------------------- a tiny check-rule evaluator
// Same three-valued logic as SQL: a comparison with a missing value is "unknown", and a check
// constraint only fails on a clear "false".

type Value = string | number | boolean | null;
type Row = Record<string, Value>;

const evaluate = (e: Expr, row: Row): Value => {
  if ("lit" in e) return e.lit;
  if ("field" in e) return row[e.field] ?? null;
  switch (e.op) {
    case "and": {
      const vs = e.args.map((a) => evaluate(a, row));
      return vs.includes(false) ? false : vs.includes(null) ? null : true;
    }
    case "or": {
      const vs = e.args.map((a) => evaluate(a, row));
      return vs.includes(true) ? true : vs.includes(null) ? null : false;
    }
    case "not": {
      const v = evaluate(e.arg, row);
      return v === null ? null : !v;
    }
    case "is_null":
      return evaluate(e.arg, row) === null;
    case "in": {
      const v = evaluate(e.arg, row);
      return v === null ? null : e.values.includes(v as string | number);
    }
    default: {
      const [a, b] = [evaluate(e.args[0], row), evaluate(e.args[1], row)];
      if (a === null || b === null) return null;
      switch (e.op) {
        case "eq":
          return a === b;
        case "ne":
          return a !== b;
        case "gt":
          return a > b;
        case "gte":
          return a >= b;
        case "lt":
          return a < b;
        case "lte":
          return a <= b;
        case "add":
          return (a as number) + (b as number);
        case "sub":
          return (a as number) - (b as number);
        case "mul":
          return (a as number) * (b as number);
      }
    }
  }
};

/** The names of the check rules a row breaks. */
const brokenChecks = (m: ModelDefinition, row: Row): string[] => m.rules.filter((r) => r.kind === "check" && evaluate(r.expr, row) === false).map((r) => r.name);

type RefValueIn = Extract<ModelRule, { kind: "ref_value_in" }>;
const refRules = (m: ModelDefinition): RefValueIn[] => m.rules.filter((r): r is RefValueIn => r.kind === "ref_value_in");
/** The ref_value_in rules a row breaks, given the value the row it points at has. */
const brokenRefRules = (m: ModelDefinition, row: Row, refValue: (rule: RefValueIn) => string): string[] =>
  refRules(m)
    .filter((r) => (r.when ? evaluate(r.when, row) === true : true) && !r.allowed.includes(refValue(r)))
    .map((r) => r.name);

const accountByCode = new Map(DEFAULT_CHART_OF_ACCOUNTS.map((a) => [a.code, a]));
const postingRow = (r: (typeof DEFAULT_POSTING_RULES)[number]): Row => ({
  part: r.part,
  sales_category: null,
  sales_group: r.salesGroup ?? null,
  payment_type: null,
  payment_kind: r.paymentKind ?? null,
  job_group: r.jobGroup ?? null,
  cost_group: r.costGroup ?? null,
  account: r.accountCode,
  active: true,
});

/** Which kind of model each one is, for rule 2. A new model must be put in one of the three. */
const REFERENCE_LISTS = ["unit", "tax_rate", "fiscal_calendar", "fiscal_period", "fiscal_week", "day_part", "revenue_centre", "sales_category", "payment_type", "reason_code", "account", "posting_rule", "budget", "vendor", "item"];
const DATED_ROWS = ["sales_day", "delivery_payout", "cash_count", "paid_in_out", "deposit", "journal_entry", "vendor_bill", "labour_day", "stock_count"];
/** The date field of each dated row. Always `business_date`, except a stock count, which is "counted on". */
const dateKeyOf = (key: string): string => (key === "stock_count" ? "counted_on" : "business_date");
const DETAIL_ROWS: Record<string, string> = {
  sales_category_day: "sales_day",
  payment_day: "sales_day",
  adjustment_day: "sales_day",
  gift_card_activity: "sales_day",
  delivery_payout_line: "delivery_payout",
  journal_line: "journal_entry",
  vendor_bill_line: "vendor_bill",
  stock_count_line: "stock_count",
};

describe("rule 1: money is whole minor units with a currency, quantities carry a unit", () => {
  const moneyWords = /(amount|sales|discounts|comps|voids|tips|charges|cost|debit|credit|balance|over_short|sales_tax|total|value)/;
  const notMoney = /(pct|hours|count|_bps|items_sold)/;

  it("every amount of money is a money field, never a decimal or a plain number", () => {
    for (const m of models) {
      for (const f of m.fields) {
        if (["enum", "ref", "parent_ref", "text", "boolean", "date", "business_date", "timestamp"].includes(f.type)) continue;
        if (moneyWords.test(f.key) && !notMoney.test(f.key)) expect(f.type, `${m.key}.${f.key}`).toBe("money");
      }
    }
  });

  it("no model keeps its own currency: the row has one currency, added by the compiler", () => {
    for (const m of models) for (const f of m.fields) expect(f.key, `${m.key}.${f.key}`).not.toMatch(/currency/);
  });

  it("decimals are only used for hours and percentages, which say their unit in the name", () => {
    const decimals = models.flatMap((m) => m.fields.filter((f) => f.type === "decimal").map((f) => `${m.key}.${f.key}`));
    expect(decimals.sort()).toEqual(["budget.pct_of_sales", "labour_day.hours", "labour_day.overtime_hours"]);
  });

  it("a rate is whole basis points, not a fraction", () => {
    expect(field(model("tax_rate"), "rate_bps")?.type).toBe("integer");
  });

  it("anything called a quantity is a quantity field, which stores its unit beside the number", () => {
    for (const m of models) for (const f of m.fields) if (/quantity|qty/.test(f.key)) expect(f.type, `${m.key}.${f.key}`).toBe("quantity");
    expect(field(model("vendor_bill_line"), "quantity")?.type).toBe("quantity");
    expect(field(model("stock_count_line"), "quantity")).toMatchObject({ type: "quantity", required: true });
    expect(field(model("item"), "base_unit")).toMatchObject({ type: "ref", model: "unit", required: true });
    expect(field(model("unit"), "code")?.required).toBe(true);
  });

  it("named queries hand money back as whole minor units", () => {
    for (const q of namedQueries) {
      for (const c of q.columns) {
        if (c.type !== "money") continue;
        const source = new RegExp(`(as bigint\\) as ${c.key}\\b|\\b[a-z]+\\.[a-z_]+ as ${c.key}\\b)`);
        expect(q.sql, `${q.key}.${c.key}`).toMatch(source);
      }
    }
  });
});

describe("rule 2: every operational row has a business date, weeks and periods come from the fiscal calendar", () => {
  it("every model is a list, a dated row or a detail row of a dated row", () => {
    expect([...REFERENCE_LISTS, ...DATED_ROWS, ...Object.keys(DETAIL_ROWS)].sort()).toEqual(models.map((m) => m.key).sort());
  });

  it("a dated row has a required business date", () => {
    for (const key of DATED_ROWS) {
      const dates = model(key).fields.filter((f) => f.type === "business_date");
      expect(dates.map((f) => f.key), key).toEqual([dateKeyOf(key)]);
      expect(dates[0]?.required, key).toBe(true);
    }
  });

  it("a detail row must point at its dated row, and does not keep a second date that could disagree", () => {
    for (const [key, header] of Object.entries(DETAIL_ROWS)) {
      const m = model(key);
      const refs = m.fields.filter((f) => f.type === "ref" && f.model === header);
      expect(refs.length, key).toBe(1);
      expect(refs[0]?.required, key).toBe(true);
      expect(m.fields.filter((f) => f.type === "business_date" || f.type === "date"), key).toEqual([]);
    }
  });

  it("no model stores a week or a period number beside its date", () => {
    for (const key of [...DATED_ROWS, ...Object.keys(DETAIL_ROWS)]) for (const f of model(key).fields) expect(f.key, `${key}.${f.key}`).not.toMatch(/week|fiscal|period_number/);
  });

  it("the weekly reports take their weeks from fiscal_week, never from date arithmetic", () => {
    for (const key of ["prime_cost_by_week", "weekly_pnl", "sales_by_day", "cost_of_goods_by_week"]) {
      const q = query(key);
      expect(q.reads, key).toContain("fiscal_week");
      expect(q.reads, key).toContain("fiscal_calendar");
    }
    for (const q of namedQueries) expect(q.sql, q.key).not.toMatch(/date_trunc|extract\s*\(|date_part|to_char|interval|current_date|now\s*\(/i);
  });

  it("the fiscal calendar is data: periods and weeks have first and last days, and a period can be closed", () => {
    for (const key of ["fiscal_period", "fiscal_week"]) {
      expect(field(model(key), "start_date")?.required).toBe(true);
      expect(field(model(key), "end_date")?.required).toBe(true);
      expect(brokenChecks(model(key), { start_date: "2026-11-09", end_date: "2026-11-08", period_number: 1, week_number: 1 })).toHaveLength(1);
    }
    const kinds = field(model("fiscal_calendar"), "kind");
    expect(kinds?.type === "enum" && kinds.values).toEqual(expect.arrayContaining(["calendar_months", "four_four_five", "thirteen_periods"]));
  });
});

describe("rule 3: the ledger balances, is never edited, corrects by reversing, and closed periods accept nothing", () => {
  const entry = model("journal_entry");
  const line = model("journal_line");

  it("journal_entry and journal_line are append-only", () => {
    expect(entry.appendOnly).toBe(true);
    expect(line.appendOnly).toBe(true);
  });

  it("they are the only append-only models today, and neither can be soft deleted", () => {
    expect(models.filter((m) => m.appendOnly).map((m) => m.key).sort()).toEqual(["journal_entry", "journal_line"]);
    expect(entry.softDelete || line.softDelete).toBe(false);
  });

  it("the entry carries the balanced rule over its lines", () => {
    expect(entry.rules.filter((r) => r.kind === "balanced")).toEqual([{ kind: "balanced", name: "journal_entry_balanced", lineModel: "journal_line", lineRef: "entry", debit: "debit", credit: "credit" }]);
    expect(line.rules.some((r) => r.kind === "balanced")).toBe(false);
    for (const side of ["debit", "credit"]) expect(field(line, side)).toMatchObject({ type: "money", required: true });
    expect(field(line, "entry")).toMatchObject({ type: "ref", model: "journal_entry", required: true, onDelete: "restrict" });
    expect(field(line, "account")).toMatchObject({ type: "ref", model: "account", required: true, onDelete: "restrict" });
  });

  it("a line is a debit or a credit, never both, never negative, never empty", () => {
    expect(brokenChecks(line, { debit: 500, credit: 0 })).toEqual([]);
    expect(brokenChecks(line, { debit: 0, credit: 500 })).toEqual([]);
    expect(brokenChecks(line, { debit: 500, credit: 500 })).toEqual(["journal_line_one_side_only"]);
    expect(brokenChecks(line, { debit: -500, credit: 0 })).toContain("journal_line_amounts_not_negative");
    expect(brokenChecks(line, { debit: 0, credit: 0 })).toEqual(["journal_line_not_empty"]);
  });

  it("a closed period accepts nothing new: the entry carries the open-period rule on its business date", () => {
    expect(entry.rules.filter((r) => r.kind === "open_period_only")).toEqual([{ kind: "open_period_only", name: "journal_entry_open_period", dateField: "business_date" }]);
  });

  it("a correction is a reversing entry that names the entry it reverses, once", () => {
    expect(field(entry, "reverses")).toMatchObject({ type: "ref", model: "journal_entry", required: false });
    expect(entry.unique).toContainEqual(["reverses"]);
    expect(brokenChecks(entry, { origin: "reversal", reverses: "an-entry" })).toEqual([]);
    expect(brokenChecks(entry, { origin: "reversal", reverses: null })).toEqual(["journal_entry_reversal_names_entry"]);
    expect(brokenChecks(entry, { origin: "sales_day", reverses: "an-entry" })).toEqual(["journal_entry_reversal_names_entry"]);
    expect(brokenChecks(entry, { origin: "sales_day", reverses: null })).toEqual([]);
  });

  it("only the owner can touch the books", () => {
    for (const m of [entry, line, model("posting_rule")]) expect(m.defaultAccess).toEqual({ owner: "write", staff: "none" });
  });

  it("no named action edits or deletes anything, and an entry is always written together with its lines", () => {
    for (const a of namedActions) {
      expect(a.sql, a.key).not.toMatch(/\b(update|delete|truncate)\b/i);
      expect(a.writes.includes("journal_entry"), a.key).toBe(a.writes.includes("journal_line"));
    }
  });

  it("posted lines put a positive amount on exactly one side", () => {
    for (const key of ["post_sales_day", "post_vendor_bill", "post_labour_day", "post_stock_count"]) {
      const sql = action(key).sql;
      expect(sql, key).toContain("greatest(p.signed, 0), greatest(-p.signed, 0)");
      expect([...sql.matchAll(/where p\.signed <> 0/g)].length, key).toBe(2);
    }
  });
});

describe("rule 4: tips, sales tax and unredeemed gift cards are liabilities, never revenue", () => {
  const posting = model("posting_rule");
  const owed = ["sales_tax", "tips", "gift_cards"];
  const typeOf = (row: Row) => () => accountByCode.get(row.account as string)?.type ?? "missing";

  it("posting_rule only lets those parts point at a liability account", () => {
    const rule = refRules(posting).find((r) => r.name === "posting_rule_owed_money_is_liability");
    expect(rule).toMatchObject({ field: "account", refField: "type", allowed: ["liability"] });
    for (const part of owed) expect(evaluate(rule?.when as Expr, { part })).toBe(true);
    expect(evaluate(rule?.when as Expr, { part: "net_sales" })).toBe(false);
    const parts = field(posting, "part");
    expect(parts?.type === "enum" && parts.values).toEqual(expect.arrayContaining(owed));
  });

  it.each(["asset", "equity", "revenue", "expense"])("a rule sending tips, sales tax or gift cards to a %s account is refused", (type) => {
    for (const part of owed) expect(brokenRefRules(posting, { part }, () => type)).toContain("posting_rule_owed_money_is_liability");
  });

  it("no default posting rule targets a revenue account for tips, sales tax or gift cards", () => {
    const rules = DEFAULT_POSTING_RULES.filter((r) => owed.includes(r.part));
    expect(rules.map((r) => r.part).sort()).toEqual([...owed].sort());
    for (const r of rules) expect(accountByCode.get(r.accountCode)?.type, r.ruleKey).toBe("liability");
  });

  it("every default posting rule passes every rule on posting_rule", () => {
    for (const r of DEFAULT_POSTING_RULES) {
      const row = postingRow(r);
      expect(accountByCode.has(r.accountCode), r.ruleKey).toBe(true);
      expect(brokenChecks(posting, row), r.ruleKey).toEqual([]);
      expect(brokenRefRules(posting, row, typeOf(row)), r.ruleKey).toEqual([]);
    }
  });

  it("every part has a default rule, with a catch-all where a part is chosen by category, payment or job", () => {
    const parts = field(posting, "part");
    expect([...new Set(DEFAULT_POSTING_RULES.map((r) => r.part))].sort()).toEqual(parts?.type === "enum" ? [...parts.values].sort() : []);
    expect(new Set(DEFAULT_POSTING_RULES.map((r) => r.ruleKey)).size).toBe(DEFAULT_POSTING_RULES.length);
    const catchAll = (part: string) => DEFAULT_POSTING_RULES.filter((r) => r.part === part && !r.salesGroup && !r.paymentKind && !r.jobGroup && !r.costGroup).length;
    expect(catchAll("net_sales")).toBe(1);
    expect(catchAll("payment")).toBe(1);
    expect(DEFAULT_POSTING_RULES.filter((r) => r.part === "labour_cost").map((r) => r.jobGroup).sort()).toEqual(["back_of_house", "front_of_house", "management"]);
    expect(DEFAULT_POSTING_RULES.filter((r) => r.part === "stock_cost").map((r) => r.costGroup).sort()).toEqual(["alcohol", "beverage", "food", "supplies"]);
  });

  it("the default chart has no revenue account for tips, tax or gift cards, and every account fits its section", () => {
    const account = model("account");
    expect(new Set(DEFAULT_CHART_OF_ACCOUNTS.map((a) => a.code)).size).toBe(DEFAULT_CHART_OF_ACCOUNTS.length);
    expect(new Set(DEFAULT_CHART_OF_ACCOUNTS.map((a) => a.name)).size).toBe(DEFAULT_CHART_OF_ACCOUNTS.length);
    for (const a of DEFAULT_CHART_OF_ACCOUNTS) {
      expect(brokenChecks(account, { type: a.type, report_section: a.reportSection }), a.code).toEqual([]);
      if (/tip|tax owed|gift card/i.test(a.name)) expect(a.type, a.name).toBe("liability");
      if (a.type === "revenue") expect(a.name, a.code).not.toMatch(/tip|tax|gift/i);
    }
    expect(brokenChecks(account, { type: "liability", report_section: "sales" })).toEqual(["account_section_matches_type"]);
    expect(brokenChecks(account, { type: "revenue", report_section: "labour" })).toEqual(["account_section_matches_type"]);
  });

  it("the seed action carries exactly the default chart and rules", () => {
    const sql = action("seed_chart_of_accounts").sql;
    for (const a of DEFAULT_CHART_OF_ACCOUNTS) expect(sql).toContain(`('${a.code}', '${a.name}', '${a.type}', '${a.reportSection}')`);
    for (const r of DEFAULT_POSTING_RULES) expect(sql).toContain(`('${r.ruleKey}', '${r.part}', `);
    expect([...sql.matchAll(/^\s+\('/gm)].length).toBe(DEFAULT_CHART_OF_ACCOUNTS.length + DEFAULT_POSTING_RULES.length);
  });

  it("posting a day takes every account from a posting rule, so the rule above always applies", () => {
    const sql = action("post_sales_day").sql;
    for (const part of [...owed, "net_sales", "payment", "service_charges"]) expect(sql).toContain(`'${part}'`);
    expect(action("post_sales_day").reads).toContain("posting_rule");
    expect(action("post_sales_day").reads).not.toContain("account");
    expect(sql).not.toMatch(/'[0-9]{4}'/);
  });

  it("gift cards sold are never part of sales: they are recorded apart from the day's sales totals", () => {
    expect(model("sales_day").fields.some((f) => /gift/.test(f.key))).toBe(false);
    expect(model("gift_card_activity").description).toMatch(/never sales/);
    const kinds = field(model("payment_type"), "kind");
    expect(kinds?.type === "enum" && kinds.values.includes("gift_card")).toBe(false);
  });
});

describe("rule 5: voids never count as sales, discounts and comps are separate and carry a reason", () => {
  const day = model("sales_day");
  const good: Row = { gross_sales: 100000, discounts: 5000, comps: 3000, voids: 2000, net_sales: 92000, tips: 0 };

  it("net sales is gross minus discounts and comps, and voids are not in the sum", () => {
    expect(brokenChecks(day, good)).toEqual([]);
    expect(brokenChecks(day, { ...good, net_sales: 90000 })).toEqual(["sales_day_net_is_gross_less_reductions"]);
    expect(brokenChecks(day, { ...good, voids: 999999 })).toEqual([]);
    expect(brokenChecks(day, { ...good, voids: null })).toEqual([]);
    const rule = day.rules.find((r) => r.name === "sales_day_net_is_gross_less_reductions");
    expect(JSON.stringify(rule)).not.toContain("voids");
  });

  it("the same holds for a category's day when the till gives the full breakdown", () => {
    const m = model("sales_category_day");
    expect(brokenChecks(m, { gross_sales: 1000, discounts: 100, comps: 50, net_sales: 850 })).toEqual([]);
    expect(brokenChecks(m, { gross_sales: 1000, discounts: 100, comps: 50, net_sales: 800 })).toHaveLength(1);
    expect(brokenChecks(m, { gross_sales: null, discounts: null, comps: null, net_sales: 850 })).toEqual([]);
    expect(m.fields.some((f) => /void/.test(f.key))).toBe(false);
  });

  it("discounts, comps and voids are three separate kinds, each with a required reason of the right kind", () => {
    const adj = model("adjustment_day");
    const kind = field(adj, "kind");
    expect(kind?.type === "enum" && kind.values).toEqual(["discount", "comp", "void"]);
    expect(field(adj, "reason")).toMatchObject({ type: "ref", model: "reason_code", required: true });
    expect(adj.unique).toContainEqual(["sales_day", "kind", "reason"]);
    for (const k of ["discount", "comp", "void"]) {
      expect(brokenRefRules(adj, { kind: k }, () => k)).toEqual([]);
      expect(brokenRefRules(adj, { kind: k }, () => "waste")).toHaveLength(1);
    }
    expect(brokenRefRules(adj, { kind: "comp" }, () => "discount")).toEqual(["adjustment_day_comp_reason"]);
  });

  it("discounts and comps are separate amounts on the day, and cannot be negative", () => {
    expect(field(day, "discounts")).toMatchObject({ type: "money", required: true });
    expect(field(day, "comps")).toMatchObject({ type: "money", required: true });
    expect(brokenChecks(day, { ...good, discounts: -1, net_sales: 97001 })).toEqual(["sales_day_reductions_not_negative"]);
  });

  it("nothing posts voids, discounts or comps: revenue is posted from net sales only", () => {
    const sql = action("post_sales_day").sql;
    expect(sql).not.toMatch(/void|comps|discount|gross_sales|adjustment_day/);
    expect(action("post_sales_day").reads).not.toContain("adjustment_day");
    const parts = field(model("posting_rule"), "part");
    expect(parts?.type === "enum" && parts.values.some((v) => /void|discount|comp/.test(v))).toBe(false);
  });

  it("no report adds voids to sales", () => {
    for (const q of namedQueries) for (const m of q.sql.matchAll(/[^\n]*voids[^\n]*/g)) expect(m[0], q.key).toMatch(/^\s*(sum\(coalesce\(sd\.voids, 0\)\) as voids|cast\(d\.voids as bigint\) as voids),$/);
  });
});

describe("rule 6: tax remitted by a delivery platform is recorded but never added to what the restaurant owes", () => {
  it("a tax rate says who pays it over", () => {
    const f = field(model("tax_rate"), "remitted_by");
    expect(f).toMatchObject({ type: "enum", required: true, values: ["restaurant", "platform"] });
  });

  it("a day of sales keeps platform-remitted tax apart from the tax the restaurant owes", () => {
    const day = model("sales_day");
    expect(field(day, "sales_tax")).toMatchObject({ type: "money", required: true });
    expect(field(day, "tax_remitted_by_platform")).toMatchObject({ type: "money", required: false });
    const inRules = day.rules.some((r) => JSON.stringify(r).includes("tax_remitted_by_platform"));
    expect(inRules).toBe(false);
  });

  it("no named action ever reads it, so it can never reach the sales tax owed account", () => {
    for (const a of namedActions) expect(a.sql, a.key).not.toContain("remitted");
    const parts = field(model("posting_rule"), "part");
    expect(parts?.type === "enum" && parts.values.some((v) => /remitted|platform/.test(v))).toBe(false);
  });

  it("a payout statement has its own line kind for it, apart from tax passed to the restaurant", () => {
    const kind = field(model("delivery_payout_line"), "kind");
    expect(kind?.type === "enum" && kind.values).toEqual(expect.arrayContaining(["sales_tax", "tax_remitted_by_platform"]));
    const line = model("delivery_payout_line");
    expect(brokenChecks(line, { kind: "tax_remitted_by_platform", amount: 1200 })).toEqual([]);
    expect(brokenChecks(line, { kind: "commission", amount: 1200 })).toEqual(["delivery_payout_line_takes_not_positive"]);
    expect(brokenChecks(line, { kind: "sales", amount: -1 })).toEqual(["delivery_payout_line_adds_not_negative"]);
  });

  it("the reconciliation shows it but leaves it out of the payout and of what the restaurant collected", () => {
    const sql = query("delivery_payout_reconciliation").sql;
    expect(sql).toContain("sum(case when l.kind <> 'tax_remitted_by_platform' then l.amount else 0 end) as expected_net");
    expect(sql).toContain("sum(case when l.kind = 'tax_remitted_by_platform' then l.amount else 0 end) as tax_remitted_by_platform");
    expect(sql).toContain("sum(case when l.kind in ('sales', 'sales_tax', 'tip') then l.amount else 0 end) as statement_collected");
    expect([...sql.matchAll(/'tax_remitted_by_platform'/g)].length).toBe(2);
  });

  it("the daily summary does not count it in what the day has to account for", () => {
    expect(query("daily_sales_summary").sql).not.toContain("remitted");
  });

  it("a payout must name a delivery platform", () => {
    const payout = model("delivery_payout");
    expect(brokenRefRules(payout, {}, () => "delivery_platform")).toEqual([]);
    expect(brokenRefRules(payout, {}, () => "card")).toEqual(["delivery_payout_platform_kind"]);
  });
});

describe("rule 7: imported records keep their source id, and re-importing changes nothing", () => {
  it("source and source id are system columns on every model, never fields a definition could get wrong", () => {
    for (const m of models) for (const f of m.fields) expect(["source", "source_id"], `${m.key}.${f.key}`).not.toContain(f.key);
  });

  it("every action is marked idempotent and gives each header row a source id it will not insert twice", () => {
    for (const a of namedActions) {
      expect(a.idempotent, a.key).toBe(true);
      expect(a.sql, a.key).toContain("on conflict do nothing");
    }
    for (const [key, origin] of [["post_sales_day", "sales_day"], ["post_vendor_bill", "vendor_bill"], ["post_labour_day", "labour_day"], ["post_stock_count", "stock_count"]] as const) {
      const sql = action(key).sql;
      expect(sql, key).toContain(`'app', '${origin}/' || cast(src.id as text)`);
      expect(sql, key).toMatch(/insert into \{\{journal_entry\}\} \([^)]*\bsource, source_id\b[^)]*\)[^;]*?on conflict do nothing\s+returning id, location_id/);
      expect(sql, key).toMatch(/from entry as e\n/);
    }
    const seed = action("seed_chart_of_accounts").sql;
    expect(seed).toContain("'app', 'chart/' || c.code");
    expect(seed).toContain("'app', 'default_rule/' || d.rule_key");
    expect([...seed.matchAll(/on conflict do nothing/g)].length).toBe(2);
  });

  it("every row an action writes says it came from the app", () => {
    for (const a of namedActions) {
      const inserts = [...a.sql.matchAll(/insert into \{\{[a-z_]+\}\} \(([^)]*)\)/g)];
      for (const ins of inserts) expect((ins[1] as string).split(", "), a.key).toContain("source");
      expect([...a.sql.matchAll(/, 'app', /g)].length, a.key).toBe(inserts.length);
    }
  });

  it("a day can only be recorded once per location, date and channel, and a breakdown row once per day", () => {
    expect(model("sales_day").unique).toContainEqual(["location_id", "business_date", "channel"]);
    expect(model("sales_category_day").unique).toContainEqual(["sales_day", "sales_category"]);
    expect(model("payment_day").unique).toContainEqual(["sales_day", "payment_type"]);
    expect(model("gift_card_activity").unique).toContainEqual(["sales_day"]);
    expect(model("labour_day").unique).toContainEqual(["location_id", "business_date", "job_group"]);
    expect(model("vendor_bill").unique).toContainEqual(["vendor", "bill_number"]);
    expect(model("stock_count").unique).toContainEqual(["location_id", "counted_on"]);
    expect(model("stock_count_line").unique).toContainEqual(["stock_count", "item"]);
  });
});

describe("rule 8: personal, payroll and financial fields are tagged", () => {
  it("every money field is tagged financial or payroll", () => {
    for (const m of models) for (const f of m.fields) if (f.type === "money") expect(["financial", "payroll"], `${m.key}.${f.key}`).toContain(f.sensitivity);
  });

  it("staff cost is payroll and only the owner can read it", () => {
    const cost = field(model("labour_day"), "labour_cost");
    expect(cost).toMatchObject({ type: "money", sensitivity: "payroll", readableBy: ["owner"] });
    for (const m of models) for (const f of m.fields) if (f.sensitivity === "payroll") expect(f.readableBy, `${m.key}.${f.key}`).toEqual(["owner"]);
  });

  it("contact details and anything naming a staff member are tagged personal", () => {
    for (const m of models) {
      for (const f of m.fields) {
        if (/email|phone|contact/.test(f.key)) expect(f.sensitivity, `${m.key}.${f.key}`).toBe("personal");
        if (f.type === "parent_ref" && f.parentModel === "staff") expect(f.sensitivity, `${m.key}.${f.key}`).toBe("personal");
      }
    }
    for (const key of ["contact_name", "email", "phone"]) expect(field(model("vendor"), key)?.sensitivity).toBe("personal");
  });

  it("account numbers and bank references are tagged financial", () => {
    expect(field(model("vendor"), "account_number")).toMatchObject({ sensitivity: "financial", readableBy: ["owner"] });
    expect(field(model("deposit"), "reference")?.sensitivity).toBe("financial");
    expect(field(model("delivery_payout"), "reference")?.sensitivity).toBe("financial");
    expect(field(model("budget"), "pct_of_sales")?.sensitivity).toBe("financial");
  });

  it("named query columns carry the tags of what they show", () => {
    for (const q of namedQueries) for (const c of q.columns) if (c.type === "money") expect(["financial", "payroll"], `${q.key}.${c.key}`).toContain(c.sensitivity);
    const prime = query("prime_cost_by_week");
    for (const key of ["labour", "labour_pct", "prime_cost", "prime_cost_pct"]) expect(prime.columns.find((c) => c.key === key), key).toMatchObject({ sensitivity: "payroll", readableBy: ["owner"] });
    expect(query("weekly_pnl").columns.find((c) => c.key === "amount")).toMatchObject({ sensitivity: "financial", readableBy: ["owner"] });
  });

  it("reports that show staff cost read the books, which staff cannot open at all", () => {
    for (const key of ["prime_cost_by_week", "weekly_pnl"]) {
      const reads = query(key).reads.filter((r) => !r.startsWith("parent."));
      expect(reads.some((r) => model(r).defaultAccess.staff === "none"), key).toBe(true);
    }
    for (const q of namedQueries) expect(q.reads, q.key).not.toContain("labour_day");
  });
});

/** The words between `name as (` and the matching close of one CTE or lateral block. */
const block = (sql: string, opener: string): string => {
  const start = sql.indexOf(opener);
  if (start < 0) throw new Error(`No "${opener}"`);
  let depth = 0;
  for (let i = sql.indexOf("(", start); i < sql.length; i += 1) {
    if (sql[i] === "(") depth += 1;
    if (sql[i] === ")") depth -= 1;
    if (depth === 0) return sql.slice(start, i + 1);
  }
  throw new Error(`Unclosed "${opener}"`);
};
/** The same text with every run of spaces and line breaks squeezed to one space. */
const flat = (text: string): string => text.replace(/\s+/g, " ");
/** Every guard part of an action: a line with no account, so the post fails when it applies. */
const guards = (sql: string): Array<{ message: string; amount: string }> =>
  [...sql.matchAll(/select 0, '([^']+)', cast\(null as uuid\), ([^\n]+)\n/g)].map((m) => ({ message: m[1] as string, amount: m[2] as string }));

describe("review fix 1: retiring a list entry can never change a posted figure", () => {
  const removable = (key: string) => {
    const m = model(key);
    return m.softDelete && !m.appendOnly;
  };

  it("every list that reports or postings look things up in is retired, not removed", () => {
    for (const key of REFERENCE_LISTS) {
      if (key === "budget") continue;
      expect(removable(key), key).toBe(false);
      expect(model(key).softDelete, key).toBe(false);
    }
    for (const key of ["account", "sales_category", "payment_type", "revenue_centre", "fiscal_calendar", "fiscal_period", "fiscal_week", "vendor", "posting_rule", "item"]) expect(removable(key), key).toBe(false);
  });

  it("a list with an in-use flag says in its description that it is retired, not removed", () => {
    for (const m of models) {
      const hasFlag = m.fields.some((f) => f.key === "active" && f.type === "boolean" && f.required);
      if (!hasFlag) continue;
      expect(m.softDelete, m.key).toBe(false);
      expect(m.description, m.key).toMatch(/Retire one by marking it not in use: it is never removed\./);
    }
  });

  it("no report built on the books reads anything that can be removed", () => {
    const ledgerReports = namedQueries.filter((q) => q.reads.includes("journal_line"));
    expect(ledgerReports.map((q) => q.key).sort()).toEqual(["cost_of_goods_by_week", "prime_cost_by_week", "weekly_pnl"]);
    // A stock count is the one exception: it only supplies the opening and closing stock shown
    // beside the cost, never the cost itself, which comes from the books.
    for (const q of ledgerReports) for (const r of q.reads) if (!r.startsWith("parent.") && !["stock_count", "stock_count_line"].includes(r)) expect(removable(r), `${q.key} reads ${r}`).toBe(false);
  });

  it("everything a ledger line or a posting points at stays put", () => {
    for (const key of ["journal_line", "posting_rule", "vendor_bill_line", "stock_count_line", "sales_category_day", "payment_day"]) {
      for (const f of model(key).fields) {
        if (f.type !== "ref" || Object.values(DETAIL_ROWS).includes(f.model)) continue;
        expect(removable(f.model), `${key}.${f.key} -> ${f.model}`).toBe(false);
        expect(f.onDelete, `${key}.${f.key}`).toBe("restrict");
      }
    }
  });

  it("the other reports only read removable rows that are the day's own records", () => {
    const dayRecords = new Set(["sales_day", "payment_day", "gift_card_activity", "delivery_payout", "delivery_payout_line", "stock_count", "stock_count_line"]);
    for (const q of namedQueries) for (const r of q.reads) if (!r.startsWith("parent.") && removable(r)) expect(dayRecords.has(r), `${q.key} reads ${r}`).toBe(true);
  });

  it("a posting never loses a line because something it looks up was retired", () => {
    const sql = action("post_vendor_bill").sql;
    expect(sql).toContain("left join {{vendor}} as v on v.id = b.vendor");
    for (const a of namedActions) expect(a.sql, a.key).not.toMatch(/\b[a-z]+\.active\b(?<!pr\.active)/);
  });
});

describe("review fixes 2, 3 and 6: what must not be posted is refused, never skipped", () => {
  it("a guard is a line with no account, which the ledger cannot accept", () => {
    expect(field(model("journal_line"), "account")?.required).toBe(true);
    for (const a of namedActions.filter((x) => x.key.startsWith("post_"))) for (const g of guards(a.sql)) expect(g.message.length, a.key).toBeGreaterThan(20);
  });

  it("post_sales_day refuses a day whose category rows do not add up to its net sales", () => {
    const sql = action("post_sales_day").sql;
    const g = guards(sql).find((x) => /category rows do not add up/.test(x.message));
    expect(g?.amount).toBe("sd.net_sales - c.total");
    const sum = flat(sql).match(/cross join lateral \( select cast\(sum\(x\.net_sales\) as bigint\) as total, count\(\*\) as row_count from \{\{sales_category_day\}\} as x where x\.sales_day = sd\.id \) as c/);
    expect(sum).not.toBeNull();
    expect(sql).toContain("where c.row_count > 0");
  });

  it("post_sales_day refuses a day that has both an all row and rows per channel", () => {
    const sql = action("post_sales_day").sql;
    const g = guards(sql).find((x) => /both an all row and rows per channel/.test(x.message));
    expect(g?.amount).toBe("1");
    expect(sql).toContain("and (other.channel = 'all') <> (sd.channel = 'all')");
    expect(flat(sql)).toContain("where other.location_id = sd.location_id and other.business_date = sd.business_date and other.id <> sd.id");
    const channel = field(model("sales_day"), "channel");
    expect(channel?.type === "enum" && channel.values[0]).toBe("all");
    expect(channel?.description).toMatch(/never both/);
  });

  it("every report that adds up days counts such a day once, by its all row", () => {
    for (const q of namedQueries) {
      const sums = [...q.sql.matchAll(/from \{\{sales_day\}\} as sd\b|join \{\{sales_day\}\} as sd\b/g)].length;
      const once = [...q.sql.matchAll(/\(sd\.channel = 'all' or not exists \(/g)].length;
      expect(once, q.key).toBe(sums);
    }
    expect(query("sales_by_day").sql).toContain("from {{sales_day}} as whole_day");
  });

  it("post_vendor_bill refuses a void bill instead of answering 0", () => {
    const sql = action("post_vendor_bill").sql;
    expect(guards(sql)).toEqual([{ message: "This bill is void, so it cannot be posted", amount: "1" }]);
    expect(flat(sql)).toContain("cast(null as uuid), 1 from vb where vb.status = 'void'");
    expect(block(sql, "with vb as (")).not.toContain("void");
  });

  it("posting a row that does not exist is an error: the entry is attempted even with nothing to post from", () => {
    for (const key of ["post_sales_day", "post_vendor_bill", "post_labour_day", "post_stock_count"]) {
      const sql = action(key).sql;
      const entry = block(sql, "entry as (");
      expect(flat(entry), key).toMatch(/from \(select 1 as asked\) as request left join [a-z]+ as src on true/);
      expect(entry, key).toContain("where src.id is null or exists (select 1 from parts as p where p.signed <> 0)");
      for (const required of ["location_id", "business_date"]) expect(field(model("journal_entry"), required)?.required ?? true, key).toBe(true);
    }
  });

  it("a payment amount leaves out tax a delivery platform pays over itself, and says so", () => {
    expect(field(model("payment_day"), "amount")?.description).toMatch(/leave out tax the platform collects and pays over itself/);
    expect(field(model("sales_day"), "tax_remitted_by_platform")?.description).toMatch(/not in any payment amount/);
    expect(model("payment_day").description).toMatch(/never tax a delivery platform pays over itself/);
  });
});

describe("review fix 5: a week that is not in the calendar gives no rows", () => {
  it("weekly_pnl only answers for a week it found", () => {
    expect(query("weekly_pnl").sql).toContain("where exists (select 1 from wk as asked_week)");
  });
});

describe("review fix 8: the fiscal calendar can be set up for any date range", () => {
  const seed = action("seed_fiscal_calendar");

  it("takes a date range and writes the calendar, its periods and its weeks", () => {
    expect(seed.params).toEqual([
      { key: "from_date", type: "date", required: true },
      { key: "to_date", type: "date", required: true },
    ]);
    expect(seed.writes).toEqual(["fiscal_calendar", "fiscal_period", "fiscal_week"]);
    expect(seed.pack).toBe("foundation");
  });

  it("weeks start on Monday and are numbered from their own Monday, so another range gives the same numbers", () => {
    expect(seed.sql).toContain("cast(:from_date as date) - (cast(extract(isodow from cast(:from_date as date)) as integer) - 1) as first_monday");
    expect(seed.sql).toContain("'calendar_months', 'monday', true");
    expect(seed.sql).toContain("cast(extract(isoyear from w.start_date) as integer), cast(extract(week from w.start_date) as integer)");
    expect(seed.sql).toContain("b.first_monday + 7 * g.n + 6 as end_date");
    expect(seed.sql).not.toMatch(/current_date|now\s*\(|date_trunc|to_char/);
  });

  it("is idempotent: one calendar found by name, and nothing that exists is touched", () => {
    expect([...seed.sql.matchAll(/on conflict do nothing/g)].length).toBe(3);
    expect([...seed.sql.matchAll(new RegExp(`fc\\.name = '${STANDARD_CALENDAR_NAME}'`, "g"))].length).toBe(2);
    expect(seed.sql).toContain("'app', 'fiscal_calendar/standard'");
    expect(seed.sql).toContain("'app', 'fiscal_period/' || cast(m.year_number as text) || '/' || cast(m.month_number as text)");
    expect(seed.sql).toContain("'app', 'fiscal_week/' || cast(cast(extract(isoyear from w.start_date) as integer) as text)");
  });

  it("the weeks it makes fit the model: Monday to Sunday, numbered 1 to 53, inside a period", () => {
    // The same arithmetic in plain code, for the week the demo is about.
    const monday = new Date(Date.UTC(2026, 10, 9));
    expect(monday.getUTCDay()).toBe(1);
    const thursday = new Date(monday.getTime() + 3 * 86400000);
    const jan4 = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
    const week1Monday = new Date(jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 86400000);
    const isoWeek = Math.round((monday.getTime() - week1Monday.getTime()) / (7 * 86400000)) + 1;
    expect(isoWeek).toBe(46);
    expect(brokenChecks(model("fiscal_week"), { start_date: "2026-11-09", end_date: "2026-11-15", week_number: isoWeek })).toEqual([]);
    expect(seed.sql).toContain("join all_periods as p on w.thursday between p.start_date and p.end_date");
  });
});

describe("stock counts: food and drink cost is what was used, not what was bought", () => {
  const post = action("post_stock_count");

  it("a stock item has a stock group, a unit and a cost, and is retired rather than removed", () => {
    const item = model("item");
    expect(field(item, "cost_group")).toMatchObject({ type: "enum", required: true, values: ["food", "beverage", "alcohol", "supplies"] });
    expect(field(item, "unit_cost")).toMatchObject({ type: "money", required: true, sensitivity: "financial" });
    expect(item.locationScoped).toBe(false);
    expect(item.softDelete).toBe(false);
    expect(field(model("vendor_bill_line"), "cost_group")).toMatchObject({ type: "enum", values: ["food", "beverage", "alcohol", "supplies"] });
    expect(field(model("posting_rule"), "cost_group")).toMatchObject({ type: "enum", values: ["food", "beverage", "alcohol", "supplies"] });
  });

  it("a count is draft or final, once per location and date, and its lines keep their own cost and value", () => {
    const count = model("stock_count");
    expect(field(count, "status")).toMatchObject({ type: "enum", required: true, values: ["draft", "final"] });
    expect(count.locationScoped).toBe(true);
    const line = model("stock_count_line");
    for (const key of ["unit_cost", "value"]) expect(field(line, key)).toMatchObject({ type: "money", required: true });
    expect(brokenChecks(line, { value: 0, quantity: 0, unit_cost: 0 })).toEqual([]);
    expect(brokenChecks(line, { value: -1, quantity: 1, unit_cost: 1 })).toEqual(["stock_count_line_value_not_negative"]);
  });

  it("only final counts are ever used", () => {
    for (const t of [...namedQueries, ...namedActions]) {
      if (!t.reads.includes("stock_count")) continue;
      for (const m of t.sql.matchAll(/\{\{stock_count\}\} as ([a-z_]+)\b/g)) {
        const alias = m[1] as string;
        if (t.key === "post_stock_count" && alias === "c") continue; // the count being posted: refused below unless final
        expect(t.sql, `${t.key} ${alias}`).toContain(`${alias}.status = 'final'`);
      }
    }
    expect(guards(post.sql).map((g) => g.message)).toContain("This stock count is not final, so it cannot be posted");
    expect(flat(post.sql)).toContain("cast(null as uuid), 1 from sc where sc.status <> 'final'");
  });

  it("stock up debits the stock account and credits the group's cost account, stock down the reverse", () => {
    expect(post.sql).toContain("'Stock on hand, ' || g.cost_group as memo, r.account as account, g.value_now - g.value_before as signed");
    expect(post.sql).toContain("select 20, 'Stock change, ' || g.cost_group, r.account, g.value_before - g.value_now");
    expect(flat(post.sql)).toContain("and pr.part = 'stock_cost' and (pr.cost_group = g.cost_group or pr.cost_group is null)");
    expect(post.sql).toContain("left join simple_rule as r on r.part = 'stock_on_hand'");
  });

  it("the example from the brief: used = opening + purchases - closing, for each group", () => {
    // Same sign rule as the template: signed > 0 is a debit, signed < 0 is a credit.
    const before = { food: 980000, beverage: 310000 };
    const now = { food: 960000, beverage: 340000 };
    const purchases = { food: 1930000, beverage: 646000 };
    const lines = (["food", "beverage"] as const).flatMap((g) => [
      { account: "Stock on hand", group: g, signed: now[g] - before[g] },
      { account: `${g} cost`, group: g, signed: before[g] - now[g] },
    ]);
    const debit = (l: { signed: number }) => Math.max(l.signed, 0);
    const credit = (l: { signed: number }) => Math.max(-l.signed, 0);
    expect(lines.map((l) => [l.account, debit(l), credit(l)])).toEqual([
      ["Stock on hand", 0, 20000],
      ["food cost", 20000, 0],
      ["Stock on hand", 30000, 0],
      ["beverage cost", 0, 30000],
    ]);
    expect(lines.reduce((a, l) => a + debit(l), 0)).toBe(lines.reduce((a, l) => a + credit(l), 0));
    const used = (g: "food" | "beverage") => purchases[g] + (lines.find((l) => l.account === `${g} cost`)?.signed ?? 0);
    expect(used("food")).toBe(1950000);
    expect(used("beverage")).toBe(616000);
    expect(used("food") + used("beverage")).toBe(2566000);
    for (const g of ["food", "beverage"] as const) expect(used(g)).toBe(before[g] + purchases[g] - now[g]);
  });

  it("the first count of a location sets the opening stock and never touches cost", () => {
    expect(post.sql).toContain("select 30, 'Opening stock on hand, ' || g.cost_group, r.account, g.value_now");
    expect(post.sql).toContain("select 31, 'Opening stock, ' || g.cost_group, r.account, -g.value_now");
    expect(post.sql).toContain("left join simple_rule as r on r.part = 'stock_opening'");
    expect([...post.sql.matchAll(/where not s\.is_first/g)].length).toBe(2);
    expect([...post.sql.matchAll(/where s\.is_first/g)].length).toBe(2);
    const rule = (part: string) => DEFAULT_POSTING_RULES.find((r) => r.part === part);
    expect(accountByCode.get(rule("stock_opening")?.accountCode ?? "")?.type).toBe("equity");
    expect(accountByCode.get(rule("stock_on_hand")?.accountCode ?? "")).toMatchObject({ type: "asset", reportSection: "balance_sheet" });
  });

  it("each food and drink group has its own cost account in the cost of goods section, and supplies do not", () => {
    const account = (group: string) => accountByCode.get(DEFAULT_POSTING_RULES.find((r) => r.part === "stock_cost" && r.costGroup === group)?.accountCode ?? "");
    const codes = ["food", "beverage", "alcohol"].map((g) => account(g)?.code);
    expect(new Set(codes).size).toBe(3);
    for (const g of ["food", "beverage", "alcohol"]) expect(account(g)).toMatchObject({ type: "expense", reportSection: "cost_of_goods" });
    expect(account("supplies")).toMatchObject({ type: "expense", reportSection: "controllable" });
  });

  it("compares with the last count that is in the books, and refuses a count that is out of order", () => {
    const inBooks = block(post.sql, "in_books as (");
    expect(inBooks).toContain("o.status = 'final' and o.id <> sc.id");
    expect(inBooks).toContain("je.origin = 'stock_count' and je.origin_id = cast(o.id as text)");
    expect(flat(block(post.sql, "base as ("))).toContain("where ib.counted_on < sc.counted_on order by ib.counted_on desc limit 1");
    expect(guards(post.sql).map((g) => g.message).sort()).toEqual(["A later stock count is already in the books", "An earlier stock count has to be posted first", "This stock count is not final, so it cannot be posted"]);
    expect(post.sql).toContain("where exists (select 1 from in_books as ib where ib.counted_on > sc.counted_on)");
  });

  it("the weekly reports say whether stock was counted, so purchases are never shown as if they were usage", () => {
    for (const key of ["prime_cost_by_week", "weekly_pnl", "cost_of_goods_by_week"]) {
      const q = query(key);
      expect(q.columns.find((c) => c.key === "stock_counted"), key).toMatchObject({ type: "boolean" });
      expect(q.sql, key).toContain("je.origin = 'stock_count'");
      expect(q.description, key).toMatch(/stock counted is false/);
    }
    expect(query("prime_cost_by_week").sql).toContain("bool_and(k.location_id is not null) as stock_counted");
  });

  it("cost of goods by week shows opening stock, purchases, closing stock and what was used", () => {
    const q = query("cost_of_goods_by_week");
    expect(q.columns.map((c) => c.key)).toEqual(expect.arrayContaining(["opening_value", "purchases", "closing_value", "usage", "stock_counted", "scope"]));
    expect(q.sql).toContain("sum(case when je.origin = 'stock_count' then 0 else jl.debit - jl.credit end) as purchases");
    expect(q.sql).toContain("sum(jl.debit - jl.credit) as used");
    expect(q.sql).toContain("where a.report_section = 'cost_of_goods'");
    expect(q.sql).toContain("where v.location_id = g.location_id and v.counted_on < g.start_date");
    expect(q.sql).toContain("where v.location_id = g.location_id and v.counted_on between g.start_date and g.end_date");
    expect(q.sql).toContain("filter (where i.cost_group in ('food', 'beverage', 'alcohol'))");
  });

  it("owner-facing labels say food and drink cost, and descriptions say it is what was used", () => {
    expect(query("prime_cost_by_week").columns.find((c) => c.key === "cost_of_goods")?.label).toBe("Food and drink cost");
    for (const key of ["prime_cost_by_week", "weekly_pnl", "cost_of_goods_by_week"]) expect(query(key).description, key).toMatch(/opening stock,? plus purchases,? minus closing stock/);
    for (const q of namedQueries) for (const c of q.columns) expect(c.label, `${q.key}.${c.key}`).not.toMatch(/cost of goods/i);
  });

  it("stock on hand is the latest final count of each location", () => {
    const q = query("stock_on_hand");
    expect(q.sql).toContain("select distinct on (c.location_id) c.id, c.location_id, c.counted_on");
    expect(q.sql).toContain("order by c.location_id, c.counted_on desc");
    expect(q.columns.map((c) => c.key)).toEqual(["location_id", "location_name", "counted_on", "food_value", "beverage_value", "alcohol_value", "supplies_value", "food_and_drink_value", "total_value"]);
  });
});

describe("the reports the accounts mini-app needs", () => {
  it("prime cost is (cost of goods sold + labour) / net sales, by fiscal week, per location and for all locations", () => {
    const q = query("prime_cost_by_week");
    expect(q.sql).toContain("round(100.0 * (s.cost_of_goods + s.labour) / nullif(s.net_sales, 0), 1) as prime_cost_pct");
    expect(q.sql).toContain("when a.report_section = 'sales' then jl.credit - jl.debit");
    expect(q.sql).toContain("when a.report_section = 'cost_of_goods' then jl.debit - jl.credit");
    expect(q.sql).toContain("when a.report_section = 'labour' then jl.debit - jl.credit");
    expect(q.sql).toContain("'location' as scope");
    expect(q.sql).toContain("'all_locations' as scope");
    expect(q.sql).toContain("group by wk.fiscal_year, wk.week_number, wk.start_date, wk.end_date, je.location_id");
    expect(q.reads).toEqual(expect.arrayContaining(["journal_line", "journal_entry", "account", "fiscal_week"]));
  });
  it("the report's arithmetic gives the demo numbers for Marigold Kitchen, week of 2026-11-09", () => {
    // Whole cents in, the same rounding the SQL does (one decimal place) out.
    const pct = (part: number, whole: number) => Math.round((1000 * part) / whole) / 10;
    const [netSales, costOfGoods, labour] = [8431000, 2546000, 2622000];
    expect(pct(costOfGoods, netSales)).toBe(30.2);
    expect(pct(labour, netSales)).toBe(31.1);
    expect(pct(costOfGoods + labour, netSales)).toBe(61.3);
    expect(5187000 + 3244000).toBe(netSales);
    expect([814000, 896000, 987000, 1142000, 1583000, 1795000, 1214000].reduce((a, b) => a + b, 0)).toBe(netSales);
  });

  it("the sections of the report are the sections an account can have", () => {
    const sections = field(model("account"), "report_section");
    const values = sections?.type === "enum" ? sections.values : [];
    const used = [...query("weekly_pnl").sql.matchAll(/when '([a-z_]+)' then \d+/g)].map((m) => m[1] as string).filter((s) => !["gross_profit", "prime_cost", "net_profit", "account"].includes(s));
    expect(used.sort()).toEqual(values.filter((v) => v !== "balance_sheet").sort());
    for (const s of ["sales", "cost_of_goods", "labour"]) expect(values).toContain(s);
  });

  it("the daily summary shows whether the day adds up", () => {
    const sql = query("daily_sales_summary").sql;
    expect(sql).toContain("d.net_sales + d.sales_tax + d.tips + d.service_charges + coalesce(gc.sold, 0) as bigint) as to_account_for");
    expect(sql).toContain("coalesce(p.payments, 0) + coalesce(gc.redeemed, 0) as bigint) as collected");
  });
});

import { describe, expect, it } from "vitest";
import type { Expr, FieldDef, ModelDefinition, ModelRule } from "@rms/contracts";
import { DEFAULT_CHART_OF_ACCOUNTS, DEFAULT_POSTING_RULES, models, namedActions, namedQueries } from "./index.js";

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
  account: r.accountCode,
  active: true,
});

/** Which kind of model each one is, for rule 2. A new model must be put in one of the three. */
const REFERENCE_LISTS = ["unit", "tax_rate", "fiscal_calendar", "fiscal_period", "fiscal_week", "day_part", "revenue_centre", "sales_category", "payment_type", "reason_code", "account", "posting_rule", "budget", "vendor"];
const DATED_ROWS = ["sales_day", "delivery_payout", "cash_count", "paid_in_out", "deposit", "journal_entry", "vendor_bill", "labour_day"];
const DETAIL_ROWS: Record<string, string> = {
  sales_category_day: "sales_day",
  payment_day: "sales_day",
  adjustment_day: "sales_day",
  gift_card_activity: "sales_day",
  delivery_payout_line: "delivery_payout",
  journal_line: "journal_entry",
  vendor_bill_line: "vendor_bill",
};

describe("rule 1: money is whole minor units with a currency, quantities carry a unit", () => {
  const moneyWords = /(amount|sales|discounts|comps|voids|tips|charges|cost|debit|credit|balance|over_short|sales_tax|total)/;
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
      const f = field(model(key), "business_date");
      expect(f?.type, key).toBe("business_date");
      expect(f?.required, key).toBe(true);
    }
  });

  it("a detail row must point at its dated row, and does not keep a second date that could disagree", () => {
    for (const [key, header] of Object.entries(DETAIL_ROWS)) {
      const m = model(key);
      const refs = m.fields.filter((f) => f.type === "ref" && f.model === header);
      expect(refs.length, key).toBe(1);
      expect(refs[0]?.required, key).toBe(true);
      expect(field(m, "business_date"), key).toBeUndefined();
    }
  });

  it("no model stores a week or a period number beside its date", () => {
    for (const key of [...DATED_ROWS, ...Object.keys(DETAIL_ROWS)]) for (const f of model(key).fields) expect(f.key, `${key}.${f.key}`).not.toMatch(/week|fiscal|period_number/);
  });

  it("the weekly reports take their weeks from fiscal_week, never from date arithmetic", () => {
    for (const key of ["prime_cost_by_week", "weekly_pnl", "sales_by_day"]) {
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
    for (const key of ["post_sales_day", "post_vendor_bill", "post_labour_day"]) {
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
    const catchAll = (part: string) => DEFAULT_POSTING_RULES.filter((r) => r.part === part && !r.salesGroup && !r.paymentKind && !r.jobGroup).length;
    expect(catchAll("net_sales")).toBe(1);
    expect(catchAll("payment")).toBe(1);
    expect(DEFAULT_POSTING_RULES.filter((r) => r.part === "labour_cost").map((r) => r.jobGroup).sort()).toEqual(["back_of_house", "front_of_house", "management"]);
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
    for (const [key, origin] of [["post_sales_day", "sales_day"], ["post_vendor_bill", "vendor_bill"], ["post_labour_day", "labour_day"]] as const) {
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

describe("the reports the accounts mini-app needs", () => {
  it("prime cost is (cost of goods sold + labour) / net sales, by fiscal week, per location and for all locations", () => {
    const q = query("prime_cost_by_week");
    expect(q.sql).toContain("round(100.0 * (s.cost_of_goods + s.labour) / nullif(s.net_sales, 0), 1) as prime_cost_pct");
    expect(q.sql).toContain("when a.report_section = 'sales' then jl.credit - jl.debit");
    expect(q.sql).toContain("when a.report_section = 'cost_of_goods' then jl.debit - jl.credit");
    expect(q.sql).toContain("when a.report_section = 'labour' then jl.debit - jl.credit");
    expect(q.sql).toContain("'location' as scope");
    expect(q.sql).toContain("'all_locations' as scope");
    expect(q.sql).toContain("group by fw.fiscal_year, fw.week_number, fw.start_date, fw.end_date, je.location_id");
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

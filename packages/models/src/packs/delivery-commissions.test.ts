import { describe, expect, it } from "vitest";
import { DEFAULT_CHART_OF_ACCOUNTS, DEFAULT_POSTING_RULES, models, namedActions, namedQueries } from "./index.js";
import { PAYOUT_TAKES } from "./sales.js";

/**
 * What delivery apps keep (commission and fees) is a running cost in the books (ADR 0011).
 * It is recorded as a statement from the delivery company, posted like any vendor bill to one
 * account. These checks need no database: they pin where that account sits and what the reports
 * do with it. The numbers themselves are checked in packages/seed/src/delivery.test.ts.
 */

const query = (key: string) => {
  const q = namedQueries.find((x) => x.key === key);
  if (!q) throw new Error(`No query "${key}"`);
  return q;
};
const action = (key: string) => {
  const a = namedActions.find((x) => x.key === key);
  if (!a) throw new Error(`No action "${key}"`);
  return a;
};
const model = (key: string) => {
  const m = models.find((x) => x.key === key);
  if (!m) throw new Error(`No model "${key}"`);
  return m;
};

const DELIVERY_ACCOUNTS = DEFAULT_CHART_OF_ACCOUNTS.filter((a) => /delivery/i.test(a.name) && a.type === "expense");

describe("delivery commissions: one account, below prime cost", () => {
  it("the chart has exactly one expense account for what delivery apps keep, so setting it up again cannot make a second", () => {
    expect(DELIVERY_ACCOUNTS).toEqual([{ code: "7500", name: "Delivery platform commissions and fees", type: "expense", reportSection: "controllable" }]);
    expect(DEFAULT_CHART_OF_ACCOUNTS.filter((a) => a.code === "7500")).toHaveLength(1);
  });

  it("the seed action carries it, keyed by its account number, and leaves an account that exists alone", () => {
    const seed = action("seed_chart_of_accounts");
    expect(seed.sql).toContain("('7500', 'Delivery platform commissions and fees', 'expense', 'controllable')");
    expect(seed.sql).toContain("'chart/' || c.code");
    expect(seed.sql).toContain("on conflict do nothing");
    expect(seed.idempotent).toBe(true);
  });

  it("it is a running cost: not food and drink cost, not staff cost, so it can never be part of prime cost", () => {
    const [account] = DELIVERY_ACCOUNTS;
    expect(["cost_of_goods", "labour"]).not.toContain(account?.reportSection);
    // No posting rule sends sales, stock or staff cost there by default.
    expect(DEFAULT_POSTING_RULES.filter((r) => r.accountCode === "7500")).toEqual([]);
  });

  it("prime cost by week reads only sales, food and drink cost and staff cost", () => {
    const sql = query("prime_cost_by_week").sql;
    expect(sql).toContain("where a.report_section in ('sales', 'cost_of_goods', 'labour')");
    expect(sql).not.toContain("controllable");
    expect(sql).toContain("cast(s.cost_of_goods + s.labour as bigint) as prime_cost");
  });
});

describe("delivery commissions: recorded as a statement from the delivery company, posted like a bill", () => {
  it("a bill line can be coded to any expense account, so no new model or action is needed", () => {
    const rule = model("vendor_bill_line").rules.find((r) => r.name === "vendor_bill_line_cost_account");
    expect(rule).toMatchObject({ kind: "ref_value_in", field: "account", refField: "type" });
    expect(rule && "allowed" in rule ? rule.allowed : []).toContain("expense");
  });

  it("posting a bill debits each line's own account and credits what is owed, in one balanced entry, once", () => {
    const post = action("post_vendor_bill");
    expect(post.sql).toContain("l.account as account, l.amount as signed");
    expect(post.sql).toContain("-vb.total_amount");
    expect(post.sql).toContain("'vendor_bill/' || cast(src.id as text)");
    expect(post.sql).toContain("on conflict do nothing");
    expect(post.writes).toEqual(["journal_entry", "journal_line"]);
    expect(post.description).toContain("delivery app");
  });

  it("the entry it makes is held to the ledger rules: balanced, and only in an open period", () => {
    const kinds = model("journal_entry").rules.map((r) => r.kind);
    expect(kinds).toContain("balanced");
    expect(kinds).toContain("open_period_only");
  });
});

describe("delivery commissions: on the reports", () => {
  it("the weekly profit and loss takes every expense off net profit, and lists each account with activity", () => {
    const pnl = query("weekly_pnl");
    expect(pnl.sql).toContain("where a.type in ('revenue', 'expense')");
    expect(pnl.sql).toContain("filter (where x.section not in ('sales', 'other_income')), 0) as expenses");
    expect(pnl.sql).toContain("select 'summary', 'net_profit', cast(null as text), cast(null as text), t.income - t.expenses");
    expect(pnl.sql).toContain("select 'account' as line_kind, x.section as section, x.account_code as account_code, x.account_name as account_name, x.amount as amount");
    expect(pnl.description).toContain("delivery apps keep");
    expect(pnl.description).toContain("net profit after every cost");
  });

  it("the running costs come after prime cost on the report, and net profit comes last", () => {
    const order = Object.fromEntries([...query("weekly_pnl").sql.matchAll(/when '([a-z_]+)' then (\d+)/g)].map((m) => [m[1] as string, Number(m[2])]));
    expect(order.controllable).toBeGreaterThan(order.prime_cost as number);
    expect(query("weekly_pnl").sql).toContain("else 100");
    for (const section of Object.keys(order)) expect(order[section]).toBeLessThan(100);
  });

  it("the payout check adds up everything the delivery app kept, the same kinds a statement can take", () => {
    const q = query("delivery_payout_reconciliation");
    expect(PAYOUT_TAKES).toEqual(["commission", "marketing_fee", "service_fee", "error_charge", "refund"]);
    expect(q.sql).toContain(`sum(case when l.kind in (${PAYOUT_TAKES.map((k) => `'${k}'`).join(", ")}) then l.amount else 0 end) as kept_by_platform`);
    expect(q.sql).toContain("cast(coalesce(s.kept_by_platform, 0) as bigint) as kept_by_platform");
    const column = q.columns.find((c) => c.key === "kept_by_platform");
    expect(column).toMatchObject({ type: "money", sensitivity: "financial" });
    expect(column?.label).toBe("Kept by the delivery app (commission, fees, refunds)");
  });
});

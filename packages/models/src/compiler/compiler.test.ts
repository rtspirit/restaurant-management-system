// No database here. These tests prove that nothing from a definition reaches SQL as free text:
// hostile definitions are either refused or come out as inert, quoted text.
import { describe, expect, it } from "vitest";
import type { Expr, ModelChange, ModelDefinition } from "@rms/contracts";
import { buildLibrary } from "../library.js";
import { fixtureModel, fixtureModels, fixturePack } from "./__fixtures__/pack.js";
import {
  CompileError,
  FISCAL_PERIOD,
  checkQuery,
  checkStatement,
  compileChange,
  compileDiscard,
  compileDrop,
  compileExpr,
  compileModel,
  modelDependencies,
  objectName,
  quoteIdent,
  quoteLiteral,
  ruleConstraintName,
  targetsFor,
} from "./index.js";

const T = targetsFor("o_c1c1c1c1c101");
const ctx = { models: fixtureModels };

/** Things an attacker would try to get into SQL. */
const HOSTILE = [
  `x'; drop schema platform cascade; --`,
  `x"; drop schema platform cascade; --`,
  `$rms$; drop schema platform cascade; $rms$`,
  `\\'; drop schema platform cascade; --`,
  `a/* */b`,
  `a -- b`,
  `a;b`,
  `E'\\x27; select 1`,
  `$$ ; select pg_sleep(10) ; $$`,
  `o_c1c1c1c1c102.vendor`,
];

// ---------------------------------------------------------------- a tiny SQL reader for the tests

type Tok = { kind: "ident" | "string" | "body" | "text"; value: string };

/** Splits compiled SQL into quoted names, quoted values (decoded), function bodies and everything else. */
const lex = (sql: string): Tok[] => {
  const out: Tok[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ kind: "text", value: text });
    text = "";
  };
  let i = 0;
  while (i < sql.length) {
    if (sql.startsWith("$rms$", i)) {
      const end = sql.indexOf("$rms$", i + 5);
      if (end < 0) throw new Error("function body is not closed");
      flush();
      out.push({ kind: "body", value: sql.slice(i + 5, end) });
      i = end + 5;
    } else if (sql[i] === '"') {
      const end = sql.indexOf('"', i + 1);
      if (end < 0 || sql[end + 1] === '"') throw new Error("odd quoted name");
      flush();
      out.push({ kind: "ident", value: sql.slice(i + 1, end) });
      i = end + 1;
    } else if (sql[i] === "'" || (sql[i] === "E" && sql[i + 1] === "'" && !/[A-Za-z0-9_]/.test(sql[i - 1] ?? " "))) {
      const escapes = sql[i] === "E";
      let j = i + (escapes ? 2 : 1);
      let value = "";
      for (;;) {
        const ch = sql[j];
        if (ch === undefined) throw new Error("string is not closed");
        if (escapes && ch === "\\") {
          if (sql[j + 1] === "\\") { value += "\\"; j += 2; }
          else if (sql.startsWith("x24", j + 1)) { value += "$"; j += 4; }
          else throw new Error("unexpected escape");
        } else if (ch === "'") {
          if (sql[j + 1] === "'") { value += "'"; j += 2; }
          else { j += 1; break; }
        } else { value += ch; j += 1; }
      }
      flush();
      out.push({ kind: "string", value });
      i = j;
    } else {
      text += sql[i];
      i += 1;
    }
  }
  flush();
  return out;
};

/** Fails when anything outside a quoted name or quoted value could start a new statement or a comment. */
const expectInert = (statement: string): Tok[] => {
  const toks = lex(statement);
  for (const t of toks) {
    if (t.kind === "ident") expect(t.value).toMatch(/^[a-z][a-z0-9_]{0,62}$/);
    if (t.kind === "text") expect(t.value).not.toMatch(/;|--|\/\*|\$|\\|'|"/);
    if (t.kind === "body") {
      for (const b of lex(t.value)) {
        if (b.kind === "ident") expect(b.value).toMatch(/^[a-z][a-z0-9_]{0,62}$/);
        if (b.kind === "body") throw new Error("nested body");
        if (b.kind === "text") expect(b.value).not.toMatch(/--|\/\*|\$|\\|'|"/);
      }
    }
  }
  return toks;
};

const strings = (statements: string[]): string[] =>
  statements.flatMap((s) => lex(s).flatMap((t) => (t.kind === "string" ? [t.value] : t.kind === "body" ? lex(t.value).flatMap((b) => (b.kind === "string" ? [b.value] : [])) : [])));

const custom = (over: Record<string, unknown>): ModelDefinition =>
  ({
    key: "x_note",
    version: 1,
    pack: "custom",
    name: "Note",
    description: "A note someone wrote down for the team.",
    fields: [{ key: "body", label: "Body", type: "text" }],
    defaultAccess: { owner: "write", staff: "read" },
    ...over,
  }) as unknown as ModelDefinition;

/** A library model (not custom) to hang ledger rules on. */
const lib = (over: Record<string, unknown>): ModelDefinition => custom({ key: "note", pack: "finance", appendOnly: true, ...over });

// ---------------------------------------------------------------- the quoting functions

describe("quoteIdent", () => {
  it("quotes a plain name", () => {
    expect(quoteIdent("sales_day")).toBe('"sales_day"');
    expect(quoteIdent(`a${"b".repeat(62)}`)).toHaveLength(65);
  });

  it("refuses everything else", () => {
    const bad: unknown[] = ["", "A", "1a", "_a", "a b", "a-b", "a.b", 'a"b', "a'b", "a;b", "a--", "a\n", "a\u0000", "é", `a${"b".repeat(63)}`, null, undefined, 5, {}, ["a"], ...HOSTILE];
    for (const name of bad) expect(() => quoteIdent(name)).toThrow(CompileError);
  });
});

describe("quoteLiteral", () => {
  it("writes values that read back exactly", () => {
    expect(quoteLiteral(null)).toBe("null");
    expect(quoteLiteral(true)).toBe("true");
    expect(quoteLiteral(42)).toBe("42");
    expect(quoteLiteral(-1.5)).toBe("(-1.5)");
    expect(quoteLiteral("it's")).toBe("E'it''s'");
    expect(quoteLiteral("a\\b")).toBe("E'a\\\\b'");
    expect(quoteLiteral("$rms$")).not.toContain("$");
    for (const h of HOSTILE) {
      const toks = lex(quoteLiteral(h));
      expect(toks).toEqual([{ kind: "string", value: h }]);
    }
  });

  it("refuses values the database cannot take as they are", () => {
    for (const v of [Number.NaN, Number.POSITIVE_INFINITY, 1e21, 1e-7, "a\u0000b", "\ud800", "x".repeat(1001), undefined, {}, [], 10n, () => 1]) {
      expect(() => quoteLiteral(v)).toThrow(CompileError);
    }
  });
});

describe("objectName", () => {
  it("is stable, short and different for different parts", () => {
    const long = "a".repeat(48);
    const name = objectName("idx", long, long, long);
    expect(name).toMatch(/^[a-z][a-z0-9_]{0,62}$/);
    expect(name).toBe(objectName("idx", long, long, long));
    expect(objectName("key", "t", "a", "b_c")).not.toBe(objectName("key", "t", "a_b", "c"));
    expect(objectName("key", "t", "a")).not.toBe(objectName("idx", "t", "a"));
    expect(() => objectName("idx", "t", "a;b")).toThrow(CompileError);
    expect(() => objectName("idx; drop", "t")).toThrow(CompileError);
  });
});

describe("compileExpr", () => {
  const resolve = (f: string) => {
    if (f !== "amount" && f !== "status") throw new CompileError("unknown field");
    return quoteIdent(f);
  };

  it("walks the tree", () => {
    const e: Expr = {
      op: "and",
      args: [
        { op: "gte", args: [{ op: "add", args: [{ field: "amount" }, { lit: 1 }] }, { lit: 0 }] },
        { op: "or", args: [{ op: "in", arg: { field: "status" }, values: ["open", "it's"] }, { op: "not", arg: { op: "is_null", arg: { field: "status" } } }] },
      ],
    };
    expect(compileExpr(e, resolve)).toBe(`((("amount" + 1) >= 0) and (("status" in (E'open', E'it''s')) or (not ("status" is null))))`);
  });

  it("refuses shapes that are not in the contract", () => {
    const bad: unknown[] = [
      { field: "nope" },
      { field: 'amount"; drop table x; --' },
      { op: "eq", args: [{ field: "amount" }] },
      { op: "eq", args: [{ field: "amount" }, { lit: 1 }, { lit: 2 }] },
      { op: "concat", args: [{ lit: "a" }, { lit: "b" }] },
      { op: "constructor", args: [{ lit: 1 }, { lit: 2 }] },
      { op: "eq", args: [{ field: "amount" }, { lit: 1 }], sql: "1; drop schema platform" },
      { fn: "pg_sleep", args: [{ lit: 10 }] },
      { sql: "select 1" },
      { lit: { toString: () => "1; drop" } },
      { lit: [1] },
      { op: "in", arg: { field: "status" }, values: [] },
      { op: "in", arg: { field: "status" }, values: [{ lit: 1 }] },
      { op: "and", args: [{ lit: true }] },
      "amount > 0",
      null,
      [],
    ];
    for (const e of bad) expect(() => compileExpr(e as Expr, resolve)).toThrow(CompileError);
  });

  it("refuses a tree that is too deep", () => {
    let e: unknown = { lit: true };
    for (let i = 0; i < 40; i++) e = { op: "not", arg: e };
    expect(() => compileExpr(e as Expr, resolve)).toThrow(CompileError);
  });

  it("keeps hostile values inside one quoted value", () => {
    for (const h of HOSTILE) {
      const sql = compileExpr({ op: "or", args: [{ op: "ne", args: [{ field: "status" }, { lit: h }] }, { op: "in", arg: { field: "status" }, values: [h, 3] }] }, resolve);
      const toks = expectInert(sql);
      expect(toks.filter((t) => t.kind === "string").map((t) => t.value)).toEqual([h, h]);
    }
  });
});

// ---------------------------------------------------------------- whole models

describe("compileModel on the fixture pack", () => {
  it("emits only inert statements with short plain names, for both schemas", () => {
    for (const target of [T.live, T.draft]) {
      for (const m of fixtureModels) {
        const c = compileModel(m, target, ctx);
        expect(c.statements.length).toBeGreaterThan(5);
        for (const s of c.statements) {
          const toks = expectInert(s);
          // Every table, function and trigger sits in this restaurant's schema, or is one of our helpers.
          const schemas = toks.flatMap((t, i) => (t.kind === "ident" && toks[i + 1]?.value === "." ? [t.value] : []));
          for (const schema of schemas) expect([target.schema, "rms"]).toContain(schema);
        }
      }
    }
  });

  it("never emits labels, descriptions or messages", () => {
    const all = fixtureModels.flatMap((m) => compileModel(m, T.live, ctx).statements).join("\n");
    for (const m of fixtureModels) {
      expect(all).not.toContain(m.description);
      for (const r of m.rules) if ("message" in r) expect(all).not.toContain(r.message);
    }
  });

  it("grants exactly what the provisioning contract says", () => {
    const grants = (key: string, target: typeof T.live) => compileModel(fixtureModel(key), target, ctx).create.filter((s) => /^(grant|revoke) /.test(s));
    expect(grants("vendor", T.live)).toEqual([
      'revoke all on table "o_c1c1c1c1c101"."vendor" from public',
      'grant select, insert, update, delete on table "o_c1c1c1c1c101"."vendor" to "o_c1c1c1c1c101_rw"',
      'grant select on table "o_c1c1c1c1c101"."vendor" to "o_c1c1c1c1c101_ask"',
    ]);
    expect(grants("vendor", T.draft)).toEqual([
      'revoke all on table "o_c1c1c1c1c101_draft"."vendor" from public',
      'grant select, insert, update, delete on table "o_c1c1c1c1c101_draft"."vendor" to "o_c1c1c1c1c101_draft_rw"',
    ]);
    expect(grants("journal_line", T.live)).toEqual([
      'revoke all on table "o_c1c1c1c1c101"."journal_line" from public',
      'grant select, insert on table "o_c1c1c1c1c101"."journal_line" to "o_c1c1c1c1c101_rw"',
      'grant select on table "o_c1c1c1c1c101"."journal_line" to "o_c1c1c1c1c101_ask"',
    ]);
    expect(grants("journal_line", T.draft)).toEqual([
      'revoke all on table "o_c1c1c1c1c101_draft"."journal_line" from public',
      'grant select, insert on table "o_c1c1c1c1c101_draft"."journal_line" to "o_c1c1c1c1c101_draft_rw"',
    ]);
    const all = [T.live, T.draft].flatMap((t) => fixtureModels.flatMap((m) => compileModel(m, t, ctx).statements));
    for (const s of all) {
      expect(s).not.toMatch(/\bto public\b/i);
      expect(s).not.toMatch(/rms_tenant\b/);
      expect(s).not.toMatch(/\b(truncate|references|trigger)\b.*\bto "/);
    }
  });

  it("fences location-scoped models by location and the rest to the restaurant's own roles", () => {
    const policy = (key: string, target: typeof T.live) => compileModel(fixtureModel(key), target, ctx).create.find((s) => s.startsWith("create policy")) ?? "";
    expect(policy("sales_day", T.live)).toMatch(/for all to "o_c1c1c1c1c101_rw", "o_c1c1c1c1c101_ask" using \("rms"\."location_ok"\("location_id"\)\) with check \("rms"\."location_ok"\("location_id"\)\)$/);
    expect(policy("sales_day", T.draft)).toMatch(/for all to "o_c1c1c1c1c101_draft_rw" using \("rms"\."location_ok"\("location_id"\)\) with check/);
    expect(policy("vendor", T.live)).toMatch(/for all to "o_c1c1c1c1c101_rw", "o_c1c1c1c1c101_ask" using \(true\) with check \(true\)$/);
    for (const m of fixtureModels) expect(compileModel(m, T.live, ctx).create.some((s) => s.endsWith("enable row level security"))).toBe(true);
  });

  it("gives every trigger function an empty search path, no public right to call it, and definer rights only where rows can be hidden", () => {
    const fns = fixtureModels.flatMap((m) => compileModel(m, T.live, ctx).link.filter((s) => s.startsWith("create function")));
    expect(fns.length).toBe(7);
    for (const f of fns) expect(f).toContain("language plpgsql");
    for (const f of fns) expect(f).toMatch(/ set search_path = '' as \$rms\$/);
    const definer = fns.filter((f) => f.includes("security definer")).map((f) => /"\."([a-z0-9_]+)"\(\)/.exec(f)?.[1]);
    // The ledger balance check (journal lines are location-scoped) and the target side of paid_out's
    // rule (paid_out rows are location-scoped). posting_rule is for all locations, so both of its
    // functions run as the caller. So does every open-period check and every forward link check.
    expect(definer.sort()).toEqual([objectName("fn", "journal_entry", "entry_balances"), objectName("fnh", "journal_entry", "entry_balances"), objectName("fnr", "paid_out", "paid_from_an_expense")].sort());
    const all = fixtureModels.flatMap((m) => compileModel(m, T.live, ctx).link);
    const revoked = all.filter((s) => s.startsWith("revoke all on function"));
    expect(revoked.length).toBe(fns.length);
  });

  it("checks the ledger at commit: on the line table, and on the header for an entry with no lines", () => {
    const link = compileModel(fixtureModel("journal_entry"), T.live, ctx).link;
    expect(link.some((s) => /^create constraint trigger "[a-z0-9_]+" after insert or update or delete on "o_c1c1c1c1c101"\."journal_line" deferrable initially deferred for each row/.test(s))).toBe(true);
    expect(link.some((s) => /^create constraint trigger "[a-z0-9_]+" after insert on "o_c1c1c1c1c101"\."journal_entry" deferrable initially deferred for each row/.test(s))).toBe(true);
    const lineFn = link.find((s) => s.startsWith("create function") && s.includes("v_made_in")) ?? "";
    // Lines only in the transaction that wrote the header, and the header's period rule again for each line.
    expect(lineFn).toContain("pg_catalog.pg_xact_status(v_made_in::text::xid8) is distinct from 'in progress'");
    expect(lineFn).toContain(`p."status" = E'closed'`);
  });

  it("makes a unique rule ignore deleted rows on a soft-delete model, and keeps the source index plain", () => {
    const account = compileModel(fixtureModel("account"), T.live, ctx);
    expect(account.create[0]).not.toContain(" unique (");
    expect(account.create.some((s) => /^create unique index "[a-z0-9_]+" on "o_c1c1c1c1c101"\."account" \("code"\) where "deleted_at" is null$/.test(s))).toBe(true);
    expect(account.create.some((s) => /^create unique index "[a-z0-9_]+" on "o_c1c1c1c1c101"\."account" \("source", "source_id"\) where "source_id" is not null$/.test(s))).toBe(true);
    // An append-only model has no deleted rows, so its rule stays a plain constraint.
    const entry = compileModel(fixtureModel("journal_entry"), T.live, ctx);
    expect(entry.create[0]).toMatch(/constraint "[a-z0-9_]+" unique \("reverses"\)/);
    expect(entry.create.filter((s) => s.startsWith("create unique index"))).toHaveLength(1);
  });

  it("adds no foreign key for a parent link, and adds a self-reference after the table exists", () => {
    const prep = compileModel(fixtureModel("prep_item"), T.live, ctx);
    expect(prep.link.filter((s) => s.includes("foreign key"))).toHaveLength(1);
    expect(prep.link[0]).toContain('foreign key ("vendor") references "o_c1c1c1c1c101"."vendor" ("id") on delete set null');
    expect(prep.create[0]).toContain('"menu_item" uuid,');
    expect(prep.create[0]).toContain('"menu_item_label" text,');
    expect(prep.create.join("\n")).not.toContain("references");

    const entry = compileModel(fixtureModel("journal_entry"), T.live, ctx);
    expect(entry.create.join("\n")).not.toContain("references");
    expect(entry.link[0]).toContain('foreign key ("reverses") references "o_c1c1c1c1c101"."journal_entry" ("id") on delete restrict');
    expect(modelDependencies(fixtureModel("journal_entry")).sort()).toEqual([FISCAL_PERIOD.model, "journal_line"]);
  });

  it("is the same every time", () => {
    for (const m of fixtureModels) expect(compileModel(m, T.live, ctx).statements).toEqual(compileModel(m, T.live, ctx).statements);
  });
});

// ---------------------------------------------------------------- hostile definitions

describe("hostile definitions", () => {
  const refused = (def: ModelDefinition, models: ModelDefinition[] = fixtureModels) => expect(() => compileModel(def, T.live, { models })).toThrow(CompileError);

  it("refuses a hostile name in every place a name can go", () => {
    for (const h of [...HOSTILE, "Note", "a".repeat(49), ""]) {
      refused(custom({ key: h }));
      refused(custom({ fields: [{ key: h, label: "x", type: "text" }] }));
      refused(custom({ fields: [{ key: "kind", label: "x", type: "enum", values: ["ok", h] }] }));
      refused(custom({ fields: [{ key: "vendor", label: "x", type: "ref", model: h }] }));
      refused(custom({ fields: [{ key: "job", label: "x", type: "parent_ref", parentModel: h }] }));
      refused(custom({ fields: [{ key: "body", label: "x", type: "text" }], unique: [[h]] }));
      refused(custom({ fields: [{ key: "body", label: "x", type: "text" }], indexes: [["body", h]] }));
      refused(custom({ labelField: h }));
      refused(custom({ rules: [{ kind: "check", name: h, expr: { lit: true }, message: "m" }] }));
      refused(custom({ rules: [{ kind: "check", name: "ok", expr: { field: h }, message: "m" }] }));
      refused(lib({ rules: [{ kind: "balanced", name: "b", lineModel: h, lineRef: "entry", debit: "debit", credit: "credit" }] }));
      refused(lib({ rules: [{ kind: "balanced", name: "b", lineModel: "journal_line", lineRef: h, debit: "debit", credit: "credit" }] }));
      refused(lib({ rules: [{ kind: "balanced", name: "b", lineModel: "journal_line", lineRef: "entry", debit: h, credit: "credit" }] }));
      refused(lib({ fields: [{ key: "day", label: "x", type: "date" }], rules: [{ kind: "open_period_only", name: "o", dateField: h }] }));
      refused(lib({ fields: [{ key: "account", label: "x", type: "ref", model: "account" }], rules: [{ kind: "ref_value_in", name: "r", field: "account", refField: h, allowed: ["liability"], message: "m" }] }));
      refused(lib({ fields: [{ key: "account", label: "x", type: "ref", model: "account" }], rules: [{ kind: "ref_value_in", name: "r", field: "account", refField: "type", allowed: [h], message: "m" }] }));
    }
  });

  it("refuses hostile values where a number or a fixed word is expected", () => {
    refused(custom({ fields: [{ key: "amount", label: "x", type: "decimal", scale: "2); drop schema platform cascade; --" }] }));
    refused(custom({ fields: [{ key: "amount", label: "x", type: "decimal", scale: 99 }] }));
    refused(custom({ fields: [{ key: "body", label: "x", type: "text", maxLength: "5) or true; --" }] }));
    refused(custom({ fields: [{ key: "body", label: "x", type: "text); drop table x; --" }] }));
    refused(custom({ fields: [{ key: "vendor", label: "x", type: "ref", model: "vendor", onDelete: "cascade; drop schema platform" }] }));
    refused(custom({ fields: [{ key: "body", label: "x", type: "text", sql: "drop" }] }));
    refused(custom({ sql: "drop schema platform cascade" }));
    refused(custom({ appendOnly: "false; --" }));
    refused(custom({ rules: [{ kind: "raw_sql", name: "r", sql: "drop schema platform cascade" }] }));
  });

  it("refuses rules that name fields or models that are not there", () => {
    refused(custom({ rules: [{ kind: "check", name: "c", expr: { op: "gt", args: [{ field: "missing" }, { lit: 0 }] }, message: "m" }] }));
    // location_id is a system column, but this model is not location-scoped.
    refused(custom({ locationScoped: false, rules: [{ kind: "check", name: "c", expr: { op: "is_null", arg: { field: "location_id" } }, message: "m" }] }));
    refused(custom({ locationScoped: false, unique: [["location_id"]] }));
    refused(custom({ fields: [{ key: "vendor", label: "x", type: "ref", model: "no_such_model" }] }));
    refused(custom({ fields: [{ key: "vendor", label: "x", type: "ref", model: "vendor" }] }), []);
    refused(custom({ fields: [{ key: "vendor", label: "x", type: "ref", model: "vendor", required: true, onDelete: "set_null" }] }));
    refused(custom({ fields: [{ key: "job", label: "x", type: "parent_ref", parentModel: "jobs" }, { key: "job_label", label: "y", type: "text" }] }));
    refused(custom({ rules: [{ kind: "check", name: "same", expr: { lit: true }, message: "m" }, { kind: "check", name: "same", expr: { lit: true }, message: "m" }] }));

    const finance = lib;
    // These two are fine, so the refusals below are for the reason each one names.
    const entryFields = [{ key: "day", label: "x", type: "date", required: true }];
    expect(() => compileModel(finance({ key: "journal_entry", fields: entryFields, rules: [{ kind: "balanced", name: "b", lineModel: "journal_line", lineRef: "entry", debit: "debit", credit: "credit" }] }), T.live, ctx)).not.toThrow();
    expect(() => compileModel(finance({ fields: entryFields, rules: [{ kind: "open_period_only", name: "o", dateField: "day" }] }), T.live, ctx)).not.toThrow();
    // A ledger must be append-only on both sides.
    refused(finance({ key: "journal_entry", appendOnly: false, rules: [{ kind: "balanced", name: "b", lineModel: "journal_line", lineRef: "entry", debit: "debit", credit: "credit" }] }));
    refused(finance({ key: "journal_entry", rules: [{ kind: "balanced", name: "b", lineModel: "journal_line", lineRef: "entry", debit: "debit", credit: "credit" }] }), fixtureModels.map((m) => (m.key === "journal_line" ? { ...m, appendOnly: false } : m)));
    // balanced: the line model must point back at this model with a required link and two money fields.
    refused(finance({ rules: [{ kind: "balanced", name: "b", lineModel: "journal_line", lineRef: "entry", debit: "debit", credit: "credit" }] }));
    refused(finance({ key: "journal_entry", rules: [{ kind: "balanced", name: "b", lineModel: "journal_line", lineRef: "account", debit: "debit", credit: "credit" }] }));
    refused(finance({ key: "journal_entry", rules: [{ kind: "balanced", name: "b", lineModel: "journal_line", lineRef: "entry", debit: "debit", credit: "debit" }] }));
    refused(finance({ key: "journal_entry", rules: [{ kind: "balanced", name: "b", lineModel: "journal_line", lineRef: "entry", debit: "entry", credit: "credit" }] }));
    refused(finance({ key: "journal_entry", rules: [{ kind: "balanced", name: "b", lineModel: "vendor", lineRef: "name", debit: "name", credit: "name" }] }));
    // open_period_only: the date field must be a date, and the fiscal period model must be known and well formed.
    refused(finance({ rules: [{ kind: "open_period_only", name: "o", dateField: "body" }] }));
    refused(finance({ fields: [{ key: "day", label: "x", type: "date" }], rules: [{ kind: "open_period_only", name: "o", dateField: "day" }] }), []);
    refused(finance({ fields: [{ key: "day", label: "x", type: "date" }], rules: [{ kind: "open_period_only", name: "o", dateField: "day" }] }), [
      { ...fixtureModel("fiscal_period"), fields: fixtureModel("fiscal_period").fields.filter((f) => f.key !== "status") },
    ]);
    refused(finance({ locationScoped: false, fields: [{ key: "day", label: "x", type: "date" }], rules: [{ kind: "open_period_only", name: "o", dateField: "day" }] }), [
      { ...fixtureModel("fiscal_period"), locationScoped: true },
    ]);
    // ref_value_in: the field must be a link, the other field must exist, the values must be real.
    const account = { key: "account", label: "x", type: "ref", model: "account" };
    refused(finance({ fields: [account], rules: [{ kind: "ref_value_in", name: "r", field: "body", refField: "type", allowed: ["liability"], message: "m" }] }));
    refused(finance({ fields: [account], rules: [{ kind: "ref_value_in", name: "r", field: "account", refField: "missing", allowed: ["liability"], message: "m" }] }));
    refused(finance({ fields: [account], rules: [{ kind: "ref_value_in", name: "r", field: "account", refField: "type", allowed: ["not_a_type"], message: "m" }] }));
    refused(finance({ fields: [account], rules: [{ kind: "ref_value_in", name: "r", field: "account", refField: "type", allowed: ["liability"], when: { field: "missing" }, message: "m" }] }));
  });

  it("keeps hostile text out of SQL, or inside one quoted value", () => {
    for (const h of HOSTILE) {
      const def = custom({
        name: h.slice(0, 60),
        description: `${h} is a description long enough`,
        fields: [{ key: "body", label: h.slice(0, 60), description: h, type: "text" }],
        rules: [
          { kind: "check", name: "not_that", expr: { op: "and", args: [{ op: "ne", args: [{ field: "body" }, { lit: h }] }, { op: "not", arg: { op: "in", arg: { field: "body" }, values: [h, "fine"] } }] }, message: h },
        ],
      });
      const c = compileModel(def, T.live, ctx);
      for (const s of c.statements) expectInert(s);
      const values = strings(c.statements);
      expect(values.filter((v) => v === h)).toHaveLength(2);
      // Outside those two quoted values the hostile text is nowhere.
      const outside = c.statements.flatMap((s) => lex(s).flatMap((t) => (t.kind === "text" || t.kind === "ident" ? [t.value] : []))).join(" ");
      expect(outside).not.toContain("drop");
      expect(outside).not.toContain("pg_sleep");
    }
  });

  it("keeps very long names under the database limit and apart from each other", () => {
    const k = (c: string) => c.repeat(48);
    const def = custom({
      key: `x_${"m".repeat(46)}`,
      fields: [
        { key: k("a"), label: "a", type: "enum", values: [k("v"), "w"] },
        { key: `${"a".repeat(47)}b`, label: "b", type: "quantity" },
        { key: k("c"), label: "c", type: "parent_ref", parentModel: "jobs" },
        { key: k("d"), label: "d", type: "text", maxLength: 10 },
      ],
      unique: [[k("a"), k("d")], [k("a")]],
      indexes: [[k("a"), `${"a".repeat(47)}b`, k("c"), k("d")]],
      rules: [{ kind: "check", name: k("r"), expr: { op: "is_null", arg: { field: k("d") } }, message: "m" }],
    });
    const c = compileModel(def, T.draft, ctx);
    const names = c.statements.flatMap((s) => expectInert(s).flatMap((t) => (t.kind === "ident" ? [t.value] : [])));
    for (const n of names) expect(Buffer.byteLength(n)).toBeLessThanOrEqual(63);
    const made = c.statements.flatMap((s) => /^(?:create (?:unique )?index|create policy|create trigger) "([^"]+)"/.exec(s)?.[1] ?? []);
    const constraints = [...(c.create[0] ?? "").matchAll(/constraint "([^"]+)"/g)].map((m) => m[1]);
    expect(new Set([...made, ...constraints]).size).toBe(made.length + constraints.length);
    expect(ruleConstraintName(`x_${"m".repeat(46)}`, k("r"))).toHaveLength(63);
  });

  it("refuses any target that is not one restaurant's own schema and roles", () => {
    const def = fixtureModel("vendor");
    const other = targetsFor("o_c1c1c1c1c102");
    const bad = [
      { ...T.live, schema: "platform" },
      { ...T.live, schema: "public" },
      { ...T.live, schema: "o_c1c1c1c1c101_parent" },
      { ...T.live, schema: 'o_c1c1c1c1c101"; drop schema platform cascade; --' },
      { ...T.live, schema: "o_c1c1c1c1c101_draft" },
      { ...T.draft, schema: "o_c1c1c1c1c101" },
      { ...T.live, roles: other.live.roles },
      { ...T.live, roles: { ...T.live.roles, ask: "rms_tenant" } },
      { ...T.live, roles: { ...T.live.roles, rw: "public" } },
      { ...T.draft, roles: { ...T.draft.roles, draftRw: "o_c1c1c1c1c101_rw" } },
      { ...T.live, env: "prod" },
      { schema: "o_c1c1c1c1c101", env: "live" },
    ];
    for (const t of bad) expect(() => compileModel(def, t as typeof T.live, ctx)).toThrow(CompileError);
    expect(() => targetsFor("platform")).toThrow();
  });
});

// ---------------------------------------------------------------- changes

describe("compileChange", () => {
  const vendor = fixtureModel("vendor");

  it("adds an optional field, a unique rule and an index", () => {
    const f = compileChange({ op: "add_field", model: "vendor", field: { key: "phone", label: "Phone", type: "text", maxLength: 30, required: false } }, vendor, T.draft, ctx);
    expect(f.statements[0]).toBe('alter table "o_c1c1c1c1c101_draft"."vendor" add column "phone" text');
    expect(f.statements[1]).toMatch(/^alter table "o_c1c1c1c1c101_draft"\."vendor" add constraint "[a-z0-9_]+" check \(pg_catalog\.char_length\("phone"\) <= 30\)$/);
    expect(f.definition.fields.map((x) => x.key)).toEqual(["name", "phone"]);
    for (const s of f.statements) expectInert(s);

    const q = compileChange({ op: "add_field", model: "vendor", field: { key: "min_order", label: "Minimum order", type: "quantity", required: false } }, vendor, T.live, ctx);
    expect(q.statements.slice(0, 2)).toEqual([
      'alter table "o_c1c1c1c1c101"."vendor" add column "min_order" numeric(18,6)',
      'alter table "o_c1c1c1c1c101"."vendor" add column "min_order_unit" text',
    ]);

    const r = compileChange({ op: "add_field", model: "vendor", field: { key: "pays_into", label: "Account", type: "ref", model: "account", required: false, onDelete: "restrict" } }, vendor, T.live, ctx);
    expect(r.statements.some((s) => s.includes('foreign key ("pays_into") references "o_c1c1c1c1c101"."account" ("id") on delete restrict'))).toBe(true);

    const u = compileChange({ op: "add_unique", model: "vendor", fields: ["name"] }, vendor, T.live, ctx);
    expect(u.statements).toHaveLength(1);
    expect(u.statements[0]).toMatch(/^create unique index "[a-z0-9_]+" on "o_c1c1c1c1c101"\."vendor" \("name"\) where "deleted_at" is null$/);
    expect(u.definition.unique).toEqual([["name"]]);
    // First it looks for rows that already break the rule. The question returns no data.
    expect(u.checks).toEqual([
      { sql: 'select 1 as found from "o_c1c1c1c1c101"."vendor" where "name" is not null and "deleted_at" is null group by "name" having pg_catalog.count(*) > 1 limit 1', message: expect.stringMatching(/already share the same values/) },
    ]);
    expect(checkQuery(u.checks[0]?.sql ?? "")).toBeTruthy();
    const hard = compileChange({ op: "add_unique", model: "journal_entry", fields: ["memo", "entry_date"] }, fixtureModel("journal_entry"), T.live, ctx);
    expect(hard.statements[0]).toMatch(/^alter table "o_c1c1c1c1c101"\."journal_entry" add constraint "[a-z0-9_]+" unique \("memo", "entry_date"\)$/);

    const i = compileChange({ op: "add_index", model: "vendor", fields: ["name", "deleted_at"] }, vendor, T.live, ctx);
    expect(i.statements[0]).toMatch(/^create index "[a-z0-9_]+" on "o_c1c1c1c1c101"\."vendor" \("name", "deleted_at"\)$/);
  });

  it("takes a change back out, and drops a model with the functions its rules made", () => {
    const changes: ModelChange[] = [
      { op: "add_field", model: "vendor", field: { key: "min_order", label: "Minimum order", type: "quantity", required: false } },
      { op: "add_unique", model: "vendor", fields: ["name"] },
      { op: "add_index", model: "vendor", fields: ["name"] },
    ];
    for (const change of changes) {
      const made = compileChange(change, vendor, T.draft, ctx);
      const undone = compileDiscard(change, made.definition, T.draft);
      expect(undone.definition).toEqual(vendor);
      for (const s of undone.statements) expect(checkStatement(s)).toBe(s);
    }
    expect(compileDiscard(changes[0] as ModelChange, compileChange(changes[0] as ModelChange, vendor, T.draft, ctx).definition, T.draft).statements).toEqual([
      'alter table "o_c1c1c1c1c101_draft"."vendor" drop column "min_order"',
      'alter table "o_c1c1c1c1c101_draft"."vendor" drop column "min_order_unit"',
    ]);
    expect(() => compileDiscard(changes[1] as ModelChange, vendor, T.draft)).toThrow(CompileError);
    const drop = compileDrop(fixtureModel("posting_rule"), T.draft);
    expect(drop).toHaveLength(3);
    expect(drop[2]).toBe('drop table "o_c1c1c1c1c101_draft"."posting_rule"');
    for (const s of drop) expect(checkStatement(s)).toBe(s);
    expect(() => compileDrop(fixtureModel("vendor"), { ...T.draft, schema: "platform" })).toThrow(CompileError);
  });

  it("refuses what it must not do", () => {
    const refused = (change: unknown, current: ModelDefinition = vendor) => expect(() => compileChange(change as ModelChange, current, T.draft, ctx)).toThrow(CompileError);
    for (const name of ["xmin", "xmax", "cmin", "cmax", "ctid", "tableoid"]) refused({ op: "add_field", model: "vendor", field: { key: name, label: "x", type: "text" } });
    refused({ op: "add_field", model: "vendor", field: { key: "phone", label: "Phone", type: "text", required: true } });
    refused({ op: "add_field", model: "vendor", field: { key: "name", label: "Again", type: "text" } });
    refused({ op: "add_field", model: "vendor", field: { key: "source", label: "System", type: "text" } });
    refused({ op: "add_field", model: "vendor", field: { key: "owed", label: "Owed", type: "money" } });
    refused({ op: "add_field", model: "vendor", field: { key: "ghost", label: "Ghost", type: "ref", model: "no_such_model" } });
    refused({ op: "add_field", model: "account", field: { key: "phone", label: "Phone", type: "text" } });
    refused({ op: "add_unique", model: "vendor", fields: ["missing"] });
    refused({ op: "add_unique", model: "vendor", fields: ["location_id"] });
    refused({ op: "add_index", model: "vendor", fields: [] });
    refused({ op: "add_unique", model: "account", fields: ["code"] }, fixtureModel("account"));
    refused({ op: "use_template", template: "vendor" });
    refused({ op: "drop_table", model: "vendor" });
    refused({ op: "add_field", model: "vendor", field: { key: "phone", label: "Phone", type: "text" }, sql: "drop" });
    for (const h of HOSTILE) {
      refused({ op: "add_field", model: "vendor", field: { key: h, label: "x", type: "text" } });
      refused({ op: "add_field", model: h, field: { key: "phone", label: "x", type: "text" } });
      refused({ op: "add_field", model: "vendor", field: { key: "kind", label: "x", type: "enum", values: [h] } });
      refused({ op: "add_unique", model: "vendor", fields: [h] });
      refused({ op: "add_index", model: "vendor", fields: ["name", h] });
    }
  });
});

// ---------------------------------------------------------------- custom models

describe("custom models", () => {
  const refused = (def: ModelDefinition, why: RegExp) => expect(() => compileModel(def, T.live, ctx)).toThrow(why);

  it("can only have check rules: the compiler refuses the rest itself", () => {
    const entry = { key: "x_ledger", appendOnly: true, fields: [{ key: "day", label: "Day", type: "date", required: true }, { key: "account", label: "Account", type: "ref", model: "account" }] };
    refused(custom({ ...entry, rules: [{ kind: "balanced", name: "b", lineModel: "journal_line", lineRef: "entry", debit: "debit", credit: "credit" }] }), /only have check rules/);
    refused(custom({ ...entry, rules: [{ kind: "open_period_only", name: "o", dateField: "day" }] }), /only have check rules/);
    refused(custom({ ...entry, rules: [{ kind: "ref_value_in", name: "r", field: "account", refField: "type", allowed: ["liability"], message: "m" }] }), /only have check rules/);
    // The same model is fine with a check rule, and never gets a function.
    const ok = compileModel(custom({ ...entry, rules: [{ kind: "check", name: "has_day", expr: { op: "not", arg: { op: "is_null", arg: { field: "day" } } }, message: "m" }] }), T.live, ctx);
    expect(ok.statements.join("\n")).not.toMatch(/create function|security definer|constraint trigger/);
  });

  it("must have a key that starts with x_, and no other model may", () => {
    refused(custom({ key: "note" }), /must start with "x_"/);
    refused(custom({ key: "vendor" }), /must start with "x_"/);
    refused(custom({ key: "journal_line" }), /must start with "x_"/);
    refused(custom({ key: "x_note", pack: "finance" }), /Only a custom model/);
    expect(compileModel(custom({}), T.live, ctx).model).toBe("x_note");
    // So no custom model can take the name of something the compiler makes for a library model.
    for (const m of fixtureModels) {
      for (const s of compileModel(m, T.live, ctx).statements) expect(s).not.toMatch(/"x_/);
    }
  });

  it("cannot name a field after a column the database keeps for itself", () => {
    for (const name of ["xmin", "xmax", "cmin", "cmax", "ctid", "tableoid"]) {
      refused(custom({ fields: [{ key: name, label: "x", type: "text" }] }), /keeps for itself/);
    }
    refused(custom({ fields: [{ key: "ctid", label: "x", type: "quantity" }] }), /keeps for itself/);
  });

  it("cannot compare with nothing using eq or ne", () => {
    const rule = (expr: unknown) => custom({ rules: [{ kind: "check", name: "c", expr, message: "m" }] });
    refused(rule({ op: "eq", args: [{ field: "body" }, { lit: null }] }), /is_null/);
    refused(rule({ op: "ne", args: [{ lit: null }, { field: "body" }] }), /is_null/);
    refused(rule({ op: "and", args: [{ lit: true }, { op: "not", arg: { op: "eq", args: [{ field: "body" }, { lit: null }] } }] }), /is_null/);
    expect(() => compileModel(rule({ op: "is_null", arg: { field: "body" } }), T.live, ctx)).not.toThrow();
    expect(() => compileModel(rule({ op: "gt", args: [{ field: "body" }, { lit: "a" }] }), T.live, ctx)).not.toThrow();
  });
});

// ---------------------------------------------------------------- the second wall

describe("the statement guard", () => {
  const all = [T.live, T.draft].flatMap((t) => fixtureModels.flatMap((m) => compileModel(m, t, ctx).statements));

  it("lets through everything the compiler emits, hostile values included", () => {
    for (const s of all) expect(checkStatement(s)).toBe(s);
    for (const h of HOSTILE) {
      const def = custom({ rules: [{ kind: "check", name: "c", expr: { op: "ne", args: [{ field: "body" }, { lit: h }] }, message: "m" }] });
      for (const s of compileModel(def, T.live, ctx).statements) expect(checkStatement(s)).toBe(s);
    }
  });

  it("refuses a second statement, a comment, or a command the compiler never emits", () => {
    const table = all[0] ?? "";
    const fn = all.find((s) => s.startsWith("create function")) ?? "";
    const bad = [
      `${table}; set role postgres`,
      `alter table "o_c1c1c1c1c101"."vendor" add column "x" text; set role rms_admin`,
      `grant select on table "o_c1c1c1c1c101"."vendor" to "o_c1c1c1c1c101_rw"; drop schema platform cascade`,
      `alter table "o_c1c1c1c1c101"."vendor" add column "x" text -- note`,
      `alter table "o_c1c1c1c1c101"."vendor" add column "x" text /* note */`,
      `alter table "o_c1c1c1c1c101"."vendor" add column "x" text default $$a$$`,
      `alter table "o_c1c1c1c1c101"."vendor" add column "x" text default 'a\\'; set role rms_admin; --'`,
      `alter table "o_c1c1c1c1c101"."Vendor" add column "x" text`,
      `alter table "o_c1c1c1c1c101"."ven""dor" add column "x" text`,
      `alter table "o_c1c1c1c1c101"."vendor" add column "x" text default 'open`,
      `alter table "o_c1c1c1c1c101"."vendor" add column "x" text $rms$ select 1; $rms$`,
      `${fn} $rms$ select 1 $rms$`,
      fn.replace("return null;", "return null; $rms$; set role rms_admin; $rms$"),
      fn.replace("return null;", "return null; -- hidden"),
      `set role rms_admin`,
      `set local role "o_c1c1c1c1c102_rw"`,
      `select pg_sleep(10)`,
      `drop schema "platform" cascade`,
      `drop role "o_c1c1c1c1c101_rw"`,
      `create role "x"`,
      `create extension "dblink"`,
      `alter role "o_c1c1c1c1c101_rw" superuser`,
      `alter function "o_c1c1c1c1c101"."f"() security definer`,
      `do $rms$ begin end $rms$`,
      `copy "o_c1c1c1c1c101"."vendor" to program 'sh'`,
      ` create table "o_c1c1c1c1c101"."x" ("id" uuid)`,
      "",
    ];
    for (const s of bad) expect(() => checkStatement(s), s.slice(0, 90)).toThrow(/Refused to run/);
    expect(() => checkStatement(undefined as unknown as string)).toThrow(/Refused to run/);
  });

  it("only lets the compiler's own read-only checks through as queries", () => {
    const ok = 'select 1 as found from "o_c1c1c1c1c101"."vendor" where "name" is not null group by "name" having pg_catalog.count(*) > 1 limit 1';
    expect(checkQuery(ok)).toBe(ok);
    for (const s of [
      `${ok}; set role rms_admin`,
      `select 1 as found from "o_c1c1c1c1c101"."vendor" into "x"`,
      `select "name" from "o_c1c1c1c1c101"."vendor"`,
      `select 1 as found from platform.secrets`,
      `with x as (delete from "o_c1c1c1c1c101"."vendor" returning 1) select 1 as found from "x"`,
      `select 1 as found from "o_c1c1c1c1c101"."vendor" where "name" = (select set_config('rms.locations', 'all', false))`,
      `update "o_c1c1c1c1c101"."vendor" set "name" = 'x'`,
    ]) {
      expect(() => checkQuery(s), s).toThrow(/Refused to run/);
    }
  });
});

// ---------------------------------------------------------------- the library

describe("buildLibrary", () => {
  it("accepts the fixture pack", () => {
    const lib = buildLibrary(fixturePack);
    expect(lib.models.map((m) => m.key)).toEqual(fixtureModels.map((m) => m.key));
    expect(lib.namedQueries).toHaveLength(1);
    expect(lib.namedActions).toHaveLength(1);
  });

  it("refuses a pack that cannot be built", () => {
    const without = (key: string) => ({ ...fixturePack, models: fixturePack.models.filter((m) => m.key !== key) });
    expect(() => buildLibrary({ ...fixturePack, models: [...fixturePack.models, fixturePack.models[0]] })).toThrow(/two models/);
    // A model with an open-period rule needs the fiscal period, though no link field says so.
    expect(() => buildLibrary(without("fiscal_period"))).toThrow(/"journal_entry" needs "fiscal_period"/);
    expect(() => buildLibrary(without("journal_line"))).toThrow(/"journal_entry" needs "journal_line"/);
    expect(() => buildLibrary(without("sales_day"))).toThrow(/reads "sales_day"/);
    expect(() => buildLibrary({ ...fixturePack, models: [...fixturePack.models, custom({})] })).toThrow(/custom pack/);
    expect(() => buildLibrary({ ...fixturePack, models: [...fixturePack.models, custom({ pack: "sales", key: "x_sneaky" })] })).toThrow(/x_/);
    expect(() => buildLibrary({ ...fixturePack, models: [{ key: "x" }] })).toThrow();
    expect(() => buildLibrary({ ...fixturePack, namedActions: [{ ...fixturePack.namedActions[0], writes: ["nothing_here"] }] })).toThrow(/writes "nothing_here"/);
  });
});

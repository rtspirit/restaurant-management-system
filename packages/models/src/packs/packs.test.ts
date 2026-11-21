import { describe, expect, it } from "vitest";
import { ModelDefinition, NamedActionDefinition, NamedQueryDefinition, ParentModelKey, SYSTEM_FIELDS } from "@rms/contracts";
import type { Expr, FieldDef } from "@rms/contracts";
import { models, namedActions, namedQueries } from "./index.js";

/**
 * Shape checks for the library packs: every definition parses, every name points at something
 * real, and every SQL template follows the template rules in packages/contracts/src/models.ts.
 * The domain rules of docs/plan/02 section 4 are in domain-rules.test.ts.
 */

const modelByKey = new Map(models.map((m) => [m.key, m]));
const model = (key: string): ModelDefinition => {
  const m = modelByKey.get(key);
  if (!m) throw new Error(`No model "${key}"`);
  return m;
};
const field = (m: ModelDefinition, key: string): FieldDef | undefined => m.fields.find((f) => f.key === key);
const templates = [...namedQueries, ...namedActions];
const system = new Set<string>(SYSTEM_FIELDS);

/** Every column a model's table has, by the storage contract. */
const columnsOf = (m: ModelDefinition): Set<string> => {
  const cols = new Set<string>(["id", "source", "source_id", "created_at", "created_by", "updated_at", "updated_by"]);
  if (m.locationScoped) cols.add("location_id");
  if (m.fields.some((f) => f.type === "money")) cols.add("currency");
  if (m.softDelete && !m.appendOnly) cols.add("deleted_at");
  for (const f of m.fields) {
    cols.add(f.key);
    if (f.type === "quantity") cols.add(`${f.key}_unit`);
    if (f.type === "parent_ref") cols.add(`${f.key}_label`);
  }
  return cols;
};

/** The parent columns these templates may use (same columns as platform.locations, minus org_id). */
const PARENT_COLUMNS: Record<string, Set<string>> = { "parent.locations": new Set(["id", "name", "timezone", "currency", "day_cutoff", "status"]) };

const fieldsInExpr = (e: Expr, out: string[] = []): string[] => {
  if ("field" in e) out.push(e.field);
  else if ("args" in e) for (const a of e.args) fieldsInExpr(a, out);
  else if ("arg" in e) fieldsInExpr(e.arg, out);
  return out;
};

/** Pairs an enum field with every literal it is compared to, so a typo in a value is caught. */
const enumComparisons = (e: Expr, out: Array<{ field: string; values: Array<string | number> }> = []) => {
  if ("op" in e) {
    if (e.op === "in" && "field" in e.arg) out.push({ field: e.arg.field, values: e.values });
    if ((e.op === "eq" || e.op === "ne") && "args" in e) {
      const [a, b] = e.args;
      if (a && b && "field" in a && "lit" in b && typeof b.lit === "string") out.push({ field: a.field, values: [b.lit] });
      if (a && b && "field" in b && "lit" in a && typeof a.lit === "string") out.push({ field: b.field, values: [a.lit] });
    }
    if ("args" in e) for (const a of e.args) enumComparisons(a, out);
    if ("arg" in e) enumComparisons(e.arg, out);
  }
  return out;
};

const placeholders = (sql: string): string[] => [...sql.matchAll(/\{\{([^}]*)\}\}/g)].map((m) => m[1] as string);
const insertTargets = (sql: string): string[] => [...sql.matchAll(/insert into \{\{([a-z0-9_.]+)\}\} \(/g)].map((m) => m[1] as string);
const readRefs = (sql: string): string[] => placeholders(sql.replaceAll(/insert into \{\{[a-z0-9_.]+\}\}/g, ""));
const paramsIn = (sql: string): string[] => [...sql.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1] as string);
const quotedStrings = (sql: string): string[] => [...sql.matchAll(/'([^']*)'/g)].map((m) => m[1] as string);

describe("every definition parses with its schema", () => {
  it("has the models, queries and actions the brief asks for", () => {
    expect(models.map((m) => m.key).sort()).toEqual(
      [
        ...["unit", "tax_rate", "fiscal_calendar", "fiscal_period", "fiscal_week", "day_part", "revenue_centre", "sales_category", "payment_type", "reason_code"],
        ...["sales_day", "sales_category_day", "payment_day", "adjustment_day", "gift_card_activity", "delivery_payout", "delivery_payout_line", "cash_count", "paid_in_out", "deposit"],
        ...["account", "journal_entry", "journal_line", "posting_rule", "budget"],
        ...["vendor", "vendor_bill", "vendor_bill_line", "labour_day"],
      ].sort(),
    );
    expect(namedQueries.map((q) => q.key).sort()).toEqual(["daily_sales_summary", "delivery_payout_reconciliation", "prime_cost_by_week", "sales_by_day", "sales_by_location", "weekly_pnl"]);
    expect(namedActions.map((a) => a.key).sort()).toEqual(["post_labour_day", "post_sales_day", "post_vendor_bill", "seed_chart_of_accounts"]);
  });

  it.each(models.map((m) => [m.key, m] as const))("model %s parses and is already in its parsed form", (_key, m) => {
    const parsed = ModelDefinition.safeParse(m);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.data).toEqual(m);
  });

  it.each(namedQueries.map((q) => [q.key, q] as const))("named query %s parses", (_key, q) => {
    const parsed = NamedQueryDefinition.safeParse(q);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.data).toEqual(q);
  });

  it.each(namedActions.map((a) => [a.key, a] as const))("named action %s parses", (_key, a) => {
    const parsed = NamedActionDefinition.safeParse(a);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.data).toEqual(a);
  });

  it("survives a trip through JSON, which is how the library is stored", () => {
    for (const m of models) expect(ModelDefinition.parse(JSON.parse(JSON.stringify(m)))).toEqual(m);
    for (const q of namedQueries) expect(NamedQueryDefinition.parse(JSON.parse(JSON.stringify(q)))).toEqual(q);
    for (const a of namedActions) expect(NamedActionDefinition.parse(JSON.parse(JSON.stringify(a)))).toEqual(a);
  });
});

describe("keys and packs", () => {
  it("model keys are unique", () => {
    expect(new Set(models.map((m) => m.key)).size).toBe(models.length);
  });

  it("named query and action keys are unique, also across the two", () => {
    const keys = templates.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("rule names are unique across the whole library", () => {
    const names = models.flatMap((m) => m.rules.map((r) => r.name));
    expect(new Set(names).size).toBe(names.length);
  });

  it("each model is in the pack the brief names", () => {
    const packOf = (key: string) => model(key).pack;
    for (const key of ["vendor", "vendor_bill", "vendor_bill_line"]) expect(packOf(key)).toBe("inventory");
    expect(packOf("labour_day")).toBe("labour");
    for (const key of ["account", "journal_entry", "journal_line", "posting_rule", "budget"]) expect(packOf(key)).toBe("finance");
    for (const key of ["sales_day", "sales_category_day", "payment_day", "adjustment_day", "gift_card_activity", "delivery_payout", "delivery_payout_line", "cash_count", "paid_in_out", "deposit"]) expect(packOf(key)).toBe("sales");
    for (const key of ["unit", "tax_rate", "fiscal_calendar", "fiscal_period", "fiscal_week", "day_part", "revenue_centre", "sales_category", "payment_type", "reason_code"]) expect(packOf(key)).toBe("foundation");
    expect(models.every((m) => m.pack !== "custom")).toBe(true);
    expect(models.every((m) => m.version === 1)).toBe(true);
  });
});

describe("plain words, because the agent picks models by meaning", () => {
  it("every model has a real description, and no two share one", () => {
    for (const m of models) expect(m.description.length, m.key).toBeGreaterThanOrEqual(60);
    expect(new Set(models.map((m) => m.description)).size).toBe(models.length);
    expect(new Set(models.map((m) => m.name)).size).toBe(models.length);
  });

  it("descriptions and labels do not leak table or code words", () => {
    const banned = /\b(table|column|schema|foreign key|uuid|sql|json|enum|null)\b/i;
    for (const m of models) {
      expect(m.description, m.key).not.toMatch(banned);
      expect(m.name, m.key).not.toMatch(/_/);
      for (const f of m.fields) expect(f.label, `${m.key}.${f.key}`).not.toMatch(/_/);
    }
    for (const t of templates) expect(t.description, t.key).not.toMatch(banned);
  });

  it("field labels are unique inside a model", () => {
    for (const m of models) expect(new Set(m.fields.map((f) => f.label)).size, m.key).toBe(m.fields.length);
  });

  it("a label field exists and every role that reads the model can read it", () => {
    for (const m of models) {
      if (!m.labelField) continue;
      const f = field(m, m.labelField);
      expect(f, `${m.key}.${m.labelField}`).toBeDefined();
      expect(f?.readableBy, `${m.key}.${m.labelField}`).toBeUndefined();
    }
  });

  it("every model another model points at has a label field", () => {
    const targets = new Set(models.flatMap((m) => m.fields.flatMap((f) => (f.type === "ref" ? [f.model] : []))));
    const needNone = new Set(["sales_day", "delivery_payout", "vendor_bill"]);
    for (const key of targets) if (!needNone.has(key)) expect(model(key).labelField, key).toBeDefined();
  });
});

describe("references between models", () => {
  it("no model declares a system field", () => {
    for (const m of models) for (const f of m.fields) expect(system.has(f.key), `${m.key}.${f.key}`).toBe(false);
  });

  it("every ref points at a model in the packs", () => {
    for (const m of models) for (const f of m.fields) if (f.type === "ref") expect(modelByKey.has(f.model), `${m.key}.${f.key} -> ${f.model}`).toBe(true);
  });

  it("models are listed after the models they point at", () => {
    const seen = new Set<string>();
    for (const m of models) {
      for (const f of m.fields) if (f.type === "ref" && f.model !== m.key) expect(seen.has(f.model), `${m.key}.${f.key} -> ${f.model}`).toBe(true);
      seen.add(m.key);
    }
  });

  it("the only model that points at itself is journal_entry (a reversal names the entry it reverses)", () => {
    const selfRefs = models.flatMap((m) => m.fields.filter((f) => f.type === "ref" && f.model === m.key).map((f) => `${m.key}.${f.key}`));
    expect(selfRefs).toEqual(["journal_entry.reverses"]);
  });

  it("every parent ref names a known parent model", () => {
    const parent = new Set<string>(ParentModelKey.options);
    for (const m of models) for (const f of m.fields) if (f.type === "parent_ref") expect(parent.has(f.parentModel), `${m.key}.${f.key}`).toBe(true);
  });

  it("a required field is never hidden from a role that may write the model", () => {
    for (const m of models) {
      if (m.defaultAccess.staff !== "write") continue;
      for (const f of m.fields) if (f.required) expect(f.readableBy ?? ["owner", "staff"], `${m.key}.${f.key}`).toContain("staff");
    }
  });
});

describe("rules point at real fields and real values", () => {
  it("check rules only use fields of their own model, and compare choices to values that exist", () => {
    for (const m of models) {
      for (const r of m.rules) {
        if (r.kind !== "check") continue;
        for (const key of fieldsInExpr(r.expr)) expect(field(m, key), `${m.key} rule ${r.name} uses ${key}`).toBeDefined();
        for (const c of enumComparisons(r.expr)) {
          const f = field(m, c.field);
          if (f?.type === "enum") for (const v of c.values) expect(f.values, `${m.key} rule ${r.name}: ${c.field} = ${v}`).toContain(v);
        }
      }
    }
  });

  it("the balanced rule names the line model, the line's ref back to the entry, and two money fields", () => {
    for (const m of models) {
      for (const r of m.rules) {
        if (r.kind !== "balanced") continue;
        const line = model(r.lineModel);
        const back = field(line, r.lineRef);
        expect(back?.type === "ref" && back.model === m.key && back.required).toBe(true);
        for (const side of [r.debit, r.credit]) {
          const f = field(line, side);
          expect(f?.type === "money" && f.required, `${line.key}.${side}`).toBe(true);
        }
      }
    }
  });

  it("the open-period rule names a required date, and fiscal_period has what the rule reads", () => {
    for (const m of models) {
      for (const r of m.rules) {
        if (r.kind !== "open_period_only") continue;
        const f = field(m, r.dateField);
        expect(f?.type === "business_date" || f?.type === "date").toBe(true);
        expect(f?.required).toBe(true);
      }
    }
    const period = model("fiscal_period");
    const status = field(period, "status");
    expect(status?.type === "enum" && status.values).toEqual(["open", "closed"]);
    expect(field(period, "start_date")?.type).toBe("date");
    expect(field(period, "end_date")?.type).toBe("date");
  });

  it("ref_value_in rules name a required ref, a choice field on its target, and values that field has", () => {
    let count = 0;
    for (const m of models) {
      for (const r of m.rules) {
        if (r.kind !== "ref_value_in") continue;
        count += 1;
        const f = field(m, r.field);
        expect(f?.type, `${m.key} rule ${r.name}`).toBe("ref");
        if (f?.type !== "ref") continue;
        expect(f.required, `${m.key} rule ${r.name}`).toBe(true);
        const target = field(model(f.model), r.refField);
        expect(target?.type, `${m.key} rule ${r.name}`).toBe("enum");
        if (target?.type === "enum") for (const v of r.allowed) expect(target.values, `${m.key} rule ${r.name}: ${v}`).toContain(v);
        if (r.when) {
          for (const key of fieldsInExpr(r.when)) expect(field(m, key), `${m.key} rule ${r.name} uses ${key}`).toBeDefined();
          for (const c of enumComparisons(r.when)) {
            const cf = field(m, c.field);
            if (cf?.type === "enum") for (const v of c.values) expect(cf.values, `${m.key} rule ${r.name}: ${c.field} = ${v}`).toContain(v);
          }
        }
      }
    }
    expect(count).toBeGreaterThan(0);
  });
});

describe("named query and action templates", () => {
  it("every reads and writes entry names a real model or a parent model", () => {
    const parent = new Set<string>(ParentModelKey.options.map((k) => `parent.${k}`));
    for (const t of templates) {
      for (const r of t.reads) expect(modelByKey.has(r) || parent.has(r), `${t.key} reads ${r}`).toBe(true);
      if ("writes" in t) for (const w of t.writes) expect(modelByKey.has(w), `${t.key} writes ${w}`).toBe(true);
    }
  });

  it("every {{...}} is listed in reads or writes, and nothing is listed that is not used", () => {
    for (const t of templates) {
      const writes = "writes" in t ? t.writes : [];
      for (const p of placeholders(t.sql)) expect(/^(parent\.)?[a-z][a-z0-9_]*$/.test(p), `${t.key} {{${p}}}`).toBe(true);
      expect([...new Set(readRefs(t.sql))].sort(), `${t.key} reads`).toEqual([...t.reads].sort());
      expect([...new Set(insertTargets(t.sql))].sort(), `${t.key} writes`).toEqual([...writes].sort());
    }
  });

  it("a named query never writes", () => {
    for (const q of namedQueries) {
      expect(q.sql, q.key).toMatch(/^(with|select)\b/);
      expect(q.sql, q.key).not.toMatch(/\b(insert|update|delete|truncate|drop|alter|create|grant|revoke|merge|copy|call|execute|do|set|lock|into)\b/i);
    }
  });

  it("a named action only inserts, and only in the one form the compiler can recognise", () => {
    for (const a of namedActions) {
      expect(a.sql, a.key).toMatch(/^with\b/);
      expect(a.sql, a.key).not.toMatch(/\b(update|delete|truncate|drop|alter|create|grant|revoke|merge|copy|call|execute|set|lock)\b/i);
      const inserts = [...a.sql.matchAll(/\binsert\b/gi)].length;
      expect(insertTargets(a.sql).length, a.key).toBe(inserts);
      expect([...a.sql.matchAll(/\binto\b/gi)].length, a.key).toBe(inserts);
    }
  });

  it("is one statement with no comments", () => {
    for (const t of templates) {
      expect(t.sql, t.key).not.toContain(";");
      expect(t.sql, t.key).not.toContain("--");
      expect(t.sql, t.key).not.toContain("/*");
      expect(t.sql, t.key).not.toMatch(/\$\d|\?/);
      expect(t.sql, t.key).not.toContain('"');
      expect([...t.sql.matchAll(/'/g)].length % 2, t.key).toBe(0);
    }
  });

  it("every :param is declared, every declared param is used, and nothing else looks like a param", () => {
    for (const t of templates) {
      const declared = t.params.map((p) => p.key).sort();
      expect(new Set(declared).size, t.key).toBe(declared.length);
      expect([...new Set(paramsIn(t.sql))].sort(), t.key).toEqual(declared);
      expect(t.sql, t.key).not.toContain("::");
      for (const s of quotedStrings(t.sql)) {
        expect(s, t.key).not.toContain(":");
        expect(s, t.key).not.toContain("{");
      }
      for (const p of t.params) expect(t.sql, `${t.key} :${p.key}`).toMatch(new RegExp(`cast\\(:${p.key} as (uuid|date|text|bigint|boolean)\\)`));
    }
  });

  it("casts each param to the type it declares", () => {
    const sqlType = { uuid: "uuid", date: "date", business_date: "date", text: "text", integer: "bigint", boolean: "boolean" } as const;
    for (const t of templates) {
      for (const p of t.params) {
        const uses = [...t.sql.matchAll(new RegExp(`:${p.key}\\b( as [a-z]+\\))?`, "g"))].map((m) => m[1]);
        for (const u of uses) expect(u, `${t.key} :${p.key}`).toBe(` as ${sqlType[p.type]})`);
      }
    }
  });

  it("every read of a model has an alias", () => {
    for (const t of templates) {
      const reads = t.sql.replaceAll(/insert into \{\{[a-z0-9_.]+\}\}/g, "");
      const all = [...reads.matchAll(/\{\{[a-z0-9_.]+\}\}/g)].length;
      const aliased = [...reads.matchAll(/(from|join) \{\{[a-z0-9_.]+\}\} as [a-z][a-z0-9_]*\b/g)].length;
      expect(aliased, t.key).toBe(all);
    }
  });

  it("only uses columns the models really have", () => {
    for (const t of templates) {
      const aliasModels = new Map<string, Set<string>>();
      for (const m of t.sql.matchAll(/\{\{([a-z0-9_.]+)\}\} as ([a-z][a-z0-9_]*)\b/g)) {
        const [ref, alias] = [m[1] as string, m[2] as string];
        aliasModels.set(alias, (aliasModels.get(alias) ?? new Set()).add(ref));
      }
      expect(aliasModels.size, t.key).toBeGreaterThan(0);
      for (const m of t.sql.matchAll(/\b([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)\b(?!\()/g)) {
        const [alias, column] = [m[1] as string, m[2] as string];
        const refs = aliasModels.get(alias);
        if (!refs) continue;
        const ok = [...refs].some((ref) => (PARENT_COLUMNS[ref] ?? (modelByKey.has(ref) ? columnsOf(model(ref)) : new Set())).has(column));
        expect(ok, `${t.key}: ${alias}.${column} is not a column of ${[...refs].join(" or ")}`).toBe(true);
      }
    }
  });

  it("an alias for a model is never reused for something else in the same template", () => {
    for (const t of templates) {
      const modelAliases = new Set([...t.sql.matchAll(/\{\{[a-z0-9_.]+\}\} as ([a-z][a-z0-9_]*)\b/g)].map((m) => m[1] as string));
      const otherAliases = [...t.sql.matchAll(/(?<!\}\}) as ([a-z][a-z0-9_]*)\b(?! \()/g)].map((m) => m[1] as string);
      const cteNames = [...t.sql.matchAll(/\b([a-z][a-z0-9_]*)(?: \([a-z0-9_, ]+\))? as \(/g)].map((m) => m[1] as string);
      for (const a of [...otherAliases, ...cteNames]) expect(modelAliases.has(a), `${t.key}: alias ${a}`).toBe(false);
    }
  });

  it("an insert names real columns and fills every column that has to be filled", () => {
    for (const a of namedActions) {
      const inserts = [...a.sql.matchAll(/insert into \{\{([a-z0-9_]+)\}\} \(([^)]*)\)/g)];
      expect(inserts.length, a.key).toBeGreaterThan(0);
      for (const ins of inserts) {
        const target = model(ins[1] as string);
        const cols = (ins[2] as string).split(",").map((c) => c.trim());
        const known = columnsOf(target);
        expect(new Set(cols).size, `${a.key} -> ${target.key}`).toBe(cols.length);
        for (const c of cols) expect(known.has(c), `${a.key} -> ${target.key}.${c}`).toBe(true);
        const mustFill = ["id", "source", "created_by", "updated_by", ...target.fields.filter((f) => f.required).map((f) => f.key)];
        if (target.locationScoped) mustFill.push("location_id");
        if (target.fields.some((f) => f.type === "money")) mustFill.push("currency");
        for (const c of mustFill) expect(cols, `${a.key} -> ${target.key} must fill ${c}`).toContain(c);
      }
    }
  });

  it("an action never writes a field its caller could not read", () => {
    for (const a of namedActions) for (const w of a.writes) expect(model(w).defaultAccess.owner, `${a.key} -> ${w}`).toBe("write");
  });

  it("every result column of a query is produced by its SQL, and none is left unnamed", () => {
    for (const q of namedQueries) {
      const keys = q.columns.map((c) => c.key);
      expect(new Set(keys).size, q.key).toBe(keys.length);
      const finalSelect = q.sql.slice(q.sql.lastIndexOf("\nselect ") + 1);
      const produced = [...finalSelect.matchAll(/ as ([a-z][a-z0-9_]*)(,|\n)/g)].map((m) => m[1] as string).filter((k) => !/^(bigint|text|date|uuid)$/.test(k));
      expect(produced.filter((k) => keys.includes(k)), q.key).toEqual(keys);
    }
  });

  it("an action reports how many rows it added", () => {
    for (const a of namedActions) expect(a.sql.trimEnd().endsWith("as affected"), a.key).toBe(true);
  });
});

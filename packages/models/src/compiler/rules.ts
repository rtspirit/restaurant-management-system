// Rules that need a trigger: balanced, open_period_only, ref_value_in.
//
// Every trigger function lives in the restaurant's own schema, is owned by the role that runs
// this SQL (rms_tenant_migrator), has `set search_path = ''`, names every table in full, and has
// PUBLIC's default right to call it removed. The body is fixed text plus quoted names and
// quoted values. There is no dynamic SQL. Only library models can have these rules: the
// compiler refuses them on a custom model (see parseModel).
//
// SECURITY DEFINER is used only when the rows the rule must read are location-scoped:
//   * balanced (both of its functions): the checks run at commit and must cover ALL lines of an
//     entry and always find its header. Running as the caller, row-level security would hide
//     lines at locations outside whatever the caller's location setting is at that moment, so
//     an entry could commit out of balance (a test does exactly that), or a correct one be refused.
//   * ref_value_in, target side: when the target row changes, every row pointing at it must be
//     found, including rows at locations the caller cannot see.
// The table owner is not subject to row-level security (no FORCE), so the owner-run function
// sees every row. These functions take no input except the row being written.
import type { Expr, ModelDefinition, ModelRule } from "@rms/contracts";
import { compileExpr } from "./expr.js";
import { type ModelLookup, exprColumn, findField, hasSoftDelete, ruleConstraintName } from "./shape.js";
import { CompileError, functionBody, isPlainName, objectName, qualified, quoteIdent, quoteLiteral } from "./sql.js";

/** The fiscal period model that `open_period_only` reads. The rule kind itself carries no names. */
export const FISCAL_PERIOD = { model: "fiscal_period", start: "start_date", end: "end_date", status: "status", closed: "closed" } as const;

type TriggerRule = Exclude<ModelRule, { kind: "check" }>;
type BalancedRule = Extract<TriggerRule, { kind: "balanced" }>;
type PeriodRule = Extract<TriggerRule, { kind: "open_period_only" }>;
type RefValueRule = Extract<TriggerRule, { kind: "ref_value_in" }>;

const raise = (schema: string, table: string, constraint: string, message: string): string =>
  `raise exception using errcode = 'check_violation', message = ${quoteLiteral(message)}, schema = ${quoteLiteral(schema)}, table = ${quoteLiteral(table)}, constraint = ${quoteLiteral(constraint)};`;

const createFunction = (schema: string, name: string, opts: { definer: boolean; declare?: string[]; body: string[] }): string[] => {
  const fn = `${qualified(schema, name)}()`;
  const text = [...(opts.declare?.length ? ["declare", ...opts.declare.map((d) => `  ${d}`)] : []), "begin", ...opts.body.map((b) => `  ${b}`), "end"].join("\n");
  return [
    `create function ${fn} returns trigger language plpgsql${opts.definer ? " security definer" : ""} set search_path = '' as ${functionBody(text)}`,
    `revoke all on function ${fn} from public`,
  ];
};

const indent = (lines: string[], by = "  "): string[] => lines.map((l) => `${by}${l}`);

const need = (def: ModelDefinition, key: string) => {
  const f = findField(def, key);
  if (!f) throw new CompileError(`Model "${def.key}" has no field ${JSON.stringify(String(key).slice(0, 40))}`);
  return f;
};

const isDate = (t: string): boolean => t === "date" || t === "business_date";

/**
 * `if` block that raises when `dateSql` falls in a closed fiscal period. `locationSql` is the
 * row's location, used only when periods belong to one location.
 */
const closedPeriodCheck = (def: ModelDefinition, rule: PeriodRule, schema: string, lookup: ModelLookup, dateSql: string, locationSql: string): string[] => {
  const dateField = need(def, rule.dateField);
  if (!isDate(dateField.type)) throw new CompileError(`"${rule.dateField}" must be a date`);
  const period = lookup(FISCAL_PERIOD.model);
  const start = need(period, FISCAL_PERIOD.start);
  const end = need(period, FISCAL_PERIOD.end);
  const status = need(period, FISCAL_PERIOD.status);
  if (!isDate(start.type) || !isDate(end.type) || !start.required || !end.required) throw new CompileError("The fiscal period needs a required start date and end date");
  if (status.type !== "enum" || !status.values.includes(FISCAL_PERIOD.closed)) throw new CompileError('The fiscal period status needs a "closed" value');
  // Running as the caller, periods at locations the caller cannot see would be skipped.
  if (period.locationScoped && !def.locationScoped) throw new CompileError("A model for all locations cannot follow fiscal periods that belong to one location");
  const conditions = [
    `p.${quoteIdent(start.key)} <= ${dateSql}`,
    `p.${quoteIdent(end.key)} >= ${dateSql}`,
    `p.${quoteIdent(status.key)} = ${quoteLiteral(FISCAL_PERIOD.closed)}`,
    ...(hasSoftDelete(period) ? [`p.${quoteIdent("deleted_at")} is null`] : []),
    ...(period.locationScoped ? [`p.${quoteIdent("location_id")} = ${locationSql}`] : []),
  ];
  return [
    `if exists (select 1 from ${qualified(schema, period.key)} as p where ${conditions.join(" and ")}) then`,
    `  ${raise(schema, def.key, ruleConstraintName(def.key, rule.name), "The period is closed")}`,
    "end if;",
  ];
};

/**
 * The ledger rule. Three guarantees, all checked at commit by deferred constraint triggers:
 *   1. An entry's lines share one currency and its debits equal its credits.
 *   2. An entry is written once. Lines can only be added in the transaction that created their
 *      header, so a posted entry can never be changed, not even by a balanced addition.
 *   3. An entry has at least one line.
 * Both models must be append-only, so no header or line can be updated or deleted either.
 */
const balanced = (def: ModelDefinition, rule: BalancedRule, schema: string, lookup: ModelLookup): string[] => {
  const line = lookup(rule.lineModel);
  const ref = need(line, rule.lineRef);
  if (ref.type !== "ref" || ref.model !== def.key || !ref.required) throw new CompileError(`"${rule.lineRef}" must be a required link from "${line.key}" to "${def.key}"`);
  const debit = need(line, rule.debit);
  const credit = need(line, rule.credit);
  if (debit.type !== "money" || credit.type !== "money" || debit.key === credit.key) throw new CompileError("Debit and credit must be two money fields");
  // An update of the header would make it look newly written. Append-only rules that out.
  if (!def.appendOnly || !line.appendOnly) throw new CompileError("A balanced entry and its lines must both be append-only");

  const constraint = ruleConstraintName(def.key, rule.name);
  const headerTable = qualified(schema, def.key);
  const lineTable = qualified(schema, line.key);
  const refCol = quoteIdent(ref.key);
  const definer = line.locationScoped;

  // The header's own period rules are checked again for every line.
  const periodRules = def.rules.filter((r): r is PeriodRule => r.kind === "open_period_only");
  const headerColumns = [
    `h.xmin::text::numeric as made_in`,
    ...periodRules.map((r, i) => `h.${quoteIdent(need(def, r.dateField).key)} as ${quoteIdent(`date_${i}`)}`),
    ...(def.locationScoped ? [`h.${quoteIdent("location_id")} as ${quoteIdent("location_id")}`] : []),
  ];
  const periodChecks = periodRules.flatMap((r, i) => closedPeriodCheck(def, r, schema, lookup, `v_header.${quoteIdent(`date_${i}`)}`, `v_header.${quoteIdent("location_id")}`));

  const lineFn = objectName("fn", def.key, rule.name);
  const headerFn = objectName("fnh", def.key, rule.name);
  return [
    ...createFunction(schema, lineFn, {
      definer,
      declare: ["v_ids uuid[];", "v_id uuid;", "v_header record;", "v_now numeric;", "v_made_in numeric;", "v_currencies bigint;", "v_debit numeric;", "v_credit numeric;"],
      body: [
        `if tg_op = 'DELETE' then v_ids := array[old.${refCol}];`,
        `elsif tg_op = 'UPDATE' then v_ids := array[old.${refCol}, new.${refCol}];`,
        `else v_ids := array[new.${refCol}];`,
        "end if;",
        "foreach v_id in array v_ids loop",
        ...indent([
          "if v_id is not null then",
          ...indent([
            `select ${headerColumns.join(", ")} into v_header from ${headerTable} as h where h.${quoteIdent("id")} = v_id;`,
            "if not found then",
            `  ${raise(schema, def.key, constraint, "The entry cannot be changed")}`,
            "end if;",
            // The header row is visible to us, so the transaction that wrote it has either
            // committed or is this one (or one of its savepoints). "In progress" therefore means
            // this transaction. xmin is 32 bits: the upper bits come from the current id.
            "v_now := pg_catalog.pg_current_xact_id()::text::numeric;",
            "v_made_in := v_now - pg_catalog.mod(v_now, 4294967296) + v_header.made_in;",
            // The real id is the one within half a cycle of ours. It can be higher than ours:
            // a savepoint of this transaction, or a transaction that began after this one.
            "if v_made_in - v_now > 2147483648 then v_made_in := v_made_in - 4294967296;",
            "elsif v_now - v_made_in > 2147483648 then v_made_in := v_made_in + 4294967296;",
            "end if;",
            "if v_header.made_in < 3 or v_made_in < 3 or pg_catalog.pg_xact_status(v_made_in::text::xid8) is distinct from 'in progress' then",
            `  ${raise(schema, def.key, constraint, "The entry is already posted and cannot be changed")}`,
            "end if;",
            ...periodChecks,
            `select pg_catalog.count(distinct l.${quoteIdent("currency")}), coalesce(pg_catalog.sum(l.${quoteIdent(debit.key)}), 0), coalesce(pg_catalog.sum(l.${quoteIdent(credit.key)}), 0)`,
            "  into v_currencies, v_debit, v_credit",
            `  from ${lineTable} as l where l.${refCol} = v_id;`,
            "if v_currencies > 1 or v_debit <> v_credit then",
            `  ${raise(schema, def.key, constraint, "The entry does not balance")}`,
            "end if;",
          ]),
          "end if;",
        ]),
        "end loop;",
        "return null;",
      ],
    }),
    // Checked at commit, so the header and all its lines can go in one batch in any order.
    `create constraint trigger ${quoteIdent(objectName("trg", def.key, rule.name))} after insert or update or delete on ${lineTable} deferrable initially deferred for each row execute function ${qualified(schema, lineFn)}()`,
    ...createFunction(schema, headerFn, {
      definer,
      body: [
        `if not exists (select 1 from ${lineTable} as l where l.${refCol} = new.${quoteIdent("id")}) then`,
        `  ${raise(schema, def.key, constraint, "The entry has no lines")}`,
        "end if;",
        "return null;",
      ],
    }),
    `create constraint trigger ${quoteIdent(objectName("trgh", def.key, rule.name))} after insert on ${headerTable} deferrable initially deferred for each row execute function ${qualified(schema, headerFn)}()`,
  ];
};

const openPeriodOnly = (def: ModelDefinition, rule: PeriodRule, schema: string, lookup: ModelLookup): string[] => {
  const dateCol = quoteIdent(need(def, rule.dateField).key);
  const fnName = objectName("fn", def.key, rule.name);
  const at = (row: "new" | "old") => closedPeriodCheck(def, rule, schema, lookup, `${row}.${dateCol}`, `${row}.${quoteIdent("location_id")}`);
  return [
    ...createFunction(schema, fnName, {
      definer: false,
      body: ["if tg_op <> 'DELETE' then", ...indent(at("new")), "end if;", "if tg_op <> 'INSERT' then", ...indent(at("old")), "end if;", "return null;"],
    }),
    `create trigger ${quoteIdent(objectName("trg", def.key, rule.name))} after insert or update or delete on ${qualified(schema, def.key)} for each row execute function ${qualified(schema, fnName)}()`,
  ];
};

const refValueIn = (def: ModelDefinition, rule: RefValueRule, schema: string, lookup: ModelLookup): string[] => {
  const field = need(def, rule.field);
  if (field.type !== "ref") throw new CompileError(`"${rule.field}" must be a link to another model`);
  const target = lookup(field.model);
  const refField = need(target, rule.refField);
  if (refField.type !== "enum" && refField.type !== "text") throw new CompileError(`"${rule.refField}" must be a text or list field`);
  for (const v of rule.allowed) {
    if (!isPlainName(v)) throw new CompileError("An allowed value is not a plain name");
    if (refField.type === "enum" && !refField.values.includes(v)) throw new CompileError(`"${v}" is not a value of "${rule.refField}"`);
  }
  const allowed = rule.allowed.map((v) => quoteLiteral(v)).join(", ");
  const when = (row: string): string | undefined =>
    rule.when === undefined ? undefined : compileExpr(rule.when as Expr, (f) => `${row}.${quoteIdent(exprColumn(def, f))}`);
  const constraint = ruleConstraintName(def.key, rule.name);
  const fieldCol = quoteIdent(field.key);
  const refCol = quoteIdent(refField.key);

  const fnName = objectName("fn", def.key, rule.name);
  const whenNew = when("new");
  const forward = [
    ...createFunction(schema, fnName, {
      definer: false,
      declare: ["v_value text;"],
      body: [
        `if new.${fieldCol} is null then return null; end if;`,
        ...(whenNew ? [`if ${whenNew} is not true then return null; end if;`] : []),
        `select t.${refCol} into v_value from ${qualified(schema, target.key)} as t where t.${quoteIdent("id")} = new.${fieldCol};`,
        // A target the caller cannot see counts as not allowed.
        `if not found or v_value is null or v_value not in (${allowed}) then`,
        `  ${raise(schema, def.key, constraint, "The linked row is not allowed here")}`,
        "end if;",
        "return null;",
      ],
    }),
    `create trigger ${quoteIdent(objectName("trg", def.key, rule.name))} after insert or update on ${qualified(schema, def.key)} for each row execute function ${qualified(schema, fnName)}()`,
  ];

  // The other direction: the target row changes its value after rows already point at it.
  const backName = objectName("fnr", def.key, rule.name);
  const whenRow = when("r");
  const pointing = [
    `r.${fieldCol} = new.${quoteIdent("id")}`,
    ...(hasSoftDelete(def) ? [`r.${quoteIdent("deleted_at")} is null`] : []),
    ...(whenRow ? [`${whenRow} is true`] : []),
  ];
  const back = [
    ...createFunction(schema, backName, {
      definer: def.locationScoped,
      body: [
        `if new.${refCol} is not distinct from old.${refCol} then return null; end if;`,
        `if new.${refCol} is not null and new.${refCol} in (${allowed}) then return null; end if;`,
        `if exists (select 1 from ${qualified(schema, def.key)} as r where ${pointing.join(" and ")}) then`,
        `  ${raise(schema, def.key, constraint, "The linked row is not allowed here")}`,
        "end if;",
        "return null;",
      ],
    }),
    `create trigger ${quoteIdent(objectName("trgr", def.key, rule.name))} after update on ${qualified(schema, target.key)} for each row execute function ${qualified(schema, backName)}()`,
  ];
  return [...forward, ...back];
};

/** Statements for one trigger rule. They need the other tables to exist, so they run after every table is created. */
export const compileTriggerRule = (def: ModelDefinition, rule: TriggerRule, schema: string, lookup: ModelLookup): string[] => {
  if (def.pack === "custom") throw new CompileError("A custom model can only have check rules");
  switch (rule.kind) {
    case "balanced":
      return balanced(def, rule, schema, lookup);
    case "open_period_only":
      return openPeriodOnly(def, rule, schema, lookup);
    case "ref_value_in":
      return refValueIn(def, rule, schema, lookup);
    default:
      throw new CompileError("Rule kind is not known");
  }
};

/** The trigger functions a model's rules create, by name. Dropping one also drops its triggers. */
export const ruleFunctionNames = (def: ModelDefinition): string[] =>
  def.rules.flatMap((r) =>
    r.kind === "balanced"
      ? [objectName("fn", def.key, r.name), objectName("fnh", def.key, r.name)]
      : r.kind === "open_period_only"
        ? [objectName("fn", def.key, r.name)]
        : r.kind === "ref_value_in"
          ? [objectName("fn", def.key, r.name), objectName("fnr", def.key, r.name)]
          : [],
  );

/** Models a rule needs to exist besides the ones its ref fields point at. */
export const ruleDependencies = (def: ModelDefinition): string[] =>
  def.rules.flatMap((r) => (r.kind === "balanced" ? [r.lineModel] : r.kind === "open_period_only" ? [FISCAL_PERIOD.model] : []));

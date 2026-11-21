// POST /data/v1/named (reports) and POST /data/v1/action (maintainer-written writes).
import {
  type FieldType,
  type ModelAccess,
  type NamedActionDefinition,
  NamedActionRequest,
  type NamedQueryDefinition,
  NamedQueryRequest,
  type NamedQueryResponse,
  type Row,
  type Scalar,
  type TenantContext,
} from "@rms/contracts";
import { type StoreHandle, apiDb, ident, withStore } from "@rms/db";
import { shapesFor } from "./access.js";
import { DataApiError, toDataApiError } from "./errors.js";
import { type Ids, type Platform, withPlatform, writeAudit } from "./platform.js";
import { type Attr, type Kind, type Shape, allColumns, baseConditions, decode, readableColumns, tableOf, textExpr } from "./shape.js";
import { Params, type PgType, readOnlyStore, run, setTimeoutFor } from "./sql.js";
import { type Checked, checkTemplate } from "./template-check.js";
import { type Piece, TemplateError, renderTemplate } from "./template.js";
import { scalarText } from "./values.js";

type ParamDef = NamedQueryDefinition["params"][number];

const PARAM_KIND: Record<ParamDef["type"], Kind> = { text: "text", integer: "integer", date: "date", business_date: "business_date", boolean: "boolean", uuid: "uuid" };
const PARAM_PG: Record<ParamDef["type"], PgType> = { text: "text", integer: "bigint", date: "date", business_date: "date", boolean: "boolean", uuid: "uuid" };

type Bound = ReadonlyMap<string, { text: string | null; pg: PgType }>;

/**
 * Checks the request's parameters against the declared ones. A missing optional parameter is
 * bound as NULL. A missing required one, an unknown one or a wrong type is `invalid_request`.
 * Parameters have no label in the definition format, so the messages never show a raw key.
 */
const bindParams = (declared: readonly ParamDef[], given: Record<string, Scalar>): Bound => {
  const known = new Set(declared.map((d) => d.key));
  for (const k of Object.keys(given)) if (!known.has(k)) throw new DataApiError("invalid_request", "That request has a setting this report or action does not take.");
  const out = new Map<string, { text: string | null; pg: PgType }>();
  for (const d of declared) {
    const v = given[d.key];
    if (v === undefined || v === null) {
      if (d.required) throw new DataApiError("invalid_request", "A setting this report or action needs is missing.");
      out.set(d.key, { text: null, pg: PARAM_PG[d.type] });
      continue;
    }
    const attr: Attr = { key: d.key, label: d.key, kind: PARAM_KIND[d.type], required: d.required, readable: true, system: false, settable: false };
    try {
      out.set(d.key, { text: scalarText(attr, v), pg: PARAM_PG[d.type] });
    } catch {
      throw new DataApiError("invalid_request", "One of the settings for this report or action is not in the right form.");
    }
  }
  return out;
};

type Definition = { key: string; reads: string[]; writes?: string[]; params: ParamDef[]; sql: string };

const broken = (def: Pick<Definition, "key">, e: unknown): DataApiError =>
  new DataApiError("internal", undefined, `template ${def.key}: ${e instanceof TemplateError ? e.message : "does not compile"}`);

/** Runs the allow-list check on a definition's template. A template that fails it is never run. */
const checked = async (def: Definition, mode: "query" | "action"): Promise<Checked> => {
  try {
    return await checkTemplate({ sql: def.sql, mode, reads: def.reads, writes: def.writes ?? [], params: def.params.map((p) => p.key) });
  } catch (e) {
    throw broken(def, e);
  }
};

/** Insert targets may only name columns the model has and the caller's role may read. */
export const targetColumnsAllowed = (pieces: readonly Piece[], shapes: ReadonlyMap<string, Shape>): "ok" | "unknown" | "hidden" => {
  for (const p of pieces) {
    if (p.t !== "target") continue;
    const shape = shapes.get(p.ref);
    if (!shape || shape.parent) return "unknown";
    const known = allColumns(shape);
    for (const c of p.columns) {
      const attr = known.get(c);
      if (!attr) return "unknown";
      if (!attr.readable) return "hidden";
    }
  }
  return "ok";
};

/**
 * Turns a checked template into one statement for this caller. Every table in it is either a
 * subquery over the caller's own readable columns or, for an insert target, the caller's own
 * table with a column list checked against the model.
 */
const compile = (def: Definition, pieces: readonly Piece[], shapes: ReadonlyMap<string, Shape>, store: StoreHandle, bound: Bound, params: Params): string => {
  const shapeOf = (ref: string): Shape => {
    const s = shapes.get(ref);
    if (!s) throw broken(def, new TemplateError("model was not loaded"));
    return s;
  };
  const targets = targetColumnsAllowed(pieces, shapes);
  if (targets === "hidden") throw new DataApiError("forbidden_field");
  if (targets === "unknown") throw broken(def, new TemplateError("insert names a column the model does not have"));
  return renderTemplate(pieces, {
    read: (ref) => {
      const shape = shapeOf(ref);
      const conditions = baseConditions(shape);
      return `select ${readableColumns(shape).map(ident).join(", ")} from ${tableOf(shape, store)}${conditions.length > 0 ? ` where ${conditions.join(" and ")}` : ""}`;
    },
    target: (ref, columns) => `${tableOf(shapeOf(ref), store)} (${columns.map(ident).join(", ")})`,
    param: (key) => {
      const b = bound.get(key);
      if (!b) throw broken(def, new TemplateError("parameter was not bound"));
      return params.add(b.text, b.pg);
    },
  });
};

/** Access needed for a definition: read on everything it reads, write on everything it writes. */
const needsOf = (def: Definition): Array<{ ref: string; need: ModelAccess }> => {
  const needs = new Map<string, ModelAccess>();
  for (const r of def.reads) needs.set(r, "read");
  for (const w of def.writes ?? []) needs.set(w, "write");
  return [...needs].map(([ref, need]) => ({ ref, need }));
};

const authorise = async <D extends Definition>(platform: Platform, tenant: TenantContext, listed: (m: { namedQueries: string[]; actions: string[] }) => boolean, load: () => Promise<D | null>) => {
  const manifest = await platform.manifest();
  // The manifest is checked before the definition is looked up, so an unlisted key gets the
  // same answer whether or not it exists.
  if (!listed(manifest)) throw new DataApiError("forbidden_model", "This mini-app is not allowed to use that.");
  const def = await load();
  if (!def) throw new DataApiError("not_found", "That report or action does not exist.");
  const shapes = await shapesFor(platform, manifest, tenant, needsOf(def));
  return { def, shapes };
};

/** SQL that turns one result column into text in the wire format, by its declared type. */
const resultExpr = (type: FieldType, col: string): string => {
  switch (type) {
    case "integer":
    case "money":
      return `round((${col})::numeric)::bigint::text`;
    case "date":
    case "business_date":
      return textExpr("date", `(${col})::date`);
    case "timestamp":
      return textExpr("timestamp", `(${col})::timestamptz`);
    case "json":
    case "quantity":
    case "parent_ref":
      return `to_jsonb(${col})::text`;
    default:
      return `(${col})::text`;
  }
};
const resultKind = (type: FieldType): Kind => (type === "quantity" || type === "parent_ref" ? "json" : type === "ref" ? "uuid" : type);

export const runNamedQuery = async (tenant: TenantContext, raw: unknown): Promise<NamedQueryResponse> => {
  const parsed = NamedQueryRequest.safeParse(raw);
  if (!parsed.success) throw new DataApiError("invalid_request");
  const req = parsed.data;

  const { def, shapes } = await withPlatform(tenant, (platform) =>
    authorise<NamedQueryDefinition>(platform, tenant, (m) => m.namedQueries.includes(req.query), () => platform.namedQuery(req.query)),
  );

  const { pieces } = await checked(def, "query");
  const bound = bindParams(def.params, req.params);
  const visible = def.columns.filter((c) => !c.readableBy || c.readableBy.includes(tenant.role));
  const masked = def.columns.filter((c) => !visible.includes(c)).map((c) => c.key);
  if (visible.length === 0) throw new DataApiError("forbidden_field", "This report only holds details your role cannot see.");
  const hasMaskedFields = [...shapes.values()].some((s) => s.masked.length > 0);

  try {
    // Reports can never write: the template passed the allow list (a select, nothing else), the
    // transaction is read-only before it runs, and it sits inside a subquery.
    return await readOnlyStore(tenant, "report", async (tx, store) => {
      const params = new Params();
      const inner = compile(def, pieces, shapes, store, bound, params);
      const select = visible.map((c, i) => `${resultExpr(c.type, `q.${ident(c.key)}`)} as c${i}`);
      // One row more than asked for, to tell "that is all" from "there is more".
      const text = `select ${select.join(", ")} from (\n${inner}\n) as q limit ${params.add(String(req.limit + 1), "integer")}`;
      const found = await run(tx, text, params.values);
      if (found.length > req.limit) throw new DataApiError("limit", "This report has more rows than were asked for. Narrow it down, or ask for more rows.");
      const rows: Row[] = found.map((r) => {
        const out: Row = {};
        visible.forEach((c, i) => (out[c.key] = decode({ kind: resultKind(c.type) }, r[`c${i}`])));
        return out;
      });
      return { columns: visible.map((c) => ({ key: c.key, label: c.label, type: c.type })), rows, masked };
    });
  } catch (e) {
    throw toDataApiError(e, { op: "named", hasMaskedFields });
  }
};

export const runNamedAction = async (tenant: TenantContext, raw: unknown, requestId: string): Promise<{ affected: number }> => {
  const parsed = NamedActionRequest.safeParse(raw);
  if (!parsed.success) throw new DataApiError("invalid_request");
  const req = parsed.data;

  const { def, shapes, who } = await withPlatform(tenant, async (platform, ids: Ids) => {
    const found = await authorise<NamedActionDefinition>(platform, tenant, (m) => m.actions.includes(req.action), () => platform.namedAction(req.action));
    return { ...found, who: ids };
  });

  const { pieces } = await checked(def, "action");
  const bound = bindParams(def.params, req.params);
  const hasMaskedFields = [...shapes.values()].some((s) => s.masked.length > 0);
  const models = def.writes.flatMap((w) => shapes.get(w)?.def ?? []);

  try {
    return await withStore(apiDb(), tenant, async (tx, store) => {
      await setTimeoutFor(tx, "write");
      const params = new Params();
      const text = compile(def, pieces, shapes, store, bound, params);
      const result = await run(tx, text, params.values);
      // Library actions end in `select ... as affected`. Without that, count the rows the statement touched.
      const reported = result[0]?.affected;
      const n = reported === undefined || reported === null ? result.count : Number(reported);
      const affected = Number.isSafeInteger(n) && n >= 0 ? n : 0;
      // Rules checked at commit (a balanced entry, for example) are checked now, while still
      // acting as the restaurant's role, so a broken rule is reported as such.
      await run(tx, "set constraints all immediate");
      // Back to the server login for the audit row, in the SAME transaction: the change and its
      // audit row commit together or not at all. No caller-chosen SQL runs after this line.
      await run(tx, "set local role none");
      try {
        await writeAudit(tx, tenant, who, {
          action: "data.action", targetType: "named_action", targetId: def.key, requestId,
          meta: { env: tenant.env, app: tenant.appId ?? null, affected, params: Object.keys(req.params).sort() },
        });
      } catch {
        // Our own bookkeeping failed. That is never the caller's fault.
        throw new DataApiError("internal", undefined, "audit write failed");
      }
      return { affected };
    });
  } catch (e) {
    // This also catches a rule that only fires when the transaction commits.
    throw toDataApiError(e, { op: "named", hasMaskedFields, models });
  }
};

// POST /data/v1/batch: writes. All ops run in one transaction, in order. Any failure rolls back
// all of them, together with the audit row and the idempotency record.
//
// How the pieces stay consistent (one transaction, not two):
//   1. Before the store: the manifest, the model definitions and any stored response for the
//      idempotency key are read with the server login, fenced to the token's restaurant.
//   2. Inside `withStore`, as the restaurant's own role: every op.
//   3. Still inside the same transaction: commit-time rules are checked (`set constraints all
//      immediate`), the role is handed back to the server login (`set local role none`), and the
//      audit row and the idempotency record are inserted. Then it commits.
// So there is no moment where the rows exist without their audit row, or where a key is
// recorded for writes that did not happen. If two requests race with the same key, the second
// one's insert of the key fails, its whole transaction rolls back, and it returns the first
// one's stored response.
import { type Actor, BatchRequest, type BatchResponse, CurrencyCode, type RowSource, type TenantContext, Uuid, type WriteOp, toUuid } from "@rms/contracts";
import { type StoreHandle, type Tx, actorText, apiDb, ident, newUuid, withStore } from "@rms/db";
import { shapesFor } from "./access.js";
import { canonical, sha256 } from "./cursor.js";
import { DataApiError, toDataApiError } from "./errors.js";
import { PARENT_SPECS } from "./parent-models.js";
import { type Ids, IdempotencyRace, type StoredResponse, storeResponse, withPlatform, writeAudit } from "./platform.js";
import { type Attr, PG_TYPE, type Shape, baseConditions, childShape, parentShape, tableOf, textExpr } from "./shape.js";
import { NOW_MS, Params, run, setTimeoutFor } from "./sql.js";
import { type ColumnValue, writeColumns } from "./values.js";

/** Longest a whole batch may run, in milliseconds. */
const MAX_BATCH_MS = 30_000;

type Prepared = {
  op: WriteOp;
  shape: Shape;
  columns: ColumnValue[];
  parentRefs: Array<{ attr: Attr; id: string | null }>;
  locationId?: string;
  currency?: string;
};

const sourceFor = (actor: Actor, op: WriteOp["op"]): RowSource => {
  if (actor.type === "connection") return "connection";
  if (actor.type === "job") return "app";
  if (actor.type === "system") return "seed";
  return op === "upsert_by_source" ? "import" : "manual";
};

/** Checks one op's values against the model. No database access, no SQL. */
const prepare = (op: WriteOp, shape: Shape): Prepared => {
  const out: Prepared = { op, shape, columns: [], parentRefs: [] };
  if (op.op === "delete") {
    if (shape.appendOnly) throw new DataApiError("forbidden_model", "These records can be added but never changed or removed.");
    return out;
  }
  if (op.op === "update" && shape.appendOnly) throw new DataApiError("forbidden_model", "These records can be added but never changed or removed.");

  const given = new Set<string>();
  for (const [key, value] of Object.entries(op.values)) {
    const attr = shape.attrs.get(key);
    if (!attr) throw new DataApiError("invalid_request", "One of the details named is not part of this kind of record.");
    if (!attr.readable) throw new DataApiError("forbidden_field");
    if (!attr.settable) throw new DataApiError("invalid_request", `"${attr.label}" is set by RMS and cannot be sent.`);
    // A field tied by a model rule to one the role cannot read: whether the write passes the
    // rule would give the hidden value away, one try at a time. Refused before any rule runs,
    // with the same answer whatever the values are.
    if (shape.guarded.has(key)) throw new DataApiError("forbidden_field", "That detail is tied to one your role cannot see, so your role cannot change it.");
    given.add(key);
    if (attr.system && key === "location_id") {
      if (typeof value !== "string" || !Uuid.safeParse(value).success) throw new DataApiError("invalid_request", "The location is not a valid id.");
      out.locationId = value.toLowerCase();
    } else if (attr.system && key === "currency") {
      if (typeof value !== "string" || !CurrencyCode.safeParse(value).success) throw new DataApiError("invalid_request", "The currency needs to be a three letter code like USD.");
      out.currency = value;
    } else if (attr.kind === "parent_ref") {
      if (value === null) {
        if (attr.required) throw new DataApiError("invalid_request", `"${attr.label}" is required.`);
        out.parentRefs.push({ attr, id: null });
      } else {
        if (typeof value !== "string" || !Uuid.safeParse(value).success) throw new DataApiError("invalid_request", `"${attr.label}" needs a record id.`);
        out.parentRefs.push({ attr, id: value.toLowerCase() });
      }
    } else out.columns.push(...writeColumns(attr, value));
  }

  if (op.op === "update") {
    if (given.size === 0) throw new DataApiError("invalid_request", "There is nothing to change.");
    return out;
  }
  // insert and upsert_by_source: every required field must be there.
  for (const attr of shape.list) {
    if (attr.system || !attr.required || given.has(attr.key)) continue;
    if (!attr.readable) throw new DataApiError("forbidden_field", "This kind of record needs a detail your role cannot set.");
    throw new DataApiError("invalid_request", `"${attr.label}" is required.`);
  }
  return out;
};

/** What the transaction knows about the restaurant's locations: id to currency. Read once. */
type Places = { all: Map<string, string>; allowed: Set<string> };

const loadPlaces = async (tx: Tx, store: StoreHandle, tenant: TenantContext): Promise<Places> => {
  const rows = await run(tx, `select ${ident("id")}::text as id, ${ident("currency")}::text as currency from ${store.parentTable("locations")}`);
  const all = new Map<string, string>(rows.map((r) => [String(r.id), String(r.currency)]));
  const allowed = tenant.locations === "all" ? new Set(all.keys()) : new Set(tenant.locations.map((l) => toUuid(l)).filter((id) => all.has(id)));
  return { all, allowed };
};

const run1 = async (tx: Tx, text: string, p: Params) => run(tx, text, p.values);

type Ctx = {
  tx: Tx;
  store: StoreHandle;
  tenant: TenantContext;
  actor: string;
  places: () => Promise<Places>;
  labels: Map<string, string>;
  /** Shapes of the models that `ref` fields in this batch point into, for this caller. */
  refShapes: ReadonlyMap<string, Shape>;
};

const NO_SUCH_LINK = "One of the linked records does not exist.";

/**
 * A `ref` must point at a row the CALLER can see: looked up as the restaurant's role, so
 * row-level security and the location rule apply. A row at another location, a removed row
 * and a made-up id all get the same answer.
 */
const checkRefs = async (c: Ctx, columns: readonly ColumnValue[]): Promise<void> => {
  for (const col of columns) {
    if (col.refModel === undefined || col.value === null) continue;
    const target = c.refShapes.get(col.refModel);
    if (!target) throw new DataApiError("invalid_request", NO_SUCH_LINK);
    const p = new Params();
    const conditions = [`${ident("id")} = ${p.add(col.value, "uuid")}`, ...baseConditions(target)];
    const rows = await run1(c.tx, `select 1 as found from ${tableOf(target, c.store)} where ${conditions.join(" and ")} limit 1`, p);
    if (rows.length !== 1) throw new DataApiError("invalid_request", NO_SUCH_LINK);
  }
};

/** A location for a new or moved row: inside the token's locations AND one of this restaurant's. */
const checkLocation = async (c: Ctx, given: string | undefined): Promise<string> => {
  const places = await c.places();
  if (given !== undefined) {
    if (!places.allowed.has(given)) throw new DataApiError("forbidden_location");
    return given;
  }
  if (places.allowed.size === 1) return [...places.allowed][0] as string;
  throw new DataApiError("invalid_request", "Say which location this is for.");
};

const defaultCurrency = async (c: Ctx, locationId: string | null): Promise<string> => {
  const places = await c.places();
  if (locationId) {
    const cur = places.all.get(locationId);
    if (cur) return cur;
  }
  const distinct = new Set([...places.allowed].map((id) => places.all.get(id) as string));
  if (distinct.size === 1) return [...distinct][0] as string;
  throw new DataApiError("invalid_request", "Say which currency this is in.");
};

/** Parent links: the id must exist in this restaurant's parent data. Returns id and label columns. */
const parentColumns = async (c: Ctx, refs: Prepared["parentRefs"]): Promise<ColumnValue[]> => {
  const out: ColumnValue[] = [];
  for (const { attr, id } of refs) {
    const labelColumn = attr.extra as string;
    if (id === null) {
      out.push({ column: attr.key, value: null, kind: "uuid" }, { column: labelColumn, value: null, kind: "text" });
      continue;
    }
    const def = attr.def;
    if (!def || def.type !== "parent_ref") throw new DataApiError("internal", undefined, "parent_ref without a definition");
    const cacheKey = `${def.parentModel}:${id}`;
    let label = c.labels.get(cacheKey);
    if (label === undefined) {
      const shape = parentShape(def.parentModel, c.tenant.role, c.tenant.env);
      const p = new Params();
      const conditions = [`${ident("id")} = ${p.add(id, "uuid")}`, ...baseConditions(shape)];
      const rows = await run1(c.tx, `select ${ident(PARENT_SPECS[def.parentModel].labelColumn)}::text as label from ${tableOf(shape, c.store)} where ${conditions.join(" and ")}`, p);
      if (rows.length !== 1) throw new DataApiError("invalid_request", `"${attr.label}" does not point at a record that exists.`);
      label = String(rows[0]?.label ?? "");
      c.labels.set(cacheKey, label);
    }
    out.push({ column: attr.key, value: id, kind: "uuid" }, { column: labelColumn, value: label, kind: "text" });
  }
  return out;
};

const insertRow = async (c: Ctx, w: Prepared, id: string, sourceId: string | null): Promise<void> => {
  const { shape } = w;
  await checkRefs(c, w.columns);
  const p = new Params();
  const names: string[] = [];
  const exprs: string[] = [];
  const put = (column: string, expr: string) => {
    names.push(ident(column));
    exprs.push(expr);
  };
  put("id", p.add(id, "uuid"));
  let locationId: string | null = null;
  if (shape.locationColumn) {
    locationId = await checkLocation(c, w.locationId);
    put("location_id", p.add(locationId, "uuid"));
  }
  if (shape.hasMoney) put("currency", p.add(w.currency ?? (await defaultCurrency(c, locationId)), "text"));
  put("source", p.add(sourceFor(c.tenant.actor, w.op.op), "text"));
  put("source_id", p.add(sourceId, "text"));
  put("created_at", NOW_MS);
  put("created_by", p.add(c.actor, "text"));
  put("updated_at", NOW_MS);
  put("updated_by", p.add(c.actor, "text"));
  for (const col of [...w.columns, ...(await parentColumns(c, w.parentRefs))]) put(col.column, p.add(col.value, PG_TYPE[col.kind]));
  await run1(c.tx, `insert into ${tableOf(shape, c.store)} (${names.join(", ")}) values (${exprs.join(", ")})`, p);
};

const updateRow = async (c: Ctx, w: Prepared, id: string, revive: boolean): Promise<void> => {
  const { shape } = w;
  await checkRefs(c, w.columns);
  const p = new Params();
  const sets: string[] = [];
  if (w.locationId !== undefined) sets.push(`${ident("location_id")} = ${p.add(await checkLocation(c, w.locationId), "uuid")}`);
  if (w.currency !== undefined) sets.push(`${ident("currency")} = ${p.add(w.currency, "text")}`);
  for (const col of [...w.columns, ...(await parentColumns(c, w.parentRefs))]) sets.push(`${ident(col.column)} = ${p.add(col.value, PG_TYPE[col.kind])}`);
  if (revive && shape.softDelete) sets.push(`${ident("deleted_at")} = null`);
  sets.push(`${ident("updated_at")} = ${NOW_MS}`, `${ident("updated_by")} = ${p.add(c.actor, "text")}`);
  const conditions = [`${ident("id")} = ${p.add(id, "uuid")}`, ...baseConditions(shape, { includeDeleted: true })];
  const done = await run1(c.tx, `update ${tableOf(shape, c.store)} set ${sets.join(", ")} where ${conditions.join(" and ")}`, p);
  if (done.count !== 1) throw new DataApiError("not_found");
};

const execute = async (c: Ctx, w: Prepared): Promise<string> => {
  const { op, shape } = w;
  const table = tableOf(shape, c.store);
  switch (op.op) {
    case "insert": {
      const id = (op.id ?? newUuid()).toLowerCase();
      await insertRow(c, w, id, null);
      return id;
    }
    case "update": {
      const id = op.id.toLowerCase();
      const p = new Params();
      const conditions = [`${ident("id")} = ${p.add(id, "uuid")}`, ...baseConditions(shape)];
      // Locks the row, so the check below and the update see the same version.
      const rows = await run1(c.tx, `select ${textExpr("timestamp", ident("updated_at"))} as u from ${table} where ${conditions.join(" and ")} for update`, p);
      if (rows.length !== 1) throw new DataApiError("not_found");
      if (op.ifUpdatedAt !== undefined && new Date(op.ifUpdatedAt).toISOString() !== String(rows[0]?.u)) {
        throw new DataApiError("conflict", "This record was changed by someone else. Load it again before saving.");
      }
      await updateRow(c, w, id, false);
      return id;
    }
    case "delete": {
      const id = op.id.toLowerCase();
      const p = new Params();
      const conditions = [`${ident("id")} = ${p.add(id, "uuid")}`, ...baseConditions(shape)];
      const text = shape.softDelete
        ? `update ${table} set ${ident("deleted_at")} = ${NOW_MS}, ${ident("updated_at")} = ${NOW_MS}, ${ident("updated_by")} = ${p.add(c.actor, "text")} where ${conditions.join(" and ")}`
        : `delete from ${table} where ${conditions.join(" and ")}`;
      const done = await run1(c.tx, text, p);
      if (done.count !== 1) throw new DataApiError("not_found");
      return id;
    }
    case "upsert_by_source": {
      const p = new Params();
      const conditions = [
        `${ident("source")} = ${p.add(sourceFor(c.tenant.actor, op.op), "text")}`,
        `${ident("source_id")} = ${p.add(op.sourceId, "text")}`,
        ...baseConditions(shape, { includeDeleted: true }),
      ];
      // Locks the row for the update that follows. An append-only table grants no update, so no lock there.
      const rows = await run1(c.tx, `select ${ident("id")}::text as id from ${table} where ${conditions.join(" and ")}${shape.appendOnly ? "" : " for update"}`, p);
      const existing = rows[0]?.id;
      if (typeof existing === "string") {
        // An append-only row is never changed: importing the same source id again is a no-op.
        if (!shape.appendOnly) await updateRow(c, w, existing, true);
        return existing;
      }
      const id = newUuid();
      await insertRow(c, w, id, op.sourceId);
      return id;
    }
  }
};

/** A parent model named in a write is refused as read-only, before the strict shape check hides why. */
const namesParentData = (raw: unknown): boolean => {
  const ops = (raw as { ops?: unknown } | null)?.ops;
  return Array.isArray(ops) && ops.some((o) => typeof (o as { model?: unknown } | null)?.model === "string" && ((o as { model: string }).model).startsWith("parent."));
};

export const runBatch = async (tenant: TenantContext, raw: unknown, requestId: string): Promise<BatchResponse> => {
  const parsed = BatchRequest.safeParse(raw);
  if (!parsed.success) throw new DataApiError(namesParentData(raw) ? "read_only" : "invalid_request");
  const req = parsed.data;
  const fingerprint = sha256(canonical(req.ops));

  const replay = (stored: StoredResponse): BatchResponse => {
    if (stored.fingerprint !== fingerprint) throw new DataApiError("conflict", "That request key was already used for a different request.");
    return stored.body as BatchResponse;
  };

  const { shapes, refShapes, ids, stored } = await withPlatform(tenant, async (platform, ids: Ids) => {
    const manifest = await platform.manifest();
    const models = [...new Set(req.ops.map((o) => o.model))];
    const shapes = await shapesFor(platform, manifest, tenant, models.map((ref) => ({ ref, need: "write" as const })));
    // The models that `ref` values point into. The mini-app needs no access to them: they are
    // only used to check that a linked row exists and the caller can see it.
    const targets = new Set<string>();
    for (const op of req.ops) {
      if (op.op === "delete") continue;
      for (const key of Object.keys(op.values)) {
        const def = shapes.get(op.model)?.attrs.get(key)?.def;
        if (def?.type === "ref") targets.add(def.model);
      }
    }
    const refShapes = new Map<string, Shape>();
    for (const [key, def] of await platform.models([...targets])) refShapes.set(key, childShape(def, tenant.role));
    const stored = req.idempotencyKey !== undefined ? await platform.storedResponse(req.idempotencyKey) : null;
    return { shapes, refShapes, ids, stored };
  });
  if (stored) return replay(stored);

  // The models being written, so a broken model rule is reported as what it is.
  const models = [...shapes.values()].flatMap((s) => (s.def ? [s.def] : []));

  // Every op is checked against its model before the first statement runs.
  const prepared = req.ops.map((op) => prepare(op, shapes.get(op.model) as Shape));

  try {
    return await withStore(apiDb(), tenant, async (tx, store) => {
      await setTimeoutFor(tx, "write");
      let places: Promise<Places> | undefined;
      const ctx: Ctx = { tx, store, tenant, actor: actorText(tenant.actor), places: () => (places ??= loadPlaces(tx, store, tenant)), labels: new Map(), refShapes };
      const results: BatchResponse["results"] = [];
      // The database limit is per statement. This caps the whole batch, so many slow ops cannot hold a transaction open.
      const deadline = Date.now() + MAX_BATCH_MS;
      for (const w of prepared) {
        if (Date.now() > deadline) throw new DataApiError("limit", "That took too long. Please send fewer changes at once.");
        try {
          results.push({ op: w.op.op, model: w.op.model, id: await execute(ctx, w) });
        } catch (e) {
          throw toDataApiError(e, { op: w.op.op === "delete" ? "delete" : "write", models });
        }
      }
      // Rules checked at commit (a balanced entry, for example) are checked now, while still
      // acting as the restaurant's role, so a broken rule is reported as such.
      try {
        await run(tx, "set constraints all immediate");
      } catch (e) {
        throw toDataApiError(e, { op: "write", models });
      }
      // Back to the server login for the audit row and the idempotency record, in the SAME
      // transaction. Nothing from the request runs as SQL after this line.
      await run(tx, "set local role none");
      const byOp: Record<string, number> = {};
      const byModel: Record<string, number> = {};
      for (const r of results) {
        byOp[r.op] = (byOp[r.op] ?? 0) + 1;
        byModel[r.model] = (byModel[r.model] ?? 0) + 1;
      }
      const body: BatchResponse = { results };
      try {
        await writeAudit(tx, tenant, ids, {
          action: "data.batch", targetType: "app", targetId: tenant.appId ?? null, requestId,
          meta: { env: tenant.env, ops: results.length, byOp, byModel, idempotent: req.idempotencyKey !== undefined },
        });
        if (req.idempotencyKey !== undefined) await storeResponse(tx, tenant, ids, req.idempotencyKey, { fingerprint, body });
      } catch (e) {
        if (e instanceof IdempotencyRace) throw e;
        // Our own bookkeeping failed. That is never the caller's fault, whatever the database said.
        throw new DataApiError("internal", undefined, "audit or idempotency write failed");
      }
      return body;
    });
  } catch (e) {
    const err = e instanceof IdempotencyRace ? new DataApiError("conflict", "The same request is already being handled. Please try again.") : toDataApiError(e, { op: "write", models });
    // A request that lost a race with its own twin (same key) gets the twin's stored response,
    // whatever it tripped over on the way (the twin may already have removed or changed the rows).
    if (req.idempotencyKey !== undefined) {
      const key = req.idempotencyKey;
      const first = await withPlatform(tenant, (platform) => platform.storedResponse(key));
      if (first) return replay(first);
    }
    throw err;
  }
};

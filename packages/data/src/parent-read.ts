// Reads one parent-data table for RMS's own screens (Menu, Staff, Locations).
//
// This is NOT a mini-app route: there is no manifest to check, because the caller is RMS
// itself, acting for a signed-in member. Everything else is the same as a Data API read, and
// uses the same pieces so there is one set of rules:
//   * the restaurant, role and locations come ONLY from the verified session's TenantContext,
//   * the table is one of the ten fixed parent tables, in that restaurant's own parent schema,
//   * a column the role may not read (staff pay and contact details, for staff) is left out,
//   * a member tied to some locations sees only rows of those locations,
//   * the transaction is read-only, and parent tables are read-only to restaurant roles anyway,
//   * a restaurant whose store is not ready gets a plain "still being set up" answer (409).
import { ParentModelKey, type ParentListResponse, type Row, type TenantContext, toUuid } from "@rms/contracts";
import { apiDb, ident, withOrg } from "@rms/db";
import { DataApiError } from "./errors.js";
import { PARENT_SPECS } from "./parent-models.js";
import { baseConditions, decode, parentShape, selectExprs, tableOf } from "./shape.js";
import { Params, readOnlyStore, run } from "./sql.js";

/** The wire shape is `ParentListResponse` in @rms/contracts. */
export type ParentRead = ParentListResponse;

/** More rows than any parent table of one restaurant should ever hold. Above it, the read is refused. */
const MAX_ROWS = 5000;

/**
 * `tenant` MUST be the context built from a verified session (`requireSession`).
 * `model` is checked against the fixed list here, whatever the caller already did.
 */
export const readParent = async (tenant: TenantContext, model: unknown): Promise<ParentRead> => {
  const parsed = ParentModelKey.safeParse(model);
  if (!parsed.success) throw new DataApiError("not_found", "That list does not exist.");
  const key = parsed.data;
  // Screens show live data only. A build or preview context has no business here.
  if (tenant.env !== "live") throw new DataApiError("unauthenticated");

  // A restaurant whose store is still being made (or has been taken away) has nothing to read
  // yet. Say so plainly, rather than letting the read fail on tables that are not there.
  const orgUuid = toUuid(tenant.orgId);
  const [org] = await withOrg(apiDb(), orgUuid, (tx) => run(tx, "select store_ready from platform.organizations where id = ($1::text)::uuid", [orgUuid]));
  if (org?.store_ready !== true) throw new DataApiError("conflict", "Your restaurant is still being set up. Give it a moment, then try again.");

  const shape = parentShape(key, tenant.role, tenant.env);
  const wanted = shape.list.filter((a) => a.readable);
  const select = wanted.map((a, i) => `${selectExprs(a)[0] as string} as c${i}`);
  const conditions = baseConditions(shape);
  const where = conditions.length > 0 ? ` where ${conditions.join(" and ")}` : "";
  const order = [PARENT_SPECS[key].labelColumn, "id"].map(ident).join(", ");

  return readOnlyStore(tenant, "read", async (tx, store) => {
    const params = new Params();
    const text = `select ${select.join(", ")} from ${tableOf(shape, store)}${where} order by ${order} limit ${params.add(String(MAX_ROWS + 1), "integer")}`;
    const found = await run(tx, text, params.values);
    if (found.length > MAX_ROWS) throw new DataApiError("limit", "That list is too long to show at once.");
    const rows: Row[] = found.map((r) => {
      const out: Row = {};
      wanted.forEach((a, i) => (out[a.key] = decode(a, r[`c${i}`])));
      return out;
    });
    return { model: key, name: PARENT_SPECS[key].name, columns: wanted.map((a) => ({ key: a.key, label: a.label, type: a.kind })), rows, masked: shape.masked };
  });
};

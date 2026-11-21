// "Bring in my sales": the Demo POS sync. Two parts, in this order.
//
//   1. Ask the POS, through the gateway. List the tools again first: a changed list stops the
//      sync before anything is read or loaded. Then `list_locations`, `get_stock_items` and every
//      dated tool for the last eight weeks, in chunks under DEMO_POS.maxRangeDays. Every call is
//      checked against the grants and written to `mcp_calls`; every answer is parsed with its
//      output shape. The POS's locations must match the restaurant's by name.
//   2. Load, with the one loader: `seedDemoBooks` from @rms/seed, as the hidden "demo data"
//      mini-app, through the Data API, repeatable (a second run adds nothing).
//
// DEMO SHORTCUT (say it in the demo notes): the loader regenerates the numbers from the same
// template the Demo POS serves (`loadDemoBooks` takes a template, not rows). So today the tool
// answers are CHECKED against what was loaded, not fed into it: after loading, the weekly net
// sales added up from `get_daily_sales` must equal `prime_cost_by_week` to the cent, or the
// sync answers `failed`. A loader that takes rows from any connected system is later work.
import {
  DEMO_POS,
  type DemoPosToolName,
  SYNC_CONSUMER,
  type SyncResult,
  toPublicId,
  toUuid,
} from "@rms/contracts";
import { adminDb, apiDb, withOrg } from "@rms/db";
import { DEFAULT_SALES_END, type SeedBooksResult, seedDemoBooks } from "@rms/seed";
import { TOOLS_CHANGED_TEXT } from "./connections.js";
import { templateForName } from "./demo-pos/data.js";
import { type GatewayOptions, GatewayError, type GatewayTenant, callTool, listTools, loadConnection, toolsHash } from "./gateway.js";

const DAY_MS = 86_400_000;
const addDays = (iso: string, days: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
/** The Monday of the week a date falls in. */
const mondayOf = (iso: string): string => addDays(iso, -((new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7));

export const SYNC_WEEKS = 8;

/** Splits [from, to] into ranges the POS accepts in one call. */
export const chunks = (from: string, to: string, maxDays: number = DEMO_POS.maxRangeDays): { from: string; to: string }[] => {
  const out: { from: string; to: string }[] = [];
  for (let start = from; start <= to; start = addDays(start, maxDays - 1)) {
    const end = addDays(start, maxDays - 2);
    out.push({ from: start, to: end < to ? end : to });
    if (end >= to) break;
  }
  return out;
};

const DATED: DemoPosToolName[] = ["get_daily_sales", "get_payments", "get_adjustments", "get_labour", "get_delivery_payouts", "get_vendor_bills", "get_stock_counts"];

export type SyncInput = {
  tenant: GatewayTenant;
  /** The owner, from the session: the loaded rows are recorded as written by them. */
  ownerUserId: string;
  connectionId: string;
  /** Test seam: how the books are loaded. Default: `seedDemoBooks` on the admin connection, live store only. */
  loadBooks?: typeof seedDemoBooks;
};

const empty = { salesDays: 0, labourDays: 0, deliveryPayouts: 0, vendorBills: 0, stockCounts: 0, posted: 0 };
const failed = (message: string, from: string | null = null, to: string | null = null): SyncResult => ({ status: "failed", from, to, counts: empty, message });
const dollars = (minor: number): string => `$${(minor / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

/** Lock the connection row for the length of the sync, so two presses at once cannot both load. */
const BUSY = "55P03";

/**
 * Runs the sync for one Demo POS connection of the session's restaurant. Returns a plain-words
 * `SyncResult`; a `failed` result changes nothing in the books. Throws `GatewayError` only for
 * a connection that is not this restaurant's (`not_found`) or one already syncing (`denied`).
 */
export const syncDemoPos = async (input: SyncInput, opts: GatewayOptions = {}): Promise<SyncResult> => {
  const { tenant, connectionId } = input;
  const conn = await loadConnection(tenant, connectionId);
  if (conn.catalog_key !== DEMO_POS.catalogKey) return failed("RMS cannot bring information in from this system yet.");
  const orgUuid = toUuid(tenant.orgId);

  try {
    return await withOrg(apiDb(), orgUuid, async (lock) => {
      // NO KEY UPDATE: a second sync waits for nothing and is told it is busy, while the gateway's
      // own `mcp_calls` rows (which only need a key-share lock on this row) still go in.
      await lock`select id from platform.mcp_connections where id = ${conn.id} and org_id = ${orgUuid} for no key update nowait`;
      return runSync(input, conn, lock, opts);
    });
  } catch (e) {
    if ((e as { code?: string }).code === BUSY) throw new GatewayError("denied", "Already bringing in your sales. This takes a few seconds.");
    throw e;
  }
};

const runSync = async (
  input: SyncInput,
  conn: Awaited<ReturnType<typeof loadConnection>>,
  lock: Parameters<Parameters<typeof withOrg>[2]>[0],
  opts: GatewayOptions,
): Promise<SyncResult> => {
  const { tenant, connectionId, ownerUserId } = input;
  const orgUuid = toUuid(tenant.orgId);
  if (conn.status === "needs_approval") return failed("Demo POS is waiting for your yes. Have a look at what RMS will read first.");
  if (conn.status !== "connected") return failed("Demo POS is not connected. Connect it first.");

  // ---- 1. the tool list must be the one the owner allowed
  const now = await listTools(tenant, connectionId, opts);
  const [stored] = await lock<{ tools_hash: string | null }[]>`select tools_hash from platform.mcp_connections where id = ${conn.id} and org_id = ${orgUuid}`;
  const hash = toolsHash(now);
  if (stored?.tools_hash !== hash) {
    await lock`update platform.mcp_connections set status = 'needs_approval', tools = ${lock.json(now as never)}, tools_hash = ${hash}, checked_at = now()
               where id = ${conn.id} and org_id = ${orgUuid}`;
    return failed(TOOLS_CHANGED_TEXT);
  }

  // ---- 2. ask the POS
  const to = DEFAULT_SALES_END;
  const from = addDays(to, -(SYNC_WEEKS * 7 - 1));
  const ask = (tool: DemoPosToolName, args: Record<string, unknown>) => callTool(tenant, connectionId, SYNC_CONSUMER, tool, args, opts);

  const { locations } = (await ask("list_locations", {})) as { locations: { key: string; name: string }[] };
  const [org] = await lock<{ name: string }[]>`select name from platform.organizations where id = ${orgUuid}`;
  const template = org ? templateForName(org.name) : null;
  if (!template || locations.length === 0) {
    await lock`update platform.mcp_connections set last_synced_at = now() where id = ${conn.id} and org_id = ${orgUuid}`;
    return { status: "nothing_new", from, to, counts: empty, message: "Demo POS has no sales for this restaurant, so nothing was brought in." };
  }
  const ours = new Set((await lock<{ name: string }[]>`select name from platform.locations where org_id = ${orgUuid}`).map((l) => l.name));
  if (locations.some((l) => !ours.has(l.name))) {
    return failed("Demo POS has a location this restaurant does not have. Nothing was brought in.", from, to);
  }

  await ask("get_stock_items", {});
  const weekly = new Map<string, number>();
  // One day early, so the opening stock count comes too.
  for (const range of chunks(addDays(from, -1), to)) {
    for (const tool of DATED) {
      const answer = await ask(tool, { from: range.from, to: range.to });
      if (tool === "get_daily_sales") {
        for (const d of (answer as { days: { businessDate: string; netSalesMinor: number }[] }).days) {
          if (d.businessDate < from) continue;
          const week = mondayOf(d.businessDate);
          weekly.set(week, (weekly.get(week) ?? 0) + d.netSalesMinor);
        }
      }
    }
  }

  // ---- 3. load, with the one loader (live store only: the draft store has its own sample numbers)
  const started = Date.now();
  const load = input.loadBooks ?? seedDemoBooks;
  const result: SeedBooksResult = await load(adminDb(), { orgUuid, template, ownerUserId, withSales: true, draftSamples: false });
  const books = result.books;
  console.info(JSON.stringify({ at: "demo-pos-sync", org: toPublicId("org", orgUuid), loadMs: Date.now() - started }));
  if (!books) return failed("The sales could not be brought in. Please try again.", from, to);

  // ---- 4. the check: what the POS said, week by week, against what the reports now show
  const reported = new Map(books.weeks.map((w) => [w.weekStart, w.netSalesMinor]));
  const mismatch = weekly.size !== SYNC_WEEKS || [...weekly].some(([week, net]) => reported.get(week) !== net);
  if (mismatch) return failed("The sales brought in do not add up to what Demo POS reported. Please try again, or tell us.", from, to);

  const posted = books.posted.salesDays + books.posted.vendorBills + books.posted.labourDays + books.posted.stockCounts;
  const counts = {
    salesDays: books.rows.sales_day ?? 0,
    labourDays: books.rows.labour_day ?? 0,
    deliveryPayouts: books.rows.delivery_payout ?? 0,
    vendorBills: books.rows.vendor_bill ?? 0,
    stockCounts: books.rows.stock_count ?? 0,
    posted,
  };
  const lastWeek = `Last week's sales: ${dollars(books.lastWeek.netSalesMinor)}.`;
  const status = posted === 0 ? "nothing_new" : "ok";
  const message =
    status === "ok"
      ? `Brought in ${SYNC_WEEKS} weeks of sales for ${locations.length} location${locations.length === 1 ? "" : "s"}. ${lastWeek}`
      : `Your sales are already up to date. ${lastWeek}`;

  await lock`update platform.mcp_connections set last_synced_at = now(), checked_at = now() where id = ${conn.id} and org_id = ${orgUuid}`;
  // The outbox is written by jobs and platform code only (admin connection).
  await adminDb()`insert into platform.outbox (topic, org_id, payload)
                  values ('connection.synced', ${orgUuid}, ${adminDb().json({ connectionId: toPublicId("con", conn.id), status, posted, salesDays: counts.salesDays } as never)})`;
  return { status, from, to, counts, message };
};

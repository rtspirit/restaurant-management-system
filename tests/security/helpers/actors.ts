// Ways to act as one restaurant, and the canary sweep that watches every one of them.
//
// Every helper here names the restaurant the caller is ("actor"). Whatever comes back, rows or
// error text, is searched for the OTHER restaurant's canary string before the test sees it.
// A hit throws CanaryLeak, which no test catches. So any test in the suite that reads across
// restaurants fails, even if that test was looking at something else.
import { type Role, type TenantContext, toPublicId } from "@rms/contracts";
import { type AskResult, type Sql, type StoreHandle, type Tx, adminDb, apiDb, askQuery, closeAll, inAskEnvelope, mintAskLogin, openAsk, withOrg, withStore } from "@rms/db";
import { CANARY, ORG, type OrgKey, ids, other } from "./world.js";

// ---------------------------------------------------------------- the sweep
export class CanaryLeak extends Error {
  constructor(actor: OrgKey | "nobody", owner: OrgKey, label: string) {
    super(`CROSS-RESTAURANT READ: acting as ${actor}, saw restaurant ${owner}'s canary in: ${label}`);
    this.name = "CanaryLeak";
  }
}

let checks = 0;
/** How many results this test file has swept so far. */
export const sweepCount = (): number => checks;

/** Everything in a value as one lowercase string: rows, nested JSON, column names, binary as text. */
export const haystack = (value: unknown): string => {
  const parts: string[] = [];
  const columns = (value as { columns?: { name: string }[] } | null)?.columns;
  if (Array.isArray(columns)) parts.push(columns.map((c) => c.name).join(","));
  if (typeof value === "string") parts.push(value);
  else {
    parts.push(
      JSON.stringify(value, (_k, v: unknown) => {
        if (typeof v === "bigint") return v.toString();
        if (v instanceof Uint8Array) return Buffer.from(v).toString("utf8");
        const b = v as { type?: string; data?: number[] } | null;
        if (b && b.type === "Buffer" && Array.isArray(b.data)) return Buffer.from(b.data).toString("utf8");
        return v;
      }) ?? "",
    );
  }
  return parts.join("\n").toLowerCase();
};

/** True when `value` contains `needle` anywhere. The suite's one detector. */
export const holds = (value: unknown, needle: string): boolean => haystack(value).includes(needle.toLowerCase());

const errorText = (e: unknown): string => {
  const x = e as Record<string, unknown> | null;
  if (!x || typeof x !== "object") return String(e);
  return ["message", "detail", "hint", "where", "query", "schema_name", "table_name", "column_name", "constraint_name"].map((k) => String(x[k] ?? "")).join("\n");
};

/**
 * Fails if `value` holds a canary the actor must never see.
 * `actor` null means "no restaurant at all" (the server login with no restaurant set): both canaries are forbidden.
 */
export const sweep = (actor: OrgKey | null, label: string, value: unknown): void => {
  checks++;
  const forbidden: OrgKey[] = actor === null ? ["a", "b"] : [other(actor)];
  for (const owner of forbidden) if (holds(value, CANARY[owner])) throw new CanaryLeak(actor ?? "nobody", owner, label);
};

const guarded = async <T>(actor: OrgKey | null, label: string, run: () => Promise<T>): Promise<T> => {
  let value: T;
  try {
    value = await run();
  } catch (e) {
    if (!(e instanceof CanaryLeak)) sweep(actor, `${label} (error text)`, errorText(e));
    throw e;
  }
  sweep(actor, label, value);
  return value;
};

/**
 * What happened to an attack: "allowed", or the database's SQLSTATE code (for example "42501").
 * Tests assert the exact code, so a query that fails for an unrelated reason does not count as a wall holding.
 */
export const outcome = async (attempt: Promise<unknown>): Promise<string> => {
  try {
    await attempt;
    return "allowed";
  } catch (e) {
    if (e instanceof CanaryLeak) throw e;
    const code = (e as { code?: unknown }).code;
    return typeof code === "string" ? code : `error: ${(e as Error).message}`;
  }
};

/** SQLSTATE codes the tests expect. */
export const DENIED = "42501"; // insufficient_privilege
export const READ_ONLY = "25006"; // read_only_sql_transaction
export const RLS = "42501"; // a row-level security refusal uses the same code as a missing grant
export const FK = "23503"; // foreign_key_violation

// ---------------------------------------------------------------- acting as a restaurant
const USER = { a: "0193a3c0-9191-7000-8000-0000000000a1", b: "0193a3c0-9191-7000-8000-0000000000b1" } as const;

export type StoreOpts = { env?: "live" | "draft"; role?: Role; locations?: "all" | string[] };
export type Row = Record<string, unknown>;
/**
 * `sweepAs` overrides whose canary is forbidden. Used ONLY by the "prove the sweep can fail" tests,
 * which connect with the right credentials and check that the sweep then raises the alarm.
 */
export type Watch = { sweepAs?: OrgKey };

/** A tenant context as the middleware would build it from a verified token. `locations` are raw uuids. */
export const tenant = (k: OrgKey, opts: StoreOpts = {}): TenantContext => ({
  orgId: toPublicId("org", ORG[k].uuid),
  storePrefix: ORG[k].prefix,
  actor: { type: "user", id: toPublicId("usr", USER[k]) },
  role: opts.role ?? "owner",
  locations: opts.locations === undefined || opts.locations === "all" ? "all" : (opts.locations.map((l) => toPublicId("loc", l)) as [`loc_${string}`, ...`loc_${string}`[]]),
  env: opts.env ?? "live",
  appId: toPublicId("app", ids(k).app),
});

/**
 * EVERY helper below rolls its transaction back, whether the attack worked or not.
 * An attack that gets through (installing an extension, writing a row, creating a large object)
 * must never be left in the shared database. The test still sees the result.
 */
const ROLLBACK = Symbol("rollback");
export const rolledBack = async <T>(run: (keep: (value: T) => never) => Promise<unknown>): Promise<T> => {
  let out: { value: T } | undefined;
  try {
    await run((value) => {
      out = { value };
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  return (out as { value: T }).value;
};

/** The restaurant-facing server login with platform rows fenced to restaurant `k`. Rolled back. */
export const asOrg = <T>(k: OrgKey, fn: (tx: Tx) => Promise<T>, watch: Watch = {}): Promise<T> =>
  guarded(watch.sweepAs ?? k, `server login fenced to ${k}`, () => rolledBack<T>((keep) => withOrg(apiDb(), ORG[k].uuid, async (tx) => keep(await fn(tx)))));

/** The restaurant-facing server login with NO restaurant set. It must see no restaurant's rows at all. Rolled back. */
export const asNoOrg = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
  guarded(null, "server login with no restaurant set", () => rolledBack<T>((keep) => apiDb().begin(async (tx) => keep(await fn(tx)))));

/** Inside restaurant `k`'s store, as its Data API role (live by default, draft on request). Rolled back. */
export const inStore = <T>(k: OrgKey, fn: (tx: Tx, store: StoreHandle) => Promise<T>, opts: StoreOpts & Watch = {}): Promise<T> =>
  guarded(opts.sweepAs ?? k, `${opts.env ?? "live"} store role of ${k}`, () => rolledBack<T>((keep) => withStore(apiDb(), tenant(k, opts), async (tx, store) => keep(await fn(tx, store)))));

/** One statement inside restaurant `k`'s store. The usual shape of an attack. */
export const storeSql = (k: OrgKey, text: string, opts: StoreOpts & Watch = {}): Promise<Row[]> => inStore(k, (tx) => tx.unsafe(text) as Promise<Row[]>, opts);

/** One statement as the server login fenced to restaurant `k`. */
export const orgSql = (k: OrgKey, text: string, watch: Watch = {}): Promise<Row[]> => asOrg(k, (tx) => tx.unsafe(text) as Promise<Row[]>, watch);

/** One statement as the server login with no restaurant set. */
export const noOrgSql = (text: string): Promise<Row[]> => asNoOrg((tx) => tx.unsafe(text) as Promise<Row[]>);

// ---------------------------------------------------------------- the Ask login
export type AskHandle = {
  /** The product path: one model-written SELECT through the envelope. `locations` defaults to every location. */
  query(text: string, maxRows?: number, locations?: "all" | string[]): Promise<AskResult>;
  /** Any statement inside the read-only envelope. */
  envelope(text: string): Promise<Row[]>;
  /**
   * One statement straight on the connection, outside the envelope and outside any transaction.
   * It is NOT rolled back: use it only for session settings and reads (poisoning a pooled connection).
   */
  raw(text: string): Promise<Row[]>;
  /** A read-write transaction outside the envelope, so refusals are about rights, not about read-only. Rolled back. */
  readWrite(text: string): Promise<Row[]>;
  /** A plain transaction outside the envelope, with whatever defaults the login has. Rolled back. */
  plain(text: string): Promise<Row[]>;
  readonly sql: Sql;
};

const askConnections = new Map<OrgKey, Sql>();

/** Logs in as restaurant `k`'s Ask role (a fresh 15-minute login, one per test file). */
export const askAs = async (k: OrgKey, watch: Watch = {}): Promise<AskHandle> => {
  let sql = askConnections.get(k);
  if (!sql) {
    sql = openAsk(await mintAskLogin(adminDb(), ORG[k].uuid));
    askConnections.set(k, sql);
  }
  const conn = sql;
  const actor = watch.sweepAs ?? k;
  const label = `Ask login of ${k}`;
  return {
    sql: conn,
    query: (text, maxRows, locations) => guarded(actor, label, () => askQuery(conn, text, maxRows, locations)),
    envelope: (text) => guarded(actor, `${label} (envelope)`, () => inAskEnvelope(conn, (tx) => tx.unsafe(text) as Promise<Row[]>)),
    raw: (text) => guarded(actor, `${label} (raw)`, () => conn.unsafe(text) as Promise<Row[]>),
    readWrite: (text) => guarded(actor, `${label} (read-write)`, () => rolledBack<Row[]>((keep) => conn.begin("read write", async (tx) => keep((await tx.unsafe(text)) as Row[])))),
    plain: (text) => guarded(actor, `${label} (plain transaction)`, () => rolledBack<Row[]>((keep) => conn.begin(async (tx) => keep((await tx.unsafe(text)) as Row[])))),
  };
};

/** Drops the cached Ask connection for `k`, so the next `askAs(k)` mints a new login. */
export const forgetAsk = async (k: OrgKey): Promise<void> => {
  await askConnections.get(k)?.end({ timeout: 2 });
  askConnections.delete(k);
};

/** Closes every connection this test file opened. Registered for every file in setup.ts. */
export const closeConnections = async (): Promise<void> => {
  await Promise.all([...askConnections.values()].map((s) => s.end({ timeout: 2 })));
  askConnections.clear();
  await closeAll();
};

/** The platform login. For fixtures and for "the right credentials can do this" controls only. Never swept. */
export const platform = (): Sql => adminDb();

/** A statement or more as the platform login, always rolled back. For controls that would otherwise change the test world. */
export const asPlatform = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => rolledBack<T>((keep) => adminDb().begin(async (tx) => keep(await fn(tx))));

/** One statement as the platform login, rolled back. */
export const platformSql = (text: string): Promise<Row[]> => asPlatform((tx) => tx.unsafe(text) as Promise<Row[]>);

/** What a refusal looked like: code, message and the constraint that fired, if any. */
export const refusal = async (attempt: Promise<unknown>): Promise<{ code: string; message: string; constraint: string }> => {
  try {
    await attempt;
    return { code: "allowed", message: "", constraint: "" };
  } catch (e) {
    if (e instanceof CanaryLeak) throw e;
    const x = e as { code?: unknown; message?: unknown; constraint_name?: unknown };
    return { code: typeof x.code === "string" ? x.code : "error", message: String(x.message ?? ""), constraint: String(x.constraint_name ?? "") };
  }
};

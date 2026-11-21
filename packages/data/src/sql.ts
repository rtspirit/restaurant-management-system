// The one place the Data API hands text to the database.
//
// Rules this file enforces:
//   * Every value is a bound parameter. A value is sent as text and cast in SQL to a type that
//     comes from a fixed list, so the driver never guesses a type and no value becomes SQL text.
//   * Every statement goes through `run`, which forces the one-statement protocol. A second
//     statement in the same text is refused by the database before anything runs.
import type { TenantContext } from "@rms/contracts";
import { type StoreHandle, type Tx, apiDb, withStore } from "@rms/db";

/** The only casts a parameter can get. A closed list: never built from a request. */
export type PgType = "text" | "bigint" | "integer" | "numeric" | "boolean" | "date" | "timestamptz" | "uuid" | "jsonb";

export type ParamValue = string | null;

export class Params {
  readonly values: ParamValue[] = [];
  /** Adds a bound value and returns its placeholder, for example `($3::text)::uuid`. */
  add(value: ParamValue, type: PgType): string {
    this.values.push(value);
    const n = this.values.length;
    return type === "text" ? `$${n}::text` : `($${n}::text)::${type}`;
  }
}

export type DbRow = Record<string, unknown>;
export type DbResult = DbRow[] & { count: number };

/** Runs exactly one statement with bound values. */
export const run = async (tx: Tx, text: string, values: readonly ParamValue[] = []): Promise<DbResult> =>
  (await tx.unsafe(text, values as ParamValue[], { simple: false })) as unknown as DbResult;

/** "Now", cut to milliseconds, the precision `ifUpdatedAt` compares at. */
export const NOW_MS = "date_trunc('milliseconds', clock_timestamp())";

/** Per-transaction time limits in milliseconds. */
export const TIMEOUT_MS = { read: 8000, write: 15000, report: 10000 } as const;

export const setTimeoutFor = (tx: Tx, kind: keyof typeof TIMEOUT_MS): Promise<DbResult> =>
  run(tx, "select set_config('statement_timeout', $1::text, true)", [String(TIMEOUT_MS[kind])]);

/**
 * Enters the caller's store for reading only. The transaction is made read-only before `fn`
 * runs, so nothing `fn` sends can change a row, whatever its text says.
 * `tenant` must come from a verified token.
 */
export const readOnlyStore = <T>(tenant: TenantContext, kind: "read" | "report", fn: (tx: Tx, store: StoreHandle) => Promise<T>): Promise<T> =>
  withStore(apiDb(), tenant, async (tx, store) => {
    await setTimeoutFor(tx, kind);
    await run(tx, "set transaction read only");
    return fn(tx, store);
  });

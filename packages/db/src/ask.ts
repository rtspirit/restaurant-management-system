// The Ask agent's database path. Lead-owned. The ONLY way to run model-written SQL.
//
// Walls, from the outside in:
//   1. A parser check in the Ask tool (Wave 2, task K): one SELECT, allow-listed functions.
//   2. This wrapper: read-only transaction, settings reset, local time limit, the statement
//      wrapped as a subquery and sent with a bound parameter so it must be ONE select.
//   3. The login itself: it exists for one restaurant, can read only that restaurant's live and
//      parent schemas, is a member of no other role, and stops working after 15 minutes.
// Walls 2 and 3 are built so that they hold even when wall 1 has a bug.
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import postgres from "postgres";
import { ASK_QUERY_LIMITS } from "@rms/contracts";
import type { Sql, Tx } from "./index.js";

/** SCRAM-SHA-256 verifier for a password, so the password itself never reaches the database or its logs. */
export const scramVerifier = (password: string, iterations = 4096): string => {
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password.normalize("NFKC"), salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
};

export type AskLogin = { role: string; password: string };

/**
 * Makes a fresh 15-minute login for one restaurant's Ask role. Admin connection only.
 * `orgUuid` MUST come from the signed-in session. The password is returned to the caller,
 * used for one Ask session, and never stored.
 */
export const mintAskLogin = async (adminSql: Sql, orgUuid: string): Promise<AskLogin> => {
  const password = randomBytes(32).toString("base64url");
  const [row] = await adminSql<{ role: string }[]>`select platform.set_ask_login(${orgUuid}, ${scramVerifier(password)}) as role`;
  if (!row?.role || !/^o_[0-9a-f]{12}_ask$/.test(row.role)) throw new Error("Ask login was not created");
  return { role: row.role, password };
};

/**
 * Opens a connection as an Ask login. One connection, no prepared-statement cache.
 * `ASK_DATABASE_HOST` is host:port. `ASK_DATABASE_USER_SUFFIX` is empty locally and
 * ".<project-ref>" on the hosted pooler.
 */
export const openAsk = (login: AskLogin): Sql => {
  const hostPort = process.env.ASK_DATABASE_HOST;
  if (!hostPort) throw new Error("ASK_DATABASE_HOST is not set");
  const [host, port] = hostPort.split(":");
  if (!host) throw new Error("ASK_DATABASE_HOST is not set");
  const local = host === "127.0.0.1" || host === "localhost";
  return postgres({
    host,
    port: Number(port ?? 5432),
    database: process.env.ASK_DATABASE_NAME ?? "postgres",
    username: `${login.role}${process.env.ASK_DATABASE_USER_SUFFIX ?? ""}`,
    password: login.password,
    ssl: local ? false : "require",
    max: 1,
    prepare: false,
    idle_timeout: 5,
    connect_timeout: 10,
    onnotice: () => {},
  });
};

const ROLLBACK = Symbol("rollback");

/**
 * Runs `fn` inside the Ask envelope and always rolls back:
 *   begin read only -> reset all (drops anything an earlier session left on a pooled
 *   connection) -> local time limit -> release session locks -> a first query, after which
 *   Postgres refuses to turn the transaction read-write.
 * Exported for the security tests. Product code uses `askQuery`.
 */
export const inAskEnvelope = async <T>(askSql: Sql, fn: (tx: Tx) => Promise<T>): Promise<T> => {
  let out: T | undefined;
  try {
    await askSql.begin("transaction read only", async (tx) => {
      await tx.unsafe("reset all");
      await tx.unsafe(`set local statement_timeout = '${ASK_QUERY_LIMITS.timeoutMs}ms'`);
      await tx.unsafe("set local lock_timeout = '1s'");
      await tx.unsafe("set local work_mem = '16MB'");
      await tx`select pg_advisory_unlock_all()`;
      out = await fn(tx);
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  return out as T;
};

export type AskResult = { columns: string[]; rows: Record<string, unknown>[]; truncated: boolean };

/**
 * Runs one model-written SELECT. The text is placed inside a subquery and the row cap is a
 * bound parameter, so the server parses it as a single prepared statement: a second
 * statement, a write, a SET or any other command is a syntax error before anything runs.
 */
export const askQuery = async (askSql: Sql, text: string, maxRows: number = ASK_QUERY_LIMITS.maxRows): Promise<AskResult> => {
  if (text.length > 8000) throw new Error("Query is too long");
  const cap = Math.min(Math.max(1, Math.trunc(maxRows)), ASK_QUERY_LIMITS.maxRows);
  return inAskEnvelope(askSql, async (tx) => {
    const res = await tx.unsafe(`select * from (\n${text}\n) as _rms_ask limit $1`, [cap + 1]);
    const rows = res.slice(0, cap) as Record<string, unknown>[];
    return { columns: res.columns.map((c) => c.name), rows, truncated: res.length > cap };
  });
};

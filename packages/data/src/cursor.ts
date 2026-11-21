// Paging cursors. Opaque to the caller, signed by the server, and tied to the exact question
// they came from: same restaurant, mini-app, user, role, locations, environment, model,
// filter and sort. A cursor from any other question is refused.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { TOKEN } from "@rms/contracts";
import { DataApiError } from "./errors.js";

/** JSON with object keys in a fixed order, so equal values always give equal text. */
export const canonical = (v: unknown): string => {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
};

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("base64url");

let cached: Buffer | undefined;
/** A key used only for cursors, derived from the token secret so the two uses never share a key. */
const key = (): Buffer => {
  if (cached) return cached;
  const secret = process.env[TOKEN.secretEnv];
  if (!secret || secret.length < 32) throw new Error(`${TOKEN.secretEnv} must be set and at least 32 characters`);
  cached = createHmac("sha256", secret).update("rms:data-api:cursor:v1").digest();
  return cached;
};

const sign = (payload: string): string => createHmac("sha256", key()).update(payload).digest("base64url");

export type CursorKeys = Array<string | null>;

/** `binding` is the hash of everything the cursor is tied to. `keys` are the last row's sort values. */
export const encodeCursor = (binding: string, keys: CursorKeys): string => {
  const payload = Buffer.from(JSON.stringify({ b: binding, k: keys }), "utf8").toString("base64url");
  return `${payload}.${sign(payload)}`;
};

const refuse = (): never => {
  throw new DataApiError("invalid_request", "That page marker does not belong to this list. Start again from the first page.");
};

export const decodeCursor = (cursor: string, binding: string, keyCount: number): CursorKeys => {
  const parts = cursor.split(".");
  if (parts.length !== 2) return refuse();
  const [payload, mac] = parts as [string, string];
  const want = Buffer.from(sign(payload), "utf8");
  const got = Buffer.from(mac, "utf8");
  if (want.length !== got.length || !timingSafeEqual(want, got)) return refuse();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return refuse();
  }
  const c = parsed as { b?: unknown; k?: unknown };
  if (c.b !== binding || !Array.isArray(c.k) || c.k.length !== keyCount) return refuse();
  if (!c.k.every((x) => x === null || typeof x === "string")) return refuse();
  return c.k as CursorKeys;
};

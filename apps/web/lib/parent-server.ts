// Server-side loader for the restaurant's own set-up lists (menu, staff, locations).
// Use from Server Components only.
//
// The API decides whose lists these are from the session's access token. Nothing here names
// a restaurant, and nothing is read from the address, a form or a header.
import { ParentListResponse, type ParentModelKey } from "@rms/contracts";
import { apiUrl } from "./me";
import { createClient } from "./supabase/server";

export type ParentRow = Record<string, unknown>;

export type ParentLists<K extends ParentModelKey> =
  | { status: "ready"; lists: Record<K, ParentListResponse> }
  /** The API refused the session. The shell layout is already dealing with it. */
  | { status: "signed-out" }
  /** The API did not answer, or answered with something unexpected. */
  | { status: "unavailable" };

/** Loads several lists at once. All of them, or a plain reason why not. */
export async function loadParentLists<K extends ParentModelKey>(models: readonly K[]): Promise<ParentLists<K>> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return { status: "signed-out" };

  try {
    const replies = await Promise.all(
      models.map((model) => fetch(`${apiUrl()}/auth/parent/${model}`, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" })),
    );
    if (replies.some((r) => r.status === 401 || r.status === 403)) return { status: "signed-out" };
    if (replies.some((r) => !r.ok)) return { status: "unavailable" };
    const lists = {} as Record<K, ParentListResponse>;
    for (const [i, model] of models.entries()) lists[model] = ParentListResponse.parse(await (replies[i] as Response).json());
    return { status: "ready", lists };
  } catch {
    // The reason stays on the server. The owner is told the list is not loading.
    return { status: "unavailable" };
  }
}

// ------------------------------------------------------------------ reading a row

export const text = (row: ParentRow, key: string): string => (typeof row[key] === "string" ? (row[key] as string) : "");
export const whole = (row: ParentRow, key: string): number | null => (typeof row[key] === "number" ? (row[key] as number) : null);

// ------------------------------------------------------------------ plain-word formats

/** Whole cents to "$18.00". Empty when there is no amount. */
export function money(minor: number | null, currency = "USD"): string {
  if (minor === null) return "";
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minor / 100);
}

/** "17:00" or "17:00:00" to "5:00 pm". Anything else is shown as it is. */
export function clock(value: unknown): string {
  const m = typeof value === "string" ? /^(\d{1,2}):(\d{2})/.exec(value) : null;
  if (!m) return typeof value === "string" ? value : "";
  const hour = Number(m[1]);
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:${m[2]} ${hour < 12 ? "am" : "pm"}`;
}

/** "2023-04-10" to "10 Apr 2023". */
export function day(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(value)) return "";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${value.slice(0, 10)}T00:00:00Z`));
}

/** "1 person", "14 people". */
export const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

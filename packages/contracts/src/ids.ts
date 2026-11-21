import { z } from "zod";

/** Raw uuid v7, generated in application code. */
export const Uuid = z.uuid();
export type Uuid = z.infer<typeof Uuid>;

/**
 * Public ids = prefix + "_" + the uuid's 32 hex chars. Used for platform objects in tokens,
 * platform APIs and URLs. Rows inside a restaurant's store use raw uuids everywhere
 * (including `location_id`): convert at the edge with `toUuid` / `toPublicId`.
 */
const prefixed = <P extends string>(prefix: P) =>
  z.string().regex(new RegExp(`^${prefix}_[0-9a-f]{32}$`)) as unknown as z.ZodType<`${P}_${string}`>;

export const OrgId = prefixed("org");
export const UserId = prefixed("usr");
export const LocationId = prefixed("loc");
export const AppId = prefixed("app");
export const AppVersionId = prefixed("ver");
export const SessionId = prefixed("ses");
export const RunId = prefixed("run");
export const ChangeSetId = prefixed("chg");
export const ListingId = prefixed("lst");
export const ConnectionId = prefixed("con");

export type OrgId = z.infer<typeof OrgId>;
export type UserId = z.infer<typeof UserId>;
export type LocationId = z.infer<typeof LocationId>;
export type AppId = z.infer<typeof AppId>;
export type AppVersionId = z.infer<typeof AppVersionId>;
export type SessionId = z.infer<typeof SessionId>;
export type RunId = z.infer<typeof RunId>;
export type ChangeSetId = z.infer<typeof ChangeSetId>;
export type ListingId = z.infer<typeof ListingId>;
export type ConnectionId = z.infer<typeof ConnectionId>;

export type IdPrefix = "org" | "usr" | "loc" | "app" | "ver" | "ses" | "run" | "chg" | "lst" | "con";

export const toPublicId = <P extends IdPrefix>(prefix: P, uuid: string): `${P}_${string}` =>
  `${prefix}_${Uuid.parse(uuid).replaceAll("-", "").toLowerCase()}`;

export const toUuid = (publicId: string): string => {
  const m = /^[a-z]{3}_([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})$/.exec(publicId);
  if (!m) throw new Error("Not a public id");
  return `${m[1]}-${m[2]}-${m[3]}-${m[4]}-${m[5]}`;
};

/**
 * Each restaurant's store prefix: "o_" + 12 hex chars. Assigned once by the platform,
 * unique on the org row. NEVER derived from, or accepted in, a request.
 */
export const StorePrefix = z.string().regex(/^o_[0-9a-f]{12}$/);
export type StorePrefix = z.infer<typeof StorePrefix>;

export const storeSchemas = (prefix: StorePrefix) =>
  ({ parent: `${prefix}_parent`, live: prefix, draft: `${prefix}_draft` }) as const;

/** `ask` is a LOGIN role for one restaurant only. Demo: the Ask agent is owner-only (ADR 0002). */
export const storeRoles = (prefix: StorePrefix) =>
  ({ rw: `${prefix}_rw`, draftRw: `${prefix}_draft_rw`, ask: `${prefix}_ask` }) as const;

/** Identifier for models, fields, named queries and actions. Safe to place in SQL after quoting. */
export const Ident = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/);
export type Ident = z.infer<typeof Ident>;

/** Parent data models. Read-only to restaurants and agents, always. */
export const ParentModelKey = z.enum([
  "profile", "locations", "staff", "jobs", "menu_categories", "menu_items",
  "menu_modifiers", "tax_rates", "licences", "equipment",
]);
export type ParentModelKey = z.infer<typeof ParentModelKey>;

export const ParentModelRef = z.templateLiteral(["parent.", ParentModelKey]);
export type ParentModelRef = z.infer<typeof ParentModelRef>;

/** A child model key, or "parent.<key>" for parent data. The ONLY way to name a model on the wire. */
export const ModelRef = z.union([ParentModelRef, Ident]);
export type ModelRef = z.infer<typeof ModelRef>;

export const isParentRef = (ref: string): ref is ParentModelRef => ref.startsWith("parent.");

/** Rejects deeply nested JSON before a recursive schema parses it (stack safety). */
export const maxDepth = (limit: number) => (value: unknown): boolean => {
  const stack: Array<[unknown, number]> = [[value, 1]];
  while (stack.length > 0) {
    const [v, d] = stack.pop() as [unknown, number];
    if (d > limit) return false;
    if (v !== null && typeof v === "object") for (const child of Object.values(v)) stack.push([child, d + 1]);
  }
  return true;
};

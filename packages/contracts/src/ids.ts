import { z } from "zod";

/** Raw uuid v7, generated in application code. */
export const Uuid = z.uuid();

/** Public ids carry a prefix so a wrong kind of id is caught at the edge. */
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

/**
 * Each restaurant's store prefix: "o_" + 12 hex chars. Assigned once by the platform
 * and stored on the org row. NEVER derived from, or accepted in, a request.
 */
export const StorePrefix = z.string().regex(/^o_[0-9a-f]{12}$/);
export type StorePrefix = z.infer<typeof StorePrefix>;

export const storeSchemas = (prefix: StorePrefix) =>
  ({ parent: `${prefix}_parent`, live: prefix, draft: `${prefix}_draft` }) as const;

export const storeRoles = (prefix: StorePrefix) =>
  ({ rw: `${prefix}_rw`, draftRw: `${prefix}_draft_rw`, ask: `${prefix}_ask` }) as const;

/** Identifier for models, fields and named queries. Safe to place in SQL after quoting. */
export const Ident = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/);
export type Ident = z.infer<typeof Ident>;

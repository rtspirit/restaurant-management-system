import { z } from "zod";
import { AppId, LocationId, OrgId, RunId, StorePrefix, UserId } from "./ids.js";

/** Demo roles. The full plan adds admin and manager. */
export const Role = z.enum(["owner", "staff"]);
export type Role = z.infer<typeof Role>;

export const StoreEnv = z.enum(["live", "draft"]);
export type StoreEnv = z.infer<typeof StoreEnv>;

/** "all" = every location of the org. Otherwise the user's assigned locations. */
export const LocationScope = z.union([z.literal("all"), z.array(LocationId).min(1)]);
export type LocationScope = z.infer<typeof LocationScope>;

const baseClaims = {
  /** Issuer is always "rms". */
  iss: z.literal("rms"),
  iat: z.number().int(),
  exp: z.number().int(),
  jti: z.string().min(8),
  org: OrgId,
};

/**
 * App token: handed by the RMS shell to a mini-app's screens. Short-lived (minutes).
 * Audience "data" = accepted only by the Data API.
 */
export const AppTokenClaims = z.object({
  ...baseClaims,
  kind: z.literal("app"),
  aud: z.literal("data"),
  sub: UserId,
  app: AppId,
  role: Role,
  loc: LocationScope,
  env: StoreEnv,
});
export type AppTokenClaims = z.infer<typeof AppTokenClaims>;

/**
 * Run token: held by a build sandbox. Draft store only, one mini-app, one run.
 * It can never read or write live data.
 */
export const RunTokenClaims = z.object({
  ...baseClaims,
  kind: z.literal("run"),
  aud: z.literal("data"),
  sub: UserId,
  app: AppId,
  run: RunId,
  role: Role,
  loc: LocationScope,
  env: z.literal("draft"),
});
export type RunTokenClaims = z.infer<typeof RunTokenClaims>;

/** Connection token: one per restaurant for an MCP server we host (Demo POS). */
export const ConnectionTokenClaims = z.object({
  ...baseClaims,
  kind: z.literal("connection"),
  aud: z.literal("mcp"),
  connection: z.string().min(1),
});
export type ConnectionTokenClaims = z.infer<typeof ConnectionTokenClaims>;

export const DataTokenClaims = z.discriminatedUnion("kind", [AppTokenClaims, RunTokenClaims]);
export type DataTokenClaims = z.infer<typeof DataTokenClaims>;

/**
 * What every server handler works from after authentication. Built ONLY from a verified
 * session or token plus a platform lookup. No field here may ever be filled from a request
 * body, query string, path parameter or header other than the credential itself.
 */
export type TenantContext = {
  readonly orgId: OrgId;
  readonly storePrefix: StorePrefix;
  readonly userId: UserId;
  readonly role: Role;
  readonly locations: LocationScope;
  readonly env: StoreEnv;
  readonly appId?: AppId;
  readonly runId?: RunId;
};

/** Token lifetimes in seconds. */
export const TOKEN_TTL = { app: 10 * 60, run: 45 * 60, connection: 60 * 60 } as const;

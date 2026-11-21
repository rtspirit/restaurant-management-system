import { z } from "zod";
import { AppId, AppVersionId, ConnectionId, LocationId, OrgId, RunId, StorePrefix, UserId } from "./ids.js";

/** Demo roles. The full plan adds admin and manager. */
export const Role = z.enum(["owner", "staff"]);
export type Role = z.infer<typeof Role>;

export const StoreEnv = z.enum(["live", "draft"]);
export type StoreEnv = z.infer<typeof StoreEnv>;

/** "all" = every location of the org. Otherwise the user's assigned locations. */
export const LocationScope = z.union([z.literal("all"), z.array(LocationId).min(1)]);
export type LocationScope = z.infer<typeof LocationScope>;

/**
 * How RMS tokens are made and checked. One place, so the minter (task A / N), the verifier
 * (Data API) and the attack tests agree.
 * - Signed JWT, HS256, key from env `RMS_TOKEN_SECRET` (at least 32 bytes). Verify with `jose`.
 * - Verifiers MUST pin `algorithms: ["HS256"]`, check `iss`, `aud`, `exp`, and parse the
 *   claims with the zod schema for the expected kind. Unknown kinds are rejected.
 * - Sent as `Authorization: Bearer <token>`. Never in a URL, never in a cookie on the apps domain.
 */
export const TOKEN = {
  alg: "HS256",
  typ: "rms+jwt",
  issuer: "rms",
  header: "authorization",
  scheme: "Bearer",
  secretEnv: "RMS_TOKEN_SECRET",
  clockToleranceSec: 5,
} as const;

/** Token lifetimes in seconds. */
export const TOKEN_TTL = { app: 10 * 60, run: 45 * 60, connection: 60 * 60 } as const;

const baseClaims = {
  iss: z.literal(TOKEN.issuer),
  iat: z.number().int(),
  exp: z.number().int(),
  jti: z.string().min(8),
  org: OrgId,
};

/**
 * App token: handed by the RMS shell to a mini-app's screens. Short-lived.
 * `ver` pins the published version whose manifest the Data API enforces.
 */
export const AppTokenClaims = z.strictObject({
  ...baseClaims,
  kind: z.literal("app"),
  aud: z.literal("data"),
  sub: UserId,
  app: AppId,
  ver: AppVersionId,
  role: Role,
  loc: LocationScope,
  env: z.literal("live"),
});
export type AppTokenClaims = z.infer<typeof AppTokenClaims>;

/**
 * Run token: held by a build sandbox and its preview. Draft store only, one mini-app, one run.
 * The manifest enforced is the run's working manifest, looked up by (app, run). It can never
 * read or write live data: `env` is the literal "draft" and the Data API maps it to the draft role.
 */
export const RunTokenClaims = z.strictObject({
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

/** Connection token: one per restaurant per connection, for an MCP server we host (Demo POS). */
export const ConnectionTokenClaims = z.strictObject({
  ...baseClaims,
  kind: z.literal("connection"),
  aud: z.literal("mcp"),
  connection: ConnectionId,
});
export type ConnectionTokenClaims = z.infer<typeof ConnectionTokenClaims>;

export const DataTokenClaims = z.discriminatedUnion("kind", [AppTokenClaims, RunTokenClaims]);
export type DataTokenClaims = z.infer<typeof DataTokenClaims>;

/** Who is acting. Imports, jobs and the seed have no signed-in user. */
export const Actor = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user"), id: UserId }),
  z.object({ type: z.literal("job"), id: z.string() }),
  z.object({ type: z.literal("connection"), id: ConnectionId }),
  z.object({ type: z.literal("system"), id: z.string() }),
]);
export type Actor = z.infer<typeof Actor>;

/**
 * What every server handler works from after authentication. Built ONLY from a verified
 * session or token plus a platform lookup. No field here may ever be filled from a request
 * body, query string, path parameter or header other than the credential itself.
 */
export type TenantContext = {
  readonly orgId: OrgId;
  readonly storePrefix: StorePrefix;
  readonly actor: Actor;
  readonly role: Role;
  readonly locations: LocationScope;
  readonly env: StoreEnv;
  readonly appId?: AppId;
  readonly appVersionId?: AppVersionId;
  readonly runId?: RunId;
};

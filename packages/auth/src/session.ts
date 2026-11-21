// Who is signed in, and which restaurant are they acting for. Lead-owned.
import { createRemoteJWKSet, jwtVerify } from "jose";
import { type DataTokenClaims, type LocationScope, type Role, StorePrefix, type TenantContext, toPublicId, toUuid } from "@rms/contracts";
import { type Sql, adminDb, apiDb, withOrg } from "@rms/db";

export class AuthError extends Error {
  constructor(readonly reason: "signed_out" | "no_restaurant" | "not_staff" | "not_allowed") {
    super(reason);
  }
}

const supabaseUrl = (): string => {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error("SUPABASE_URL is not set");
  return url.replace(/\/$/, "");
};

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

export type SignedInUser = { userUuid: string; email: string | null };

/**
 * Verifies a Supabase access token (asymmetric signing keys, checked against the project's
 * published keys). Returns the user's id. Throws AuthError("signed_out") on anything else.
 */
export const verifySupabaseToken = async (accessToken: string | null | undefined): Promise<SignedInUser> => {
  if (!accessToken) throw new AuthError("signed_out");
  jwks ??= createRemoteJWKSet(new URL(`${supabaseUrl()}/auth/v1/.well-known/jwks.json`));
  try {
    const { payload } = await jwtVerify(accessToken, jwks, {
      issuer: `${supabaseUrl()}/auth/v1`,
      audience: "authenticated",
      algorithms: ["ES256", "RS256", "EdDSA"],
    });
    if (typeof payload.sub !== "string" || payload.role !== "authenticated") throw new AuthError("signed_out");
    return { userUuid: payload.sub, email: typeof payload.email === "string" ? payload.email : null };
  } catch {
    throw new AuthError("signed_out");
  }
};

export type Membership = { orgUuid: string; memberUuid: string; role: Role; storePrefix: string; orgName: string; storeReady: boolean };

export const membershipsFor = async (userUuid: string, sql: Sql = apiDb()): Promise<Membership[]> => {
  const rows = await sql<{ org_id: string; member_id: string; role: Role; store_prefix: string; org_name: string; store_ready: boolean }[]>`
    select * from platform.memberships_for(${userUuid})`;
  return rows.map((r) => ({ orgUuid: r.org_id, memberUuid: r.member_id, role: r.role, storePrefix: r.store_prefix, orgName: r.org_name, storeReady: r.store_ready }));
};

const locationsFor = async (orgUuid: string, memberUuid: string): Promise<LocationScope> => {
  const rows = await withOrg(apiDb(), orgUuid, (tx) => tx<{ location_id: string }[]>`select location_id from platform.member_locations where member_id = ${memberUuid}`);
  const ids = rows.map((r) => toPublicId("loc", r.location_id));
  return ids.length > 0 ? (ids as [typeof ids[number], ...typeof ids]) : "all";
};

/**
 * The tenant context for a signed-in user's own RMS session (live store, no mini-app).
 * Demo: a user belongs to one restaurant. The org is taken from the membership row, never
 * from the request.
 */
export const tenantForUser = async (user: SignedInUser): Promise<TenantContext> => {
  const [m] = await membershipsFor(user.userUuid);
  if (!m) throw new AuthError("no_restaurant");
  return {
    orgId: toPublicId("org", m.orgUuid),
    storePrefix: StorePrefix.parse(m.storePrefix),
    actor: { type: "user", id: toPublicId("usr", user.userUuid) },
    role: m.role,
    locations: await locationsFor(m.orgUuid, m.memberUuid),
    env: "live",
  };
};

/**
 * The tenant context for a verified app or run token. Everything comes from the signed claims
 * plus one platform lookup for the store prefix. A token for a suspended or unknown org fails.
 */
export const tenantForDataToken = async (claims: DataTokenClaims): Promise<TenantContext> => {
  const orgUuid = toUuid(claims.org);
  const [org] = await withOrg(apiDb(), orgUuid, (tx) => tx<{ store_prefix: string }[]>`
    select store_prefix from platform.organizations where id = ${orgUuid} and status = 'active' and store_ready`);
  if (!org) throw new AuthError("no_restaurant");
  return {
    orgId: claims.org,
    storePrefix: StorePrefix.parse(org.store_prefix),
    actor: { type: "user", id: claims.sub },
    role: claims.role,
    locations: claims.loc,
    env: claims.env,
    appId: claims.app,
    ...(claims.kind === "app" ? { appVersionId: claims.ver } : { runId: claims.run }),
  };
};

/** Maintainers are a separate list. Being a restaurant owner never makes someone staff. */
export const requireStaffUser = async (user: SignedInUser): Promise<{ staffUuid: string; name: string }> => {
  const [row] = await adminDb()<{ id: string; name: string }[]>`select id, name from platform.staff_users where user_id = ${user.userUuid}`;
  if (!row) throw new AuthError("not_staff");
  return { staffUuid: row.id, name: row.name };
};

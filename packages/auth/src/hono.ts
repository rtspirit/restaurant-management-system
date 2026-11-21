// Hono middleware. Every API route gets its identity from one of these three, never from the request body.
import type { Context, MiddlewareHandler } from "hono";
import type { DataTokenClaims, TenantContext } from "@rms/contracts";
import { AuthError, type SignedInUser, requireStaffUser, tenantForDataToken, tenantForUser, verifySupabaseToken } from "./session.js";
import { TokenError, bearer, verifyDataToken } from "./tokens.js";

export type SessionEnv = { Variables: { user: SignedInUser; tenant: TenantContext } };
export type UserEnv = { Variables: { user: SignedInUser } };
export type StaffEnv = { Variables: { user: SignedInUser; staff: { staffUuid: string; name: string } } };
export type DataEnv = { Variables: { claims: DataTokenClaims; tenant: TenantContext } };

const deny = (c: Context, status: 401 | 403, code: string, message: string) =>
  c.json({ error: { code, message, requestId: crypto.randomUUID() } }, status);

const handle = (c: Context, e: unknown) => {
  if (e instanceof TokenError) return deny(c, 401, "unauthenticated", "Please sign in again.");
  if (e instanceof AuthError) {
    if (e.reason === "signed_out") return deny(c, 401, "unauthenticated", "Please sign in again.");
    if (e.reason === "no_restaurant") return deny(c, 403, "forbidden_role", "This account is not set up with a restaurant yet.");
    return deny(c, 403, "forbidden_role", "You do not have access to this.");
  }
  throw e;
};

/** A signed-in person, who may not have a restaurant yet (sign-up and onboarding). */
export const requireUser: MiddlewareHandler<UserEnv> = async (c, next) => {
  try {
    c.set("user", await verifySupabaseToken(bearer(c.req.header("authorization"))));
  } catch (e) {
    return handle(c, e);
  }
  await next();
};

/** A signed-in restaurant member. Sets `tenant` for their own restaurant, live store. */
export const requireSession: MiddlewareHandler<SessionEnv> = async (c, next) => {
  try {
    const user = await verifySupabaseToken(bearer(c.req.header("authorization")));
    c.set("user", user);
    c.set("tenant", await tenantForUser(user));
  } catch (e) {
    return handle(c, e);
  }
  await next();
};

/** A maintainer. */
export const requireStaff: MiddlewareHandler<StaffEnv> = async (c, next) => {
  try {
    const user = await verifySupabaseToken(bearer(c.req.header("authorization")));
    c.set("user", user);
    c.set("staff", await requireStaffUser(user));
  } catch (e) {
    return handle(c, e);
  }
  await next();
};

/** A mini-app or build sandbox presenting an RMS app or run token. Used by the Data API only. */
export const requireDataToken: MiddlewareHandler<DataEnv> = async (c, next) => {
  try {
    const claims = await verifyDataToken(bearer(c.req.header("authorization")));
    c.set("claims", claims);
    c.set("tenant", await tenantForDataToken(claims));
  } catch (e) {
    return handle(c, e);
  }
  await next();
};

// RMS tokens: the signed credentials mini-apps, build sandboxes and connections present.
// Lead-owned. See TOKEN in @rms/contracts for the rules both sides follow.
import { SignJWT, jwtVerify } from "jose";
import {
  AppTokenClaims,
  ConnectionTokenClaims,
  DataTokenClaims,
  RunTokenClaims,
  TOKEN,
  TOKEN_TTL,
} from "@rms/contracts";

export class TokenError extends Error {
  constructor(readonly reason: "missing" | "invalid" | "expired" | "wrong_kind") {
    super(`token ${reason}`);
  }
}

const key = (): Uint8Array => {
  const secret = process.env[TOKEN.secretEnv];
  if (!secret || secret.length < 32) throw new Error(`${TOKEN.secretEnv} must be set and at least 32 characters`);
  return new TextEncoder().encode(secret);
};

type Unsigned<T> = Omit<T, "iss" | "iat" | "exp" | "jti">;

const sign = async (claims: Record<string, unknown>, ttlSec: number): Promise<string> => {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ ...claims, iss: TOKEN.issuer, iat: now, exp: now + ttlSec, jti: crypto.randomUUID() })
    .setProtectedHeader({ alg: TOKEN.alg, typ: TOKEN.typ })
    .sign(key());
};

/** For a published mini-app's screens. Live store, one app, one version, one user. */
export const mintAppToken = async (c: Unsigned<AppTokenClaims>) => sign(AppTokenClaims.omit({ iss: true, iat: true, exp: true, jti: true }).parse(c), TOKEN_TTL.app);

/** For a build sandbox and its preview. Draft store only. */
export const mintRunToken = async (c: Unsigned<RunTokenClaims>) => sign(RunTokenClaims.omit({ iss: true, iat: true, exp: true, jti: true }).parse(c), TOKEN_TTL.run);

/** For an MCP server we host (Demo POS). One per restaurant per connection. */
export const mintConnectionToken = async (c: Unsigned<ConnectionTokenClaims>) =>
  sign(ConnectionTokenClaims.omit({ iss: true, iat: true, exp: true, jti: true }).parse(c), TOKEN_TTL.connection);

const verify = async (token: string | undefined | null, audience: "data" | "mcp"): Promise<unknown> => {
  if (!token) throw new TokenError("missing");
  try {
    const { payload, protectedHeader } = await jwtVerify(token, key(), {
      algorithms: [TOKEN.alg],
      issuer: TOKEN.issuer,
      audience,
      clockTolerance: TOKEN.clockToleranceSec,
      requiredClaims: ["exp", "iat", "jti"],
    });
    if (protectedHeader.typ !== TOKEN.typ) throw new TokenError("invalid");
    return payload;
  } catch (e) {
    if (e instanceof TokenError) throw e;
    const code = (e as { code?: string }).code;
    throw new TokenError(code === "ERR_JWT_EXPIRED" ? "expired" : "invalid");
  }
};

/** Verifies an app or run token for the Data API. Throws TokenError. Never returns partial claims. */
export const verifyDataToken = async (token: string | undefined | null): Promise<DataTokenClaims> => {
  const parsed = DataTokenClaims.safeParse(await verify(token, "data"));
  if (!parsed.success) throw new TokenError("wrong_kind");
  return parsed.data;
};

export const verifyConnectionToken = async (token: string | undefined | null): Promise<ConnectionTokenClaims> => {
  const parsed = ConnectionTokenClaims.safeParse(await verify(token, "mcp"));
  if (!parsed.success) throw new TokenError("wrong_kind");
  return parsed.data;
};

/** Reads `Authorization: Bearer <token>`. Tokens are never accepted from a URL or a cookie. */
export const bearer = (headerValue: string | undefined | null): string | null => {
  if (!headerValue) return null;
  const m = /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(headerValue.trim());
  return m?.[1] ?? null;
};

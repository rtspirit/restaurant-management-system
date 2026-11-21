// Token forging by hand, with node:crypto only. A signing library refuses to make most of the
// broken tokens an attacker would send (no algorithm, wrong type, missing claims), so the attack
// tests build them byte by byte.
import { createHmac, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { toPublicId } from "@rms/contracts";
import { mintAppToken, mintRunToken } from "@rms/auth";
import { ORG, type AnyOrgKey, type OrgKey, ids } from "./world.js";

const part = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
export const nowSec = (): number => Math.floor(Date.now() / 1000);

export const RMS_HEADER = { alg: "HS256", typ: "rms+jwt" } as const;

/** A token signed with HMAC-SHA256 (or 384/512) over whatever header and claims are given. */
export const hmacToken = (claims: object, secret: string | Buffer, header: object = RMS_HEADER, hash: "sha256" | "sha384" | "sha512" = "sha256"): string => {
  const body = `${part(header)}.${part(claims)}`;
  return `${body}.${createHmac(hash, secret).update(body).digest("base64url")}`;
};

/** A token with no signature at all. */
export const unsignedToken = (claims: object, header: object = { alg: "none", typ: "rms+jwt" }): string => `${part(header)}.${part(claims)}.`;

/** A fresh ES256 key pair nobody trusts, and a token signed with it. */
export const strangerKey = () => generateKeyPairSync("ec", { namedCurve: "P-256" });
export const es256Token = (claims: object, header: object, privateKey: ReturnType<typeof strangerKey>["privateKey"]): string => {
  const body = `${part(header)}.${part(claims)}`;
  return `${body}.${cryptoSign("sha256", Buffer.from(body), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
};

export const decode = (token: string): { header: Record<string, unknown>; claims: Record<string, unknown>; signature: string } => {
  const [h, p, s] = token.split(".") as [string, string, string];
  return { header: JSON.parse(Buffer.from(h, "base64url").toString()), claims: JSON.parse(Buffer.from(p, "base64url").toString()), signature: s };
};

/** The same token with some claims changed and the ORIGINAL signature kept. */
export const tampered = (token: string, patch: Record<string, unknown>): string => {
  const [h, , s] = token.split(".") as [string, string, string];
  return `${h}.${part({ ...decode(token).claims, ...patch })}.${s}`;
};

/** The real signing secret of the local stack. Used to test what the verifier does with a correctly signed but wrong token. */
export const realSecret = (): string => process.env.RMS_TOKEN_SECRET as string;

const USER = { a: "0193a3c0-9191-7000-8000-0000000000a1", b: "0193a3c0-9191-7000-8000-0000000000b1", c: "0193a3c0-9191-7000-8000-0000000000c1", d: "0193a3c0-9191-7000-8000-0000000000d1" } as const;

export type ClaimOpts = { role?: "owner" | "staff"; loc?: "all" | string[]; app?: string; ver?: string; run?: string };

/** The claims of an honest app token for restaurant `k`, before signing. */
export const appClaims = (k: AnyOrgKey, opts: ClaimOpts = {}) => {
  const own = k === "a" || k === "b" ? ids(k) : ids("a");
  return {
    org: toPublicId("org", ORG[k].uuid),
    sub: toPublicId("usr", USER[k]),
    app: toPublicId("app", opts.app ?? own.app),
    ver: toPublicId("ver", opts.ver ?? own.appVersion),
    role: opts.role ?? "owner",
    loc: opts.loc === undefined || opts.loc === "all" ? ("all" as const) : opts.loc.map((l) => toPublicId("loc", l)),
    kind: "app" as const,
    aud: "data" as const,
    env: "live" as const,
  };
};

export const runClaims = (k: AnyOrgKey, opts: ClaimOpts = {}) => {
  const { ver: _ver, ...rest } = appClaims(k, opts);
  return { ...rest, kind: "run" as const, env: "draft" as const, run: toPublicId("run", opts.run ?? (k === "a" || k === "b" ? ids(k).run : ids("a").run)) };
};

/** Standard claims the minter adds. */
export const stamped = <T extends object>(claims: T, life = 60): T & { iss: string; iat: number; exp: number; jti: string } => ({ iss: "rms", iat: nowSec(), exp: nowSec() + life, jti: crypto.randomUUID() as string, ...claims });

/** Honest tokens, made by the product's own minter. */
export const appToken = (k: OrgKey, opts: ClaimOpts = {}): Promise<string> => mintAppToken(appClaims(k, opts) as never);
export const runToken = (k: OrgKey, opts: ClaimOpts = {}): Promise<string> => mintRunToken(runClaims(k, opts) as never);

export const bearer = (token: string): { authorization: string } => ({ authorization: `Bearer ${token}` });

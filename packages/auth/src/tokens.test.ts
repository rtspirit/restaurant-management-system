import { SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { TokenError, bearer, mintAppToken, mintConnectionToken, mintRunToken, verifyConnectionToken, verifyDataToken } from "./tokens.js";

const hex = "a".repeat(32);
const base = { org: `org_${hex}`, sub: `usr_${hex}`, app: `app_${hex}`, role: "owner", loc: "all" } as const;
const app = { ...base, kind: "app", aud: "data", ver: `ver_${hex}`, env: "live" } as const;
const run = { ...base, kind: "run", aud: "data", run: `run_${hex}`, env: "draft" } as const;
const secret = "test-secret-test-secret-test-secret-1234";
const enc = (s: string) => new TextEncoder().encode(s);
const now = () => Math.floor(Date.now() / 1000);
const forge = (claims: object, key = secret, header: object = { alg: "HS256", typ: "rms+jwt" }) =>
  new SignJWT({ iss: "rms", iat: now(), exp: now() + 60, jti: "12345678", ...claims }).setProtectedHeader(header as never).sign(enc(key));
const rejects = (p: Promise<unknown>) => expect(p).rejects.toBeInstanceOf(TokenError);

beforeAll(() => {
  process.env.RMS_TOKEN_SECRET = secret;
});

describe("RMS tokens", () => {
  it("round-trips an app token and a run token", async () => {
    const a = await verifyDataToken(await mintAppToken(app));
    expect(a.kind).toBe("app");
    expect(a.org).toBe(app.org);
    const r = await verifyDataToken(await mintRunToken(run));
    expect(r.env).toBe("draft");
  });

  it("refuses to mint a run token for the live store or an app token for draft", async () => {
    await expect(mintRunToken({ ...run, env: "live" } as never)).rejects.toThrow();
    await expect(mintAppToken({ ...app, env: "draft" } as never)).rejects.toThrow();
  });

  it("rejects a missing, garbled or tampered token", async () => {
    await rejects(verifyDataToken(null));
    await rejects(verifyDataToken("not.a.token"));
    const t = await mintAppToken(app);
    const [h, p, s] = t.split(".") as [string, string, string];
    const other = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url").toString()), org: `org_${"b".repeat(32)}` })).toString("base64url");
    await rejects(verifyDataToken(`${h}.${other}.${s}`));
  });

  it("rejects a token signed with another key", async () => rejects(verifyDataToken(await forge(app, "another-secret-another-secret-another-1"))));

  it("rejects alg none and other algorithms", async () => {
    const none = `${Buffer.from(JSON.stringify({ alg: "none", typ: "rms+jwt" })).toString("base64url")}.${Buffer.from(JSON.stringify({ ...app, iss: "rms", iat: now(), exp: now() + 60, jti: "12345678" })).toString("base64url")}.`;
    await rejects(verifyDataToken(none));
    await rejects(verifyDataToken(await forge(app, secret, { alg: "HS512", typ: "rms+jwt" })));
  });

  it("rejects an expired token, a wrong issuer and a wrong type header", async () => {
    await rejects(verifyDataToken(await forge({ ...app, exp: now() - 600 })));
    await rejects(verifyDataToken(await forge({ ...app, iss: "someone-else" })));
    await rejects(verifyDataToken(await forge(app, secret, { alg: "HS256", typ: "JWT" })));
  });

  it("rejects a correctly signed token with unknown or extra claims", async () => {
    await rejects(verifyDataToken(await forge({ ...app, storePrefix: "o_000000000000" })));
    await rejects(verifyDataToken(await forge({ ...run, env: "live" })));
    await rejects(verifyDataToken(await forge({ ...app, kind: "admin" })));
    await rejects(verifyDataToken(await forge({ ...app, org: "o_000000000000" })));
  });

  it("keeps connection tokens and data tokens apart", async () => {
    const c = await mintConnectionToken({ org: app.org, kind: "connection", aud: "mcp", connection: `con_${hex}` });
    await rejects(verifyDataToken(c));
    await rejects(verifyConnectionToken(await mintAppToken(app)));
    expect((await verifyConnectionToken(c)).connection).toBe(`con_${hex}`);
  });

  it("only reads a bearer header", () => {
    expect(bearer("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(bearer("bearer abc")).toBeNull();
    expect(bearer("Basic abc")).toBeNull();
    expect(bearer("Bearer a b")).toBeNull();
    expect(bearer(undefined)).toBeNull();
  });
});

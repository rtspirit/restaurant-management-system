// Token attacks on requireDataToken, through a tiny Hono app that echoes what the middleware decided.
// packages/auth/src/tokens.test.ts covers verifyDataToken itself. These tests go through the HTTP
// layer and the database lookup, and check the rule that matters: the restaurant comes from the
// signed token only.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { TOKEN_TTL, toPublicId } from "@rms/contracts";
import { type DataEnv, requireDataToken } from "@rms/auth";
import { CANARY, ORG, ids, orgPublicId } from "../helpers/world.js";
import { holds, sweep } from "../helpers/actors.js";
import { RMS_HEADER, appClaims, appToken, bearer, decode, hmacToken, nowSec, realSecret, runClaims, runToken, stamped, tampered, unsignedToken } from "../helpers/tokens.js";

const app = new Hono<DataEnv>();
app.use("*", requireDataToken);
app.all("*", (c) => c.json({ tenant: c.var.tenant, claims: c.var.claims }));

type Echo = { tenant?: { orgId: string; storePrefix: string; role: string; locations: unknown; env: string; appId?: string; appVersionId?: string; runId?: string }; error?: { code: string; message: string; requestId: string } };

type Init = { path?: string; method?: string; headers?: Record<string, string>; body?: unknown };
const call = async (token: string | null, init: Init = {}) => {
  const res = await app.request(init.path ?? "/data/v1/query", {
    method: init.method ?? "POST",
    headers: { "content-type": "application/json", ...(token === null ? {} : bearer(token)), ...init.headers },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as Echo };
};

const expectRefused = async (token: string | null, status: 401 | 403 = 401, init: Init = {}) => {
  const r = await call(token, init);
  expect(r.status).toBe(status);
  expect(r.json.tenant).toBeUndefined();
  expect(r.json.error?.code).toBe(status === 401 ? "unauthenticated" : "forbidden_role");
  return r;
};

describe("control: an honest token is accepted and yields its own restaurant", () => {
  it("an app token for A gives A's live store", async () => {
    const r = await call(await appToken("a"));
    expect(r.status).toBe(200);
    expect(r.json.tenant).toMatchObject({ orgId: orgPublicId("a"), storePrefix: ORG.a.prefix, role: "owner", locations: "all", env: "live", appId: toPublicId("app", ids("a").app), appVersionId: toPublicId("ver", ids("a").appVersion) });
    expect(r.json.tenant?.runId).toBeUndefined();
  });

  it("a run token for A gives A's draft store, never live", async () => {
    const r = await call(await runToken("a"));
    expect(r.json.tenant).toMatchObject({ orgId: orgPublicId("a"), storePrefix: ORG.a.prefix, env: "draft" });
    expect(r.json.tenant?.appVersionId).toBeUndefined();
  });

  it("a token for B gives B, and a staff token keeps its role and locations", async () => {
    expect((await call(await appToken("b"))).json.tenant).toMatchObject({ orgId: orgPublicId("b"), storePrefix: ORG.b.prefix });
    const staff = (await call(await appToken("a", { role: "staff", loc: [ids("a").loc1] }))).json.tenant;
    expect(staff).toMatchObject({ role: "staff", locations: [toPublicId("loc", ids("a").loc1)] });
  });

  it("tokens live no longer than they should: 10 minutes for a mini-app, 45 for a build", async () => {
    const appT = decode(await appToken("a")).claims as { iat: number; exp: number };
    const runT = decode(await runToken("a")).claims as { iat: number; exp: number };
    expect(appT.exp - appT.iat).toBe(TOKEN_TTL.app);
    expect(TOKEN_TTL.app).toBeLessThanOrEqual(600);
    expect(runT.exp - runT.iat).toBe(TOKEN_TTL.run);
    expect(TOKEN_TTL.run).toBeLessThanOrEqual(2700);
  });
});

describe("no token, or a token in the wrong place", () => {
  it.each([
    ["no Authorization header", {}],
    ["an empty header", { authorization: "" }],
    ["the scheme alone", { authorization: "Bearer" }],
    ["a lower-case scheme", { authorization: "bearer TOKEN" }],
    ["Basic auth carrying the token", { authorization: "Basic TOKEN" }],
    ["the bare token", { authorization: "TOKEN" }],
    ["two tokens", { authorization: "Bearer TOKEN, Bearer TOKEN" }],
    ["a token with a space in it", { authorization: "Bearer TOK EN" }],
    ["a different header", { "x-authorization": "Bearer TOKEN" }],
    ["a forwarded header", { "x-forwarded-authorization": "Bearer TOKEN" }],
    ["a cookie", { cookie: "token=TOKEN; rms_token=TOKEN; access_token=TOKEN" }],
  ])("refuses %s", async (_what, headers) => {
    const token = await appToken("a");
    const sent = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, String(v).replaceAll("TOKEN", token).replace("TOK EN", `${token.slice(0, 20)} ${token.slice(20)}`)]));
    await expectRefused(null, 401, { headers: sent });
  });

  it("refuses a token in the URL or the body", async () => {
    const token = await appToken("a");
    await expectRefused(null, 401, { path: `/data/v1/query?token=${token}&access_token=${token}&authorization=Bearer%20${token}` });
    await expectRefused(null, 401, { body: { token, access_token: token, authorization: `Bearer ${token}` } });
  });
});

describe("forged tokens", () => {
  const good = () => stamped(appClaims("b"));

  it.each([
    ["random text", () => "not-a-token"],
    ["three random parts", () => "aaaa.bbbb.cccc"],
    ["an empty signature", () => `${hmacToken(good(), realSecret()).split(".").slice(0, 2).join(".")}.`],
    ["no algorithm", () => unsignedToken(good())],
    ["no algorithm, spelled None", () => unsignedToken(good(), { alg: "None", typ: "rms+jwt" })],
    ["no algorithm, with a signature attached", () => `${unsignedToken(good())}${hmacToken(good(), realSecret()).split(".")[2]}`],
    ["a different secret", () => hmacToken(good(), "another-secret-another-secret-another-1")],
    ["an empty secret", () => hmacToken(good(), "")],
    ["the secret's name instead of its value", () => hmacToken(good(), "RMS_TOKEN_SECRET")],
    ["a published local default secret", () => hmacToken(good(), "super-secret-jwt-token-with-at-least-32-characters-long")],
    ["the right secret but HS512", () => hmacToken(good(), realSecret(), { alg: "HS512", typ: "rms+jwt" }, "sha512")],
    ["the right secret but HS384", () => hmacToken(good(), realSecret(), { alg: "HS384", typ: "rms+jwt" }, "sha384")],
    ["a header that claims RS256", () => hmacToken(good(), realSecret(), { alg: "RS256", typ: "rms+jwt" })],
    ["a header that claims ES256", () => hmacToken(good(), realSecret(), { alg: "ES256", typ: "rms+jwt" })],
    ["a very long token", () => `${"a".repeat(200_000)}.${"b".repeat(200_000)}.${"c".repeat(1000)}`],
  ])("refuses %s", async (_what, make) => {
    await expectRefused(make());
  });

  it.each([
    ["the restaurant", { org: orgPublicId("b") }],
    ["the role", { role: "owner" }],
    ["the locations", { loc: "all" }],
    ["the mini-app", { app: toPublicId("app", ids("b").app) }],
    ["the version", { ver: toPublicId("ver", ids("b").appVersion) }],
    ["the user", { sub: toPublicId("usr", "0193a3c0-9191-7000-8000-0000000000b1") }],
    ["the expiry", { exp: nowSec() + 86_400 * 365 }],
  ])("refuses an honest token for A with %s changed and the old signature kept", async (_what, patch) => {
    const honest = await appToken("a", { role: "staff", loc: [ids("a").loc1] });
    await expectRefused(tampered(honest, patch));
  });

  it("refuses a token whose signature belongs to a different token", async () => {
    const [h1, p1] = (await appToken("b")).split(".") as [string, string, string];
    const s2 = (await appToken("a")).split(".")[2] as string;
    await expectRefused(`${h1}.${p1}.${s2}`);
  });
});

describe("correctly signed, but not a valid data token", () => {
  // These are signed with the real local secret. They test what the verifier does when the minter (or a
  // leaked key) produces something outside the rules: each must still be refused.
  const sign = (claims: object, header: object = RMS_HEADER) => hmacToken(claims, realSecret(), header);
  const base = () => stamped(appClaims("a"));

  it("control: this signing helper makes a token the verifier accepts when the claims are right", async () => {
    expect((await call(sign(base()))).status).toBe(200);
  });

  it.each([
    ["expired", () => sign({ ...base(), iat: nowSec() - 3600, exp: nowSec() - 60 })],
    ["expired one minute ago", () => sign({ ...base(), exp: nowSec() - 60 })],
    ["no expiry", () => { const { exp: _exp, ...rest } = base(); return sign(rest); }],
    ["no issue time", () => { const { iat: _iat, ...rest } = base(); return sign(rest); }],
    ["no token id", () => { const { jti: _jti, ...rest } = base(); return sign(rest); }],
    ["an expiry that is text", () => sign({ ...base(), exp: "never" })],
    ["another issuer", () => sign({ ...base(), iss: "supabase" })],
    ["no issuer", () => { const { iss: _iss, ...rest } = base(); return sign(rest); }],
    ["the wrong type header", () => sign(base(), { alg: "HS256", typ: "JWT" })],
    ["no type header", () => sign(base(), { alg: "HS256" })],
    ["an audience for connections", () => sign({ ...base(), aud: "mcp" })],
    ["two audiences", () => sign({ ...base(), aud: ["data", "mcp"] })],
    ["no audience", () => { const { aud: _aud, ...rest } = base(); return sign(rest); }],
    ["a connection token", () => sign(stamped({ org: orgPublicId("a"), kind: "connection", aud: "mcp", connection: toPublicId("con", ids("a").connection) }))],
    ["a connection token re-aimed at the Data API", () => sign(stamped({ org: orgPublicId("a"), kind: "connection", aud: "data", connection: toPublicId("con", ids("a").connection) }))],
    ["an unknown kind", () => sign({ ...base(), kind: "admin" })],
    ["no kind", () => { const { kind: _kind, ...rest } = base(); return sign(rest); }],
    ["a run token aimed at live", () => sign(stamped({ ...runClaims("a"), env: "live" }))],
    ["an app token aimed at draft", () => sign({ ...base(), env: "draft" })],
    ["an app token with no version", () => { const { ver: _ver, ...rest } = base(); return sign(rest); }],
    ["an app token that also carries a run", () => sign({ ...base(), run: toPublicId("run", ids("a").run) })],
    ["a run token that also carries a version", () => sign(stamped({ ...runClaims("a"), ver: toPublicId("ver", ids("a").appVersion) }))],
    ["an extra claim naming a store", () => sign({ ...base(), storePrefix: ORG.b.prefix })],
    ["an extra claim naming a schema", () => sign({ ...base(), schema: ORG.b.prefix })],
    ["a second restaurant claim", () => sign({ ...base(), org_id: orgPublicId("b"), orgId: orgPublicId("b") })],
    ["a restaurant given as a store prefix", () => sign({ ...base(), org: ORG.b.prefix })],
    ["a restaurant given as a raw uuid", () => sign({ ...base(), org: ORG.b.uuid })],
    ["a restaurant given as a list", () => sign({ ...base(), org: [orgPublicId("a"), orgPublicId("b")] })],
    ["a restaurant id with SQL in it", () => sign({ ...base(), org: `${orgPublicId("a")}' or '1'='1` })],
    ["an unknown role", () => sign({ ...base(), role: "admin" })],
    ["a maintainer role", () => sign({ ...base(), role: "maintainer" })],
    ["no locations", () => sign({ ...base(), loc: [] })],
    ["locations as a wildcard", () => sign({ ...base(), loc: "*" })],
    ["locations as raw uuids", () => sign({ ...base(), loc: [ids("a").loc1] })],
    ["a user id that is not a user id", () => sign({ ...base(), sub: "root" })],
  ])("refuses a token with %s", async (_what, make) => {
    await expectRefused(make());
  });

  it("every refusal looks the same from outside: no hint whether the token was expired, forged or the wrong kind", async () => {
    const strip = (t: string) => t.replace(/"requestId":"[^"]+"/, "");
    const bodies = await Promise.all([
      call(null), call("not-a-token"), call(sign({ ...base(), exp: nowSec() - 60 })), call(hmacToken(base(), "another-secret-another-secret-another-1")), call(sign({ ...base(), kind: "admin" })),
    ]);
    expect(new Set(bodies.map((b) => strip(b.text))).size).toBe(1);
    expect(bodies[0]?.text).not.toMatch(/expired|signature|jwt|jose|secret|claim|zod/i);
  });

  it("a refusal never echoes the token or the secret", async () => {
    const bad = hmacToken(base(), "another-secret-another-secret-another-1");
    const r = await call(bad);
    expect(r.text).not.toContain(bad.slice(0, 40));
    expect(r.text).not.toContain(realSecret());
  });
});

describe("a valid token for a restaurant that may not be served", () => {
  const sign = (claims: object) => hmacToken(stamped(claims), realSecret());

  it("refuses a suspended restaurant", async () => {
    await expectRefused(sign(appClaims("c")), 403);
  });

  it("refuses a restaurant whose store was never set up", async () => {
    await expectRefused(sign(appClaims("d")), 403);
  });

  it("refuses a restaurant that does not exist", async () => {
    await expectRefused(sign({ ...appClaims("a"), org: toPublicId("org", "0193a3c0-9191-7fff-8fff-ffffffffffff") }), 403);
  });

  it("the refusal does not say which of those it was", async () => {
    const strip = (t: string) => t.replace(/"requestId":"[^"]+"/, "");
    const a = await call(sign(appClaims("c")));
    const b = await call(sign({ ...appClaims("a"), org: toPublicId("org", "0193a3c0-9191-7fff-8fff-ffffffffffff") }));
    expect(strip(a.text)).toBe(strip(b.text));
  });
});

describe("the restaurant comes from the signed token only", () => {
  const B = { uuid: ORG.b.uuid, pub: orgPublicId("b"), prefix: ORG.b.prefix };
  const smuggle: [string, Init][] = [
    ["the query string", { path: `/data/v1/query?org=${B.pub}&orgId=${B.pub}&org_id=${B.uuid}&schema=${B.prefix}&storePrefix=${B.prefix}&env=draft&role=owner&tenant=${B.pub}` }],
    ["the path", { path: `/data/v1/${B.pub}/${B.prefix}/query` }],
    ["the body", { body: { org: B.pub, orgId: B.pub, org_id: B.uuid, schema: B.prefix, storePrefix: B.prefix, env: "draft", role: "owner", tenant: { orgId: B.pub, storePrefix: B.prefix } } }],
    ["restaurant headers", { headers: { "x-org": B.pub, "x-org-id": B.pub, "x-rms-org": B.pub, "x-tenant": B.pub, "x-tenant-id": B.uuid, "x-store-prefix": B.prefix, "x-schema": B.prefix, "x-restaurant": B.pub } }],
    ["role and environment headers", { headers: { "x-role": "owner", "x-rms-role": "owner", "x-env": "draft", "x-rms-env": "draft", "x-locations": "all", "x-user-id": "root" } }],
    ["proxy headers", { headers: { "x-forwarded-host": `${B.prefix}.rms.test`, "x-forwarded-for": "127.0.0.1", "x-original-url": `/data/v1/query?org=${B.pub}`, forwarded: `host=${B.prefix}.rms.test`, host: `${B.prefix}.rms.test` } }],
    ["a second token for B in another header", { headers: { "x-rms-token": "B_TOKEN", "x-authorization": "Bearer B_TOKEN", cookie: "token=B_TOKEN" } }],
    ["a method override", { method: "GET", headers: { "x-http-method-override": "POST", "x-org-id": B.pub } }],
  ];

  it.each(smuggle)("a staff token for A stays a staff token for A, whatever %s says", async (_what, init) => {
    const token = await appToken("a", { role: "staff", loc: [ids("a").loc1] });
    const bToken = await appToken("b");
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k, v.replaceAll("B_TOKEN", bToken)]));
    const r = await call(token, { ...init, headers });
    expect(r.status).toBe(200);
    expect(r.json.tenant).toEqual({
      orgId: orgPublicId("a"), storePrefix: ORG.a.prefix, actor: { type: "user", id: appClaims("a").sub }, role: "staff",
      locations: [toPublicId("loc", ids("a").loc1)], env: "live", appId: toPublicId("app", ids("a").app), appVersionId: toPublicId("ver", ids("a").appVersion),
    });
    sweep("a", "tenant echo", r.text);
  });

  it("restaurant A's token carrying restaurant B's mini-app and version still opens A's store, never B's", async () => {
    // The middleware cannot know the mini-app belongs to B (the Data API must check the manifest belongs to the
    // token's restaurant: see tests/security/data-api). What it must never do is follow the mini-app to B's store.
    const r = await call(await appToken("a", { app: ids("b").app, ver: ids("b").appVersion }));
    expect(r.status).toBe(200);
    expect(r.json.tenant).toMatchObject({ orgId: orgPublicId("a"), storePrefix: ORG.a.prefix });
    expect(r.text).not.toContain(ORG.b.prefix);
  });

  it("the store prefix is looked up for the token's restaurant and matches it every time", async () => {
    for (let i = 0; i < 10; i++) {
      const k = i % 2 === 0 ? "a" : "b";
      const r = await call(await appToken(k));
      expect(r.json.tenant).toMatchObject({ orgId: orgPublicId(k), storePrefix: ORG[k].prefix });
    }
  });

  it("nothing the middleware returns carries the other restaurant's data", async () => {
    const r = await call(await appToken("a"));
    expect(holds(r.text, CANARY.b)).toBe(false);
    expect(holds(r.text, CANARY.a)).toBe(false); // nor its own: a tenant context holds ids, not data
  });
});

describe("KNOWN LIMIT: a signed token is good until it expires", () => {
  it("KNOWN LIMIT: the same token is accepted again and again (no one-time use). A captured token works for up to 10 minutes", async () => {
    // Today: replay works. That is normal for a bearer token, and it is why the lifetime is short and why batch
    // writes carry idempotency keys. If one-time tokens are ever added, this test fails: delete it then.
    const token = await appToken("a");
    for (let i = 0; i < 3; i++) expect((await call(token)).status).toBe(200);
  });

  it("the wall that does hold: once expired, the same token is refused", async () => {
    await expectRefused(hmacToken({ ...stamped(appClaims("a")), iat: nowSec() - 700, exp: nowSec() - 100 }, realSecret()));
  });
});

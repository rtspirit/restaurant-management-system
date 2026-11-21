// Session attacks on requireSession, requireStaff and requireUser, through a tiny Hono app.
// The users are real users of the LOCAL sign-in service, made by global-setup.ts.
import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, inject, it } from "vitest";
import { toPublicId } from "@rms/contracts";
import { type DataEnv, type SessionEnv, type StaffEnv, type UserEnv, requireDataToken, requireSession, requireStaff, requireUser } from "@rms/auth";
import { holds, platform, sweep } from "../helpers/actors.js";
import { appToken, bearer, decode, es256Token, hmacToken, nowSec, realSecret, strangerKey, tampered, unsignedToken } from "../helpers/tokens.js";
import { CANARY, ORG, ids, orgPublicId } from "../helpers/world.js";

const users = inject("suiteUsers");

const session = new Hono<SessionEnv>().use("*", requireSession).all("*", (c) => c.json({ tenant: c.var.tenant, user: c.var.user }));
const staff = new Hono<StaffEnv>().use("*", requireStaff).all("*", (c) => c.json({ staff: c.var.staff, user: c.var.user }));
const user = new Hono<UserEnv>().use("*", requireUser).all("*", (c) => c.json({ user: c.var.user }));
const data = new Hono<DataEnv>().use("*", requireDataToken).all("*", (c) => c.json({ tenant: c.var.tenant }));

type Body = { tenant?: Record<string, unknown>; user?: { userUuid: string }; staff?: { staffUuid: string; name: string }; error?: { code: string; message: string } };
const call = async (app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> }, token: string | null, init: { path?: string; headers?: Record<string, string>; body?: unknown } = {}) => {
  const res = await app.request(init.path ?? "/", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token === null ? {} : bearer(token)), ...init.headers },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as Body };
};

const supabaseIssuer = () => `${(process.env.SUPABASE_URL as string).replace(/\/$/, "")}/auth/v1`;
/** Claims shaped exactly like a real access token for `userId`. Only the signature will be wrong. */
const sessionClaims = (userId: string) => ({ iss: supabaseIssuer(), sub: userId, aud: "authenticated", role: "authenticated", email: "forged@g.rms-security.test", iat: nowSec(), exp: nowSec() + 600, session_id: crypto.randomUUID(), is_anonymous: false });

describe("control: real sessions give each person their own restaurant", () => {
  it("A's owner gets A, live, as owner, every location", async () => {
    const r = await call(session, users.ownerA.accessToken);
    expect(r.status).toBe(200);
    expect(r.json.tenant).toEqual({ orgId: orgPublicId("a"), storePrefix: ORG.a.prefix, actor: { type: "user", id: toPublicId("usr", users.ownerA.id) }, role: "owner", locations: "all", env: "live" });
  });

  it("A's staff member gets A, as staff, with only the location they are assigned", async () => {
    const r = await call(session, users.staffA.accessToken);
    expect(r.json.tenant).toMatchObject({ orgId: orgPublicId("a"), role: "staff", locations: [toPublicId("loc", ids("a").loc1)] });
  });

  it("B's owner gets B", async () => {
    expect((await call(session, users.ownerB.accessToken)).json.tenant).toMatchObject({ orgId: orgPublicId("b"), storePrefix: ORG.b.prefix, role: "owner" });
  });

  it("the maintainer is recognised as staff of RMS", async () => {
    const r = await call(staff, users.maintainer.accessToken);
    expect(r.status).toBe(200);
    expect(r.json.staff?.name).toBe("Suite Maintainer");
  });
});

describe("who is refused", () => {
  it("someone with no restaurant gets no tenant", async () => {
    const r = await call(session, users.nobody.accessToken);
    expect(r.status).toBe(403);
    expect(r.json.tenant).toBeUndefined();
    expect(r.json.error?.code).toBe("forbidden_role");
    // They are still a signed-in person, for sign-up and onboarding.
    expect((await call(user, users.nobody.accessToken)).status).toBe(200);
  });

  it("a maintainer is not a member of any restaurant", async () => {
    expect((await call(session, users.maintainer.accessToken)).status).toBe(403);
  });

  it.each([
    ["a restaurant owner", "ownerA"],
    ["a restaurant staff member", "staffA"],
    ["another restaurant's owner", "ownerB"],
    ["a person with no restaurant", "nobody"],
  ] as const)("%s is not a maintainer", async (_who, key) => {
    const r = await call(staff, users[key].accessToken);
    expect(r.status).toBe(403);
    expect(r.json.staff).toBeUndefined();
  });

  it("no token, on every kind of route", async () => {
    for (const app of [session, staff, user]) {
      const r = await call(app, null);
      expect(r.status).toBe(401);
      expect(r.json.error?.code).toBe("unauthenticated");
    }
  });

  it("a member who was removed loses access at once, even with a token that is still valid", async () => {
    const a = ids("a");
    await platform()`update platform.members set status = 'removed' where id = ${a.staffMember}`;
    try {
      const r = await call(session, users.staffA.accessToken);
      expect(r.status).toBe(403);
      expect(r.json.tenant).toBeUndefined();
    } finally {
      await platform()`update platform.members set status = 'active' where id = ${a.staffMember}`;
    }
    expect((await call(session, users.staffA.accessToken)).status).toBe(200);
  });

  it("a suspended restaurant's owner loses access at once", async () => {
    await platform()`update platform.organizations set status = 'suspended' where id = ${ORG.b.uuid}`;
    try {
      expect((await call(session, users.ownerB.accessToken)).status).toBe(403);
      expect((await call(data, await appToken("b"))).status).toBe(403);
    } finally {
      await platform()`update platform.organizations set status = 'active' where id = ${ORG.b.uuid}`;
    }
    expect((await call(session, users.ownerB.accessToken)).status).toBe(200);
  });

  it("a maintainer who was removed from the list loses access at once", async () => {
    const [row] = await platform()`select id, user_id, name from platform.staff_users where user_id = ${users.maintainer.id}`;
    // change_reviews points at the staff row, so move it aside instead of deleting it.
    await platform()`update platform.staff_users set user_id = ${users.nobody.id} where id = ${row?.id as string}`;
    try {
      expect((await call(staff, users.maintainer.accessToken)).status).toBe(403);
    } finally {
      await platform()`update platform.staff_users set user_id = ${users.maintainer.id} where id = ${row?.id as string}`;
    }
    expect((await call(staff, users.maintainer.accessToken)).status).toBe(200);
  });
});

describe("forged session tokens", () => {
  const target = () => users.ownerB.id;

  it("signed with a key nobody trusts", async () => {
    const { privateKey } = strangerKey();
    const r = await call(session, es256Token(sessionClaims(target()), { alg: "ES256", typ: "JWT", kid: "stranger" }, privateKey));
    expect(r.status).toBe(401);
  });

  it("signed with a stranger's key but naming the real key id", async () => {
    const kid = decode(users.ownerA.accessToken).header.kid;
    const { privateKey } = strangerKey();
    expect((await call(session, es256Token(sessionClaims(target()), { alg: "ES256", typ: "JWT", kid }, privateKey))).status).toBe(401);
  });

  it("carrying its own public key in the header", async () => {
    const { privateKey, publicKey } = strangerKey();
    const jwk = publicKey.export({ format: "jwk" });
    const token = es256Token(sessionClaims(target()), { alg: "ES256", typ: "JWT", jwk, kid: "embedded" }, privateKey);
    expect((await call(session, token)).status).toBe(401);
    const pointing = es256Token(sessionClaims(target()), { alg: "ES256", typ: "JWT", jku: "https://attacker.test/keys.json", x5u: "https://attacker.test/cert.pem" }, privateKey);
    expect((await call(session, pointing)).status).toBe(401);
  });

  it("signed with the sign-in service's shared secret (readable from the database today: see db/findings.test.ts)", async () => {
    // The sign-in service still has an old shared-secret way of signing. RMS must accept public-key signatures only,
    // so knowing that secret must not be enough to become another restaurant's owner here.
    const [row] = await platform().unsafe("select current_setting('app.settings.jwt_secret', true) as s");
    const secret = String((row as Record<string, unknown> | undefined)?.s ?? "super-secret-jwt-token-with-at-least-32-characters-long");
    for (const app of [session, staff, user]) {
      expect((await call(app, hmacToken(sessionClaims(target()), secret, { alg: "HS256", typ: "JWT" }))).status).toBe(401);
      expect((await call(app, hmacToken({ ...sessionClaims(users.maintainer.id), role: "service_role" }, secret, { alg: "HS256", typ: "JWT" }))).status).toBe(401);
    }
  });

  it("signed with the public key used as a shared secret (algorithm confusion)", async () => {
    const jwks = (await (await fetch(`${supabaseIssuer()}/.well-known/jwks.json`)).json()) as { keys: Record<string, string>[] };
    const key = jwks.keys[0] as Record<string, string>;
    const kid = key.kid;
    for (const secret of [JSON.stringify(key), `${key.x}${key.y}`, Buffer.concat([Buffer.from(key.x as string, "base64url"), Buffer.from(key.y as string, "base64url")])]) {
      for (const [alg, hash] of [["HS256", "sha256"], ["HS384", "sha384"], ["HS512", "sha512"]] as const) {
        expect((await call(session, hmacToken(sessionClaims(target()), secret, { alg, typ: "JWT", kid }, hash))).status).toBe(401);
      }
    }
  });

  it("with no signature", async () => {
    expect((await call(session, unsignedToken(sessionClaims(target()), { alg: "none", typ: "JWT" }))).status).toBe(401);
    const [h, p] = users.ownerA.accessToken.split(".") as [string, string, string];
    expect((await call(session, `${h}.${p}.`)).status).toBe(401);
  });

  it.each([
    ["the user", () => ({ sub: users.ownerB.id })],
    ["the user, to the maintainer", () => ({ sub: users.maintainer.id })],
    ["the expiry", () => ({ exp: nowSec() + 86_400 * 365 })],
    ["the role", () => ({ role: "service_role" })],
  ])("a real token for A's owner with %s changed and the old signature kept", async (_what, patch) => {
    const token = tampered(users.ownerA.accessToken, patch());
    for (const app of [session, staff, user]) expect((await call(app, token)).status).toBe(401);
  });

  it("an RMS mini-app token is not a session, and a session is not a mini-app token", async () => {
    const rms = await appToken("a");
    for (const app of [session, staff, user]) expect((await call(app, rms)).status).toBe(401);
    expect((await call(data, users.ownerA.accessToken)).status).toBe(401);
    // A token shaped like a session but signed with the RMS token secret.
    expect((await call(session, hmacToken(sessionClaims(target()), realSecret(), { alg: "HS256", typ: "JWT" }))).status).toBe(401);
  });

  it("the sign-in service's public and secret API keys are not sessions", async () => {
    for (const key of [process.env.SUPABASE_PUBLISHABLE_KEY as string, process.env.SUPABASE_SECRET_KEY as string]) {
      for (const app of [session, staff, user]) expect((await call(app, key)).status).toBe(401);
    }
  });

  it("every refusal has the same plain body and never echoes the token", async () => {
    const strip = (t: string) => t.replace(/"requestId":"[^"]+"/, "");
    const forged = hmacToken(sessionClaims(target()), "x".repeat(40), { alg: "HS256", typ: "JWT" });
    const bodies = [await call(session, null), await call(session, "garbage"), await call(session, forged), await call(session, tampered(users.ownerA.accessToken, { sub: users.ownerB.id }))];
    expect(new Set(bodies.map((b) => strip(b.text))).size).toBe(1);
    for (const b of bodies) {
      expect(b.text).not.toContain(forged.slice(0, 30));
      expect(b.text).not.toMatch(/jwt|jwks|signature|jose|ES256|expired/i);
    }
  });
});

describe("the restaurant comes from the session only", () => {
  const B = { pub: orgPublicId("b"), uuid: ORG.b.uuid, prefix: ORG.b.prefix };
  const smuggle: [string, { path?: string; headers?: Record<string, string>; body?: unknown }][] = [
    ["the query string", { path: `/?org=${B.pub}&orgId=${B.pub}&org_id=${B.uuid}&storePrefix=${B.prefix}&role=owner&locations=all&env=draft&userId=${"USER_B"}` }],
    ["the path", { path: `/orgs/${B.pub}/stores/${B.prefix}` }],
    ["the body", { body: { org: B.pub, orgId: B.pub, org_id: B.uuid, storePrefix: B.prefix, role: "owner", locations: "all", env: "draft", user: { userUuid: "USER_B" }, tenant: { orgId: B.pub } } }],
    ["headers", { headers: { "x-org-id": B.pub, "x-rms-org": B.pub, "x-tenant-id": B.uuid, "x-store-prefix": B.prefix, "x-role": "owner", "x-rms-role": "owner", "x-locations": "all", "x-user-id": "USER_B", "x-supabase-user": "USER_B", "x-forwarded-user": "USER_B", "x-staff": "true", "x-rms-staff": "true" } }],
    ["cookies", { headers: { cookie: `org=${B.pub}; role=owner; sb-access-token=${"TOKEN_B"}; sb-127-auth-token=${"TOKEN_B"}` } }],
  ];

  it.each(smuggle)("A's staff member stays A's staff member, whatever %s says", async (_what, init) => {
    const fill = (s: string) => s.replaceAll("USER_B", users.ownerB.id).replaceAll("TOKEN_B", users.ownerB.accessToken);
    const r = await call(session, users.staffA.accessToken, {
      ...(init.path ? { path: fill(init.path) } : {}),
      ...(init.headers ? { headers: Object.fromEntries(Object.entries(init.headers).map(([k, v]) => [k, fill(v)])) } : {}),
      ...(init.body ? { body: JSON.parse(fill(JSON.stringify(init.body))) } : {}),
    });
    expect(r.status).toBe(200);
    expect(r.json.tenant).toEqual({ orgId: orgPublicId("a"), storePrefix: ORG.a.prefix, actor: { type: "user", id: toPublicId("usr", users.staffA.id) }, role: "staff", locations: [toPublicId("loc", ids("a").loc1)], env: "live" });
    sweep("a", "session echo", r.text);
  });

  it("a restaurant owner cannot make themselves a maintainer with a header, a query or a body", async () => {
    const r = await call(staff, users.ownerA.accessToken, { path: "/?staff=true&role=maintainer", headers: { "x-staff": "true", "x-rms-staff": "1", "x-role": "maintainer" }, body: { staff: true, role: "maintainer", staffUuid: "x" } });
    expect(r.status).toBe(403);
  });

  it("a session is always for the live store: a session cannot ask for draft", async () => {
    const r = await call(session, users.ownerA.accessToken, { path: "/?env=draft", headers: { "x-env": "draft" }, body: { env: "draft" } });
    expect(r.json.tenant?.env).toBe("live");
  });

  it("what comes back holds no restaurant's data", async () => {
    for (const key of ["ownerA", "staffA", "ownerB"] as const) {
      const r = await call(session, users[key].accessToken);
      expect(holds(r.text, CANARY.a) || holds(r.text, CANARY.b), key).toBe(false);
    }
  });
});

describe("the sign-in service itself", () => {
  it("publishes public keys only, and signs with a public-key algorithm", async () => {
    const jwks = (await (await fetch(`${supabaseIssuer()}/.well-known/jwks.json`)).json()) as { keys: Record<string, unknown>[] };
    expect(jwks.keys.length).toBeGreaterThan(0);
    for (const k of jwks.keys) {
      expect(k.d, "a private key part was published").toBeUndefined();
      expect(k.k, "a shared secret was published").toBeUndefined();
    }
    expect(["ES256", "RS256", "EdDSA"]).toContain(decode(users.ownerA.accessToken).header.alg);
  });

  it("a session token is not a long-lived credential", () => {
    const c = decode(users.ownerA.accessToken).claims as { iat: number; exp: number };
    expect(c.exp - c.iat).toBeLessThanOrEqual(3600);
  });

  it("signing something with the wrong secret proves nothing (sanity check of the forging helper)", () => {
    const token = hmacToken({ a: 1 }, "k".repeat(32));
    const [h, p, s] = token.split(".") as [string, string, string];
    expect(createHmac("sha256", "k".repeat(32)).update(`${h}.${p}`).digest("base64url")).toBe(s);
  });
});

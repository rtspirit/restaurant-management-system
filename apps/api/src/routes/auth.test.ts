// Task A checks: sign-up through the local sign-in service, onboarding, /auth/me, isolation.
// Test data: uuid suffixes a0..af and store prefixes o_a1a1a1a1a1xx only (wave 1 brief).
import { existsSync } from "node:fs";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toPublicId } from "@rms/contracts";
import { adminDb, closeAll, provisionStore } from "@rms/db";
import { type CreateDemoRestaurant, type DemoTemplate, type MeResponse, createAuthRoutes } from "./auth.js";

const envFile = "/Users/rahultiwari/github/restaurant-management-system/.env.local";
if (existsSync(envFile)) process.loadEnvFile(envFile);
const env = process.env;
const ready = Boolean(env.DATABASE_URL && env.DATABASE_ADMIN_URL && env.SUPABASE_URL && env.SUPABASE_PUBLISHABLE_KEY && env.SUPABASE_SECRET_KEY);

const ID = (hex: string) => `0193a3c0-0000-7000-8000-0000000000${hex}`;
// Orgs a1..a6, one location each at a9..ae.
const ORG_SLOTS = ["a1", "a2", "a3", "a4", "a5", "a6"] as const;
const LOC_FOR: Record<string, string> = { a1: "a9", a2: "aa", a3: "ab", a4: "ac", a5: "ad", a6: "ae" };
const ALL_ORGS = ORG_SLOTS.map(ID);

let nextSlot = 0;
const stubCalls: DemoTemplate[] = [];

/** Stands in for task B's createDemoRestaurant: one org row, one location, a provisioned store. */
const stubCreate: CreateDemoRestaurant = async (sql, { template }) => {
  stubCalls.push(template);
  const slot = ORG_SLOTS[nextSlot++];
  if (!slot) throw new Error("test ran out of org ids");
  const orgUuid = ID(slot);
  const prefix = `o_a1a1a1a1a1${slot}`;
  const name = template === "marigold" ? "Marigold Kitchen (test)" : "Slice Yard (test)";
  const colour = template === "marigold" ? "#E8892B" : "#C8372D";
  await sql`insert into platform.organizations (id, slug, name, store_prefix, brand_colour)
            values (${orgUuid}, ${`task-a-test-${slot}`}, ${name}, ${prefix}, ${colour})`;
  await sql`insert into platform.locations (id, org_id, name) values (${ID(LOC_FOR[slot]!)}, ${orgUuid}, ${`${name} Downtown`})`;
  await provisionStore(sql, orgUuid);
  return { orgUuid, storePrefix: prefix, name };
};

const app = new Hono().route("/auth", createAuthRoutes({ createDemoRestaurant: stubCreate }));

type TestUser = { id: string; token: string };
const users: TestUser[] = [];

const randomHex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");

const signUp = async (): Promise<TestUser> => {
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY!, "content-type": "application/json" },
    body: JSON.stringify({ email: `owner-${randomHex(6)}@a.rms.test`, password: `Pw-${randomHex(16)}` }),
  });
  const json = (await res.json()) as { access_token?: string; user?: { id: string } };
  if (!res.ok || !json.access_token || !json.user) throw new Error(`sign-up failed with status ${res.status}`);
  const u = { id: json.user.id, token: json.access_token };
  users.push(u);
  return u;
};

const deleteUser = async (id: string) => {
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${id}`, {
    method: "DELETE",
    headers: { apikey: env.SUPABASE_SECRET_KEY!, authorization: `Bearer ${env.SUPABASE_SECRET_KEY}` },
  });
  if (!res.ok) throw new Error(`could not delete test user (status ${res.status})`);
};

const call = (path: string, init: { token?: string | undefined; method?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
  app.request(path, {
    method: init.method ?? "GET",
    headers: {
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });

const answers = (serviceStyle: "full_service" | "counter_service" | "cafe") => ({
  restaurantName: "Whatever The Owner Typed",
  serviceStyle,
  cuisine: "Pizza",
  locationCount: 1,
  systemsUsed: ["Square"],
});

const me = async (token: string) => (await (await call("/auth/me", { token })).json()) as MeResponse;

const cleanupOrgs = async () => {
  const sql = adminDb();
  for (const org of ALL_ORGS) {
    const [row] = await sql<{ id: string }[]>`select id from platform.organizations where id = ${org}`;
    if (!row) continue;
    await sql`select platform.drop_store(${org})`;
    await sql`delete from platform.members where org_id = ${org}`;
    await sql`delete from platform.locations where org_id = ${org}`;
    await sql`delete from platform.organizations where id = ${org}`;
  }
};

describe.skipIf(!ready)("sign-up and onboarding", () => {
  let a: TestUser;
  let b: TestUser;

  beforeAll(async () => {
    await cleanupOrgs();
    a = await signUp();
    b = await signUp();
  });

  afterAll(async () => {
    try {
      await cleanupOrgs();
      for (const u of users) await deleteUser(u.id);
      // Nothing left behind.
      const left = await adminDb()`select id from platform.organizations where id = any(${ALL_ORGS})`;
      expect(left).toHaveLength(0);
      for (const u of users) {
        const res = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${u.id}`, {
          headers: { apikey: env.SUPABASE_SECRET_KEY!, authorization: `Bearer ${env.SUPABASE_SECRET_KEY}` },
        });
        expect(res.status).toBe(404);
      }
    } finally {
      await closeAll();
    }
  });

  it("refuses no token and forged tokens on every route", async () => {
    const tampered = (() => {
      const [h, p, s] = a.token.split(".");
      const payload = JSON.parse(Buffer.from(p!, "base64url").toString());
      payload.sub = b.id;
      return `${h}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${s}`;
    })();
    const garbage = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4Iiwicm9sZSI6ImF1dGhlbnRpY2F0ZWQifQ.c2lnbmF0dXJl";
    for (const token of [undefined, tampered, garbage, "not-a-token"]) {
      expect((await call("/auth/me", { token })).status).toBe(401);
      expect((await call("/auth/onboarding", { token, method: "POST", body: answers("full_service") })).status).toBe(401);
    }
    expect(stubCalls).toHaveLength(0);
  });

  it("a new user has no restaurant yet", async () => {
    const body = await me(a.token);
    expect(body.user.id).toBe(toPublicId("usr", a.id));
    expect(body.restaurant).toBeNull();
  });

  it("rejects answers that try to name an org, role or user", async () => {
    for (const extra of [{ orgId: toPublicId("org", ALL_ORGS[0]!) }, { role: "owner" }, { userId: b.id }]) {
      const res = await call("/auth/onboarding", { token: a.token, method: "POST", body: { ...answers("full_service"), ...extra } });
      expect(res.status).toBe(400);
    }
    expect((await call("/auth/onboarding", { token: a.token, method: "POST", body: { serviceStyle: "full_service" } })).status).toBe(400);
    expect(stubCalls).toHaveLength(0);
  });

  it("onboards each user to the right template, once", async () => {
    const ra = await call("/auth/onboarding", { token: a.token, method: "POST", body: answers("full_service") });
    expect(ra.status).toBe(201);
    const rb = await call("/auth/onboarding", { token: b.token, method: "POST", body: answers("counter_service") });
    expect(rb.status).toBe(201);
    expect(stubCalls).toEqual(["marigold", "slice_yard"]);

    const meA = await me(a.token);
    const meB = await me(b.token);
    expect(meA.restaurant).toMatchObject({ id: toPublicId("org", ALL_ORGS[0]!), name: "Marigold Kitchen (test)", role: "owner", brandColour: "#E8892B", ready: true });
    expect(meA.restaurant?.locations).toEqual([{ id: toPublicId("loc", ID("a9")), name: "Marigold Kitchen (test) Downtown" }]);
    expect(meB.restaurant).toMatchObject({ id: toPublicId("org", ALL_ORGS[1]!), name: "Slice Yard (test)", role: "owner", brandColour: "#C8372D" });

    // Onboarding again returns the same restaurant and makes nothing new.
    const again = await call("/auth/onboarding", { token: a.token, method: "POST", body: answers("counter_service") });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { restaurant: { id: string }; created: boolean })).toMatchObject({ created: false, restaurant: { id: meA.restaurant?.id } });
    expect(stubCalls).toHaveLength(2);
    const [{ n }] = (await adminDb()`select count(*)::int as n from platform.members where user_id = ${a.id}`) as unknown as [{ n: number }];
    expect(n).toBe(1);
  });

  it("user A never gets user B's restaurant back, whatever the request says", async () => {
    const orgB = toPublicId("org", ALL_ORGS[1]!);
    const tries = [
      call(`/auth/me?org=${orgB}&orgId=${orgB}`, { token: a.token }),
      call("/auth/me", { token: a.token, headers: { "x-org-id": orgB, "x-rms-org": orgB } }),
      call("/auth/onboarding", { token: a.token, method: "POST", body: answers("counter_service") }),
    ];
    for (const res of await Promise.all(tries)) {
      const text = await res.text();
      expect(text).not.toContain(orgB);
      expect(text).not.toContain("Slice Yard");
      expect(text).not.toContain(ID("aa"));
    }
  });

  it("two onboarding requests at once still give one restaurant", async () => {
    const c = await signUp();
    const [r1, r2] = await Promise.all([
      call("/auth/onboarding", { token: c.token, method: "POST", body: answers("cafe") }),
      call("/auth/onboarding", { token: c.token, method: "POST", body: answers("cafe") }),
    ]);
    const ids = await Promise.all([r1, r2].map(async (r) => ((await r.json()) as { restaurant: { id: string } }).restaurant.id));
    expect(ids[0]).toBe(ids[1]);
    expect([r1.status, r2.status].sort()).toEqual([200, 201]);
    const [{ n }] = (await adminDb()`select count(*)::int as n from platform.members where user_id = ${c.id}`) as unknown as [{ n: number }];
    expect(n).toBe(1);
    // A loser, if any, is switched off and has no store.
    const off = await adminDb()<{ status: string; store_ready: boolean }[]>`
      select o.status, o.store_ready from platform.organizations o
      where o.id = any(${ALL_ORGS}) and not exists (select 1 from platform.members m where m.org_id = o.id)`;
    for (const o of off) expect(o).toEqual({ status: "suspended", store_ready: false });
  });

  it("answers the web origin's preflight and nobody else's", async () => {
    const web = env.WEB_URL!.replace(/\/$/, "");
    const ok = await app.request("/auth/me", { method: "OPTIONS", headers: { origin: web, "access-control-request-method": "GET", "access-control-request-headers": "authorization" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe(web);
    expect(ok.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("authorization");
    expect(ok.headers.get("access-control-allow-credentials")).toBeNull();
    const bad = await app.request("/auth/me", { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "GET" } });
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
  });
});

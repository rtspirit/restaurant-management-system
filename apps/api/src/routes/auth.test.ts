// Task A checks: sign-up through the local sign-in service, onboarding, /auth/me, isolation.
// Test data: uuid suffixes a0..af and store prefixes o_a1a1a1a1a1xx only (wave 1 brief).
import { existsSync } from "node:fs";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type DemoTemplate, MeResponse, toPublicId } from "@rms/contracts";
import { adminDb, closeAll, provisionStore } from "@rms/db";
import { type CreateDemoRestaurant, createAuthRoutes } from "./auth.js";

const envFile = "/Users/rahultiwari/github/restaurant-management-system/.env.local";
if (existsSync(envFile)) process.loadEnvFile(envFile);
const env = process.env;
const NEEDED = ["DATABASE_URL", "DATABASE_ADMIN_URL", "SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY", "WEB_URL"];
// These tests are the proof for task A. Missing settings are a failure, not a skip.
const missing = NEEDED.filter((k) => !env[k]);
if (missing.length > 0) throw new Error(`auth tests need these settings: ${missing.join(", ")}`);

const ID = (hex: string) => `0193a3c0-0000-7000-8000-0000000000${hex}`;
// Orgs a1..a6, one location each at a9..ae.
const ORG_SLOTS = ["a1", "a2", "a3", "a4", "a5", "a6"] as const;
const LOC_FOR: Record<string, string> = { a1: "a9", a2: "aa", a3: "ab", a4: "ac", a5: "ad", a6: "ae" };
const ALL_ORGS = ORG_SLOTS.map(ID);

let nextSlot = 0;
const stubCalls: DemoTemplate[] = [];
/** Extra behaviour for one test: runs after the org is made, or replaces the result. */
let stubHook: ((made: { orgUuid: string; storePrefix: string; name: string }) => Promise<void>) | undefined;
let stubOverride: (() => Promise<{ orgUuid: string; storePrefix: string; name: string }>) | undefined;

/** Stands in for task B's createDemoRestaurant: one org row, one location, a provisioned store. */
const stubCreate: CreateDemoRestaurant = async (sql, { template }) => {
  stubCalls.push(template);
  if (stubOverride) return stubOverride();
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
  const made = { orgUuid, storePrefix: prefix, name };
  await stubHook?.(made);
  return made;
};

const app = new Hono().route("/auth", createAuthRoutes({ createDemoRestaurant: stubCreate }));

type TestUser = { id: string; token: string };
const users: TestUser[] = [];

const randomHex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");
const adminHeaders = () => ({ apikey: env.SUPABASE_SECRET_KEY!, authorization: `Bearer ${env.SUPABASE_SECRET_KEY}` });

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

/** Deletes a sign-in user. Already gone is fine. */
const deleteUser = async (id: string) => {
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: adminHeaders() });
  if (!res.ok && res.status !== 404) throw new Error(`could not delete test user (status ${res.status})`);
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
const onboard = (token: string, style: "full_service" | "counter_service" | "cafe" = "cafe") =>
  call("/auth/onboarding", { token, method: "POST", body: answers(style) });

const me = async (token: string) => MeResponse.parse(await (await call("/auth/me", { token })).json());

const orgRow = async (org: string) =>
  (await adminDb()<{ status: string; store_ready: boolean }[]>`select status, store_ready from platform.organizations where id = ${org}`)[0];
const memberCount = async (user: string) =>
  (await adminDb()<{ n: number }[]>`select count(*)::int as n from platform.members where user_id = ${user}`)[0]?.n;

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

describe("sign-up and onboarding", () => {
  let a: TestUser;
  let b: TestUser;

  beforeAll(async () => {
    await cleanupOrgs();
    a = await signUp();
    b = await signUp();
  });

  beforeEach(() => {
    stubHook = undefined;
    stubOverride = undefined;
  });

  afterAll(async () => {
    try {
      await cleanupOrgs();
      for (const u of users) await deleteUser(u.id);
      // Nothing left behind.
      const left = await adminDb()`select id from platform.organizations where id = any(${ALL_ORGS})`;
      expect(left).toHaveLength(0);
      for (const u of users) {
        const res = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${u.id}`, { headers: adminHeaders() });
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
    expect((await onboard(a.token, "full_service")).status).toBe(201); // org a1
    expect((await onboard(b.token, "counter_service")).status).toBe(201); // org a2
    expect(stubCalls).toEqual(["marigold", "slice_yard"]);

    const meA = await me(a.token);
    const meB = await me(b.token);
    expect(meA.restaurant).toMatchObject({ id: toPublicId("org", ALL_ORGS[0]!), name: "Marigold Kitchen (test)", role: "owner", brandColour: "#E8892B", ready: true });
    expect(meA.restaurant?.locations).toEqual([{ id: toPublicId("loc", ID("a9")), name: "Marigold Kitchen (test) Downtown" }]);
    expect(meB.restaurant).toMatchObject({ id: toPublicId("org", ALL_ORGS[1]!), name: "Slice Yard (test)", role: "owner", brandColour: "#C8372D" });

    // Onboarding again returns the same restaurant and makes nothing new.
    const again = await onboard(a.token, "counter_service");
    expect(again.status).toBe(200);
    expect((await again.json()) as unknown).toMatchObject({ created: false, restaurant: { id: meA.restaurant?.id } });
    expect(stubCalls).toHaveLength(2);
    expect(await memberCount(a.id)).toBe(1);
  });

  it("user A never gets user B's restaurant back, whatever the request says", async () => {
    const orgB = toPublicId("org", ALL_ORGS[1]!);
    const tries = [
      call(`/auth/me?org=${orgB}&orgId=${orgB}`, { token: a.token }),
      call("/auth/me", { token: a.token, headers: { "x-org-id": orgB, "x-rms-org": orgB } }),
      onboard(a.token, "counter_service"),
    ];
    for (const res of await Promise.all(tries)) {
      const text = await res.text();
      expect(text).not.toContain(orgB);
      expect(text).not.toContain("Slice Yard");
      expect(text).not.toContain(ID("aa"));
    }
  });

  it("parallel onboarding requests: exactly one winner, the others get 409 and build nothing", async () => {
    const c = await signUp();
    const before = stubCalls.length;
    // Slow the build down so every request arrives while the first one holds the lock.
    stubHook = () => new Promise((r) => setTimeout(r, 400));
    const results = await Promise.all([onboard(c.token), onboard(c.token), onboard(c.token)]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409]);
    for (const r of results.filter((x) => x.status === 409)) {
      expect(((await r.json()) as { error: { message: string } }).error.message).toBe("Your restaurant is being set up. Give it a moment.");
    }
    expect(stubCalls.length - before).toBe(1); // org a3
    expect(await memberCount(c.id)).toBe(1);
    expect((await me(c.token)).restaurant?.id).toBe(toPublicId("org", ALL_ORGS[2]!));
  });

  it("a failure after the restaurant is made leaves no active ownerless org", async () => {
    const d = await signUp();
    // The user is deleted while their token is still valid, so the member insert fails.
    stubHook = async () => deleteUser(d.id);
    const res = await onboard(d.token);
    expect(res.status).toBe(500); // in the real app, index.ts onError turns this into plain words
    expect(await orgRow(ALL_ORGS[3]!)).toEqual({ status: "suspended", store_ready: false }); // org a4
    const ownerless = await adminDb()`
      select o.id from platform.organizations o
      where o.id = any(${ALL_ORGS}) and o.status = 'active'
        and not exists (select 1 from platform.members m where m.org_id = o.id)`;
    expect(ownerless).toHaveLength(0);
  });

  it("refuses a restaurant that already has people, and leaves it alone", async () => {
    const e = await signUp();
    stubOverride = async () => ({ orgUuid: ALL_ORGS[0]!, storePrefix: "o_a1a1a1a1a1a1", name: "Marigold Kitchen (test)" });
    const res = await onboard(e.token);
    expect(res.status).toBe(500);
    expect(await memberCount(e.id)).toBe(0);
    expect(await orgRow(ALL_ORGS[0]!)).toEqual({ status: "active", store_ready: true });
    expect((await me(a.token)).restaurant?.id).toBe(toPublicId("org", ALL_ORGS[0]!));
  });

  it("a member of a suspended restaurant is not given a new one", async () => {
    const f = await signUp();
    expect((await onboard(f.token)).status).toBe(201); // org a5
    await adminDb()`update platform.organizations set status = 'suspended' where id = ${ALL_ORGS[4]!}`;
    const before = stubCalls.length;
    const res = await onboard(f.token);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe("This account cannot set up a restaurant. Contact support.");
    expect(stubCalls.length).toBe(before);
    expect(await memberCount(f.id)).toBe(1);
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

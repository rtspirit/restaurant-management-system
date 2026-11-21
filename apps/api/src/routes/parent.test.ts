// GET /auth/parent/:model: a signed-in member reads their own restaurant's parent data, and
// nothing else. Real sign-in users against the local sign-in service, two seeded restaurants.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ParentModelKey } from "@rms/contracts";
import { adminDb, closeAll, newUuid } from "@rms/db";
import { requireTestEnv } from "@rms/db/testing";
import { createDemoRestaurant, removeRestaurants } from "@rms/seed";
import app from "../index.js";

requireTestEnv("DATABASE_URL", "DATABASE_ADMIN_URL", "SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY");
const env = process.env;

// Integration test ids: uuid suffix 70 to 7f, store prefixes o_7171717171xx. (d0 to df belongs to the @rms/db tests.)
const M = { org: "0193a3c0-0000-7000-8000-000000000079", prefix: "o_717171717109" };
const S = { org: "0193a3c0-0000-7000-8000-00000000007a", prefix: "o_71717171710a" };

type TestUser = { id: string; token: string };
const users: TestUser[] = [];
const randomHex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");

const signUp = async (): Promise<TestUser> => {
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY as string, "content-type": "application/json" },
    body: JSON.stringify({ email: `parent-${randomHex(6)}@integ.rms.test`, password: `Pw-${randomHex(16)}` }),
  });
  const json = (await res.json()) as { access_token?: string; user?: { id: string } };
  if (!res.ok || !json.access_token || !json.user) throw new Error(`sign-up failed with status ${res.status}`);
  const u = { id: json.user.id, token: json.access_token };
  users.push(u);
  return u;
};
const deleteUser = async (id: string) => {
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: { apikey: env.SUPABASE_SECRET_KEY as string, authorization: `Bearer ${env.SUPABASE_SECRET_KEY}` } });
  if (!res.ok && res.status !== 404) throw new Error(`could not delete test user (status ${res.status})`);
};

type Reply = { status: number; body: any; text: string };
const get = async (path: string, token?: string, init: { method?: string; headers?: Record<string, string> } = {}): Promise<Reply> => {
  const res = await app.request(path, { method: init.method ?? "GET", headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...init.headers } });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: the status assertions still apply.
  }
  return { status: res.status, body, text };
};
const ok = (r: Reply) => {
  expect(r.status, r.text.slice(0, 300)).toBe(200);
  return r.body;
};

describe("GET /auth/parent/:model", () => {
  let ownerM: TestUser, staffM: TestUser, ownerS: TestUser, nobody: TestUser;
  let downtown = "";

  beforeAll(async () => {
    const sql = adminDb();
    await removeRestaurants(sql, [M.org, S.org]);
    await createDemoRestaurant(sql, { template: "marigold", orgUuid: M.org, storePrefix: M.prefix });
    await createDemoRestaurant(sql, { template: "slice_yard", orgUuid: S.org, storePrefix: S.prefix });
    [ownerM, staffM, ownerS, nobody] = [await signUp(), await signUp(), await signUp(), await signUp()];
    const [loc] = await sql<{ id: string }[]>`select id from platform.locations where org_id = ${M.org} and name = 'Downtown'`;
    downtown = loc?.id as string;
    const staffMember = newUuid();
    await sql`insert into platform.members (id, org_id, user_id, role) values
      (${newUuid()}, ${M.org}, ${ownerM.id}, 'owner'), (${staffMember}, ${M.org}, ${staffM.id}, 'staff'), (${newUuid()}, ${S.org}, ${ownerS.id}, 'owner')`;
    await sql`insert into platform.member_locations (org_id, member_id, location_id) values (${M.org}, ${staffMember}, ${downtown})`;
  }, 120_000);

  afterAll(async () => {
    await removeRestaurants(adminDb(), [M.org, S.org]);
    for (const u of users) await deleteUser(u.id);
    await closeAll();
  }, 60_000);

  it("an owner reads every one of the ten lists of their own restaurant", async () => {
    for (const model of ParentModelKey.options) {
      const res = ok(await get(`/auth/parent/${model}`, ownerM.token));
      expect(res.model).toBe(model);
      expect(res.rows.length, model).toBeGreaterThan(0);
      expect(res.masked).toEqual([]);
    }
    expect(ok(await get("/auth/parent/locations", ownerM.token)).rows.map((r: any) => r.name)).toEqual(["Downtown", "Riverside"]);
    expect(ok(await get("/auth/parent/staff", ownerM.token)).rows).toHaveLength(24);
    expect(ok(await get("/auth/parent/profile", ownerM.token)).rows[0].name).toBe("Marigold Kitchen");
  });

  it("an owner sees pay and contact details. A staff member does not, and sees their own location only", async () => {
    const owner = ok(await get("/auth/parent/staff", ownerM.token));
    expect(owner.rows.every((r: any) => typeof r.hourly_rate_minor === "number" && typeof r.email === "string")).toBe(true);

    const staff = ok(await get("/auth/parent/staff", staffM.token));
    expect(staff.masked.sort()).toEqual(["email", "hourly_rate_minor", "phone"]);
    expect(staff.rows.length).toBeGreaterThan(0);
    expect(staff.rows.length).toBeLessThan(24);
    for (const r of staff.rows) {
      expect(Object.keys(r)).not.toContain("hourly_rate_minor");
      expect(Object.keys(r)).not.toContain("email");
      expect(Object.keys(r)).not.toContain("phone");
      expect(r.location_id).toBe(downtown);
    }
    expect(staff.columns.map((c: any) => c.key)).not.toContain("hourly_rate_minor");
    expect(ok(await get("/auth/parent/locations", staffM.token)).rows.map((r: any) => r.name)).toEqual(["Downtown"]);
    // The menu is not tied to a location: staff see all of it.
    expect(ok(await get("/auth/parent/menu_items", staffM.token)).rows.length).toBe(ok(await get("/auth/parent/menu_items", ownerM.token)).rows.length);
  });

  it("each restaurant sees only its own data", async () => {
    const seenByS: string[] = [];
    const seenByM: string[] = [];
    for (const model of ParentModelKey.options) {
      seenByS.push((await get(`/auth/parent/${model}`, ownerS.token)).text);
      seenByM.push((await get(`/auth/parent/${model}`, ownerM.token)).text);
    }
    const s = seenByS.join("\n");
    const m = seenByM.join("\n");
    expect(s).toContain("Slice Yard");
    expect(m).toContain("Marigold Kitchen");
    for (const word of ["Marigold", "Downtown", "Riverside", "marigold.test", M.org, downtown]) expect(s, word).not.toContain(word);
    for (const word of ["Slice Yard", "Mill Street", "sliceyard.test", S.org]) expect(m, word).not.toContain(word);
    expect(ok(await get("/auth/parent/locations", ownerS.token)).rows).toHaveLength(1);
    expect(ok(await get("/auth/parent/staff", ownerS.token)).rows).toHaveLength(9);
  });

  it("the restaurant cannot be chosen by the request", async () => {
    const mine = ok(await get("/auth/parent/staff", ownerS.token)).rows;
    for (const r of [
      await get(`/auth/parent/staff?org=${M.org}&org_id=${M.org}&orgId=org_${M.org}&store=${M.prefix}&role=owner`, ownerS.token),
      await get("/auth/parent/staff", ownerS.token, { headers: { "x-org": M.org, "x-org-id": M.org, "x-rms-org": M.org, "x-store-prefix": M.prefix, "x-role": "owner" } }),
    ]) {
      expect(ok(r).rows).toEqual(mine);
    }
    // A staff member cannot talk their way up to owner either.
    const staff = ok(await get("/auth/parent/staff?role=owner&locations=all", staffM.token, { headers: { "x-role": "owner" } }));
    expect(staff.masked.sort()).toEqual(["email", "hourly_rate_minor", "phone"]);
  });

  it("only the ten lists exist", async () => {
    for (const model of ["organizations", "members", "secrets", "STAFF", "staff%20", "staff%3Bdrop%20table", "parent.staff", "..%2Fplatform.secrets", `${M.prefix}_parent.staff`, "sales_day", "pg_roles"]) {
      const r = await get(`/auth/parent/${model}`, ownerM.token);
      expect(r.status, model).toBe(404);
      expect(r.text).not.toMatch(/rows|permission denied|relation|syntax|o_[0-9a-f]{12}/);
    }
  });

  it("needs a signed-in member", async () => {
    expect((await get("/auth/parent/staff")).status).toBe(401);
    expect((await get("/auth/parent/staff", `${ownerM.token.slice(0, -6)}AAAAAA`)).status).toBe(401);
    expect((await get("/auth/parent/staff", "not-a-token")).status).toBe(401);
    // Signed in, but with no restaurant.
    const r = await get("/auth/parent/staff", nobody.token);
    expect(r.status).toBe(403);
    expect(r.body?.rows).toBeUndefined();
  });

  it("is read-only: there is nothing to write to", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const r = await get("/auth/parent/staff", ownerM.token, { method });
      expect([404, 405], method).toContain(r.status);
    }
    expect(ok(await get("/auth/parent/staff", ownerM.token)).rows).toHaveLength(24);
  });
});

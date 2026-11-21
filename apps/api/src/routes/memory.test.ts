// Task M. POST /memory/v1/duplicates and GET /memory/v1/summaries: owner only, own restaurant only.
// Real sign-in users against the local sign-in service, two throwaway restaurants. No model call:
// the matches below are word for word, and a restaurant with nothing to compare makes no call.
// Ids: task M's range (uuid suffix 54, 55; store prefixes o_5151515151a4, o_5151515151b5). Cleans up.
import { DuplicateCheckResult, MEMORY_ROUTES, toPublicId } from "@rms/contracts";
import { adminDb, closeAll, newUuid } from "@rms/db";
import { requireTestEnv } from "@rms/db/testing";
import { createDemoRestaurant, removeRestaurants } from "@rms/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../index.js";

requireTestEnv("DATABASE_URL", "DATABASE_ADMIN_URL", "SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY");
const env = process.env;

const A = { org: "0193a3c0-0000-7000-8000-000000000054", prefix: "o_5151515151a4" };
const B = { org: "0193a3c0-0000-7000-8000-000000000055", prefix: "o_5151515151b5" };
const CANARY = "mcanary_route_a_91be04";
const REQUEST = `I want to see how much money I'm making ${CANARY}`;

type TestUser = { id: string; token: string };
const users: TestUser[] = [];
const randomHex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");

const signUp = async (): Promise<TestUser> => {
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY as string, "content-type": "application/json" },
    body: JSON.stringify({ email: `memory-${randomHex(6)}@integ.rms.test`, password: `Pw-${randomHex(16)}` }),
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
const call = async (method: "GET" | "POST", path: string, token?: string, body?: unknown): Promise<Reply> => {
  const res = await app.request(path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON: the status assertions still apply.
  }
  return { status: res.status, body: parsed, text };
};

describe("memory routes", () => {
  let ownerA: TestUser, staffA: TestUser, ownerB: TestUser;
  const moneyApp = newUuid();
  const session = newUuid();

  beforeAll(async () => {
    const sql = adminDb();
    await removeRestaurants(sql, [A.org, B.org]);
    await createDemoRestaurant(sql, { template: "marigold", orgUuid: A.org, storePrefix: A.prefix });
    await createDemoRestaurant(sql, { template: "slice_yard", orgUuid: B.org, storePrefix: B.prefix });
    [ownerA, staffA, ownerB] = [await signUp(), await signUp(), await signUp()];
    await sql`insert into platform.members (id, org_id, user_id, role) values
      (${newUuid()}, ${A.org}, ${ownerA.id}, 'owner'), (${newUuid()}, ${A.org}, ${staffA.id}, 'staff'), (${newUuid()}, ${B.org}, ${ownerB.id}, 'owner')`;
    const [n] = await sql<{ n: number }[]>`select coalesce(max(number), 0)::int + 1 as n from platform.apps where org_id = ${A.org}`;
    await sql`insert into platform.apps (id, org_id, slug, number, name, kind, status) values (${moneyApp}, ${A.org}, 'm-route-money', ${n?.n ?? 1}, 'Money', 'custom', 'published')`;
    await sql`insert into platform.app_profiles (app_id, org_id, purpose, capabilities, requests)
      values (${moneyApp}, ${A.org}, 'Weekly sales, costs, profit and prime cost.', '{}', ${[REQUEST]}::text[])`;
    await sql`insert into platform.agent_sessions (id, org_id, user_id, app_id, mode, model) values (${session}, ${A.org}, ${ownerA.id}, ${moneyApp}, 'build', 'test')`;
    await sql`insert into platform.org_memory (id, org_id, kind, text, source_session_id) values
      (${newUuid()}, ${A.org}, 'session_summary', ${`The owner built Money. ${CANARY}`}, ${session}),
      (${newUuid()}, ${A.org}, 'fact', 'Their week runs Monday to Sunday.', ${session})`;
  }, 180_000);

  afterAll(async () => {
    await removeRestaurants(adminDb(), [A.org, B.org]);
    for (const u of users) await deleteUser(u.id);
    await closeAll();
  }, 60_000);

  const dup = MEMORY_ROUTES.duplicates;
  const sums = MEMORY_ROUTES.summaries;

  it("refuses no token, a staff member, and a body that names a restaurant", async () => {
    expect((await call("POST", dup, undefined, { text: REQUEST })).status).toBe(401);
    expect((await call("GET", sums)).status).toBe(401);
    const staff = await call("POST", dup, staffA.token, { text: REQUEST });
    expect(staff.status).toBe(403);
    expect(staff.body.error.code).toBe("forbidden");
    expect((await call("GET", sums, staffA.token)).status).toBe(403);
    const named = await call("POST", dup, ownerA.token, { text: REQUEST, orgId: toPublicId("org", B.org) });
    expect(named.status).toBe(400);
    expect(named.body.error.code).toBe("invalid_request");
    expect((await call("POST", dup, ownerA.token, {})).status).toBe(400);
    expect((await call("POST", dup, ownerA.token)).status).toBe(400);
  });

  it("the owner asking again, word for word, hears 'you already have this', with a reason and no score", async () => {
    const r = await call("POST", dup, ownerA.token, { text: REQUEST.toUpperCase() });
    expect(r.status, r.text.slice(0, 300)).toBe(200);
    const body = DuplicateCheckResult.parse(r.body);
    expect(body.verdict).toBe("same");
    expect(body.matches).toEqual([{ appId: toPublicId("app", moneyApp), appName: "Money", reason: "It already does this: weekly sales, costs, profit and prime cost.", published: true }]);
    expect(r.text).not.toMatch(/score|similarity|distance/i);
  });

  it("another restaurant's owner, with the same words, gets nothing of A's", async () => {
    const r = await call("POST", dup, ownerB.token, { text: REQUEST });
    expect(r.status, r.text.slice(0, 300)).toBe(200);
    expect(r.body).toEqual({ verdict: "none", matches: [] });
    expect(r.text).not.toContain(CANARY);
  });

  it("the owner lists what RMS remembers, newest first; the other restaurant sees none of it", async () => {
    const mine = await call("GET", sums, ownerA.token);
    expect(mine.status, mine.text.slice(0, 300)).toBe(200);
    expect(mine.body.summaries).toHaveLength(1);
    expect(mine.body.summaries[0]).toMatchObject({ sessionId: toPublicId("ses", session), appId: toPublicId("app", moneyApp), facts: ["Their week runs Monday to Sunday."] });
    const theirs = await call("GET", sums, ownerB.token);
    expect(theirs.status).toBe(200);
    expect(theirs.body).toEqual({ summaries: [] });
    expect(theirs.text).not.toContain(CANARY);
  });
});

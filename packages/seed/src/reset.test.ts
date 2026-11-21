import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Sql, adminDb, closeAll } from "@rms/db";
import { createDemoRestaurant, removeRestaurants } from "./demo.js";
import { type DemoUserSpec, authAdminFromEnv, checkDemoPassword, checkResetAllowed, createDemoUsers, deleteAuthUsers, listAuthUsers, resetDemo } from "./reset.js";

for (const f of [resolve(import.meta.dirname, "../../../.env.local"), "/Users/rahultiwari/github/restaurant-management-system/.env.local"]) {
  if (existsSync(f)) {
    process.loadEnvFile(f);
    break;
  }
}
const hasDb = Boolean(process.env.DATABASE_ADMIN_URL && process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY && process.env.SUPABASE_PUBLISHABLE_KEY);

const LOCAL = { DATABASE_ADMIN_URL: "postgresql://rms_admin:x@127.0.0.1:54322/postgres", SUPABASE_URL: "http://127.0.0.1:54321" };
const GOOD_PW = { DEMO_PASSWORD: "a-long-enough-one" };

describe("checkResetAllowed", () => {
  it("allows a local database and a local sign-in service", () => {
    expect(checkResetAllowed(LOCAL).ok).toBe(true);
    expect(checkResetAllowed({ DATABASE_ADMIN_URL: "postgres://u:p@localhost:5432/db", SUPABASE_URL: "http://localhost:54321" }).ok).toBe(true);
  });

  it.each([
    ["a hosted database", { ...LOCAL, DATABASE_ADMIN_URL: "postgresql://u:p@aws-0-us-east-1.pooler.supabase.com:6543/postgres" }],
    ["a hosted sign-in service", { ...LOCAL, SUPABASE_URL: "https://abcdefgh.supabase.co" }],
    ["a look-alike host", { ...LOCAL, DATABASE_ADMIN_URL: "postgresql://u:p@127.0.0.1.nip.io:5432/db" }],
    ["localhost as a subdomain", { ...LOCAL, SUPABASE_URL: "http://localhost.example.com" }],
    ["a host override in the query", { ...LOCAL, DATABASE_ADMIN_URL: "postgresql://u:p@127.0.0.1:5432/db?host=db.example.com" }],
    ["localhost hidden in the user part", { ...LOCAL, DATABASE_ADMIN_URL: "postgresql://127.0.0.1:p@db.example.com:5432/db" }],
    ["a remote PGHOST", { ...LOCAL, PGHOST: "db.example.com" }],
    ["no database URL", { SUPABASE_URL: LOCAL.SUPABASE_URL }],
    ["no sign-in URL", { DATABASE_ADMIN_URL: LOCAL.DATABASE_ADMIN_URL }],
    ["a garbage URL", { ...LOCAL, DATABASE_ADMIN_URL: "not a url" }],
  ])("refuses %s", (_label, env) => {
    const res = checkResetAllowed(env as Record<string, string>);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/^Refusing to reset/);
  });

  it("RMS_ALLOW_RESET=1, and only exactly that, overrides", () => {
    const remote = { DATABASE_ADMIN_URL: "postgresql://u:p@db.example.com:5432/db", SUPABASE_URL: "https://x.supabase.co" };
    expect(checkResetAllowed({ ...remote, RMS_ALLOW_RESET: "1" }).ok).toBe(true);
    expect(checkResetAllowed({ ...remote, RMS_ALLOW_RESET: "true" }).ok).toBe(false);
  });
});

describe("checkDemoPassword", () => {
  it("needs DEMO_PASSWORD of 10 characters or more, and says so plainly", () => {
    const missing = checkDemoPassword({});
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toMatch(/DEMO_PASSWORD is not set/);
    const short = checkDemoPassword({ DEMO_PASSWORD: "123456789" });
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.reason).toMatch(/too short/);
    expect(checkDemoPassword({ DEMO_PASSWORD: "1234567890" }).ok).toBe(true);
  });
});

describe("resetDemo refuses before touching anything", () => {
  const untouchable = new Proxy(() => {}, {
    get: () => {
      throw new Error("the database was touched");
    },
    apply: () => {
      throw new Error("the database was touched");
    },
  }) as unknown as Sql;

  it("on a remote host", async () => {
    await expect(resetDemo(untouchable, { ...GOOD_PW, DATABASE_ADMIN_URL: "postgresql://u:p@db.example.com/x", SUPABASE_URL: LOCAL.SUPABASE_URL })).rejects.toThrow(/Refusing to reset/);
  });
  it("without a demo password", async () => {
    await expect(resetDemo(untouchable, LOCAL)).rejects.toThrow(/DEMO_PASSWORD is not set/);
  });
});

// The full reset deletes EVERY sign-in user and restaurant, so it is never run here: the shared
// local database is in use by other tasks. Its pieces are tested on this task's own data only.
describe.skipIf(!hasDb)("reset pieces, on task B's own restaurant and users", () => {
  const ORG = { orgUuid: "0193a3c0-0000-7000-8000-0000000000b8", storePrefix: "o_b1b1b1b1b1b8" };
  const mine = (email: string) => email.endsWith("@b.rms.test");
  const password = randomBytes(18).toString("base64url"); // test process only, never logged
  const USERS: DemoUserSpec[] = [
    { email: "owner-slice@b.rms.test", name: "Test owner", kind: "owner", template: "slice_yard" },
    { email: "staff-slice@b.rms.test", name: "Test staff", kind: "staff", template: "slice_yard", onlyLocation: "Mill Street" },
    { email: "maintainer@b.rms.test", name: "Test maintainer", kind: "maintainer" },
  ];
  const auth = hasDb ? authAdminFromEnv() : (undefined as never);

  beforeAll(async () => {
    await deleteAuthUsers(auth, mine);
    await removeRestaurants(adminDb(), [ORG.orgUuid]);
  });
  afterAll(async () => {
    await deleteAuthUsers(auth, mine);
    await removeRestaurants(adminDb(), [ORG.orgUuid]);
    await closeAll();
  });

  it("the configured local stack passes the safety check", () => {
    expect(checkResetAllowed(process.env).ok).toBe(true);
  });

  it("creates owners, staff and the maintainer, linked to the right places", async () => {
    const slice = await createDemoRestaurant(adminDb(), { template: "slice_yard", ...ORG });
    const summary = await createDemoUsers(adminDb(), auth, { slice_yard: slice }, password, USERS);
    expect(summary).toEqual([
      { email: "owner-slice@b.rms.test", kind: "owner", restaurant: "Slice Yard" },
      { email: "staff-slice@b.rms.test", kind: "staff", restaurant: "Slice Yard" },
      { email: "maintainer@b.rms.test", kind: "maintainer", restaurant: null },
    ]);
    expect(JSON.stringify(summary)).not.toContain(password);

    const users = await listAuthUsers(auth, mine);
    expect(users.map((u) => u.email).sort()).toEqual(USERS.map((u) => u.email).sort());
    const id = (email: string) => users.find((u) => u.email === email)!.id;

    const members = await adminDb()<{ user_id: string; role: string; locs: string[] }[]>`
      select m.user_id, m.role, coalesce(array_agg(l.name) filter (where l.name is not null), '{}') as locs
      from platform.members m
      left join platform.member_locations ml on ml.member_id = m.id
      left join platform.locations l on l.id = ml.location_id
      where m.org_id = ${ORG.orgUuid} group by m.user_id, m.role order by m.role`;
    expect(members).toEqual([
      { user_id: id("owner-slice@b.rms.test"), role: "owner", locs: [] },
      { user_id: id("staff-slice@b.rms.test"), role: "staff", locs: ["Mill Street"] },
    ]);
    const [staffUser] = await adminDb()`select name from platform.staff_users where user_id = ${id("maintainer@b.rms.test")}`;
    expect(staffUser?.name).toBe("Test maintainer");
  });

  it("the demo password signs in", async () => {
    const client = createClient(process.env.SUPABASE_URL as string, process.env.SUPABASE_PUBLISHABLE_KEY as string, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await client.auth.signInWithPassword({ email: "owner-slice@b.rms.test", password });
    expect(error).toBeNull();
    expect(data.user?.email).toBe("owner-slice@b.rms.test");
    await client.auth.signOut();
  });

  it("deleting sign-in users removes their memberships and maintainer rows too", async () => {
    const userIds = (await listAuthUsers(auth, mine)).map((u) => u.id);
    expect(await deleteAuthUsers(auth, mine)).toBe(3);
    expect(await listAuthUsers(auth, mine)).toEqual([]);
    const [m] = await adminDb()`select count(*)::int as n from platform.members where user_id = any(${userIds}::uuid[])`;
    const [s] = await adminDb()`select count(*)::int as n from platform.staff_users where user_id = any(${userIds}::uuid[])`;
    expect([m?.n, s?.n]).toEqual([0, 0]);
  });
});

// The demo reset: wipe every restaurant and every sign-in user, then build the two demo
// restaurants and their users again. Destructive, so it refuses to run anywhere but a local stack
// unless RMS_ALLOW_RESET=1 is set.
import { createClient } from "@supabase/supabase-js";
import { type Sql, newUuid } from "@rms/db";
import { type CreatedRestaurant, createDemoRestaurant, removeRestaurants } from "./demo.js";
import type { DemoTemplate } from "./templates.js";

type Env = Record<string, string | undefined>;
export type Check = { ok: true } | { ok: false; reason: string };

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);

const hostOf = (url: string | undefined): string | null => {
  if (!url) return null;
  try {
    const u = new URL(url);
    // A libpq-style ?host= or ?hostaddr= would override the address in the URL.
    for (const k of u.searchParams.keys()) if (/^(host|hostaddr)$/i.test(k)) return null;
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
};

/** Pure. The reset runs only against a local database and a local sign-in service, or with RMS_ALLOW_RESET=1. */
export const checkResetAllowed = (env: Env): Check => {
  if (env.RMS_ALLOW_RESET === "1") return { ok: true };
  const db = hostOf(env.DATABASE_ADMIN_URL);
  const auth = hostOf(env.SUPABASE_URL);
  if (env.PGHOST && !LOCAL_HOSTS.has(env.PGHOST.toLowerCase())) {
    return { ok: false, reason: "Refusing to reset: PGHOST points somewhere other than this computer. Set RMS_ALLOW_RESET=1 if you really mean it." };
  }
  if (!db || !LOCAL_HOSTS.has(db)) {
    return { ok: false, reason: "Refusing to reset: the database is not on this computer (127.0.0.1 or localhost). Set RMS_ALLOW_RESET=1 if you really mean it." };
  }
  if (!auth || !LOCAL_HOSTS.has(auth)) {
    return { ok: false, reason: "Refusing to reset: the sign-in service (SUPABASE_URL) is not on this computer. Set RMS_ALLOW_RESET=1 if you really mean it." };
  }
  return { ok: true };
};

/** Pure. Demo passwords come from DEMO_PASSWORD and must be at least 10 characters. */
export const checkDemoPassword = (env: Env): Check => {
  const pw = env.DEMO_PASSWORD;
  if (!pw) return { ok: false, reason: "DEMO_PASSWORD is not set. Add it to .env.local (10 characters or more) and run again." };
  if (pw.length < 10) return { ok: false, reason: "DEMO_PASSWORD is too short. Use 10 characters or more." };
  return { ok: true };
};

/** The few calls we need from Supabase Auth's admin API. */
export type AuthAdmin = ReturnType<typeof createClient>["auth"]["admin"];

export const authAdminFromEnv = (env: Env = process.env): AuthAdmin => {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY must be set");
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } }).auth.admin;
};

/** Lists sign-in users, all pages. `filter` narrows by email. */
export const listAuthUsers = async (auth: AuthAdmin, filter: (email: string) => boolean = () => true): Promise<{ id: string; email: string }[]> => {
  const out: { id: string; email: string }[] = [];
  for (let page = 1; ; page++) {
    const { data, error } = await auth.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`Could not list sign-in users: ${error.message}`);
    for (const u of data.users) if (filter(u.email ?? "")) out.push({ id: u.id, email: u.email ?? "" });
    if (data.users.length < 200) return out;
  }
};

/** Deletes sign-in users (all of them, or those whose email passes `filter`). Returns how many. */
export const deleteAuthUsers = async (auth: AuthAdmin, filter?: (email: string) => boolean): Promise<number> => {
  const users = await listAuthUsers(auth, filter);
  for (const u of users) {
    const { error } = await auth.deleteUser(u.id);
    if (error) throw new Error(`Could not delete a sign-in user: ${error.message}`);
  }
  return users.length;
};

export type DemoUserSpec =
  | { email: string; name: string; kind: "owner" | "staff"; template: DemoTemplate; onlyLocation?: string }
  | { email: string; name: string; kind: "maintainer" };

export const DEFAULT_DEMO_USERS: readonly DemoUserSpec[] = [
  { email: "owner@marigold.test", name: "Marigold owner", kind: "owner", template: "marigold" },
  { email: "staff@marigold.test", name: "Marigold staff", kind: "staff", template: "marigold", onlyLocation: "Downtown" },
  { email: "owner@sliceyard.test", name: "Slice Yard owner", kind: "owner", template: "slice_yard" },
  { email: "staff@sliceyard.test", name: "Slice Yard staff", kind: "staff", template: "slice_yard" },
  { email: "maintainer@rms.test", name: "RMS maintainer", kind: "maintainer" },
];

/**
 * Creates sign-in users and links them: owners and staff to their restaurant (staff optionally to
 * one location), the maintainer to platform.staff_users. Passwords are never logged or returned.
 */
export const createDemoUsers = async (
  adminSql: Sql,
  auth: AuthAdmin,
  restaurants: Partial<Record<DemoTemplate, CreatedRestaurant>>,
  password: string,
  users: readonly DemoUserSpec[] = DEFAULT_DEMO_USERS,
): Promise<{ email: string; kind: DemoUserSpec["kind"]; restaurant: string | null }[]> => {
  const summary: { email: string; kind: DemoUserSpec["kind"]; restaurant: string | null }[] = [];
  for (const u of users) {
    const { data, error } = await auth.createUser({ email: u.email, password, email_confirm: true, user_metadata: { name: u.name } });
    if (error || !data.user) throw new Error(`Could not create the sign-in user ${u.email}: ${error?.message ?? "no user returned"}`);
    const userId = data.user.id;
    if (u.kind === "maintainer") {
      await adminSql`insert into platform.staff_users (id, user_id, name) values (${newUuid()}, ${userId}, ${u.name})`;
      summary.push({ email: u.email, kind: u.kind, restaurant: null });
      continue;
    }
    const r = restaurants[u.template];
    if (!r) throw new Error(`No ${u.template} restaurant to add ${u.email} to`);
    await adminSql.begin(async (tx) => {
      const memberId = newUuid();
      await tx`insert into platform.members (id, org_id, user_id, role) values (${memberId}, ${r.orgUuid}, ${userId}, ${u.kind})`;
      if (u.onlyLocation) {
        const [loc] = await tx<{ id: string }[]>`select id from platform.locations where org_id = ${r.orgUuid} and name = ${u.onlyLocation}`;
        if (!loc) throw new Error(`No location called ${u.onlyLocation}`);
        await tx`insert into platform.member_locations (org_id, member_id, location_id) values (${r.orgUuid}, ${memberId}, ${loc.id})`;
      }
    });
    summary.push({ email: u.email, kind: u.kind, restaurant: r.name });
  }
  return summary;
};

/**
 * The full reset. Checks first, then: drop every store, delete every restaurant's platform rows,
 * delete every sign-in user, create both demo restaurants and their users.
 */
export const resetDemo = async (adminSql: Sql, env: Env = process.env): Promise<string[]> => {
  for (const check of [checkResetAllowed(env), checkDemoPassword(env)]) if (!check.ok) throw new Error(check.reason);
  const password = env.DEMO_PASSWORD as string;
  const auth = authAdminFromEnv(env);

  const orgs = await adminSql<{ id: string }[]>`select id from platform.organizations`;
  await removeRestaurants(adminSql, orgs.map((o) => o.id));
  const removedUsers = await deleteAuthUsers(auth);

  const marigold = await createDemoRestaurant(adminSql, { template: "marigold" });
  const sliceYard = await createDemoRestaurant(adminSql, { template: "slice_yard" });
  const users = await createDemoUsers(adminSql, auth, { marigold, slice_yard: sliceYard }, password);

  return [
    `Removed ${orgs.length} restaurant(s) and ${removedUsers} sign-in user(s).`,
    `Created ${marigold.name} and ${sliceYard.name}.`,
    ...users.map((u) => `  ${u.email}  ${u.kind}${u.restaurant ? ` at ${u.restaurant}` : ""}`),
    "Passwords are the value of DEMO_PASSWORD.",
  ];
};

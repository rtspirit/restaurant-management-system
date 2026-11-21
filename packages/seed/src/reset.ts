// The demo reset: wipe every restaurant and every sign-in user, then build the two demo
// restaurants and their users again. Destructive, so it refuses to run anywhere but a local stack
// unless RMS_ALLOW_RESET=1 is set.
import { createClient } from "@supabase/supabase-js";
import { type Sql, apiDb, newUuid } from "@rms/db";
import { drainOutbox, recordChange } from "@rms/governance";
import { LIBRARY } from "@rms/models";
import { seedDemoBooks } from "./books.js";
import { type CreatedRestaurant, createDemoRestaurant, removeRestaurants } from "./demo.js";
import { installPlatformLibrary } from "./library.js";
import type { DemoTemplate } from "./templates.js";

type Env = Record<string, string | undefined>;
export type Check = { ok: true } | { ok: false; reason: string };

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);

const hostOf = (url: string | undefined): string | null => {
  if (!url) return null;
  // The standard URL parser stops at "#", but postgres.js does not: "u:p@127.0.0.1#@remote/db"
  // would pass a URL check and connect elsewhere. Anything with "#" is refused outright.
  if (url.includes("#")) return null;
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

/**
 * Checks the connection the reset is actually about to use, not the settings it came from:
 * every host postgres.js will try must be exactly 127.0.0.1 or localhost, with no socket path.
 */
export const checkConnectionIsLocal = (adminSql: Pick<Sql, "options">): Check => {
  const hosts = adminSql.options.host;
  const local = Array.isArray(hosts) && hosts.length > 0 && hosts.every((h) => LOCAL_HOSTS.has(String(h).toLowerCase()));
  if (!local || adminSql.options.path) {
    return { ok: false, reason: "Refusing to reset: the database connection is not to this computer (127.0.0.1 or localhost). Set RMS_ALLOW_RESET=1 if you really mean it." };
  }
  return { ok: true };
};

/**
 * The restaurant-facing connection must go to the same server and database as the admin
 * connection the reset is using. Otherwise the reset would rebuild one database and try to load
 * numbers into another. This compares what the two drivers will REALLY connect to (their parsed
 * options), not the text of a connection string: a `?port=` or `?host=` in the text changes
 * where the driver goes without changing what the text appears to say.
 */
export const checkSameDatabase = (adminSql: Pick<Sql, "options">, apiSql: Pick<Sql, "options">): Check => {
  const where = (sql: Pick<Sql, "options">): string | null => {
    const o = sql.options;
    const hosts = Array.isArray(o.host) ? o.host.map((h) => String(h).toLowerCase()) : [];
    const ports = Array.isArray(o.port) ? o.port.map(Number) : [];
    // The driver sends its extra connection settings AFTER the database name when it connects, so
    // a `?database=` in a connection string wins over the name in the path. Read it the same way.
    const override = (o.connection as Record<string, unknown> | undefined)?.database;
    const database = override ?? o.database;
    // One host, one port, a named database, no socket path. Anything else is not compared, it is refused.
    if (hosts.length !== 1 || ports.length !== 1 || !Number.isInteger(ports[0]) || typeof database !== "string" || database === "" || o.path) return null;
    return JSON.stringify([hosts[0], ports[0], database]);
  };
  const admin = where(adminSql);
  const api = where(apiSql);
  return admin !== null && admin === api
    ? { ok: true }
    : { ok: false, reason: "Refusing to reset: DATABASE_URL and DATABASE_ADMIN_URL do not point at the same database." };
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

export const authAdminFromEnv = (env: Env = process.env): AuthAdmin => buildAuthAdmin(env).auth;

/** Builds the admin client and returns the exact host it was built with. */
const buildAuthAdmin = (env: Env): { auth: AuthAdmin; host: string } => {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY must be set");
  if (url.includes("#")) throw new Error("SUPABASE_URL is not a plain address");
  const u = new URL(url);
  // The client is built from the parsed origin, so the host checked below is the host it calls.
  const auth = createClient(u.origin, key, { auth: { autoRefreshToken: false, persistSession: false } }).auth.admin;
  return { auth, host: u.hostname.toLowerCase() };
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

/** Deletes the sign-in users whose email passes `filter`. The filter is required. Returns how many. */
export const deleteAuthUsers = async (auth: AuthAdmin, filter: (email: string) => boolean): Promise<number> => {
  if (typeof filter !== "function") throw new Error("deleteAuthUsers needs a filter");
  return deleteUsers(auth, filter);
};

/** Not exported. Called with "everyone" only from resetDemo, after its guards. */
const deleteUsers = async (auth: AuthAdmin, filter: (email: string) => boolean): Promise<number> => {
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

export type ResetOptions = {
  /**
   * Load eight weeks of sales, bills, staff cost and stock counts into each restaurant and post
   * them to the books, so the demo starts with numbers. Default true. Once the Demo POS
   * connection exists (Wave 2) it becomes the thing that loads them, and the reset passes false.
   */
  withSales?: boolean;
};

/**
 * The full reset. Checks first, then: drop every store, delete every restaurant's platform rows,
 * delete every sign-in user, create both demo restaurants and their users, install the model
 * library (every template checked first), make each restaurant's library tables and, with
 * `withSales`, load and post its numbers.
 */
export const resetDemo = async (adminSql: Sql, env: Env = process.env, opts: ResetOptions = {}): Promise<string[]> => {
  const withSales = opts.withSales ?? true;
  const allowAnywhere = env.RMS_ALLOW_RESET === "1";
  const checks: (() => Check)[] = [
    () => checkResetAllowed(env),
    () => checkDemoPassword(env),
    () => (allowAnywhere ? { ok: true } : checkConnectionIsLocal(adminSql)),
  ];
  for (const run of checks) {
    const check = run();
    if (!check.ok) throw new Error(check.reason);
  }
  const password = env.DEMO_PASSWORD as string;
  const { auth, host: authHost } = buildAuthAdmin(env);
  if (!allowAnywhere && !LOCAL_HOSTS.has(authHost)) {
    throw new Error("Refusing to reset: the sign-in service is not on this computer. Set RMS_ALLOW_RESET=1 if you really mean it.");
  }

  // The numbers are loaded through the Data API, which opens its own connection from
  // DATABASE_URL. It must be the same database the reset is about to rebuild.
  if (withSales) {
    let same: Check;
    try {
      // `apiDb()` is the very connection the Data API will use.
      same = checkSameDatabase(adminSql, apiDb());
    } catch {
      same = { ok: false, reason: "Refusing to reset: DATABASE_URL is not set, so the numbers have nowhere to go." };
    }
    if (!same.ok) throw new Error(same.reason);
  }

  const orgs = await adminSql<{ id: string }[]>`select id from platform.organizations`;
  await removeRestaurants(adminSql, orgs.map((o) => o.id));
  const removedUsers = await deleteUsers(auth, () => true);

  const marigold = await createDemoRestaurant(adminSql, { template: "marigold" });
  const sliceYard = await createDemoRestaurant(adminSql, { template: "slice_yard" });
  const users = await createDemoUsers(adminSql, auth, { marigold, slice_yard: sliceYard }, password);

  // The library: every template is checked, then all of it is installed, or none of it.
  const library = await installPlatformLibrary(adminSql);

  const books: string[] = [];
  for (const [template, r] of [["marigold", marigold], ["slice_yard", sliceYard]] as const) {
    const [owner] = await adminSql<{ user_id: string }[]>`
      select user_id from platform.members where org_id = ${r.orgUuid} and role = 'owner' order by created_at limit 1`;
    if (!owner) throw new Error(`${r.name} has no owner to record its numbers under`);
    const { books: loaded } = await seedDemoBooks(adminSql, { orgUuid: r.orgUuid, template, ownerUserId: owner.user_id, withSales });
    // Giving a restaurant its tables is a change like any other, so it goes on the record:
    // one change set per restaurant, which the maintainer console's feed then shows.
    await adminSql.begin((tx) =>
      recordChange(tx, {
        orgUuid: r.orgUuid,
        origin: "system",
        actor: { type: "system", id: "demo-reset" },
        signals: ["new_model"],
        subject: { kind: "settings", name: "Standard records" },
        diff: { models: LIBRARY.models.map((m) => m.key), numbersLoaded: loaded !== null },
      }),
    );
    if (!loaded) {
      books.push(`  ${r.name}: tables, chart of accounts and fiscal calendar ready. No numbers loaded.`);
      continue;
    }
    const posted = loaded.posted.salesDays + loaded.posted.vendorBills + loaded.posted.labourDays + loaded.posted.stockCounts;
    const net = (loaded.lastWeek.netSalesMinor / 100).toLocaleString("en-US", { minimumFractionDigits: 2 });
    books.push(
      `  ${r.name}: ${loaded.rows.sales_day ?? 0} days of sales from ${loaded.startsOn} to ${loaded.endsOn}, ${posted} entries posted to the books. ` +
        `Week of ${loaded.lastWeek.weekStart}: net sales $${net}, prime cost ${loaded.lastWeek.primeCostPct}%${loaded.lastWeek.stockCounted ? "" : " (no stock count yet)"}.`,
    );
  }

  // Hand the recorded changes to the console feed.
  await drainOutbox(adminSql, { orgUuids: [marigold.orgUuid, sliceYard.orgUuid] });

  return [
    `Removed ${orgs.length} restaurant(s) and ${removedUsers} sign-in user(s).`,
    `Created ${marigold.name} and ${sliceYard.name}.`,
    ...users.map((u) => `  ${u.email}  ${u.kind}${u.restaurant ? ` at ${u.restaurant}` : ""}`),
    `Installed the model library: ${library.models} models, ${library.namedQueries} reports, ${library.namedActions} actions.`,
    ...books,
    "Passwords are the value of DEMO_PASSWORD.",
  ];
};

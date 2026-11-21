// Removes what this suite signs up: the e2e-<random>@rms.test sign-in users and the restaurants
// they own. Restaurants go through the platform's own `removeRestaurants` (which calls
// platform.drop_store and deletes the platform rows, in one transaction) on the admin login.
// Users go through the local sign-in service's admin API. Nothing else is ever touched: a user
// is only removed when its email matches the suite's pattern, and a restaurant only when every
// one of its members is such a user.
import { adminDb } from "@rms/db";
// @rms/seed is not a dependency of the repo root, so it is loaded from its built output.
// Build it first (pnpm build, or turbo run build --filter=@rms/seed...).
import { removeRestaurants } from "../../../packages/seed/dist/index.js";
import { SIGNUP_DOMAIN, SIGNUP_PREFIX, SUPABASE, supabaseSecret } from "./env.js";

const isSuiteEmail = (email: string | undefined): email is string =>
  !!email && email.startsWith(SIGNUP_PREFIX) && email.endsWith(`@${SIGNUP_DOMAIN}`) && /^e2e-[0-9a-f]{10}@/.test(email);

const authBase = () => `${SUPABASE}/auth/v1`;
const adminHeaders = () => ({ apikey: supabaseSecret(), authorization: `Bearer ${supabaseSecret()}`, "content-type": "application/json" });

/** The suite's leftover sign-in users (id and email), from any run. */
export const suiteUsers = async (): Promise<{ id: string; email: string }[]> => {
  const out: { id: string; email: string }[] = [];
  for (let page = 1; page < 50; page++) {
    const res = await fetch(`${authBase()}/admin/users?page=${page}&per_page=200`, { headers: adminHeaders() });
    // Never echo the body: it can carry tokens.
    if (!res.ok) throw new Error(`The local sign-in service refused to list users (status ${res.status})`);
    const users = ((await res.json()) as { users?: { id: string; email?: string }[] }).users ?? [];
    for (const u of users) if (isSuiteEmail(u.email)) out.push({ id: u.id, email: u.email });
    if (users.length < 200) break;
  }
  return out;
};

/**
 * Removes the given suite users and every restaurant that only they belong to.
 * Returns how many restaurants and users were removed.
 */
export const removeSuiteSignUps = async (only?: string[]): Promise<{ restaurants: number; users: number }> => {
  const all = await suiteUsers();
  const users = only ? all.filter((u) => only.includes(u.email)) : all;
  if (users.length === 0) return { restaurants: 0, users: 0 };
  const ids = users.map((u) => u.id);
  const admin = adminDb();
  // Restaurants these users are members of, where NO member is anyone else.
  const orgs = await admin<{ org_id: string }[]>`
    select distinct m.org_id from platform.members m
    where m.user_id = any(${ids}::uuid[])
      and not exists (select 1 from platform.members o where o.org_id = m.org_id and not (o.user_id = any(${ids}::uuid[])))`;
  await removeRestaurants(admin, orgs.map((o) => o.org_id));
  for (const u of users) {
    const res = await fetch(`${authBase()}/admin/users/${u.id}`, { method: "DELETE", headers: adminHeaders() });
    if (!res.ok && res.status !== 404) throw new Error(`The local sign-in service refused to delete a test user (status ${res.status})`);
  }
  return { restaurants: orgs.length, users: users.length };
};

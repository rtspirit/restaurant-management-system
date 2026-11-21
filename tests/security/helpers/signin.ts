// Test users on the LOCAL sign-in service. Used by global-setup.ts only: sign-ins are rate limited
// (30 per five minutes per address, shared by every task), so the suite signs each user in once
// and hands the access tokens to the tests.
import { randomBytes } from "node:crypto";

/** Every user this suite makes has an address in this made-up domain, so cleanup can find them. */
export const USER_DOMAIN = "g.rms-security.test";
export const USER_EMAILS = {
  ownerA: `owner-a@${USER_DOMAIN}`,
  staffA: `staff-a@${USER_DOMAIN}`,
  ownerB: `owner-b@${USER_DOMAIN}`,
  maintainer: `maintainer@${USER_DOMAIN}`,
  nobody: `nobody@${USER_DOMAIN}`,
} as const;
export type UserKey = keyof typeof USER_EMAILS;

const base = () => `${(process.env.SUPABASE_URL as string).replace(/\/$/, "")}/auth/v1`;
const adminHeaders = () => ({
  apikey: process.env.SUPABASE_SECRET_KEY as string,
  authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY as string}`,
  "content-type": "application/json",
});

const must = async (res: Response, what: string): Promise<unknown> => {
  // Never echo the response body: it can carry tokens.
  if (!res.ok) throw new Error(`Local sign-in service refused to ${what} (status ${res.status})`);
  return res.json();
};

/** Deletes every user in the suite's domain, including ones a failed run left behind. */
export const deleteSuiteUsers = async (): Promise<void> => {
  for (let page = 1; page < 50; page++) {
    const body = (await must(await fetch(`${base()}/admin/users?page=${page}&per_page=200`, { headers: adminHeaders() }), "list users")) as { users?: { id: string; email?: string }[] };
    const users = body.users ?? [];
    for (const u of users) {
      if (u.email?.endsWith(`@${USER_DOMAIN}`)) await must(await fetch(`${base()}/admin/users/${u.id}`, { method: "DELETE", headers: adminHeaders() }), "delete a user");
    }
    if (users.length < 200) return;
  }
};

export type SuiteUser = { id: string; email: string; accessToken: string };

/** Creates the suite's users with one random password (kept in memory only) and signs each in once. */
export const createSuiteUsers = async (): Promise<Record<UserKey, SuiteUser>> => {
  const password = randomBytes(24).toString("base64url");
  const out = {} as Record<UserKey, SuiteUser>;
  for (const [key, email] of Object.entries(USER_EMAILS) as [UserKey, string][]) {
    const made = (await must(
      await fetch(`${base()}/admin/users`, { method: "POST", headers: adminHeaders(), body: JSON.stringify({ email, password, email_confirm: true }) }),
      "create a user",
    )) as { id: string };
    const session = (await must(
      await fetch(`${base()}/token?grant_type=password`, {
        method: "POST",
        headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY as string, "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      }),
      "sign a user in",
    )) as { access_token: string };
    out[key] = { id: made.id, email, accessToken: session.access_token };
  }
  return out;
};

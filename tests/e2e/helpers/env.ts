// Settings for the browser suite. Read from the repo's `.env.local` (or RMS_ENV_FILE) through
// the same loader the other tests use. Refuses to run against anything but this computer.
// Never print a value from here: DEMO_PASSWORD and the service key are secrets.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTestEnv } from "@rms/db/testing";

loadTestEnv();

const need = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`The browser suite needs the setting ${name}. Start the local stack and run scripts/dev-db-roles.sh, or set RMS_ENV_FILE.`);
  return v;
};

const LOCAL = new Set(["127.0.0.1", "localhost", "[::1]"]);
const local = (name: string): string => {
  const url = need(name).replace(/\/$/, "");
  if (!LOCAL.has(new URL(url).hostname)) throw new Error(`The browser suite only runs against this computer, and ${name} points elsewhere.`);
  return url;
};

// The API only answers these exact origins, so the suite always uses 127.0.0.1, never localhost.
const to127 = (url: string): string => url.replace("://localhost", "://127.0.0.1");

export const WEB = to127(process.env.E2E_WEB_URL ?? local("WEB_URL"));
export const CONSOLE = to127(process.env.E2E_ADMIN_URL ?? local("ADMIN_URL"));
export const API = to127(local("NEXT_PUBLIC_API_URL"));
export const SUPABASE = local("SUPABASE_URL");
for (const url of [WEB, CONSOLE, API]) {
  if (!LOCAL.has(new URL(url).hostname)) throw new Error("The browser suite only runs against this computer.");
}

/** The seeded demo users' password. Never log it, never put it in a title, a file name or a report. */
export const demoPassword = (): string => need("DEMO_PASSWORD");
/** The local sign-in service's admin key, for cleaning up the users this suite signs up. */
export const supabaseSecret = (): string => need("SUPABASE_SECRET_KEY");

export const E2E_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
export const AUTH_DIR = join(E2E_DIR, ".auth");

/** The seeded sign-ins (emails only). */
export const USERS = {
  marigoldOwner: "owner@marigold.test",
  marigoldStaff: "staff@marigold.test",
  sliceYardOwner: "owner@sliceyard.test",
  sliceYardStaff: "staff@sliceyard.test",
  maintainer: "maintainer@rms.test",
} as const;

/** Every account this suite signs up has an address like e2e-<random>@rms.test, so cleanup can find them. */
export const SIGNUP_PREFIX = "e2e-";
export const SIGNUP_DOMAIN = "rms.test";

/** Saved signed-in browser state, one file per session made in global-setup.ts. */
export const STATE = {
  marigoldOwner: join(AUTH_DIR, "marigold-owner.json"),
  marigoldStaff: join(AUTH_DIR, "marigold-staff.json"),
  sliceYardOwner: join(AUTH_DIR, "sliceyard-owner.json"),
  maintainer: join(AUTH_DIR, "console-maintainer.json"),
  ownerInConsole: join(AUTH_DIR, "console-owner.json"),
} as const;

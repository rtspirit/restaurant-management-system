// Read-only checks of the HOSTED project. They run only when the suite is pointed at the hosted
// settings file:
//
//   RMS_ENV_FILE=.env.hosted pnpm test:security
//
// In that mode vitest.security.config.ts runs THIS FILE ONLY: no test world is created and no
// attack is made. Each check is one SELECT as the restaurant-facing login. On the local stack
// every test here is skipped.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiDb, closeAll } from "@rms/db";
import { assertHostedIsOurProject, hostedMode, loadEnv } from "../helpers/env.js";

loadEnv();
const HOSTED = hostedMode();

describe.skipIf(!HOSTED)("hosted project: read-only checks (set RMS_ENV_FILE to the hosted settings file)", () => {
  beforeAll(() => {
    // Only ever our own project, through its pooler, as rms_api. Anything else stops here.
    assertHostedIsOurProject();
  });
  afterAll(closeAll);

  it("the sign-in service's signing secret is NOT readable from database settings", async () => {
    // On the local stack it is (known-limits.test.ts). Hosted must return nothing, for every setting name it has gone by.
    for (const name of ["app.settings.jwt_secret", "app.jwt_secret", "pgrst.jwt_secret"]) {
      const [row] = await apiDb().unsafe("select coalesce(current_setting($1, true), '') as value", [name]);
      expect(String((row as Record<string, unknown>).value).length, name).toBe(0);
    }
  });

  it("no app.settings value of any kind is set for the database or for a role", async () => {
    const rows = await apiDb().unsafe("select count(*)::int as n from pg_catalog.pg_db_role_setting s cross join lateral unnest(s.setconfig) as c(entry) where c.entry ilike 'app.settings.%' or c.entry ilike '%jwt_secret%'");
    expect((rows[0] as Record<string, unknown>).n).toBe(0);
  });

  it("the connection goes through the pooler, with no prepared statements", async () => {
    expect(new URL(process.env.DATABASE_URL as string).hostname).toMatch(/\.pooler\.supabase\.com$/);
    expect(apiDb().options.prepare).toBe(false);
    const [row] = await apiDb().unsafe("select current_user as who");
    expect((row as Record<string, unknown>).who).toBe("rms_api");
  });

  it("with no restaurant set, the restaurant-facing login sees no restaurant", async () => {
    const [row] = await apiDb().unsafe("select count(*)::int as n from platform.organizations");
    expect((row as Record<string, unknown>).n).toBe(0);
  });
});

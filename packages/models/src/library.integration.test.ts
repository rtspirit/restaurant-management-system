// Lead-owned integration test: the real library packs through the real compiler, on a real database.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminDb, closeAll, ident, newStorePrefix, newUuid, provisionStore } from "@rms/db";
import { requireTestEnv } from "@rms/db/testing";
import { LIBRARY, ensureModels, installLibrary } from "./index.js";

requireTestEnv("DATABASE_URL", "DATABASE_ADMIN_URL");

// Fresh id and store prefix on every run, so parallel runs on the shared local database never meet.
const ORG = newUuid();
const PREFIX = newStorePrefix();

const cleanup = async () => {
  const sql = adminDb();
  await sql`select platform.drop_store(${ORG})`.catch(() => {});
  await sql`delete from platform.org_model_changes where org_id = ${ORG}`;
  await sql`delete from platform.org_models where org_id = ${ORG}`;
  await sql`delete from platform.organizations where id = ${ORG}`;
};

// Shared local database: under parallel runs these wait on other runs. Give them time.
describe("the real library on a real store", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    await adminDb()`insert into platform.organizations (id, slug, name, store_prefix) values (${ORG}, ${`libtest-${PREFIX.slice(2)}`}, 'Library Test', ${PREFIX})`;
    await provisionStore(adminDb(), ORG);
  });
  afterAll(async () => {
    await cleanup();
    await closeAll();
  });

  it("has the models, reports and actions the accounts mini-app needs", () => {
    const keys = new Set(LIBRARY.models.map((m) => m.key));
    for (const k of ["sales_day", "sales_category_day", "payment_day", "account", "journal_entry", "journal_line", "posting_rule", "fiscal_week", "vendor", "vendor_bill", "labour_day", "item", "stock_count", "stock_count_line"]) {
      expect(keys.has(k), k).toBe(true);
    }
    const queries = new Set(LIBRARY.namedQueries.map((q) => q.key));
    for (const k of ["prime_cost_by_week", "weekly_pnl", "sales_by_day", "sales_by_location", "cost_of_goods_by_week", "stock_on_hand"]) expect(queries.has(k), k).toBe(true);
    const actions = new Set(LIBRARY.namedActions.map((a) => a.key));
    for (const k of ["post_sales_day", "post_vendor_bill", "post_labour_day", "post_stock_count", "seed_chart_of_accounts", "seed_fiscal_calendar"]) expect(actions.has(k), k).toBe(true);
  });

  it("installs the library and is safe to install twice", async () => {
    const first = await installLibrary(adminDb(), LIBRARY);
    expect(first.models).toBe(LIBRARY.models.length);
    await installLibrary(adminDb(), LIBRARY);
    const [row] = await adminDb()<{ n: number }[]>`select count(*)::int as n from platform.model_templates`;
    expect(row?.n).toBeGreaterThanOrEqual(LIBRARY.models.length);
  });

  it("creates every library table in both the live and the draft schema, and a second run changes nothing", async () => {
    const keys = LIBRARY.models.map((m) => m.key);
    const first = await ensureModels(adminDb(), ORG, keys, { library: LIBRARY });
    expect(first.created.length).toBe(keys.length);
    const again = await ensureModels(adminDb(), ORG, keys, { library: LIBRARY });
    expect(again.created).toEqual([]);
    for (const schema of [PREFIX, `${PREFIX}_draft`]) {
      const tables = await adminDb()<{ tablename: string }[]>`select tablename from pg_tables where schemaname = ${schema}`;
      const have = new Set(tables.map((t) => t.tablename));
      for (const k of keys) expect(have.has(k), `${schema}.${k}`).toBe(true);
    }
  }, 120_000);

  it("leaves nothing of ours in public and gives no table to PUBLIC", async () => {
    const [pub] = await adminDb()<{ n: number }[]>`select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','v','m','S','f')`;
    expect(pub?.n).toBe(0);
    const [grants] = await adminDb()<{ n: number }[]>`
      select count(*)::int as n from information_schema.role_table_grants
      where table_schema in (${PREFIX}, ${`${PREFIX}_draft`}) and grantee in ('PUBLIC', 'rms_tenant', 'anon', 'authenticated')`;
    expect(grants?.n).toBe(0);
    expect(ident(PREFIX)).toBe(`"${PREFIX}"`);
  });
});

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TenantContext, toPublicId } from "@rms/contracts";
import { adminDb, apiDb, closeAll, ident, newUuid, provisionStore, withStore } from "@rms/db";
import { PARENT_TABLES, syncParent } from "./index.js";

for (const f of [resolve(import.meta.dirname, "../../../.env.local"), "/Users/rahultiwari/github/restaurant-management-system/.env.local"]) {
  if (existsSync(f)) {
    process.loadEnvFile(f);
    break;
  }
}
const hasDb = Boolean(process.env.DATABASE_URL && process.env.DATABASE_ADMIN_URL);

// Task B test range.
const A = "0193a3c0-0000-7000-8000-0000000000b0";
const B = "0193a3c0-0000-7000-8000-0000000000b1";
const PA = "o_b1b1b1b1b1a0";
const PB = "o_b1b1b1b1b1a1";

const ctx = (org: string, prefix: string, env: "live" | "draft"): TenantContext => ({
  orgId: toPublicId("org", org),
  storePrefix: prefix,
  actor: { type: "user", id: toPublicId("usr", "0193a3c0-0000-7000-8000-0000000000bf") },
  role: "owner",
  locations: "all",
  env,
});

const cleanup = async () => {
  const sql = adminDb();
  for (const id of [A, B]) {
    await sql`select platform.drop_store(${id})`.catch(() => {});
    await sql`delete from platform.parent_sync_state where org_id = ${id}`;
    for (const t of ["parent_equipment", "parent_licences", "parent_tax_rates", "parent_menu_modifiers", "parent_menu_items", "parent_menu_categories", "parent_staff", "parent_jobs", "restaurant_profiles", "locations"]) {
      await sql.unsafe(`delete from platform.${ident(t)} where org_id = $1`, [id]);
    }
    await sql`delete from platform.organizations where id = ${id}`;
  }
};

/** Every parent table of one store, as JSON text ordered by id, read as that restaurant. */
const parentSnapshot = async (org: string, prefix: string) =>
  withStore(apiDb(), ctx(org, prefix, "live"), async (tx, s) => {
    const out: Record<string, unknown> = {};
    for (const t of PARENT_TABLES) {
      const [r] = await tx.unsafe(`select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]'::jsonb)::text as j from ${s.parentTable(t.key)} x`);
      out[t.key] = JSON.parse(r?.j as string);
    }
    return out;
  });

/** The same, from the platform source tables, minus org_id. */
const sourceSnapshot = async (org: string) => {
  const out: Record<string, unknown> = {};
  for (const t of PARENT_TABLES) {
    const [r] = await adminDb().unsafe(
      `select coalesce(jsonb_agg(to_jsonb(x) - 'org_id' order by x.id), '[]'::jsonb)::text as j from platform.${ident(t.source)} x where org_id = $1`,
      [org],
    );
    out[t.key] = JSON.parse(r?.j as string);
  }
  return out;
};

const seedOrg = async (org: string, prefix: string, label: string) => {
  const sql = adminDb();
  const loc = newUuid();
  const job = newUuid();
  const cat = newUuid();
  const item = newUuid();
  await sql.begin(async (tx) => {
    await tx`insert into platform.organizations (id, slug, name, store_prefix) values (${org}, ${`taskb-sync-${prefix.slice(-2)}`}, ${label}, ${prefix})`;
    await tx`insert into platform.locations (id, org_id, name, hours, seats) values (${loc}, ${org}, 'Main', ${tx.json({ mon: { open: "17:00", close: "22:00" } })}, 40)`;
    await tx`insert into platform.restaurant_profiles (org_id, id, name, concept, cuisine, service_style, seats, price_band, systems_used)
             values (${org}, ${newUuid()}, ${label}, 'Test', 'Test', 'full_service', 40, 'mid', ${["Demo POS", "Spreadsheets"]})`;
    await tx`insert into platform.parent_jobs (id, org_id, name, house, tipped) values (${job}, ${org}, 'Server', 'front', true)`;
    await tx`insert into platform.parent_staff (id, org_id, location_id, full_name, job_id, email, hourly_rate_minor, started_on)
             values (${newUuid()}, ${org}, ${loc}, ${`${label} Person`}, ${job}, 'person@b.rms.test', 9007199254740993, '2025-01-02')`;
    await tx`insert into platform.parent_menu_categories (id, org_id, name, sales_group) values (${cat}, ${org}, 'Mains', 'food')`;
    await tx`insert into platform.parent_menu_items (id, org_id, category_id, name, price_minor) values (${item}, ${org}, ${cat}, ${`${label} Dish`}, 2500)`;
    await tx`insert into platform.parent_menu_modifiers (id, org_id, item_id, name, price_minor) values (${newUuid()}, ${org}, ${item}, 'Extra', 200)`;
    await tx`insert into platform.parent_tax_rates (id, org_id, location_id, name, rate_bps) values (${newUuid()}, ${org}, ${loc}, 'Sales tax', 875)`;
    await tx`insert into platform.parent_licences (id, org_id, location_id, name, expires_on) values (${newUuid()}, ${org}, ${loc}, 'Permit', '2027-01-01')`;
    await tx`insert into platform.parent_equipment (id, org_id, location_id, name) values (${newUuid()}, ${org}, ${loc}, 'Oven')`;
  });
  await provisionStore(sql, org);
};

describe.skipIf(!hasDb)("syncParent", () => {
  beforeAll(async () => {
    await cleanup();
    await seedOrg(A, PA, "Sync A");
    await seedOrg(B, PB, "Sync B");
  });
  afterAll(async () => {
    await cleanup();
    await closeAll();
  });

  it("makes the parent schema match the source, exactly", async () => {
    const res = await syncParent(adminDb(), A);
    expect(res.tables.map((t) => t.key)).toEqual(PARENT_TABLES.map((t) => t.key));
    expect(res.tables.every((t) => t.rows === 1 && t.changed)).toBe(true);
    const copy = await parentSnapshot(A, PA);
    expect(copy).toEqual(await sourceSnapshot(A));
    // A bigint beyond JavaScript's safe range (2^53 + 1) survives the copy unchanged.
    const [big] = await withStore(apiDb(), ctx(A, PA, "live"), (tx, s) => tx.unsafe(`select hourly_rate_minor::text as v from ${s.parentTable("staff")}`));
    expect(big?.v).toBe("9007199254740993");
  });

  it("running it twice changes nothing", async () => {
    const before = await parentSnapshot(A, PA);
    const res = await syncParent(adminDb(), A);
    expect(res.tables.every((t) => !t.changed)).toBe(true);
    expect(await parentSnapshot(A, PA)).toEqual(before);
  });

  it("follows changes, additions and removals in the source", async () => {
    const sql = adminDb();
    await sql`update platform.parent_menu_items set price_minor = 2700, updated_at = now() where org_id = ${A}`;
    await sql`delete from platform.parent_equipment where org_id = ${A}`;
    await sql`insert into platform.parent_jobs (id, org_id, name, house) values (${newUuid()}, ${A}, 'Cook', 'back')`;
    const res = await syncParent(sql, A);
    const changed = res.tables.filter((t) => t.changed).map((t) => t.key).sort();
    expect(changed).toEqual(["equipment", "jobs", "menu_items"]);
    expect(await parentSnapshot(A, PA)).toEqual(await sourceSnapshot(A));
  });

  it("records what it copied in parent_sync_state", async () => {
    const rows = await adminDb()<{ model_key: string; row_count: number }[]>`
      select model_key, row_count from platform.parent_sync_state where org_id = ${A} order by model_key`;
    expect(rows).toHaveLength(10);
    expect(rows.find((r) => r.model_key === "jobs")?.row_count).toBe(2);
    expect(rows.find((r) => r.model_key === "equipment")?.row_count).toBe(0);
  });

  it("copies one restaurant only: the other's parent schema is untouched", async () => {
    const empty = await parentSnapshot(B, PB);
    expect(Object.values(empty).every((v) => Array.isArray(v) && v.length === 0)).toBe(true);
    await syncParent(adminDb(), B);
    const b = await parentSnapshot(B, PB);
    expect((b.menu_items as { name: string }[]).map((r) => r.name)).toEqual(["Sync B Dish"]);
    expect(await parentSnapshot(A, PA)).toEqual(await sourceSnapshot(A));
  });

  it("a restaurant's own roles cannot write its parent schema", async () => {
    for (const env of ["live", "draft"] as const) {
      await expect(
        withStore(apiDb(), ctx(A, PA, env), (tx, s) => tx.unsafe(`insert into ${s.parentTable("jobs")} (id, name, house) values ($1, 'Hacker', 'front')`, [newUuid()])),
      ).rejects.toThrow(/permission denied/);
      await expect(withStore(apiDb(), ctx(A, PA, env), (tx, s) => tx.unsafe(`update ${s.parentTable("menu_items")} set price_minor = 1`))).rejects.toThrow(/permission denied/);
      await expect(withStore(apiDb(), ctx(A, PA, env), (tx, s) => tx.unsafe(`delete from ${s.parentTable("staff")}`))).rejects.toThrow(/permission denied/);
    }
    // Nor can the admin login write it directly: only the sync role can.
    await expect(adminDb().unsafe(`delete from ${ident(`${PA}_parent`)}.jobs`)).rejects.toThrow(/permission denied/);
  });

  it("refuses an unknown restaurant or one without a store", async () => {
    await expect(syncParent(adminDb(), "0193a3c0-0000-7000-8000-0000000000be")).rejects.toThrow(/Unknown restaurant/);
  });
});

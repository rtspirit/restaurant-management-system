import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TenantContext, toPublicId } from "@rms/contracts";
import { adminDb, apiDb, closeAll, ident, newUuid, withStore } from "@rms/db";
import { PARENT_TABLES, syncParent } from "@rms/parent";
import { createDemoRestaurant, removeRestaurants } from "./demo.js";
import { PARENT_SOURCE_TABLES, buildParentRows } from "./parent-data.js";
import { TEMPLATES } from "./templates.js";
import { loadTestEnv } from "@rms/db/testing";

loadTestEnv();
const hasDb = Boolean(process.env.DATABASE_URL && process.env.DATABASE_ADMIN_URL);

// Task B test range.
const MARIGOLD = { orgUuid: "0193a3c0-0000-7000-8000-0000000000b4", storePrefix: "o_b1b1b1b1b1b4" };
const SLICE = { orgUuid: "0193a3c0-0000-7000-8000-0000000000b5", storePrefix: "o_b1b1b1b1b1b5" };
const TODAY = "2026-11-21";

const EXPECTED: Record<"marigold" | "slice_yard", Record<string, number>> = {
  marigold: { profile: 1, locations: 2, jobs: 11, staff: 24, menu_categories: 6, menu_items: 40, menu_modifiers: 11, tax_rates: 4, licences: 6, equipment: 13 },
  slice_yard: { profile: 1, locations: 1, jobs: 7, staff: 9, menu_categories: 4, menu_items: 20, menu_modifiers: 7, tax_rates: 2, licences: 3, equipment: 7 },
};

const ctx = (org: string, prefix: string, env: "live" | "draft"): TenantContext => ({
  orgId: toPublicId("org", org),
  storePrefix: prefix,
  actor: { type: "user", id: toPublicId("usr", "0193a3c0-0000-7000-8000-0000000000bf") },
  role: "owner",
  locations: "all",
  env,
});

describe("parent data (no database)", () => {
  it.each(["marigold", "slice_yard"] as const)("%s has the counts in the brief", (t) => {
    const rows = buildParentRows(t, { orgUuid: newUuid(), today: TODAY });
    const byKey = Object.fromEntries(PARENT_TABLES.map((p) => [p.key, rows[p.source as (typeof PARENT_SOURCE_TABLES)[number]].length]));
    expect(byKey).toEqual(EXPECTED[t]);
  });

  it.each(["marigold", "slice_yard"] as const)("%s: emails end in .test, names are unique, ids are uuid v7", (t) => {
    const rows = buildParentRows(t, { orgUuid: newUuid(), today: TODAY });
    for (const s of rows.parent_staff) expect(String(s.email)).toMatch(/^[a-z.-]+@[a-z]+\.test$/);
    expect(new Set(rows.parent_staff.map((s) => s.full_name)).size).toBe(rows.parent_staff.length);
    expect(new Set(rows.parent_staff.map((s) => s.email)).size).toBe(rows.parent_staff.length);
    for (const s of rows.parent_staff) expect(String(s.phone)).toMatch(/^\+1 202 555 01\d\d$/);
    for (const table of PARENT_SOURCE_TABLES) for (const r of rows[table]) expect(String(r.id)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
  });

  it.each(["marigold", "slice_yard"] as const)("%s: exactly one licence expires within 30 days", (t) => {
    const rows = buildParentRows(t, { orgUuid: newUuid(), today: TODAY });
    const soon = rows.parent_licences.filter((l) => String(l.expires_on) <= "2026-12-21");
    expect(soon).toHaveLength(1);
    expect(rows.parent_licences.every((l) => String(l.expires_on) > TODAY)).toBe(true);
  });

  it("two builds give the same names, prices and dates; only ids differ", () => {
    const strip = (rows: ReturnType<typeof buildParentRows>) =>
      JSON.parse(JSON.stringify(rows, (k, v) => (k.endsWith("id") ? undefined : v)));
    expect(strip(buildParentRows("marigold", { orgUuid: newUuid(), today: TODAY }))).toEqual(strip(buildParentRows("marigold", { orgUuid: newUuid(), today: TODAY })));
  });

  it("brand colours and categories match the brief", () => {
    expect(TEMPLATES.marigold.brandColour).toBe("#E8892B");
    expect(TEMPLATES.slice_yard.brandColour).toBe("#C8372D");
    expect(TEMPLATES.marigold.categories.some((c) => c.salesGroup === "alcohol")).toBe(true);
  });

  it("the seed never calls Math.random", () => {
    const dir = import.meta.dirname;
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"))) {
      expect(readFileSync(resolve(dir, f), "utf8")).not.toMatch(/Math\.random\s*\(/);
    }
  });
});

describe.skipIf(!hasDb)("createDemoRestaurant", () => {
  beforeAll(async () => {
    await removeRestaurants(adminDb(), [MARIGOLD.orgUuid, SLICE.orgUuid]);
  });
  afterAll(async () => {
    await removeRestaurants(adminDb(), [MARIGOLD.orgUuid, SLICE.orgUuid]);
    await closeAll();
  });

  let created: { orgUuid: string; storePrefix: string; name: string }[] = [];

  it("creates both restaurants with the interface task A codes against", async () => {
    const m = await createDemoRestaurant(adminDb(), { template: "marigold", ...MARIGOLD, today: TODAY });
    const s = await createDemoRestaurant(adminDb(), { template: "slice_yard", ...SLICE, today: TODAY });
    expect(m).toEqual({ orgUuid: MARIGOLD.orgUuid, storePrefix: MARIGOLD.storePrefix, name: "Marigold Kitchen" });
    expect(s).toEqual({ orgUuid: SLICE.orgUuid, storePrefix: SLICE.storePrefix, name: "Slice Yard" });
    created = [m, s];
    const orgs = await adminDb()<{ id: string; brand_colour: string; store_ready: boolean; slug: string }[]>`
      select id, brand_colour, store_ready, slug from platform.organizations where id in ${adminDb()([m.orgUuid, s.orgUuid])} order by id`;
    expect(orgs.map((o) => [o.brand_colour, o.store_ready])).toEqual([["#E8892B", true], ["#C8372D", true]]);
    expect(orgs[0]?.slug).toBe("marigold-kitchen-b1b1b1b1b1b4");
  });

  it("row counts match the brief, in the platform and in each parent schema", async () => {
    for (const [r, t] of [[created[0]!, "marigold"], [created[1]!, "slice_yard"]] as const) {
      const counts = await withStore(apiDb(), ctx(r.orgUuid, r.storePrefix, "live"), async (tx, st) => {
        const out: Record<string, number> = {};
        for (const p of PARENT_TABLES) {
          const [row] = await tx.unsafe(`select count(*)::int as n from ${st.parentTable(p.key)}`);
          out[p.key] = row?.n as number;
        }
        return out;
      });
      expect(counts).toEqual(EXPECTED[t]);
      for (const p of PARENT_TABLES) {
        const [row] = await adminDb().unsafe(`select count(*)::int as n from platform.${ident(p.source)} where org_id = $1`, [r.orgUuid]);
        expect(row?.n).toBe(EXPECTED[t][p.key]);
      }
    }
  });

  it("locations carry hours and a 04:00 day cutoff", async () => {
    const locs = await adminDb()<{ name: string; day_cutoff: string; hours: Record<string, unknown> }[]>`
      select name, day_cutoff::text, hours from platform.locations where org_id = ${MARIGOLD.orgUuid} order by name`;
    expect(locs.map((l) => l.name)).toEqual(["Downtown", "Riverside"]);
    for (const l of locs) {
      expect(l.day_cutoff).toBe("04:00:00");
      expect(Object.keys(l.hours).sort()).toEqual(["fri", "mon", "sat", "sun", "thu", "tue", "wed"]);
    }
  });

  it("staff belong to a location and a job of the same restaurant", async () => {
    const [bad] = await adminDb()<{ n: number }[]>`
      select count(*)::int as n from platform.parent_staff s
      left join platform.locations l on l.id = s.location_id and l.org_id = s.org_id
      left join platform.parent_jobs j on j.id = s.job_id and j.org_id = s.org_id
      where s.org_id in ${adminDb()([MARIGOLD.orgUuid, SLICE.orgUuid])} and (l.id is null or j.id is null or s.hourly_rate_minor is null)`;
    expect(bad?.n).toBe(0);
  });

  it("the parent copy matches the source, and a second sync changes nothing", async () => {
    for (const r of created) {
      const res = await syncParent(adminDb(), r.orgUuid);
      expect(res.tables.every((t) => !t.changed)).toBe(true);
    }
  });

  it("a write to the parent schema as the restaurant's own roles fails at the database", async () => {
    const r = created[0]!;
    for (const env of ["live", "draft"] as const) {
      await expect(
        withStore(apiDb(), ctx(r.orgUuid, r.storePrefix, env), (tx, s) => tx.unsafe(`update ${s.parentTable("menu_items")} set price_minor = 1`)),
      ).rejects.toThrow(/permission denied/);
      await expect(
        withStore(apiDb(), ctx(r.orgUuid, r.storePrefix, env), (tx, s) => tx.unsafe(`insert into ${s.parentTable("licences")} (id, name) values ($1, 'Fake')`, [newUuid()])),
      ).rejects.toThrow(/permission denied/);
    }
  });

  it("the draft role sees staff names and jobs but not pay or contact details", async () => {
    const r = created[0]!;
    const names = await withStore(apiDb(), ctx(r.orgUuid, r.storePrefix, "draft"), (tx, s) => tx.unsafe(`select full_name from ${s.parentTable("staff")}`));
    expect(names).toHaveLength(24);
    await expect(
      withStore(apiDb(), ctx(r.orgUuid, r.storePrefix, "draft"), (tx, s) => tx.unsafe(`select hourly_rate_minor from ${s.parentTable("staff")}`)),
    ).rejects.toThrow(/permission denied/);
  });

  it("removeRestaurants leaves nothing behind", async () => {
    await removeRestaurants(adminDb(), [MARIGOLD.orgUuid, SLICE.orgUuid]);
    const ids = [MARIGOLD.orgUuid, SLICE.orgUuid];
    for (const t of [...PARENT_TABLES.map((p) => p.source), "parent_sync_state"]) {
      const [row] = await adminDb().unsafe(`select count(*)::int as n from platform.${ident(t)} where org_id = any($1::uuid[])`, [ids]);
      expect(row?.n).toBe(0);
    }
    const [orgs] = await adminDb()`select count(*)::int as n from platform.organizations where id = any(${ids}::uuid[])`;
    expect(orgs?.n).toBe(0);
    const [schemas] = await adminDb()`select count(*)::int as n from pg_namespace where nspname like 'o_b1b1b1b1b1b4%' or nspname like 'o_b1b1b1b1b1b5%'`;
    expect(schemas?.n).toBe(0);
    const [roles] = await adminDb()`select count(*)::int as n from pg_roles where rolname like 'o_b1b1b1b1b1b4%' or rolname like 'o_b1b1b1b1b1b5%'`;
    expect(roles?.n).toBe(0);
  });
});

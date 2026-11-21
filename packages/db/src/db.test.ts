import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TenantContext, toPublicId } from "@rms/contracts";
import { adminDb, apiDb, asParentSync, closeAll, ident, newStorePrefix, provisionStore, withOrg, withStore } from "./index.js";

const envFile = resolve(import.meta.dirname, "../../../.env.local");
if (existsSync(envFile)) process.loadEnvFile(envFile);
const hasDb = Boolean(process.env.DATABASE_URL && process.env.DATABASE_ADMIN_URL);

const A = "0193a3c0-0000-7000-8000-0000000000d1";
const B = "0193a3c0-0000-7000-8000-0000000000d2";
const PA = "o_dddddddddd01";
const PB = "o_dddddddddd02";
const user = toPublicId("usr", "0193a3c0-0000-7000-8000-0000000000d9");
const ctx = (org: string, prefix: string, env: "live" | "draft" = "live"): TenantContext => ({
  orgId: toPublicId("org", org), storePrefix: prefix, actor: { type: "user", id: user }, role: "owner", locations: "all", env,
});

const cleanup = async () => {
  const sql = adminDb();
  for (const id of [A, B]) {
    await sql`select platform.drop_store(${id})`.catch(() => {});
    await sql`delete from platform.parent_jobs where org_id = ${id}`;
    await sql`delete from platform.organizations where id = ${id}`;
  }
};

describe.skipIf(!hasDb)("entering a store", () => {
  beforeAll(async () => {
    await cleanup();
    const sql = adminDb();
    await sql`insert into platform.organizations (id, slug, name, store_prefix) values (${A}, 'dbtest-a', 'DB Test A', ${PA}), (${B}, 'dbtest-b', 'DB Test B', ${PB})`;
    expect(await provisionStore(sql, A)).toBe(PA);
    expect(await provisionStore(sql, B)).toBe(PB);
    await asParentSync(sql, async (tx) => {
      await tx.unsafe(`insert into ${ident(`${PA}_parent`)}.jobs (id, name, house) values (gen_random_uuid(), 'Server', 'front')`);
      await tx.unsafe(`insert into ${ident(`${PB}_parent`)}.jobs (id, name, house) values (gen_random_uuid(), 'Cook', 'back')`);
    });
  });
  afterAll(async () => {
    await cleanup();
    await closeAll();
  });

  it("withOrg fences platform rows to one org", async () => {
    const none = await apiDb()`select count(*)::int as n from platform.organizations`;
    expect(none[0]?.n).toBe(0);
    const mine = await withOrg(apiDb(), A, (tx) => tx`select slug from platform.organizations`);
    expect(mine.map((r) => r.slug)).toEqual(["dbtest-a"]);
  });

  it("withStore reads its own parent data and nothing else", async () => {
    const own = await withStore(apiDb(), ctx(A, PA), (tx, s) => tx.unsafe(`select name from ${s.parentTable("jobs")}`));
    expect(own.map((r) => r.name)).toEqual(["Server"]);
    await expect(withStore(apiDb(), ctx(A, PA), (tx) => tx.unsafe(`select name from ${ident(`${PB}_parent`)}.jobs`))).rejects.toThrow(/permission denied/);
    await expect(withStore(apiDb(), ctx(A, PA), (tx) => tx`select count(*) from platform.secrets`)).rejects.toThrow(/permission denied/);
  });

  it("parent data cannot be written from a store, live or draft", async () => {
    for (const env of ["live", "draft"] as const) {
      await expect(
        withStore(apiDb(), ctx(A, PA, env), (tx, s) => tx.unsafe(`insert into ${s.parentTable("jobs")} (id, name, house) values (gen_random_uuid(), 'x', 'front')`)),
      ).rejects.toThrow(/permission denied/);
    }
  });

  it("a draft context cannot reach the live schema", async () => {
    await expect(withStore(apiDb(), ctx(A, PA, "draft"), (tx) => tx.unsafe(`create table ${ident(PA)}.x (id int)`))).rejects.toThrow(/permission denied/);
  });

  it("the role switch ends with the transaction", async () => {
    await withStore(apiDb(), ctx(A, PA), (tx) => tx`select 1`);
    const [row] = await apiDb()`select current_user as u`;
    expect(row?.u).toBe("rms_api");
  });

  it("refuses a store prefix that is not well formed", () => {
    expect(() => withStore(apiDb(), ctx(A, 'o_dddddddddd01"; drop schema platform cascade; --'), async () => 1)).toThrow();
    expect(() => ident("x; drop")).toThrow();
  });

  it("makes well-formed store prefixes", () => {
    expect(newStorePrefix()).toMatch(/^o_[0-9a-f]{12}$/);
  });
});

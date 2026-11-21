// Regression tests for the holes task G reported on 2026-11-21 that are now closed
// (migration 20261121120400_hardening_2.sql and the Ask size budget in @rms/db).
// Each test asserts the wall, next to a control showing the allowed case still works.
//
// What is still open from that report lives in known-limits.test.ts: the signing secret on the
// local stack, large objects created by store roles, and a model-written SELECT widening its locations.
import { beforeAll, describe, expect, it } from "vitest";
import { ASK_MAX_BYTES, AskTooLargeError, adminDb, apiDb, mintAskLogin, openAsk, provisionStore } from "@rms/db";
import { type AskHandle, DENIED, type Row, asOrg, askAs, orgSql, outcome, platform, platformSql } from "../helpers/actors.js";
import { TEMPLATES, insertRow } from "../helpers/rows.js";
import { EXTRA_ORG, ORG, ids } from "../helpers/world.js";

const a = ids("a");
let ask: AskHandle;

beforeAll(async () => {
  ask = await askAs("a");
});

describe("closed: the server login cannot change a version once it is no longer a draft", () => {
  const rewrite = (id: string) =>
    `update platform.app_versions set manifest = '{"name":"Rewritten","models":[{"use":"sec_ledger","access":"write"}]}'::jsonb, bundle_key = 'bundles/unchecked', checks = '{"all":"passed"}'::jsonb, summary = 'x' where id = '${id}' returning id`;

  it("a published version's manifest, bundle and check results cannot be replaced", async () => {
    expect(await orgSql("a", rewrite(a.appVersion))).toHaveLength(0);
    expect(await orgSql("a", rewrite(a.readOnlyAppVersion))).toHaveLength(0);
    for (const column of ["manifest", "bundle_key", "source_key", "checks", "ui_version", "summary", "run_id"]) {
      expect(await orgSql("a", `update platform.app_versions set ${column} = ${column} where id = '${a.appVersion}' returning id`), column).toHaveLength(0);
    }
  });

  it("not through an insert that turns into an update either", async () => {
    const upsert = `insert into platform.app_versions (id, app_id, org_id, number, manifest) values ('${a.appVersion}', '${a.app}', '${ORG.a.uuid}', 1, '{}'::jsonb)
                    on conflict (id) do update set manifest = excluded.manifest`;
    expect(await outcome(orgSql("a", upsert))).toBe(DENIED);
  });

  it.each(["checked", "published", "superseded", "failed"])("a version marked %s by the platform is closed to the server login", async (status) => {
    // The platform login makes a version with that status, the server login tries to change it, and the row is removed again.
    const version = (TEMPLATES.app_versions as (k: "a") => Record<string, unknown>)("a");
    await platform().begin(async (tx) => {
      await insertRow(tx, "app_versions", { ...version, status });
    });
    try {
      expect(await orgSql("a", rewrite(String(version.id)))).toHaveLength(0);
    } finally {
      await platform()`delete from platform.app_versions where id = ${String(version.id)}`;
    }
  });

  it("control: a draft version can still be changed by the server login", async () => {
    const rows = await asOrg("a", async (tx) => {
      const version = (TEMPLATES.app_versions as (k: "a") => Record<string, unknown>)("a");
      await insertRow(tx, "app_versions", version);
      return tx.unsafe(rewrite(String(version.id))) as Promise<Row[]>;
    });
    expect(rows).toHaveLength(1);
  });

  it("control: the platform login can still change a published version (publishing is its job)", async () => {
    expect(await platformSql(rewrite(a.appVersion))).toHaveLength(1);
  });
});

describe("closed: the server login cannot reword a listing once it is no longer a draft", () => {
  const reword = (id: string) => `update platform.listings set title = 'Reworded after review', summary = 'Not what was approved', category = 'other' where id = '${id}' returning id`;

  it("a listed listing's title, summary and category cannot be changed", async () => {
    expect(await orgSql("a", reword(a.listingPublic))).toHaveLength(0);
    expect(await orgSql("a", reword(a.listingFranchise))).toHaveLength(0);
  });

  it("nor a delisted one, nor one in review or rejected", async () => {
    expect(await orgSql("a", reword(a.listingDelisted))).toHaveLength(0);
    for (const status of ["in_review", "rejected"]) {
      await platform()`update platform.listings set status = ${status} where id = ${a.listingDraft}`;
      try {
        expect(await orgSql("a", reword(a.listingDraft)), status).toHaveLength(0);
      } finally {
        await platform()`update platform.listings set status = 'draft' where id = ${a.listingDraft}`;
      }
    }
  });

  it("control: a draft listing can still be reworded", async () => {
    expect(await orgSql("a", reword(a.listingDraft))).toHaveLength(1);
  });

  it("what other restaurants see is unchanged after every attempt above", async () => {
    const rows = await orgSql("b", `select title from platform.public_listings where id = '${a.listingPublic}'`);
    expect(rows).toEqual([{ title: "Open tracker a" }]);
  });
});

describe("closed: a store can be dropped whatever its roles left behind", () => {
  it("a large object left by the Data API role and one left by the Ask login do not stop platform.drop_store", async () => {
    // The one test that commits an attack: on a throwaway restaurant, removed by the drop itself.
    const admin = adminDb();
    const rw = `${EXTRA_ORG.prefix}_rw`;
    await admin`insert into platform.organizations (id, slug, name, store_prefix) values (${EXTRA_ORG.uuid}, ${EXTRA_ORG.slug}, ${EXTRA_ORG.name}, ${EXTRA_ORG.prefix})`;
    const made: string[] = [];
    try {
      await provisionStore(admin, EXTRA_ORG.uuid);
      const byRw = await apiDb().begin(async (tx) => {
        await tx.unsafe(`set local role ${rw}`);
        return tx.unsafe("select lo_from_bytea(0, 'left behind by a Data API role')::text as oid");
      });
      made.push(String((byRw as Row[])[0]?.oid));
      const askSql = openAsk(await mintAskLogin(admin, EXTRA_ORG.uuid));
      try {
        const byAsk = await askSql.begin("read write", (tx) => tx.unsafe("select lo_from_bytea(0, 'left behind by an Ask login')::text as oid"));
        made.push(String((byAsk as Row[])[0]?.oid));
      } finally {
        await askSql.end({ timeout: 2 });
      }
      const before = await admin`select count(*)::int as n from pg_largeobject_metadata where oid::text = any(${made})`;
      expect(before[0]?.n).toBe(2); // the objects really exist, owned by the store's roles

      expect(await outcome(admin`select platform.drop_store(${EXTRA_ORG.uuid})`)).toBe("allowed");

      const [left] = await admin.unsafe(
        `select (select count(*)::int from pg_roles where rolname like '${EXTRA_ORG.prefix}%') as roles,
                (select count(*)::int from pg_namespace where nspname like '${EXTRA_ORG.prefix}%') as schemas,
                (select count(*)::int from pg_largeobject_metadata where oid::text = any($1)) as large_objects`,
        [made],
      );
      expect(left).toEqual({ roles: 0, schemas: 0, large_objects: 0 });
    } finally {
      // If the drop regressed, the suite's own cleanup (helpers/world.ts) removes the objects and the store.
      await admin`select platform.drop_store(${EXTRA_ORG.uuid})`.catch(() => {});
      await admin`delete from platform.organizations where id = ${EXTRA_ORG.uuid}`.catch(() => {});
    }
  });

  it("the drop gives the platform login no lasting way into a store role", async () => {
    // drop_store joins each role to remove what it owns. After a drop there must be no membership left over, anywhere.
    const rows = await platform().unsafe(
      `select r.rolname from pg_auth_members am join pg_roles r on r.oid = am.roleid join pg_roles m on m.oid = am.member
       where r.rolname ~ '^o_[0-9a-f]{12}_ask$' and (am.set_option or am.inherit_option)`,
    );
    expect(rows).toEqual([]);
  });
});

describe("closed: an Ask answer has a size budget", () => {
  it("the budget is about one megabyte", () => {
    expect(ASK_MAX_BYTES).toBeLessThanOrEqual(1_048_576);
  });

  it("one 8 MB cell is refused", async () => {
    await expect(ask.query("select repeat('x', 8000000) as big")).rejects.toBeInstanceOf(AskTooLargeError);
  });

  it("many medium rows that add up past the budget are refused, though each is small and the row cap is not reached", async () => {
    await expect(ask.query("select repeat('x', 10000) as chunk from generate_series(1, 400)")).rejects.toBeInstanceOf(AskTooLargeError);
    await expect(ask.query("select repeat('x', 3000) as chunk, g from generate_series(1, 5000) g")).rejects.toBeInstanceOf(AskTooLargeError);
  });

  it.each([
    ["binary data", "select decode(repeat('00', 2000000), 'hex') as b"],
    ["a JSON document", "select jsonb_build_object('k', repeat('x', 2000000)) as j"],
    ["an array", "select array_agg(repeat('x', 1000)) as a from generate_series(1, 3000)"],
    ["many columns", `select ${Array.from({ length: 30 }, (_, i) => `repeat('x', 50000) as c${i}`).join(", ")}`],
    ["a full page of rows that is just past the budget in total", "select repeat('x', 2100) as v from generate_series(1, 500)"],
  ])("the budget cannot be dodged with %s", async (_what, sql) => {
    await expect(ask.query(sql)).rejects.toBeInstanceOf(AskTooLargeError);
  });

  it("control: an answer under the budget comes back whole", async () => {
    const r = await ask.query("select repeat('x', 10000) as chunk from generate_series(1, 50)");
    expect(r.rows).toHaveLength(50);
    expect(r.truncated).toBe(false);
  });

  it("the refusal says nothing about the data, and the connection still works afterwards", async () => {
    const error = await ask.query("select repeat('x', 8000000) as big").catch((e: Error) => e);
    expect((error as Error).message).toBe("The answer is too large");
    expect((await ask.query("select 1 as n")).rows).toEqual([{ n: 1 }]);
  });
});

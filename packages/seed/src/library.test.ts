// Installing the library checks every SQL template first, and installs nothing if one fails.
import { afterAll, describe, expect, it } from "vitest";
import { NamedActionDefinition, NamedQueryDefinition } from "@rms/contracts";
import { adminDb, closeAll, newStorePrefix } from "@rms/db";
import { requireTestEnv } from "@rms/db/testing";
import { LIBRARY, type Library } from "@rms/models";
import { checkLibraryTemplates, installPlatformLibrary } from "./library.js";

requireTestEnv("DATABASE_ADMIN_URL");

/** Keys only this file uses, fresh on every run so parallel runs never see each other's. */
const RUN = newStorePrefix().slice(2);
const GOOD_QUERY = `integ_lib_good_query_${RUN}`;
const BAD_QUERY = `integ_lib_bad_query_${RUN}`;
const BAD_ACTION = `integ_lib_bad_action_${RUN}`;
const TEST_KEYS = [GOOD_QUERY, BAD_QUERY, BAD_ACTION];

const goodQuery = NamedQueryDefinition.parse({
  key: GOOD_QUERY, pack: "sales", name: "Count of sales days", description: "A harmless extra report used by this test only.",
  reads: ["sales_day"], params: [],
  sql: "select cast(count(*) as bigint) as n from {{sales_day}} as sd",
  columns: [{ key: "n", label: "N", type: "integer" }],
});

/** Doctored: reads the database's own role list beside a real model. */
const badQuery = NamedQueryDefinition.parse({
  ...goodQuery, key: BAD_QUERY,
  sql: "select cast(count(*) as bigint) as n from {{sales_day}} as sd cross join pg_catalog.pg_roles as r",
});

/** Doctored: a real action's template with an update smuggled in front of it. */
const realAction = LIBRARY.namedActions.find((a) => a.key === "post_labour_day") as NamedActionDefinition;
const badAction = NamedActionDefinition.parse({
  ...realAction, key: BAD_ACTION,
  sql: realAction.sql.replace("with ld as (", "with gone as (update {{labour_day}} as x set labour_cost = 0 returning x.id), ld as ("),
});

const installedKeys = async (): Promise<string[]> => {
  const rows = await adminDb()<{ key: string }[]>`
    select key from platform.named_queries where key = any(${TEST_KEYS})
    union all select key from platform.named_actions where key = any(${TEST_KEYS})`;
  return rows.map((r) => r.key).sort();
};
const cleanup = async () => {
  await adminDb()`delete from platform.named_queries where key = any(${TEST_KEYS})`;
  await adminDb()`delete from platform.named_actions where key = any(${TEST_KEYS})`;
};

afterAll(async () => {
  await cleanup();
  await closeAll();
});

// Shared local database: under parallel runs the library install waits on other runs. Give it time.
describe("installPlatformLibrary", { timeout: 60_000 }, () => {
  it("every real library template passes the Data API's checker", async () => {
    expect(LIBRARY.namedQueries.length).toBeGreaterThanOrEqual(8);
    expect(LIBRARY.namedActions.length).toBeGreaterThanOrEqual(6);
    expect(await checkLibraryTemplates(LIBRARY)).toEqual([]);
  });

  it("installs the real library, and doing it again changes nothing", async () => {
    const counts = { models: LIBRARY.models.length, namedQueries: LIBRARY.namedQueries.length, namedActions: LIBRARY.namedActions.length };
    expect(await installPlatformLibrary(adminDb())).toEqual(counts);
    expect(await installPlatformLibrary(adminDb())).toEqual(counts);
    const [row] = await adminDb()<{ queries: number; actions: number }[]>`
      select (select count(*)::int from platform.named_queries where key = any(${LIBRARY.namedQueries.map((q) => q.key)})) as queries,
             (select count(*)::int from platform.named_actions where key = any(${LIBRARY.namedActions.map((a) => a.key)})) as actions`;
    expect(row).toEqual({ queries: counts.namedQueries, actions: counts.namedActions });
  });

  it("names a doctored template and what kind it is", async () => {
    const doctored: Library = { ...LIBRARY, namedQueries: [...LIBRARY.namedQueries, badQuery], namedActions: [...LIBRARY.namedActions, badAction] };
    const problems = await checkLibraryTemplates(doctored);
    expect(problems.map((p) => [p.kind, p.key])).toEqual([["named query", BAD_QUERY], ["named action", BAD_ACTION]]);
  });

  it("refuses a library with one doctored report, and installs nothing from it", async () => {
    await cleanup();
    // The good extra report comes BEFORE the bad one, so a partial install would leave it behind.
    const doctored: Library = { ...LIBRARY, namedQueries: [...LIBRARY.namedQueries, goodQuery, badQuery] };
    await expect(installPlatformLibrary(adminDb(), doctored)).rejects.toThrow(/was not installed.*integ_lib_bad_query/);
    expect(await installedKeys()).toEqual([]);
  });

  it("refuses a library with one doctored action, and installs nothing from it", async () => {
    await cleanup();
    const doctored: Library = { ...LIBRARY, namedQueries: [...LIBRARY.namedQueries, goodQuery], namedActions: [...LIBRARY.namedActions, badAction] };
    await expect(installPlatformLibrary(adminDb(), doctored)).rejects.toThrow(/was not installed.*integ_lib_bad_action/);
    expect(await installedKeys()).toEqual([]);
  });

  it("the same extra report installs once the doctored one is gone (so the refusals above were about the template)", async () => {
    await cleanup();
    await installPlatformLibrary(adminDb(), { ...LIBRARY, namedQueries: [...LIBRARY.namedQueries, goodQuery] });
    expect(await installedKeys()).toEqual([GOOD_QUERY]);
  });
});

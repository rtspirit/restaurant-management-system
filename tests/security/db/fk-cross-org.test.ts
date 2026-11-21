// fk_cross_org_*: a restaurant's row can never point at another restaurant's row (ADR 0004, item 3).
// The links are read from the hardening migration itself, so the tests follow the list.
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DENIED, FK, asOrg, asPlatform, outcome, platform, refusal } from "../helpers/actors.js";
import { repoPath } from "../helpers/env.js";
import { PARENT_ROW, TEMPLATES, insertRow } from "../helpers/rows.js";
import { ORG, ids } from "../helpers/world.js";

type Link = { child: string; col: string; parent: string; orgCol: string };

/** Every ('child', 'col', 'parent', 'org_col') tuple in the migrations that add same-restaurant links. */
const linksFromMigrations = (): Link[] => {
  const dir = repoPath("supabase/migrations");
  const out: Link[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(`${dir}/${file}`, "utf8");
    if (!sql.includes("_same_org_fkey")) continue;
    // Form 1: a ('child', 'col', 'parent', 'org_col') tuple in a generated list.
    for (const m of sql.matchAll(/\(\s*'([a-z_]+)'\s*,\s*'([a-z_]+)'\s*,\s*'([a-z_]+)'\s*,\s*'((?:publisher_)?org_id)'\s*\)/g)) {
      out.push({ child: m[1] as string, col: m[2] as string, parent: m[3] as string, orgCol: m[4] as string });
    }
    // Form 2: a link written out as its own statement.
    for (const m of sql.matchAll(/alter table platform\.([a-z_]+)\s+add constraint [a-z_]+_same_org_fkey\s+foreign key \(((?:publisher_)?org_id), ([a-z_]+)\) references platform\.([a-z_]+) \(org_id, id\)/g)) {
      out.push({ child: m[1] as string, col: m[3] as string, parent: m[4] as string, orgCol: m[2] as string });
    }
  }
  return out;
};

const LINKS = linksFromMigrations();
const name = (l: Link) => `${l.child}.${l.col} -> ${l.parent}`;
/** [title, link] pairs for it.each. */
const NAMED: [string, Link][] = LINKS.map((l) => [`${l.child}.${l.col}`, l]);

/** A row that is valid for restaurant A in every way, except that `col` names restaurant B's row. */
const crossRow = (l: Link) => {
  const template = TEMPLATES[l.child];
  const target = PARENT_ROW[l.parent];
  if (!template || !target) throw new Error(`tests/security/helpers/rows.ts needs a template for platform.${l.child} and a parent row for platform.${l.parent}`);
  const row = template("a");
  // Where the template leaves the link empty, the control row points at A's own row.
  return { own: l.col in row ? row : { ...row, [l.col]: target("a") }, cross: { ...row, [l.col]: target("b") } };
};

describe("the list of links", () => {
  it("is the list from the hardening migrations: 32 links or more", () => {
    expect(LINKS.length).toBeGreaterThanOrEqual(32);
    expect(new Set(LINKS.map(name)).size).toBe(LINKS.length);
  });

  it("matches the constraints that exist in the database, one for one", async () => {
    const rows = await platform()<{ conname: string }[]>`
      select conname from pg_catalog.pg_constraint where contype = 'f' and connamespace = 'platform'::regnamespace and conname like '%\_same\_org\_fkey' order by 1`;
    expect(rows.map((r) => r.conname)).toEqual(LINKS.map((l) => `${l.child}_${l.col}_same_org_fkey`).sort());
  });

  it("every link has a row template, so none is skipped", () => {
    for (const l of LINKS) expect(() => crossRow(l), name(l)).not.toThrow();
  });
});

describe("fk_cross_org: the platform login itself cannot link A's row to B's row", () => {
  // The platform login has every grant and passes every row-security policy, so the only thing
  // left to refuse the row is the (restaurant, id) link. That isolates the wall being tested.
  it.each(NAMED)("%s cannot point at another restaurant's row", async (_title, l) => {
    const r = await refusal(asPlatform((tx) => insertRow(tx, l.child, crossRow(l).cross)));
    expect(r.code).toBe(FK);
    expect(r.constraint).toBe(`${l.child}_${l.col}_same_org_fkey`);
  });

  it.each(NAMED)("control: %s may point at its own restaurant's row", async (_title, l) => {
    // Same row, same login, pointing at A's own row. If this failed, the refusal above would prove nothing.
    expect(await outcome(asPlatform((tx) => insertRow(tx, l.child, crossRow(l).own)))).toBe("allowed");
  });
});

describe("fk_cross_org: the restaurant-facing server login, fenced to A", () => {
  it.each(NAMED)("%s cannot point at another restaurant's row", async (_title, l) => {
    const r = await refusal(asOrg("a", (tx) => insertRow(tx, l.child, crossRow(l).cross)));
    // 23503: the link check. 42501: this login may not insert into that table at all, or row security refused first.
    expect([FK, DENIED]).toContain(r.code);
  });

  it("cannot move an existing row's link to another restaurant's row", async () => {
    const a = ids("a");
    const b = ids("b");
    const moves: [string, string][] = [
      ["mcp_connections.secret_id", `update platform.mcp_connections set secret_id = '${b.secret}' where id = '${a.connection}'`],
      ["agent_sessions.app_id", `update platform.agent_sessions set app_id = '${b.app}' where id = '${a.session}'`],
      ["agent_runs.sandbox_id", `update platform.agent_runs set sandbox_id = '${b.sandbox}' where id = '${a.run}'`],
      ["org_memory.source_session_id", `update platform.org_memory set source_session_id = '${b.session}' where id = '${a.memory}'`],
      ["sandboxes.app_id", `update platform.sandboxes set app_id = '${b.app}' where id = '${a.sandbox}'`],
    ];
    for (const [what, sql] of moves) expect((await refusal(asOrg("a", (tx) => tx.unsafe(sql)))).code, what).toBe(FK);
  });

  it("is refused with the same code whether the other restaurant's secret id is real or made up", async () => {
    // The constraint NAME still differs between the two cases, so database error text must never reach a caller.
    // The Data API tests check that no response carries it.
    const real = await refusal(asOrg("a", (tx) => insertRow(tx, "mcp_connections", { ...(TEMPLATES.mcp_connections as (k: "a") => Record<string, unknown>)("a"), secret_id: ids("b").secret })));
    const madeUp = await refusal(asOrg("a", (tx) => insertRow(tx, "mcp_connections", { ...(TEMPLATES.mcp_connections as (k: "a") => Record<string, unknown>)("a"), secret_id: "0193a3c0-9191-7fff-8fff-ffffffffffff" })));
    expect(real.code).toBe(FK);
    expect(madeUp.code).toBe(FK);
  });
});

describe("links the list does not cover", () => {
  // Every single-column link between two restaurant-owned tables should also be checked on (restaurant, id).
  const uncovered = async () => {
    const rows = await platform()<{ child: string; col: string; parent: string }[]>`
      select con.conrelid::regclass::text as child, a.attname as col, con.confrelid::regclass::text as parent
      from pg_catalog.pg_constraint con
      join pg_catalog.pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
      where con.contype = 'f' and con.connamespace = 'platform'::regnamespace and array_length(con.conkey, 1) = 1
        and con.confrelid <> 'platform.organizations'::regclass
        and exists (select 1 from pg_catalog.pg_attribute x where x.attrelid = con.conrelid and x.attname in ('org_id', 'publisher_org_id') and not x.attisdropped)
        and exists (select 1 from pg_catalog.pg_attribute x where x.attrelid = con.confrelid and x.attname in ('org_id', 'publisher_org_id') and not x.attisdropped)
      order by 1, 2`;
    const covered = new Set(LINKS.map((l) => `platform.${l.child}.${l.col}`));
    return rows.map((r) => `${r.child}.${r.col}`).filter((k) => !covered.has(k));
  };

  // Links that cross restaurants ON PURPOSE: an install or a recommendation names another restaurant's public listing.
  const BY_DESIGN = ["platform.installs.listing_id", "platform.org_recommendations.listing_id"];

  it("there is none: every link between two restaurant-owned tables is also checked on (restaurant, id)", async () => {
    // Was a hole until migration 20261121120400 (app_versions.parent_version_id and org_memory.superseded_by).
    // A new single-column link between restaurant-owned tables fails here until it gets its own same-restaurant link.
    expect((await uncovered()).filter((k) => !BY_DESIGN.includes(k))).toEqual([]);
  });

  it("a real id from another restaurant and a made-up id are both refused for the two links closed last", async () => {
    const a = ids("a");
    const b = ids("b");
    const version = (parent: string) => asOrg("a", (tx) => tx.unsafe(`insert into platform.app_versions (id, app_id, org_id, number, manifest, parent_version_id) values (gen_random_uuid(), '${a.app}', '${ORG.a.uuid}', 80, '{}'::jsonb, '${parent}')`));
    const memory = (next: string) => asOrg("a", (tx) => tx.unsafe(`insert into platform.org_memory (id, org_id, kind, text, superseded_by) values (gen_random_uuid(), '${ORG.a.uuid}', 'fact', 'x', '${next}')`));
    expect(await outcome(version(b.appVersion))).toBe(FK);
    expect(await outcome(version("0193a3c0-9191-7fff-8fff-ffffffffffff"))).toBe(FK);
    expect(await outcome(memory(b.memory))).toBe(FK);
    expect(await outcome(memory("0193a3c0-9191-7fff-8fff-ffffffffffff"))).toBe(FK);
    // Control: A's own rows are accepted.
    expect(await outcome(version(a.readOnlyAppVersion))).toBe("allowed");
    expect(await outcome(memory(a.memory))).toBe("allowed");
  });
});

// public_schema_empty, public_listings_barrier, and what Supabase's own roles can reach.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { apiDb, adminDb } from "@rms/db";
import { DENIED, type Row, asOrg, holds, orgSql, outcome, platform, refusal } from "../helpers/actors.js";
import { repoPath } from "../helpers/env.js";
import { CANARY, ORG, ids } from "../helpers/world.js";

const baseline = JSON.parse(readFileSync(repoPath("tests/security/extensions.baseline.json"), "utf8")) as { extensions: string[] };

describe("public_schema_empty", () => {
  it("nothing of ours is in the public schema: no table, view, sequence, function or type", async () => {
    const relations = await platform().unsafe(`select c.relname, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'`);
    const functions = await platform().unsafe(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`);
    const types = await platform().unsafe(`select t.typname from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public'`);
    expect(relations).toEqual([]);
    expect(functions).toEqual([]);
    expect(types).toEqual([]);
  });

  it("the installed extensions are exactly the recorded baseline", async () => {
    const rows = await platform().unsafe("select extname from pg_extension");
    expect(rows.map((r) => String((r as Row).extname)).sort()).toEqual([...baseline.extensions].sort());
  });

  it("no extension that can reach the network or another database is installed", async () => {
    const rows = await platform().unsafe("select extname from pg_extension where extname in ('http', 'pg_net', 'dblink', 'postgres_fdw', 'file_fdw', 'plpython3u', 'plperlu', 'pg_cron', 'wrappers')");
    expect(rows).toEqual([]);
  });

  it("our schemas are the only ones we added", async () => {
    const rows = await platform().unsafe(`select nspname from pg_namespace where nspname in ('platform', 'rms') or nspname ~ '^o_[0-9a-f]{12}'`);
    const names = rows.map((r) => String((r as Row).nspname));
    expect(names).toContain("platform");
    expect(names).toContain("rms");
    // Every restaurant schema follows the one naming rule. Nothing else may look like one.
    for (const n of names.filter((x) => x.startsWith("o_"))) expect(n).toMatch(/^o_[0-9a-f]{12}(_parent|_draft)?$/);
  });
});

describe("Supabase's auto-generated API can reach nothing of ours", () => {
  // The auto-generated REST and GraphQL APIs run as these database roles. If they hold no rights on our
  // schemas, a mistake in the API settings still exposes nothing.
  const SUPABASE_ROLES = ["anon", "authenticated", "service_role", "authenticator", "dashboard_user", "supabase_auth_admin", "supabase_storage_admin", "supabase_functions_admin", "supabase_realtime_admin", "pgbouncer"];

  it("its roles cannot enter platform, rms or any restaurant schema", async () => {
    const rows = await platform().unsafe(
      `select r.rolname, n.nspname from pg_roles r cross join pg_namespace n
       where r.rolname = any($1) and (n.nspname in ('platform', 'rms') or n.nspname ~ '^o_[0-9a-f]{12}') and has_schema_privilege(r.oid, n.oid, 'usage,create')`,
      [SUPABASE_ROLES],
    );
    expect(rows).toEqual([]);
  });

  it("its roles hold no right on any of our tables, views or functions", async () => {
    const tables = await platform().unsafe(
      `select r.rolname, n.nspname || '.' || c.relname as obj from pg_roles r cross join pg_class c join pg_namespace n on n.oid = c.relnamespace
       where r.rolname = any($1) and (n.nspname in ('platform', 'rms') or n.nspname ~ '^o_[0-9a-f]{12}') and c.relkind in ('r', 'v', 'm', 'S', 'p')
         and (has_table_privilege(r.oid, c.oid, 'select,insert,update,delete,truncate,references,trigger') or has_any_column_privilege(r.oid, c.oid, 'select,insert,update,references'))`,
      [SUPABASE_ROLES],
    );
    expect(tables).toEqual([]);
  });

  it("nothing of ours is granted to everyone", async () => {
    // Grantee 0 is PUBLIC. No table, view or sequence in our schemas, and no platform function.
    const relations = await platform().unsafe(
      `select n.nspname || '.' || c.relname as obj from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join lateral aclexplode(c.relacl) a
       where a.grantee = 0 and (n.nspname in ('platform', 'rms') or n.nspname ~ '^o_[0-9a-f]{12}')`,
    );
    expect(relations).toEqual([]);
    const functions = await platform().unsafe(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'platform' and (p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0))`,
    );
    expect(functions).toEqual([]);
    const schemas = await platform().unsafe(
      `select n.nspname from pg_namespace n cross join lateral aclexplode(n.nspacl) a where a.grantee = 0 and (n.nspname in ('platform', 'rms') or n.nspname ~ '^o_[0-9a-f]{12}')`,
    );
    expect(schemas).toEqual([]);
  });

  it("control: the roles exist, so the two checks above looked at something", async () => {
    const rows = await platform().unsafe("select rolname from pg_roles where rolname = any($1)", [SUPABASE_ROLES]);
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(rows.map((r) => (r as Row).rolname)).toEqual(expect.arrayContaining(["anon", "authenticated", "service_role", "authenticator"]));
  });

  it("the API settings expose none of our schemas", () => {
    const toml = readFileSync(repoPath("supabase/config.toml"), "utf8");
    const api = /\[api\]([\s\S]*?)(\n\[|$)/.exec(toml)?.[1] ?? "";
    const exposed = /^\s*schemas\s*=\s*\[([^\]]*)\]/m.exec(api)?.[1] ?? "MISSING";
    expect(exposed).not.toBe("MISSING");
    const names = exposed.split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
    for (const n of names) {
      expect(n).not.toBe("public");
      expect(n).not.toBe("platform");
      expect(n).not.toBe("rms");
      expect(n).not.toMatch(/^o_/);
    }
  });

  it("if the auto-generated REST API is running, it serves none of our tables", async () => {
    // The local stack normally runs without it. When it is up (hosted, or a full local stack), it must show nothing of ours.
    const base = (process.env.SUPABASE_URL as string).replace(/\/$/, "");
    const key = process.env.SUPABASE_PUBLISHABLE_KEY as string;
    for (const path of ["organizations", "secrets", "members", "sec_note", "public_listings"]) {
      const res = await fetch(`${base}/rest/v1/${path}?select=*&limit=1`, { headers: { apikey: key, authorization: `Bearer ${key}` } }).catch(() => null);
      if (!res) continue; // not running
      const body = await res.text();
      expect(res.status === 200 && body.trim().startsWith("["), `${path} answered with rows`).toBe(false);
      expect(holds(body, CANARY.a) || holds(body, CANARY.b), path).toBe(false);
    }
  });
});

describe("connections are made the way a transaction pooler needs", () => {
  it("no prepared statements, small pools", () => {
    for (const sql of [apiDb(), adminDb()]) {
      expect(sql.options.prepare).toBe(false);
      expect(sql.options.max).toBeLessThanOrEqual(5);
    }
  });

  it("when the database is not local, the address must be the pooler (not checked locally)", () => {
    for (const name of ["DATABASE_URL", "DATABASE_ADMIN_URL"]) {
      const host = new URL(process.env[name] as string).hostname;
      if (host === "127.0.0.1" || host === "localhost") continue;
      expect(host, name).toMatch(/\.pooler\.supabase\.com$/);
    }
  });
});

describe("public_listings_barrier: what one restaurant can see of another's listings", () => {
  const b = ids("b");

  it("the view is a barrier view, owned by the platform, with no publisher and no embedding", async () => {
    const [view] = await platform().unsafe(`select c.reloptions, pg_get_userbyid(c.relowner) as owner from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'platform' and c.relname = 'public_listings'`);
    expect((view as Row).reloptions).toEqual(["security_barrier=true"]);
    const columns = await platform().unsafe(`select column_name from information_schema.columns where table_schema = 'platform' and table_name = 'public_listings' order by ordinal_position`);
    expect(columns.map((r) => (r as Row).column_name)).toEqual(["id", "title", "summary", "category", "required_models", "required_connections", "install_count", "current_version_id"]);
  });

  it("A sees exactly the listed public listings, B's included, and no restaurant's name or id with them", async () => {
    const rows = await orgSql("a", "select * from platform.public_listings order by title");
    expect(rows.map((r) => r.title)).toEqual(expect.arrayContaining(["Open tracker a", "Open tracker b"]));
    expect(rows.map((r) => r.id).sort()).toEqual(await listedPublicIds());
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(["category", "current_version_id", "id", "install_count", "required_connections", "required_models", "summary", "title"]);
      expect(JSON.stringify(r)).not.toContain(ORG.b.uuid);
      expect(JSON.stringify(r)).not.toContain(ORG.b.prefix);
    }
    expect(rows.map((r) => r.id)).not.toContain(b.listingDraft);
    expect(rows.map((r) => r.id)).not.toContain(b.listingFranchise);
    expect(rows.map((r) => r.id)).not.toContain(b.listingDelisted);
  });

  /** What the platform itself says is listed and public, across every restaurant in the database. */
  const listedPublicIds = async () => (await platform().unsafe("select id from platform.listings where status = 'listed' and visibility = 'public'")).map((r) => String((r as Row).id)).sort();

  /** A cheap function in the WHERE clause that remembers every title it is shown. Returns what it saw. */
  const leak = (relation: string, column = "title") => async (tx: Parameters<Parameters<typeof asOrg>[1]>[0]) => {
    await tx.unsafe(`select count(*) from ${relation} where set_config('rms.leak', coalesce(current_setting('rms.leak', true), '') || '|' || ${column}, true) is not null`);
    const [row] = await tx.unsafe(`select current_setting('rms.leak', true) as seen`);
    return String((row as Row).seen ?? "");
  };

  it("a cheap leaking function in the WHERE clause is shown only listed public rows", async () => {
    const seen = (await asOrg("a", leak("platform.public_listings", "id::text"))).split("|").filter(Boolean);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    // Exactly the listed public rows (of every restaurant in this shared database), and not one more.
    expect([...new Set(seen)].sort()).toEqual(await listedPublicIds());
    const titles = await asOrg("a", leak("platform.public_listings"));
    expect(holds(titles, "Open tracker b")).toBe(true);
    expect(holds(titles, CANARY.b)).toBe(false);
    const summaries = await asOrg("a", leak("platform.public_listings", "summary"));
    expect(holds(summaries, CANARY.b)).toBe(false);
  });

  it("control: the same leaking function does see unlisted titles when pointed at the table with the right credentials", async () => {
    // Fenced to B, on the base table: the function is shown B's draft, franchise and delisted titles.
    const seen = await asOrg("b", leak("platform.listings"));
    expect(holds(seen, `Draft ${CANARY.b}`)).toBe(true);
    expect(holds(seen, `Delisted ${CANARY.b}`)).toBe(true);
  });

  it("an error raised from the WHERE clause names only listed public rows", async () => {
    const r = await refusal(orgSql("a", "select * from platform.public_listings where title::int = 1"));
    expect(r.code).toBe("22P02");
    expect(r.message).toMatch(/Open tracker/);
    const s = await refusal(orgSql("a", "select * from platform.public_listings where (summary || title)::int = 1 order by 1"));
    expect(holds(s.message, CANARY.b)).toBe(false);
  });

  it("A cannot reach B's unlisted listings through the table either", async () => {
    const rows = await orgSql("a", "select * from platform.listings");
    for (const r of rows) expect(r.publisher_org_id).toBe(ORG.a.uuid);
    expect(await orgSql("a", `select * from platform.listings where id = '${b.listingDraft}'`)).toHaveLength(0);
    expect(await outcome(orgSql("a", "select * from platform.listing_versions"))).toBe(DENIED);
  });

  it("A cannot change B's public listing", async () => {
    expect(await orgSql("a", `update platform.listings set title = 'defaced' where id = '${b.listingPublic}' returning id`)).toHaveLength(0);
    expect(await outcome(orgSql("a", `update platform.public_listings set title = 'defaced' where id = '${b.listingPublic}'`))).toBe(DENIED);
    expect(await outcome(orgSql("a", `delete from platform.public_listings where id = '${b.listingPublic}'`))).toBe(DENIED);
  });

  it("a listing version (the bundle and manifest) is never readable by a restaurant", async () => {
    expect(await outcome(orgSql("b", "select * from platform.listing_versions"))).toBe(DENIED);
  });
});

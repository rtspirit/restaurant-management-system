// The canary sweep.
//
// Each restaurant holds one secret string, in its parent data, its live and draft tables and its
// platform rows (helpers/world.ts). Every helper that acts as a restaurant searches what comes
// back for the OTHER restaurant's string and throws CanaryLeak on a hit (helpers/actors.ts). That
// runs in every test file. This file adds three things:
//   1. proof that the canaries are really there, in every place they are meant to be;
//   2. one sweep of every surface, as each restaurant;
//   3. proof that the sweep can fail: the same reads made with the RIGHT credentials set it off.
import { beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { type DataEnv, requireDataToken } from "@rms/auth";
import api from "../../../apps/api/src/index.js";
import { CanaryLeak, type Row, type Watch, asNoOrg, askAs, haystack, holds, inStore, noOrgSql, orgSql, platform, storeSql, sweep, sweepCount } from "../helpers/actors.js";
import { appToken, bearer } from "../helpers/tokens.js";
import { CANARY, MODEL_KEYS, ORG, type OrgKey, PARENT_TABLES, orgScopedTables, schemas } from "../helpers/world.js";

const PARENT = PARENT_TABLES.map(([t]) => t);

/** Platform tables the server login may read, with the columns it may read. */
let readable: { table: string; columns: string[] }[] = [];

beforeAll(async () => {
  const rows = await platform()<{ table: string; columns: string[] | null }[]>`
    select c.relname as table,
           (select array_agg(a.attname::text order by a.attnum) from pg_catalog.pg_attribute a
             where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped and has_column_privilege('rms_api', c.oid, a.attnum, 'select')) as columns
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'platform' and c.relkind in ('r', 'v') order by 1`;
  readable = rows.filter((r) => (r.columns ?? []).length > 0).map((r) => ({ table: r.table, columns: r.columns as string[] }));
});

// ---------------------------------------------------------------- the surfaces
// Each surface reads everything one kind of credential can reach, connected as `k`.
// `watch.sweepAs` is only ever set by the "can fail" tests at the bottom.
const SURFACES: Record<string, (k: OrgKey, watch?: Watch) => Promise<number>> = {
  "platform rows, through the server login fenced to the restaurant": async (k, watch = {}) => {
    let rows = 0;
    for (const t of readable) rows += (await orgSql(k, `select ${t.columns.join(", ")} from platform.${t.table}`, watch)).length;
    return rows;
  },
  "parent data, through the live Data API role": async (k, watch = {}) => {
    let rows = 0;
    for (const t of PARENT) rows += (await storeSql(k, `select * from ${schemas(k).parent}.${t}`, watch)).length;
    return rows;
  },
  "live tables, through the live Data API role": async (k, watch = {}) => {
    let rows = 0;
    for (const t of MODEL_KEYS) rows += (await storeSql(k, `select * from ${schemas(k).live}.${t}`, watch)).length;
    return rows;
  },
  "draft tables, through the draft Data API role": async (k, watch = {}) => {
    let rows = 0;
    for (const t of MODEL_KEYS) rows += (await storeSql(k, `select * from ${schemas(k).draft}.${t}`, { env: "draft", ...watch })).length;
    return rows;
  },
  "parent data and live tables, through the Ask login": async (k, watch = {}) => {
    const ask = await askAs(k, watch);
    let rows = 0;
    for (const t of [...PARENT, ...MODEL_KEYS]) rows += (await ask.query(`select * from ${t}`)).rows.length;
    return rows;
  },
  "everything the Ask login can read, dumped in one go": async (k, watch = {}) => {
    const ask = await askAs(k, watch);
    return (await ask.query("select schema_to_xml(n.nspname, true, false, '')::text as dump from pg_namespace n where has_schema_privilege(n.oid, 'usage') and n.nspname like 'o\\_%'")).rows.length;
  },
};

describe("1. the canaries are really there", () => {
  it("the two strings are different and neither contains the other", () => {
    expect(CANARY.a).not.toBe(CANARY.b);
    expect(CANARY.a.includes(CANARY.b) || CANARY.b.includes(CANARY.a)).toBe(false);
  });

  it.each(["a", "b"] as const)("restaurant %s has its canary in every platform table that can hold text", async (k) => {
    const without: string[] = [];
    let withCanary = 0;
    for (const t of await orgScopedTables(platform())) {
      const [row] = await platform().unsafe(`select count(*)::int as rows, count(*) filter (where t::text like $1)::int as marked from platform.${t.table} t where t.${t.column} = $2`, [`%${CANARY[k]}%`, ORG[k].uuid]);
      if ((row as Row).marked === 0) without.push(t.table);
      else withCanary++;
    }
    // The only tables with no canary are the ones with no free text to put it in.
    expect(without.sort()).toEqual(["app_models", "member_locations", "members", "parent_sync_state"]);
    expect(withCanary).toBeGreaterThanOrEqual(36);
  });

  it.each(["a", "b"] as const)("restaurant %s has its canary in every parent table, every live table and every draft table", async (k) => {
    for (const t of PARENT) expect(holds(await storeSql(k, `select * from ${schemas(k).parent}.${t}`), CANARY[k]), `parent.${t}`).toBe(true);
    for (const t of MODEL_KEYS) {
      expect(holds(await storeSql(k, `select * from ${schemas(k).live}.${t}`), CANARY[k]), `live ${t}`).toBe(true);
      expect(holds(await storeSql(k, `select * from ${schemas(k).draft}.${t}`, { env: "draft" }), CANARY[k]), `draft ${t}`).toBe(true);
    }
  });

  it("no canary sits anywhere the other restaurant is meant to see (a listed public listing)", async () => {
    const rows = await platform().unsafe("select * from platform.public_listings");
    expect(holds(rows, CANARY.a) || holds(rows, CANARY.b)).toBe(false);
  });
});

describe("2. the detector", () => {
  it("finds the string in nested values, column names, binary data, numbers-as-text and error text, in any letter case", () => {
    const needle = CANARY.b;
    expect(holds([{ a: { b: [{ c: `x ${needle} y` }] } }], needle)).toBe(true);
    expect(holds(Object.assign([{ n: 1 }], { columns: [{ name: needle }] }), needle)).toBe(true);
    expect(holds([{ blob: Buffer.from(`bin ${needle}`) }], needle)).toBe(true);
    expect(holds([{ blob: new Uint8Array(Buffer.from(needle)) }], needle)).toBe(true);
    expect(holds(needle.toUpperCase(), needle)).toBe(true);
    expect(holds({ big: 10n, text: needle }, needle)).toBe(true);
    expect(holds(`{"escaped":"line\\n${needle}"}`, needle)).toBe(true);
  });

  it("does not cry wolf", () => {
    expect(holds([{ a: CANARY.a }], CANARY.b)).toBe(false);
    expect(holds([{ a: CANARY.b.slice(0, -1) }], CANARY.b)).toBe(false);
    expect(holds(null, CANARY.b)).toBe(false);
    expect(haystack(undefined)).toBe("");
  });

  it("throws CanaryLeak, naming whose data was seen and where", () => {
    expect(() => sweep("a", "a made-up result", [{ body: CANARY.b }])).toThrow(CanaryLeak);
    expect(() => sweep("a", "a made-up result", [{ body: CANARY.b }])).toThrow(/acting as a, saw restaurant b's canary in: a made-up result/);
    expect(() => sweep("a", "its own data", [{ body: CANARY.a }])).not.toThrow();
    expect(() => sweep(null, "no restaurant", [{ body: CANARY.a }])).toThrow(CanaryLeak);
  });

  it("an error message that carries the other restaurant's string sets it off too", async () => {
    const leaky = orgSql("a", `select ('${CANARY.b}')::int`);
    await expect(leaky).rejects.toBeInstanceOf(CanaryLeak);
  });
});

describe("3. the sweep: every surface, as each restaurant", () => {
  describe.each(["a", "b"] as const)("acting as restaurant %s", (k) => {
    it.each(Object.keys(SURFACES))("%s", async (name) => {
      const before = sweepCount();
      const rows = await (SURFACES[name] as (k: OrgKey) => Promise<number>)(k);
      // It read real rows, and each read was swept. A hit would have thrown CanaryLeak before this line.
      expect(rows).toBeGreaterThan(0);
      expect(sweepCount()).toBeGreaterThan(before);
    });
  });

  it("the server login with no restaurant set sees neither canary, in any table it can read", async () => {
    for (const t of readable) {
      const rows = await noOrgSql(`select ${t.columns.join(", ")} from platform.${t.table}`);
      expect(holds(rows, CANARY.a) || holds(rows, CANARY.b), t.table).toBe(false);
    }
  });

  it("the public listings other restaurants may see carry neither canary", async () => {
    for (const k of ["a", "b"] as const) expect((await orgSql(k, "select * from platform.public_listings")).length).toBeGreaterThanOrEqual(2);
    await asNoOrg((tx) => tx.unsafe("select * from platform.public_listings"));
  });

  it("refusals do not leak either: every attempt by A on B's tables is swept, error text included", async () => {
    const b = schemas("b");
    const attempts = [...PARENT.map((t) => `${b.parent}.${t}`), ...MODEL_KEYS.flatMap((t) => [`${b.live}.${t}`, `${b.draft}.${t}`])];
    const before = sweepCount();
    for (const t of attempts) {
      await storeSql("a", `select * from ${t}`).catch((e: unknown) => {
        if (e instanceof CanaryLeak) throw e;
      });
      await inStore("a", (tx) => tx.unsafe(`select * from ${t} where body::int = 1`), { env: "draft" }).catch((e: unknown) => {
        if (e instanceof CanaryLeak) throw e;
      });
    }
    expect(sweepCount() - before).toBe(attempts.length * 2);
  });

  it("HTTP responses carry neither canary", async () => {
    const echo = new Hono<DataEnv>().use("*", requireDataToken).all("*", (c) => c.json({ tenant: c.var.tenant, claims: c.var.claims }));
    for (const k of ["a", "b"] as const) {
      const token = await appToken(k);
      const bodies = [
        await (await echo.request("/", { method: "POST", headers: bearer(token) })).text(),
        await (await api.request("/health")).text(),
        await (await api.request("/data/v1/catalog", { method: "POST", headers: { ...bearer(token), "content-type": "application/json" }, body: "{}" })).text(),
        await (await api.request("/data/v1/query", { method: "POST", headers: { ...bearer(token), "content-type": "application/json" }, body: JSON.stringify({ model: "sec_note" }) })).text(),
        await (await api.request("/auth/me", { headers: bearer(token) })).text(),
        await (await api.request("/admin/feed", { headers: bearer(token) })).text(),
      ];
      for (const body of bodies) sweep(k, "HTTP response body", body);
    }
  });
});

describe("4. proof the sweep can fail: the same reads with the right credentials set it off", () => {
  // Connected as B (the right credentials for B's data) while the sweep is told the caller is A.
  // If any of these did NOT throw, the sweep in section 3 would be blind on that surface.
  it.each(Object.keys(SURFACES))("%s", async (name) => {
    await expect((SURFACES[name] as (k: OrgKey, w: Watch) => Promise<number>)("b", { sweepAs: "a" })).rejects.toBeInstanceOf(CanaryLeak);
  });

  it("and the other way round", async () => {
    for (const name of Object.keys(SURFACES)) {
      await expect((SURFACES[name] as (k: OrgKey, w: Watch) => Promise<number>)("a", { sweepAs: "b" }), name).rejects.toBeInstanceOf(CanaryLeak);
    }
  });

  it("a leak through the known limit (the shared server login) is caught by the sweep when it is not expected", async () => {
    // The one cross-restaurant read that works today (ADR 0003). Routed through the swept helper, it is caught.
    const leak = inStore("a", async (tx) => {
      await tx.unsafe(`set local role ${ORG.b.prefix}_rw`);
      return tx.unsafe(`select body from ${schemas("b").live}.sec_note`);
    });
    await expect(leak).rejects.toBeInstanceOf(CanaryLeak);
  });
});

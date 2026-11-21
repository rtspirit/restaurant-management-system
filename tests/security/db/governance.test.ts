// api_cannot_self_approve: the restaurant-facing server login cannot write a governance field.
// Publishing, listing, installing, deploying and deciding belong to the platform login (ADR 0004, item 4).
// Every refusal must be 42501 from Postgres: a missing grant or a row-security policy.
import { describe, expect, it } from "vitest";
import { DENIED, asOrg, orgSql, outcome, platformSql, refusal } from "../helpers/actors.js";
import { TEMPLATES, insertRow } from "../helpers/rows.js";
import { ORG, ids } from "../helpers/world.js";

const a = ids("a");
const org = ORG.a.uuid;

/** [what it tries, SQL run as the server login fenced to restaurant A] */
const GOVERNANCE_WRITES: [string, string][] = [
  // The restaurant's own row.
  ["change its own store prefix", `update platform.organizations set store_prefix = '${ORG.b.prefix}' where id = '${org}'`],
  ["change its own status", `update platform.organizations set status = 'active' where id = '${org}'`],
  ["change its own kind", `update platform.organizations set kind = 'franchisor' where id = '${org}'`],
  ["mark its own store ready", `update platform.organizations set store_ready = true where id = '${org}'`],
  ["change its own slug", `update platform.organizations set slug = 'someone-else' where id = '${org}'`],
  ["change its own region", `update platform.organizations set region = 'eu' where id = '${org}'`],
  ["change its own id", `update platform.organizations set id = gen_random_uuid() where id = '${org}'`],
  ["create a restaurant", `insert into platform.organizations (id, slug, name, store_prefix) values (gen_random_uuid(), 'g-sec-extra', 'Extra', 'o_919191919e01')`],
  ["delete its own restaurant row", `delete from platform.organizations where id = '${org}'`],
  // Mini-apps.
  ["mark a mini-app published", `update platform.apps set status = 'published' where id = '${a.installedApp}'`],
  ["set a mini-app's published version", `update platform.apps set published_version_id = '${a.appVersion}' where id = '${a.installedApp}'`],
  ["attach a mini-app to a listing", `update platform.apps set listing_id = '${a.listingPublic}' where id = '${a.installedApp}'`],
  ["turn a mini-app into a system app", `update platform.apps set kind = 'system' where id = '${a.app}'`],
  ["move a mini-app to another restaurant", `update platform.apps set org_id = '${ORG.b.uuid}' where id = '${a.app}'`],
  ["delete a mini-app", `delete from platform.apps where id = '${a.installedApp}'`],
  ["create a mini-app that is already published", `insert into platform.apps (id, org_id, slug, number, name, status) values (gen_random_uuid(), '${org}', 'born-published', 60, 'x', 'published')`],
  ["create a mini-app with a published version set", `insert into platform.apps (id, org_id, slug, number, name, published_version_id) values (gen_random_uuid(), '${org}', 'born-with-version', 61, 'x', '${a.appVersion}')`],
  ["create a mini-app already tied to a listing", `insert into platform.apps (id, org_id, slug, number, name, listing_id) values (gen_random_uuid(), '${org}', 'born-listed', 62, 'x', '${a.listingPublic}')`],
  // Versions.
  ["mark a version published", `update platform.app_versions set status = 'published' where id = '${a.readOnlyAppVersion}'`],
  ["mark a version checked", `update platform.app_versions set status = 'checked' where id = '${a.readOnlyAppVersion}'`],
  ["renumber a version", `update platform.app_versions set number = 99 where id = '${a.appVersion}'`],
  ["move a version to another mini-app", `update platform.app_versions set app_id = '${a.readOnlyApp}' where id = '${a.appVersion}'`],
  ["delete a version", `delete from platform.app_versions where id = '${a.readOnlyAppVersion}'`],
  ["create a version that is already published", `insert into platform.app_versions (id, app_id, org_id, number, manifest, status) values (gen_random_uuid(), '${a.app}', '${org}', 70, '{}'::jsonb, 'published')`],
  ["create a version that is already checked", `insert into platform.app_versions (id, app_id, org_id, number, manifest, status) values (gen_random_uuid(), '${a.app}', '${org}', 71, '{}'::jsonb, 'checked')`],
  // Deployments, installs, notifications.
  ["deploy a version", `insert into platform.deployments (id, app_id, org_id, version_id, env, screens_key) values (gen_random_uuid(), '${a.app}', '${org}', '${a.appVersion}', 'live', 'x')`],
  ["change a deployment", `update platform.deployments set status = 'active', screens_key = 'elsewhere' where org_id = '${org}'`],
  ["delete a deployment", `delete from platform.deployments where org_id = '${org}'`],
  ["record an install", `insert into platform.installs (id, listing_id, listing_version_id, org_id, app_id) values (gen_random_uuid(), '${a.listingPublic}', '${a.listingVersion}', '${org}', '${a.installedApp}')`],
  ["change an install", `update platform.installs set model_mapping = '{}'::jsonb where org_id = '${org}'`],
  ["delete an install", `delete from platform.installs where org_id = '${org}'`],
  ["write a notice to the maintainers", `insert into platform.notifications (id, audience, org_id, kind, title) values (gen_random_uuid(), 'maintainer', '${org}', 'k', 't')`],
  ["write a notice to itself", `insert into platform.notifications (id, audience, org_id, kind, title) values (gen_random_uuid(), 'owner', '${org}', 'k', 't')`],
  ["reword a notice", `update platform.notifications set title = 'All approved' where id = '${a.notification}'`],
  ["delete a notice", `delete from platform.notifications where id = '${a.notification}'`],
  // Change sets and decisions.
  ["approve its own change", `update platform.change_sets set decision = 'approved' where id = '${a.changeSet}'`],
  ["lower the tier of its own change", `update platform.change_sets set tier = 'T0', decision = 'applied' where id = '${a.changeSet}'`],
  ["delete its own change", `delete from platform.change_sets where id = '${a.changeSet}'`],
  ["record a change that is already approved", `insert into platform.change_sets (id, org_id, origin, actor, tier, summary, decision) values (gen_random_uuid(), '${org}', 'share', 'user:x', 'T3', 's', 'approved')`],
  ["record a change that is already rejected", `insert into platform.change_sets (id, org_id, origin, actor, tier, summary, decision) values (gen_random_uuid(), '${org}', 'share', 'user:x', 'T3', 's', 'rejected')`],
  ["record a maintainer-tier change as applied", `insert into platform.change_sets (id, org_id, origin, actor, tier, summary, decision) values (gen_random_uuid(), '${org}', 'share', 'user:x', 'T3', 's', 'applied')`],
  ["record a maintainer-tier change as waiting for the owner", `insert into platform.change_sets (id, org_id, origin, actor, tier, summary, decision) values (gen_random_uuid(), '${org}', 'share', 'user:x', 'T3', 's', 'pending_owner')`],
  ["record an owner-tier change as applied", `insert into platform.change_sets (id, org_id, origin, actor, tier, summary, decision) values (gen_random_uuid(), '${org}', 'publish', 'user:x', 'T2', 's', 'applied')`],
  ["record a change with a decision time", `insert into platform.change_sets (id, org_id, origin, actor, tier, summary, decision, decided_at) values (gen_random_uuid(), '${org}', 'build', 'user:x', 'T0', 's', 'applied', now())`],
  ["record a change decided by a maintainer", `insert into platform.change_sets (id, org_id, origin, actor, tier, summary, decision, decided_by_staff_id) values (gen_random_uuid(), '${org}', 'share', 'user:x', 'T3', 's', 'pending_maintainer', '00000000-0000-0000-0000-000000000000')`],
  ["write a maintainer's review", `insert into platform.change_reviews (id, change_set_id, staff_id, decision) values (gen_random_uuid(), '${a.changeSet}', gen_random_uuid(), 'approved')`],
  ["make itself a maintainer", `insert into platform.staff_users (id, user_id, name) values (gen_random_uuid(), gen_random_uuid(), 'Me')`],
  // Marketplace.
  ["list its own listing", `update platform.listings set status = 'listed' where id = '${a.listingDraft}'`],
  ["change a listing's reach", `update platform.listings set visibility = 'public' where id = '${a.listingFranchise}'`],
  ["inflate a listing's install count", `update platform.listings set install_count = 9999 where id = '${a.listingPublic}'`],
  ["swap a listing's version", `update platform.listings set current_version_id = gen_random_uuid() where id = '${a.listingPublic}'`],
  ["change what a listing says it needs", `update platform.listings set required_models = '{}', required_connections = '{}' where id = '${a.listingPublic}'`],
  ["hand a listing to another restaurant", `update platform.listings set publisher_org_id = '${ORG.b.uuid}' where id = '${a.listingPublic}'`],
  ["delete a listing", `delete from platform.listings where id = '${a.listingDraft}'`],
  ["create a listing that is already listed", `insert into platform.listings (id, source_app_id, publisher_org_id, title, summary, category, status) values (gen_random_uuid(), '${a.app}', '${org}', 't', 's', 'c', 'listed')`],
  ["create a listing with installs", `insert into platform.listings (id, source_app_id, publisher_org_id, title, summary, category, install_count) values (gen_random_uuid(), '${a.app}', '${org}', 't', 's', 'c', 500)`],
  ["write a listing version", `insert into platform.listing_versions (id, listing_id, number, bundle_key, manifest) values (gen_random_uuid(), '${a.listingPublic}', 9, 'x', '{}'::jsonb)`],
  ["write its own recommendations", `insert into platform.org_recommendations (org_id, listing_id, score, reasons) values ('${org}', '${a.listingDraft}', 1, '{x}')`],
  ["delete its recommendations", `delete from platform.org_recommendations where org_id = '${org}'`],
  // Models: structure changes only through the platform.
  ["register a model", `insert into platform.org_models (id, org_id, key, kind, definition) values (gen_random_uuid(), '${org}', 'sneaky', 'custom', '{}'::jsonb)`],
  ["rewrite a model definition", `update platform.org_models set definition = '{}'::jsonb where id = '${a.orgModelVisit}'`],
  ["mark a model live", `update platform.org_models set status = 'live' where id = '${a.orgModelVisit}'`],
  ["delete a model record", `delete from platform.org_models where id = '${a.orgModelLedger}'`],
  ["record a table change with its own SQL", `insert into platform.org_model_changes (id, org_id, org_model_id, change, compiled_sql) values (gen_random_uuid(), '${org}', '${a.orgModelNote}', '{}'::jsonb, 'drop schema platform cascade')`],
  ["rewrite a recorded table change", `update platform.org_model_changes set compiled_sql = 'drop schema platform cascade' where id = '${a.orgModelChange}'`],
  // Stored secrets.
  ["store a secret directly", `insert into platform.secrets (id, org_id, purpose, ciphertext) values (gen_random_uuid(), '${org}', 'x', 'x')`],
  ["read its own stored secret", `select ciphertext from platform.secrets where id = '${a.secret}'`],
];

describe("api_cannot_self_approve: governance writes by the server login", () => {
  it.each(GOVERNANCE_WRITES)("cannot %s", async (_what, sql) => {
    expect(await outcome(orgSql("a", sql))).toBe(DENIED);
  });

  it("the list above is long enough to mean something", () => {
    expect(GOVERNANCE_WRITES.length).toBeGreaterThanOrEqual(60);
  });

  it("control: the platform login can make each kind of governance write", async () => {
    // The same statements, as the login that is meant to make them. Skips the ones that are refused for
    // a reason other than rights (a made-up staff id, a duplicate) so the control stays honest.
    const sample = [
      `update platform.organizations set kind = 'franchisor' where id = '${org}'`,
      `update platform.apps set status = 'published' where id = '${a.installedApp}'`,
      `update platform.app_versions set status = 'checked' where id = '${a.readOnlyAppVersion}'`,
      `insert into platform.deployments (id, app_id, org_id, version_id, env, screens_key) values (gen_random_uuid(), '${a.app}', '${org}', '${a.appVersion}', 'live', 'x')`,
      `insert into platform.notifications (id, audience, org_id, kind, title) values (gen_random_uuid(), 'maintainer', '${org}', 'k', 't')`,
      `update platform.change_sets set decision = 'approved' where id = '${a.changeSet}'`,
      `update platform.listings set status = 'listed' where id = '${a.listingDraft}'`,
      `update platform.org_models set status = 'live' where id = '${a.orgModelVisit}'`,
      `select ciphertext from platform.secrets where id = '${a.secret}'`,
    ];
    for (const sql of sample) expect(await outcome(platformSql(sql)), sql).toBe("allowed");
  });

  it("the refusals are row-security refusals where a policy, not a grant, is the wall", async () => {
    const published = await refusal(orgSql("a", `insert into platform.apps (id, org_id, slug, number, name, status) values (gen_random_uuid(), '${org}', 'born-published', 60, 'x', 'published')`));
    expect(published).toMatchObject({ code: DENIED });
    expect(published.message).toMatch(/row-level security/);
    const approved = await refusal(orgSql("a", `insert into platform.change_sets (id, org_id, origin, actor, tier, summary, decision) values (gen_random_uuid(), '${org}', 'share', 'user:x', 'T3', 's', 'approved')`));
    expect(approved.message).toMatch(/row-level security/);
  });
});

describe("what the server login MAY do (so the refusals above are not just a login that can do nothing)", () => {
  it("can change its restaurant's name, colour and logo", async () => {
    expect(await orgSql("a", `update platform.organizations set brand_colour = '#112233', logo_url = 'https://logo.test/a.png' where id = '${org}' returning id`)).toHaveLength(1);
  });

  it("can start a draft mini-app, a draft version and a draft listing", async () => {
    expect(await outcome(asOrg("a", (tx) => insertRow(tx, "apps", (TEMPLATES.apps as (k: "a") => Record<string, unknown>)("a"))))).toBe("allowed");
    expect(await outcome(asOrg("a", (tx) => insertRow(tx, "app_versions", (TEMPLATES.app_versions as (k: "a") => Record<string, unknown>)("a"))))).toBe("allowed");
    expect(await outcome(asOrg("a", (tx) => insertRow(tx, "listings", (TEMPLATES.listings as (k: "a") => Record<string, unknown>)("a"))))).toBe("allowed");
  });

  it("can record a change with the decision its tier allows, and only that one", async () => {
    const insert = (tier: string, decision: string) =>
      outcome(orgSql("a", `insert into platform.change_sets (id, org_id, origin, actor, tier, summary, decision) values (gen_random_uuid(), '${org}', 'build', 'user:x', '${tier}', 's', '${decision}')`));
    const allowed: Record<string, string> = { T0: "applied", T1: "applied", T2: "pending_owner", T3: "pending_maintainer" };
    for (const tier of Object.keys(allowed)) {
      for (const decision of ["applied", "pending_owner", "pending_maintainer", "approved", "rejected"]) {
        expect(await insert(tier, decision), `${tier} ${decision}`).toBe(allowed[tier] === decision ? "allowed" : DENIED);
      }
    }
  });

  it("can mark its own notice as read, and nothing else about it", async () => {
    expect(await orgSql("a", `update platform.notifications set read_at = now() where id = '${a.notification}' returning id`)).toHaveLength(1);
    expect(await outcome(orgSql("a", `update platform.notifications set read_at = now(), severity = 'info' where id = '${a.notification}'`))).toBe(DENIED);
  });
});

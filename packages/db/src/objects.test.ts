// Lead-owned test. Needs the local database. Ids: the lead's own range for this file (uuid suffix 90 to 9f). Cleans up after itself.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppSource, OBJECT_KEY_PATTERNS, OBJECT_LIMITS, objectKeys, toPublicId } from "@rms/contracts";
import {
  ObjectStoreError,
  adminDb,
  apiDb,
  closeAll,
  dbObjectStore,
  loadListingSource,
  loadSource,
  readPublishedScreen,
  saveListingSource,
  saveScreens,
  saveSource,
  withOrg,
} from "./index.js";
import { requireTestEnv } from "./testing.js";

const id = (suffix: string) => `0193a3c0-0000-7000-8000-0000000000${suffix}`;
const A = id("90");
const B = id("91");
const APP_A = id("92");
const APP_B = id("93");
const DRAFT_A = id("94"); // version 2 of A's mini-app, a draft
const LIVE_A = id("95"); // version 1 of A's mini-app, published
const DRAFT_B = id("96");
const LISTING = id("97");
const orgA = toPublicId("org", A);
const orgB = toPublicId("org", B);
const appA = toPublicId("app", APP_A);
const appB = toPublicId("app", APP_B);
const liveA = toPublicId("ver", LIVE_A);
const listing = toPublicId("lst", LISTING);

const source: AppSource = { format: 1, files: [{ path: "src/screens/index.ts", text: "export const screens = [];" }, { path: "src/screens/money/index.tsx", text: "export default function Money() { return null; }" }] };
const text = (s: string) => new TextEncoder().encode(s);
const built = [
  { path: "index.html", bytes: text("<!doctype html><title>Money</title>") },
  { path: "assets/index-abc.js", bytes: text("console.log('money')") },
];

const clean = async () => {
  const admin = adminDb();
  await admin`delete from platform.objects where org_id in (${A}, ${B})`;
  await admin`delete from platform.listings where publisher_org_id in (${A}, ${B})`;
  await admin`delete from platform.app_versions where org_id in (${A}, ${B})`;
  await admin`delete from platform.apps where org_id in (${A}, ${B})`;
  await admin`delete from platform.organizations where id in (${A}, ${B})`;
};

const asA = <T>(fn: (store: ReturnType<typeof dbObjectStore>) => Promise<T>): Promise<T> => withOrg(apiDb(), A, (tx) => fn(dbObjectStore(tx)));
const code = async (p: Promise<unknown>): Promise<string> => p.then(() => "allowed", (e: { code?: string; reason?: string }) => e.code ?? e.reason ?? "error");

beforeAll(async () => {
  requireTestEnv("DATABASE_URL", "DATABASE_ADMIN_URL");
  await clean();
  const admin = adminDb();
  await admin`insert into platform.organizations (id, slug, name, store_prefix) values
    (${A}, 'lead-objects-a', 'Objects A', 'o_9090909090a1'), (${B}, 'lead-objects-b', 'Objects B', 'o_9090909090b1')`;
  await admin`insert into platform.apps (id, org_id, slug, number, name, status, published_version_id, current_version_id) values
    (${APP_A}, ${A}, 'money', 1, 'Money', 'published', ${LIVE_A}, ${DRAFT_A}), (${APP_B}, ${B}, 'money', 1, 'Money', 'draft', null, ${DRAFT_B})`;
  await admin`insert into platform.app_versions (id, app_id, org_id, number, manifest, status) values
    (${LIVE_A}, ${APP_A}, ${A}, 1, '{"name":"Money"}', 'published'), (${DRAFT_A}, ${APP_A}, ${A}, 2, '{"name":"Money"}', 'draft'),
    (${DRAFT_B}, ${APP_B}, ${B}, 1, '{"name":"Money"}', 'draft')`;
  await admin`insert into platform.listings (id, source_app_id, publisher_org_id, title, summary, category) values (${LISTING}, ${APP_A}, ${A}, 'Money', 'Sales and costs', 'money')`;
  // Something of B's for A to try to reach, and A's own published files.
  await saveSource(dbObjectStore(admin), orgB, appB, 1, source);
  await admin.begin((tx) => saveScreens(dbObjectStore(tx), orgA, appA, 1, built, { shellOrigin: "http://localhost:3000", builtAt: new Date().toISOString() }));
  await saveListingSource(dbObjectStore(admin), listing, 1, source);
});

afterAll(async () => {
  await clean();
  await closeAll();
});

describe("the restaurant-facing login and the object store", () => {
  it("saves and reads the source of its own draft version", async () => {
    const saved = await asA((s) => saveSource(s, orgA, appA, 2, source));
    expect(saved.key).toBe(objectKeys.source(orgA, appA, 2));
    expect(await asA((s) => loadSource(s, orgA, appA, 2))).toEqual(source);
    // Saving again replaces it: one object, the new content.
    const next: AppSource = { format: 1, files: [{ path: "src/screens/index.ts", text: "export const screens = [1];" }] };
    await asA((s) => saveSource(s, orgA, appA, 2, next));
    expect(await asA((s) => loadSource(s, orgA, appA, 2))).toEqual(next);
    const [n] = await adminDb()<{ n: number }[]>`select count(*)::int as n from platform.objects where key = ${objectKeys.source(orgA, appA, 2)}`;
    expect(n?.n).toBe(1);
  });

  it("cannot write the source of a published version, built files or a listing", async () => {
    expect(await code(asA((s) => saveSource(s, orgA, appA, 1, source)))).toBe("42501");
    expect(await code(asA((s) => s.put(objectKeys.screen(orgA, appA, 2, "index.html"), text("<p>x</p>"), "text/html; charset=utf-8")))).toBe("42501");
    expect(await code(asA((s) => s.put(objectKeys.screen(orgA, appA, 1, "index.html"), text("<p>x</p>"), "text/html; charset=utf-8")))).toBe("42501");
    expect(await code(asA((s) => saveListingSource(s, listing, 1, source)))).toBe("42501");
    expect(await code(asA((s) => saveSource(s, orgA, appA, 7, source)))).toBe("42501"); // no such version
  });

  it("cannot remove its own published files", async () => {
    expect(await asA((s) => s.deletePrefix(objectKeys.screensPrefix(orgA, appA, 1)))).toBe(0);
    expect(await asA((s) => s.list(objectKeys.screensPrefix(orgA, appA, 1)))).toHaveLength(2);
  });

  it("cannot read, write, list or remove another restaurant's objects", async () => {
    expect(await asA((s) => loadSource(s, orgB, appB, 1))).toBeNull();
    expect(await asA((s) => s.exists(objectKeys.source(orgB, appB, 1)))).toBe(false);
    expect(await asA((s) => s.list(`orgs/${orgB}/apps/${appB}/`))).toEqual([]);
    expect(await asA((s) => s.deletePrefix(`orgs/${orgB}/apps/${appB}/`))).toBe(0);
    expect(await code(asA((s) => saveSource(s, orgB, appB, 1, source)))).toBe("42501");
    expect(await asA((s) => loadListingSource(s, listing, 1))).toBeNull();
    expect(await loadSource(dbObjectStore(adminDb()), orgB, appB, 1)).toEqual(source);
  });

  it("with no restaurant set it sees nothing", async () => {
    const rows = await apiDb()`select key from platform.objects`;
    expect(rows).toHaveLength(0);
  });

  it("nobody can change an object in place, not even the platform login", async () => {
    expect(await code(withOrg(apiDb(), A, (tx) => tx`update platform.objects set content_type = 'text/plain' where org_id = ${A}`))).toBe("42501");
    expect(await code(adminDb()`update platform.objects set content_type = 'text/plain' where org_id = ${A}`)).toBe("42501");
  });
});

describe("the store refuses bad keys before it asks the database", () => {
  it.each([
    "", "x", "orgs/", `orgs/${orgA}/`, `orgs/${orgA}/apps/${appA}/versions/../1.bundle`, `orgs/${orgA}/apps/${appA}/builds/1/screens/../x.js`, `orgs/${A}/apps/${appA}/versions/1.bundle`,
    `listings/${listing}/0.bundle`, `orgs/${orgA}/store/backups/x.dump`,
  ])("put and get refuse %s", async (key) => {
    const store = dbObjectStore(adminDb());
    expect(await code(store.put(key, text("x"), "text/plain"))).toBe("bad_key");
    expect(await code(store.get(key))).toBe("bad_key");
    expect(await code(store.exists(key))).toBe("bad_key");
  });

  it.each(["", "orgs/", `orgs/${orgA}/`, `orgs/${orgA}/apps/`, "listings/", "%", `orgs/${orgA}/apps/${appA}`, `orgs/${orgA}/apps/${appA}/builds/`, `orgs/%/apps/${appA}/`])(
    "list and delete refuse the prefix %s",
    async (prefix) => {
      const store = dbObjectStore(adminDb());
      expect(await code(store.list(prefix))).toBe("bad_prefix");
      expect(await code(store.deletePrefix(prefix))).toBe("bad_prefix");
    },
  );

  it("holds an object and a build to their size limits", async () => {
    const store = dbObjectStore(adminDb());
    expect(await code(store.put(objectKeys.source(orgA, appA, 2), new Uint8Array(OBJECT_LIMITS.maxObjectBytes + 1), "text/plain"))).toBe("too_big");
    expect(await code(store.put(objectKeys.source(orgA, appA, 2), new Uint8Array(0), "text/plain"))).toBe("empty");
    expect(await code(store.put(objectKeys.source(orgA, appA, 2), text("x"), "text/html; charset=utf-7"))).toBe("bad_type");
    const meta = { shellOrigin: "http://localhost:3000", builtAt: new Date().toISOString() };
    expect(await code(saveScreens(store, orgA, appA, 2, [{ path: "index.html", bytes: text("x") }, { path: "assets/a.js.map", bytes: text("x") }], meta))).toBe("bad_type");
    expect(await code(saveScreens(store, orgA, appA, 2, [{ path: "../index.html", bytes: text("x") }], meta))).toBe("bad_type");
    expect(await code(saveScreens(store, orgA, appA, 2, [{ path: "assets/a.js", bytes: text("x") }], meta))).toBe("bad_content"); // no start page
    expect(await code(saveScreens(store, orgA, appA, 2, [], meta))).toBe("empty");
    const big = new Uint8Array(4_500_000).fill(120);
    expect(await code(saveScreens(store, orgA, appA, 2, [{ path: "index.html", bytes: text("x") }, { path: "a.js", bytes: big }, { path: "b.js", bytes: big }, { path: "c.js", bytes: big }], meta))).toBe("too_big");
    expect(await store.list(objectKeys.screensPrefix(orgA, appA, 2))).toEqual([]);
  });
});

describe("the database's own rules on objects", () => {
  const insert = (key: string, org: string | null, bytes: string, extra: { sha?: string; size?: number } = {}) =>
    adminDb()`
      insert into platform.objects (key, org_id, bytes, content_type, sha256, size)
      select ${key}, ${org}::uuid, b, 'text/plain', coalesce(${extra.sha ?? null}, encode(sha256(b), 'hex')), coalesce(${extra.size ?? null}::int, octet_length(b))
      from (select convert_to(${bytes}, 'UTF8') as b) s`;

  it("a key must be one of the three forms, and a key under orgs/ must name the row's restaurant", async () => {
    expect(await code(insert(`orgs/${orgA}/apps/${appA}/secrets/1`, A, "x"))).toBe("23514");
    expect(await code(insert(`orgs/${orgA}/apps/${appA}/builds/9/screens/../../x`, A, "x"))).toBe("23514");
    expect(await code(insert(objectKeys.source(orgA, appA, 9), B, "x"))).toBe("23514");
    expect(await code(insert(objectKeys.source(orgA, appA, 9), null, "x"))).toBe("23502");
    expect(await code(insert(objectKeys.listing(listing, 9), null, "x"))).toBe("23502");
  });

  it("what is stored must match its hash and its size", async () => {
    expect(await code(insert(objectKeys.source(orgA, appA, 9), A, "x", { sha: "0".repeat(64) }))).toBe("23514");
    expect(await code(insert(objectKeys.source(orgA, appA, 9), A, "x", { size: 2 }))).toBe("23514");
  });

  it("uses the same key patterns as the contract", async () => {
    const [row] = await adminDb()<{ def: string }[]>`select pg_get_constraintdef(oid) as def from pg_catalog.pg_constraint where conname = 'objects_key_form'`;
    for (const pattern of Object.values(OBJECT_KEY_PATTERNS)) expect(row?.def, pattern).toContain(`'${pattern}'`);
  });

  it("a listing's object is filed under the restaurant that shared it, and a listing that does not exist cannot have one", async () => {
    const [row] = await adminDb()<{ org_id: string }[]>`select org_id from platform.objects where key = ${objectKeys.listing(listing, 1)}`;
    expect(row?.org_id).toBe(A);
    expect(await code(saveListingSource(dbObjectStore(adminDb()), toPublicId("lst", id("9f")), 1, source))).toBe("23502");
  });

  it("the restaurant that shared a listing cannot read the listing's object through its own login", async () => {
    expect(await asA((s) => loadListingSource(s, listing, 1))).toBeNull();
    expect(await withOrg(apiDb(), A, (tx) => tx`select key from platform.objects where key like 'listings/%'`)).toHaveLength(0);
    expect(await loadListingSource(dbObjectStore(adminDb()), listing, 1)).toEqual(source);
  });
});

describe("what the apps host can read", () => {
  it("a published version's files, by mini-app, version and path", async () => {
    const page = await readPublishedScreen(adminDb(), appA, liveA, "index.html");
    expect(page?.contentType).toBe("text/html; charset=utf-8");
    expect(new TextDecoder().decode(page?.bytes)).toContain("<title>Money</title>");
    expect((await readPublishedScreen(adminDb(), appA, liveA, "assets/index-abc.js"))?.contentType).toBe("text/javascript; charset=utf-8");
  });

  it("nothing for a path that is not a built file, a draft version, or another mini-app's version", async () => {
    for (const path of ["nope.html", "../index.html", "assets/../index.html", "", "index.html/", `../../versions/2.bundle`, "a.map"]) {
      expect(await readPublishedScreen(adminDb(), appA, liveA, path), path).toBeNull();
    }
    expect(await readPublishedScreen(adminDb(), appA, toPublicId("ver", DRAFT_A), "index.html")).toBeNull();
    expect(await readPublishedScreen(adminDb(), appB, liveA, "index.html")).toBeNull();
    expect(await readPublishedScreen(adminDb(), appB, toPublicId("ver", DRAFT_B), "index.html")).toBeNull();
  });

  it("nothing once the mini-app is paused, or once another version is the published one", async () => {
    const admin = adminDb();
    await admin`update platform.apps set status = 'paused' where id = ${APP_A}`;
    expect(await readPublishedScreen(admin, appA, liveA, "index.html")).toBeNull();
    await admin`update platform.apps set status = 'published', published_version_id = ${DRAFT_A} where id = ${APP_A}`;
    expect(await readPublishedScreen(admin, appA, liveA, "index.html")).toBeNull();
    await admin`update platform.apps set published_version_id = ${LIVE_A} where id = ${APP_A}`;
    expect(await readPublishedScreen(admin, appA, liveA, "index.html")).not.toBeNull();
  });

  it("the restaurant-facing login cannot use that door", async () => {
    expect(await code(apiDb()`select * from platform.published_screen(${APP_A}::uuid, ${LIVE_A}::uuid, 'index.html')`)).toBe("42501");
  });

  it("an error from the store never carries a key", () => {
    expect(new ObjectStoreError("bad_key").message).toBe("object store: bad_key");
  });
});

// Wave 3 contract tests: the security-relevant shapes. Each test tries one thing and expects a refusal.
import { describe, expect, it } from "vitest";
import * as c from "./index.js";

const ok = (r: { success: boolean }) => expect(r.success).toBe(true);
const no = (r: { success: boolean }) => expect(r.success).toBe(false);
const hex = "a".repeat(32);
const hexB = "b".repeat(32);
const sha = "c".repeat(64);
const now = "2026-11-21T10:00:00.000Z";
const org = `org_${hex}` as c.OrgId;
const app = `app_${hex}` as c.AppId;
const ver = `ver_${hex}` as c.AppVersionId;
const lst = `lst_${hex}` as c.ListingId;

type Schema = { safeParse: (v: unknown) => { success: boolean } };
type Sample = { schema: Schema; value: unknown };

/** One full, valid example of every shape a browser sends in Wave 3. */
const WAVE3_SAMPLES: Record<string, Sample> = {
  PublishRequest: { schema: c.PublishRequest, value: { confirm: true } },
  RollbackRequest: { schema: c.RollbackRequest, value: { confirm: true } },
  ConfirmChangeRequest: { schema: c.ConfirmChangeRequest, value: { confirm: true } },
  DecideChangeRequest: { schema: c.DecideChangeRequest, value: { decision: "approve", note: "Looks fine." } },
  ShareRequest: { schema: c.ShareRequest, value: { title: "Money at a glance", summary: "Shows sales, costs and what is left each week.", category: "money", confirm: true } },
  InstallRequest: { schema: c.InstallRequest, value: { confirm: true } },
};

const IDENTITY_KEYS = [
  "org", "orgId", "org_id", "organization", "restaurant", "restaurantId", "tenant", "tenantId", "schema", "storePrefix", "store_prefix",
  "database", "role", "roles", "env", "environment", "user", "userId", "user_id", "sub", "actor", "locations", "loc", "token", "claims",
  "sql", "raw", "url", "origin", "headers", "authorization", "key", "prefix", "path", "bundleKey", "sourceKey", "appId", "versionId", "listingId",
  "tier", "signals", "staffId", "publisher", "publisherOrgId", "__proto__", "constructor",
];

const withKey = (value: unknown, key: string, injected: unknown): unknown => {
  const copy = structuredClone(value) as Record<string, unknown>;
  Object.defineProperty(copy, key, { value: injected, enumerable: true, writable: true, configurable: true });
  return copy;
};

describe("Wave 3: no request can name a restaurant, a user, a role, a store, a key or what it acts on", () => {
  it.each(Object.entries(WAVE3_SAMPLES))("%s is valid to begin with", (_n, s) => ok(s.schema.safeParse(s.value)));

  it.each(Object.entries(WAVE3_SAMPLES))("%s refuses every identity field", (_n, s) => {
    const own = Object.keys(s.value as object);
    let attempts = 0;
    for (const key of IDENTITY_KEYS) {
      if (own.includes(key)) continue;
      for (const injected of ["x", org, "o_000000000000", { id: org }, true]) {
        expect(s.schema.safeParse(withKey(s.value, key, injected)).success, key).toBe(false);
        attempts++;
      }
    }
    expect(attempts).toBeGreaterThan(100);
  });

  it("has an example for every Wave 3 request shape", () => {
    const mine = Object.keys(c).filter((name) => /Request$/.test(name) && /^(Publish|Rollback|ConfirmChange|DecideChange|Share|Install)/.test(name));
    expect(mine.sort()).toEqual(Object.keys(WAVE3_SAMPLES).sort());
  });

  it("a confirm is the literal true, never a maybe", () => {
    for (const schema of [c.PublishRequest, c.RollbackRequest, c.ConfirmChangeRequest, c.InstallRequest]) {
      for (const bad of [{}, { confirm: false }, { confirm: "true" }, { confirm: 1 }, null, [], "true"]) no(schema.safeParse(bad));
    }
    no(c.ShareRequest.safeParse({ title: "Money at a glance", summary: "Shows sales, costs and what is left.", category: "money", confirm: false }));
    no(c.ShareRequest.safeParse({ title: "Money at a glance", summary: "Shows sales, costs and what is left.", category: "made_up", confirm: true }));
    no(c.DecideChangeRequest.safeParse({ decision: "approved" }));
  });

  it("is bumped for Wave 3", () => expect(c.CONTRACTS_VERSION).toBe("0.5.0"));
});

describe("object keys: where mini-app code is kept", () => {
  it("the builders make exactly the plan's keys", () => {
    expect(c.objectKeys.source(org, app, 3)).toBe(`orgs/${org}/apps/${app}/versions/3.bundle`);
    expect(c.objectKeys.screensPrefix(org, app, 3)).toBe(`orgs/${org}/apps/${app}/builds/3/screens/`);
    expect(c.objectKeys.screen(org, app, 3, "assets/index-abc.js")).toBe(`orgs/${org}/apps/${app}/builds/3/screens/assets/index-abc.js`);
    expect(c.objectKeys.listing(lst, 1)).toBe(`listings/${lst}/1.bundle`);
  });

  it("a key reads back into the same parts", () => {
    expect(c.parseObjectKey(c.objectKeys.source(org, app, 12))).toEqual({ kind: "source", orgId: org, appId: app, number: 12 });
    expect(c.parseObjectKey(c.objectKeys.screen(org, app, 2, "assets/a.css"))).toEqual({ kind: "screen", orgId: org, appId: app, number: 2, path: "assets/a.css" });
    expect(c.parseObjectKey(c.objectKeys.listing(lst, 4))).toEqual({ kind: "listing", listingId: lst, number: 4 });
    const uuid = "0193a3c0-0000-7000-8000-0000000000e1";
    const real = c.toPublicId("org", uuid);
    expect(c.orgUuidOfKey(c.objectKeys.source(real, app, 1))).toBe(uuid);
    expect(c.orgUuidOfKey(c.objectKeys.listing(lst, 1))).toBeNull();
    expect(c.objectKeys.source(real, app, 1).startsWith(c.orgKeyPrefix(uuid))).toBe(true);
    expect(c.objectKeys.source(`org_${hexB}` as c.OrgId, app, 1).startsWith(c.orgKeyPrefix(uuid))).toBe(false);
  });

  it("refuses anything that is not one of the three forms", () => {
    for (const bad of [
      "", "/", "orgs", `orgs/${org}`, `orgs/${org}/`, `orgs/${org}/apps/${app}/versions/0.bundle`, `orgs/${org}/apps/${app}/versions/1.bundle/x`,
      `orgs/${org}/apps/${app}/versions/../1.bundle`, `orgs/${org}/apps/${app}/builds/1/screens/`, `orgs/${org}/apps/${app}/builds/1/screens/../../x`,
      `orgs/${org}/apps/${app}/builds/1/screens/.env`, `orgs/${org}/apps/${app}/builds/1/screens//a.js`, `orgs/${org}/apps/${app}/builds/1/screens/a/../b.js`,
      `/orgs/${org}/apps/${app}/versions/1.bundle`, `orgs/${c.toUuid(org)}/apps/${app}/versions/1.bundle`, `orgs/ORG_${hex}/apps/${app}/versions/1.bundle`,
      `orgs/${org}/apps/${app}/versions/1.bundle\n`, `orgs/${org}/apps/${app}/secrets/1`, `orgs/${org}/store/backups/x.dump`, `listings/${lst}/0.bundle`,
      `listings/${app}/1.bundle`, `listings/${lst}/1.bundle/..`, `orgs/${org}\\apps`, `orgs/%2e%2e/apps/${app}/versions/1.bundle`,
    ]) {
      no(c.ObjectKey.safeParse(bad));
      expect(c.parseObjectKey(bad), bad).toBeNull();
    }
  });

  it("a builder cannot be talked into a bad key", () => {
    expect(() => c.objectKeys.source(org, app, 0)).toThrow();
    expect(() => c.objectKeys.source(org, app, 1.5)).toThrow();
    expect(() => c.objectKeys.source("org_x" as c.OrgId, app, 1)).toThrow();
    expect(() => c.objectKeys.source(`${org}/../org_${hexB}` as c.OrgId, app, 1)).toThrow();
    expect(() => c.objectKeys.screen(org, app, 1, "../x.js")).toThrow();
    expect(() => c.objectKeys.screen(org, app, 1, "a.map")).toThrow();
    expect(() => c.objectKeys.listing("lst_x" as c.ListingId, 1)).toThrow();
  });

  it("every pattern is anchored at both ends", () => {
    for (const p of Object.values(c.OBJECT_KEY_PATTERNS)) {
      expect(p.startsWith("^")).toBe(true);
      expect(p.endsWith("$")).toBe(true);
    }
  });
});

describe("built files", () => {
  it("only known kinds of file have a content type", () => {
    expect(c.contentTypeFor("index.html")).toBe("text/html; charset=utf-8");
    expect(c.contentTypeFor("assets/index-abc.JS")).toBe("text/javascript; charset=utf-8");
    for (const bad of ["a.map", "a.php", "a.exe", "a.sh", "a.zip", "a.wasm", "a.mjs.map", "noextension", ".htaccess", "a.", "a.html.gz"]) expect(c.contentTypeFor(bad), bad).toBeNull();
  });

  it("a path stays inside its version", () => {
    for (const good of ["index.html", "assets/index-abc123.js", "assets/fonts/inter.woff2"]) ok(c.BundlePath.safeParse(good));
    for (const bad of ["", "/index.html", "../index.html", "a/../b.js", "a//b.js", "./a.js", ".hidden/a.js", "a\\b.js", "a.js?x=1", "a b.js", "a.js\0", "https://evil.test/a.js", "a.map", `${"a/".repeat(120)}a.js`]) {
      no(c.BundlePath.safeParse(bad));
    }
  });

  const file = (path: string, size = 100) => ({ path, contentType: c.contentTypeFor(path), size, sha256: sha });
  const index = { format: 1, entry: "index.html", shellOrigin: "http://localhost:3000", builtAt: now, files: [file("index.html"), file("assets/a.js")] };

  it("an index needs a start page, honest types and a real shell origin", () => {
    ok(c.BundleIndex.safeParse(index));
    no(c.BundleIndex.safeParse({ ...index, files: [file("assets/a.js")] }));
    no(c.BundleIndex.safeParse({ ...index, files: [file("index.html"), { ...file("assets/a.js"), contentType: "text/html; charset=utf-8" }] }));
    no(c.BundleIndex.safeParse({ ...index, files: [file("index.html"), file("Index.html")] }));
    no(c.BundleIndex.safeParse({ ...index, shellOrigin: "*" }));
    no(c.BundleIndex.safeParse({ ...index, shellOrigin: "https://rms.example.com/path" }));
    no(c.BundleIndex.safeParse({ ...index, files: [file("index.html"), file("a.js", c.OBJECT_LIMITS.screens.maxFileBytes + 1)] }));
    no(c.BundleIndex.safeParse({ ...index, files: [file("index.html"), file("a.js", 5_000_000), file("b.js", 5_000_000), file("c.js", 5_000_000)] }));
    no(c.BundleIndex.safeParse({ ...index, orgId: org }));
  });
});

describe("source: only what the agent may write", () => {
  const src = (files: { path: string; text: string }[]) => ({ format: 1, files });

  it("accepts screens and components", () => {
    ok(c.AppSource.safeParse(src([{ path: "src/screens/index.ts", text: "export const screens = [];" }, { path: "src/screens/money/index.tsx", text: "export default 1;" }, { path: "src/components/total.tsx", text: "" }])));
  });

  it("refuses every locked file and anything outside the two folders", () => {
    for (const path of [
      "package.json", "package-lock.json", "vite.config.ts", "index.html", "rms.config.ts", ".env.local", "src/main.tsx", "src/rms/app.tsx", ".rms/locked.json", ".rms/catalog.json",
      "vendor/x.ts", "node_modules/x/index.ts", "dist/index.html", "src/screens/../rms/app.tsx", "src/screens/../../package.json", "/src/screens/a.tsx", "src/screens/a.js",
      "src/screens/a.css", "src/screens/a.json", "src/screens/.hidden.ts", "src/screens//a.tsx", "src\\screens\\a.tsx", "src/screensx/a.tsx", "public/a.ts", "src/screens/a.tsx\0",
    ]) {
      no(c.AppSource.safeParse(src([{ path, text: "x" }])));
    }
  });

  it("refuses repeats, binary text, an empty list and too much", () => {
    no(c.AppSource.safeParse(src([])));
    no(c.AppSource.safeParse(src([{ path: "src/screens/a.tsx", text: "1" }, { path: "src/screens/A.tsx", text: "2" }])));
    no(c.AppSource.safeParse(src([{ path: "src/screens/a.tsx", text: "a\0b" }])));
    no(c.AppSource.safeParse(src([{ path: "src/screens/a.tsx", text: "x".repeat(c.OBJECT_LIMITS.source.maxFileBytes + 1) }])));
    no(c.AppSource.safeParse(src(Array.from({ length: 11 }, (_v, i) => ({ path: `src/screens/s${i}.tsx`, text: "x".repeat(c.OBJECT_LIMITS.source.maxFileBytes) })))));
    no(c.AppSource.safeParse({ ...src([{ path: "src/screens/a.tsx", text: "1" }]), manifest: {} }));
    no(c.AppSource.safeParse(src([{ path: "src/screens/a.tsx", text: "1", orgId: org } as never])));
  });
});

describe("the apps host", () => {
  it("reads only its own address form", () => {
    expect(c.parseAppsHostPath(`/a/${app}/${ver}/`)).toEqual({ appId: app, versionId: ver, path: "index.html" });
    expect(c.parseAppsHostPath(`/a/${app}/${ver}`)).toEqual({ appId: app, versionId: ver, path: "index.html" });
    expect(c.parseAppsHostPath(`/a/${app}/${ver}/assets/index-abc.js`)).toEqual({ appId: app, versionId: ver, path: "assets/index-abc.js" });
    for (const bad of [
      "/", "/a", `/a/${app}`, `/a/${app}/`, `/a/${app}/${app}/`, `/a/${ver}/${ver}/`, `/a/${org}/${ver}/`, `/b/${app}/${ver}/`, `/a/${app}/${ver}/../x.js`, `/a/${app}/${ver}/..%2fx.js`,
      `/a/${app}/${ver}/%2e%2e/x.js`, `/a/${app}/${ver}//x.js`, `/a/${app}/${ver}/x.map`, `/a/${app}/${ver}/.env`, `/a/${app}/${ver}/a\\b.js`, `/a/${app.toUpperCase()}/${ver}/`,
      `/a/${app}/${ver}/orgs/${org}/apps/${app}/versions/1.bundle`, `/a/${app}/${ver}/${"x".repeat(500)}.js`, `//evil.test/a/${app}/${ver}/`,
    ]) {
      expect(c.parseAppsHostPath(bad), bad).toBeNull();
    }
  });

  it("the policy lets a mini-app call nothing and be framed only by RMS", () => {
    const policy = c.appsHostPolicy(["http://localhost:3000"]);
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain("script-src 'self';");
    expect(policy).toContain("form-action 'none'");
    expect(policy).toContain("frame-ancestors http://localhost:3000");
    expect(policy).not.toMatch(/script-src[^;]*unsafe/);
    expect(policy).not.toContain("*");
    expect(c.appsHostPolicy([])).toContain("frame-ancestors 'none'");
    expect(c.appsHostPolicy(["*", "https://*.example.com", "javascript:alert(1)", "https://rms.example.com/x; script-src *"])).toContain("frame-ancestors 'none'");
    expect(c.appsHostPolicy(["https://rms.example.com", "*"])).toContain("frame-ancestors https://rms.example.com");
    expect(Object.keys(c.APPS_HOST_HEADERS)).not.toContain("set-cookie");
  });

  it("origins from settings are exact, few, and never a wildcard", () => {
    expect(c.exactOrigins("http://localhost:3000")).toEqual(["http://localhost:3000"]);
    expect(c.exactOrigins("https://rms.example.com/some/path?x=1")).toEqual(["https://rms.example.com"]);
    expect(c.exactOrigins("http://localhost:3000, https://rms.example.com,https://rms.example.com")).toEqual(["http://localhost:3000", "https://rms.example.com"]);
    for (const empty of [undefined, null, "", " , "]) expect(c.exactOrigins(empty)).toEqual([]);
    expect(c.exactOrigins("*, https://*.example.com, not an address, javascript:alert(1), http://example.com")).toEqual([]);
    expect(c.exactOrigins("https://a.example.com,https://b.example.com,https://c.example.com,https://d.example.com,https://e.example.com")).toHaveLength(c.APPS_HOST.maxOrigins);
  });

  it("a network address is an origin only in local demo mode, and a public http address never is", () => {
    const lan = "http://192.168.1.20:3000, http://rahuls-mac.local:3000";
    expect(c.exactOrigins(lan)).toEqual([]);
    expect(c.exactOrigins(lan, "strict")).toEqual([]);
    expect(c.exactOrigins(lan, "local_demo")).toEqual(["http://192.168.1.20:3000", "http://rahuls-mac.local:3000"]);
    expect(c.exactOrigins("http://rms.example.com, http://8.8.8.8:3000, http://*.local:3000", "local_demo")).toEqual([]);
  });

  it("a frame address makes an app grant that parses", () => {
    const url = c.appFrameUrl("http://localhost:3002", app, ver);
    expect(url).toBe(`http://localhost:3002/a/${app}/${ver}/`);
    expect(c.parseAppsHostPath(new URL(url).pathname)).toEqual({ appId: app, versionId: ver, path: "index.html" });
    expect(() => c.appFrameUrl("http://localhost:3002/x", app, ver)).toThrow();
    expect(() => c.appFrameUrl("*", app, ver)).toThrow();
    expect(() => c.appFrameUrl("http://rms.example.com", app, ver)).toThrow();
    expect(() => c.appFrameUrl("http://localhost:3002", "app_x" as c.AppId, ver)).toThrow();
    const context = {
      app: { id: app, name: "Money" }, env: "live", user: { name: "Asha", role: "staff" },
      restaurant: { name: "Marigold Kitchen", brandColour: null }, locations: [], currency: "USD", locale: "en-US",
    };
    const grant = { kind: "app", appId: app, appName: "Money", versionId: ver, url, frameOrigin: "http://localhost:3002", token: "t".repeat(40), expiresAt: now, context };
    ok(c.AppGrant.safeParse(grant));
    ok(c.AppGrant.safeParse({ ...grant, url: `http://192.168.1.20:3002/a/${app}/${ver}/`, frameOrigin: "http://192.168.1.20:3002" }));
    no(c.AppGrant.safeParse({ ...grant, frameOrigin: "http://127.0.0.1:3002" })); // not the origin of its address
    no(c.AppGrant.safeParse({ ...grant, url: `http://rms.example.com/a/${app}/${ver}/`, frameOrigin: "http://rms.example.com" }));
    no(c.AppGrant.safeParse({ ...grant, url: `http://8.8.8.8:3002/a/${app}/${ver}/`, frameOrigin: "http://8.8.8.8:3002" }));
    no(c.AppGrant.safeParse({ ...grant, versionId: `run_${hex}` }));
  });
});

describe("local and phone demo origins (ADR 0012)", () => {
  const LAPTOP = { shell: "http://127.0.0.1:3000", apps: "http://localhost:3002" };
  const PHONE = { shell: "http://rahuls-mac.local:3000", apps: "http://192.168.1.20:3002" };
  const can = (frameOrigin: string, shellOrigin: string, appsOrigins: string[], mode: c.OriginMode = "local_demo") => c.canFrameApp({ frameOrigin, shellOrigin, appsOrigins, mode });

  it("plain http is only ever for this machine or this network", () => {
    for (const good of [
      "http://localhost:3002", "http://127.0.0.1:3000", "http://192.168.1.20:3002", "http://192.168.0.1", "http://10.0.0.7:3000", "http://172.16.0.1:3000", "http://172.31.255.255:3000",
      "http://rahuls-mac.local:3000", "http://mac.local",
    ]) ok(c.LocalOrigin.safeParse(good));
    for (const bad of [
      "http://rms.example.com", "http://8.8.8.8:3000", "http://172.15.0.1:3000", "http://172.32.0.1:3000", "http://192.169.1.1:3000", "http://11.0.0.1:3000", "http://169.254.1.1:3000",
      "http://127.0.0.2:3000", "http://0.0.0.0:3000", "http://192.168.1.256:3000", "http://192.168.1:3000", "http://192.168.01.1:3000", "http://192.168.1.20.evil.test:3000",
      "http://a.b.local:3000", "http://local:3000", "http://mac.local.evil.test:3000", "http://evil.test/rahuls-mac.local", "http://MAC.local:3000", "http://mac.local:3000/", "http://*.local:3000",
      "https://192.168.1.20:3002", "http://[::1]:3000", "http://localhost.evil.test", "http://user@192.168.1.20:3000", "", "*", "null",
    ]) {
      no(c.LocalOrigin.safeParse(bad));
    }
    // The strict rule did not move: a network address is still not an Origin.
    no(c.Origin.safeParse(PHONE.shell));
    no(c.Origin.safeParse(PHONE.apps));
  });

  it("the mode is local demo only when the flag is exactly 1 and the server is not a deployed one", () => {
    expect(c.originMode({})).toBe("strict");
    expect(c.originMode({ RMS_LOCAL_DEMO: "1" })).toBe("local_demo");
    for (const flag of ["0", "true", "yes", "", " 1", "01"]) expect(c.originMode({ RMS_LOCAL_DEMO: flag }), flag).toBe("strict");
    expect(c.originMode({ RMS_LOCAL_DEMO: "1", VERCEL: "1" })).toBe("strict");
    expect(c.originMode({ RMS_LOCAL_DEMO: "1", RAILWAY_ENVIRONMENT: "production" })).toBe("strict");
    expect(c.originAllowed(PHONE.shell, "strict")).toBe(false);
    expect(c.originAllowed(PHONE.shell, "local_demo")).toBe(true);
    expect(c.originAllowed("https://rms.example.com", "strict")).toBe(true);
    expect(c.originAllowed("http://rms.example.com", "local_demo")).toBe(false);
  });

  it("the laptop pair and the phone pair may frame a published mini-app, either way round", () => {
    expect(can(LAPTOP.apps, LAPTOP.shell, [LAPTOP.apps])).toBe(true);
    expect(can(PHONE.apps, PHONE.shell, [PHONE.apps])).toBe(true);
    expect(can("http://127.0.0.1:3002", "http://localhost:3000", ["http://127.0.0.1:3002"])).toBe(true);
    expect(can("http://rahuls-mac.local:3002", "http://192.168.1.20:3000", ["http://rahuls-mac.local:3002"])).toBe(true);
    // The laptop pair needs no switch: both are loopback origins, which the strict rule already knows.
    expect(can(LAPTOP.apps, LAPTOP.shell, [LAPTOP.apps], "strict")).toBe(true);
    expect(can("https://rms-apps.example.net", "https://rms.example.com", ["https://rms-apps.example.net"], "strict")).toBe(true);
  });

  it("the same host on another port is never enough, in any mode", () => {
    for (const mode of ["strict", "local_demo"] as const) {
      expect(can("http://127.0.0.1:3002", "http://127.0.0.1:3000", ["http://127.0.0.1:3002"], mode)).toBe(false);
      expect(can("http://localhost:3002", "http://localhost:3000", ["http://localhost:3002"], mode)).toBe(false);
      expect(can("http://192.168.1.20:3002", "http://192.168.1.20:3000", ["http://192.168.1.20:3002"], mode)).toBe(false);
      expect(can("http://rahuls-mac.local:3002", "http://rahuls-mac.local:3000", ["http://rahuls-mac.local:3002"], mode)).toBe(false);
      expect(can("https://apps.rms.example.com", "https://rms.example.com", ["https://apps.rms.example.com"], mode)).toBe(false);
      expect(can("https://rms.example.com", "https://apps.rms.example.com", ["https://rms.example.com"], mode)).toBe(false);
    }
  });

  it("the phone pair is refused unless local demo mode is on", () => {
    expect(can(PHONE.apps, PHONE.shell, [PHONE.apps], "strict")).toBe(false);
    expect(can(PHONE.apps, LAPTOP.shell, [PHONE.apps], "strict")).toBe(false);
    expect(can(LAPTOP.apps, PHONE.shell, [LAPTOP.apps], "strict")).toBe(false);
  });

  it("the frame must be exactly a configured apps host, and never a public http host", () => {
    expect(can(PHONE.apps, PHONE.shell, [])).toBe(false);
    expect(can(PHONE.apps, PHONE.shell, [LAPTOP.apps])).toBe(false);
    expect(can("http://192.168.1.66:3002", PHONE.shell, [PHONE.apps])).toBe(false);
    expect(can("http://192.168.1.20:3003", PHONE.shell, [PHONE.apps])).toBe(false);
    expect(can("http://evil.test", PHONE.shell, ["http://evil.test"])).toBe(false);
    expect(can("http://8.8.8.8:3002", PHONE.shell, ["http://8.8.8.8:3002"])).toBe(false);
    expect(can("*", PHONE.shell, ["*"])).toBe(false);
    expect(can(PHONE.apps, "null", [PHONE.apps])).toBe(false);
  });

  it("a shell on https never frames plain http", () => {
    expect(can(LAPTOP.apps, "https://rms.example.com", [LAPTOP.apps])).toBe(false);
    expect(can(PHONE.apps, "https://rms.example.com", [PHONE.apps])).toBe(false);
  });

  it("build previews did not loosen: the strict rule and the localhost ban are as they were", () => {
    expect(c.isSeparateSite(PHONE.apps, PHONE.shell)).toBe(false);
    expect(c.isSeparateSite("http://192.168.1.20:5173", "http://127.0.0.1:3000")).toBe(false);
    expect(c.isSeparateSite("http://127.0.0.1:5173", "http://127.0.0.1:3000")).toBe(false);
    expect(c.isSeparateSite("https://sb-abc123.vercel.run", "http://127.0.0.1:3000")).toBe(true);
    const context = {
      app: { id: app, name: "Money" }, env: "draft", user: { name: "Asha", role: "owner" },
      restaurant: { name: "Marigold Kitchen", brandColour: null }, locations: [], currency: "USD", locale: "en-US",
    };
    const preview = { kind: "preview", appId: app, appName: "Money", runId: `run_${hex}`, url: "https://sb-abc123.vercel.run/", frameOrigin: "https://sb-abc123.vercel.run", token: "t".repeat(40), expiresAt: now, context };
    ok(c.PreviewGrant.safeParse(preview));
    no(c.PreviewGrant.safeParse({ ...preview, url: "http://localhost:5173/", frameOrigin: "http://localhost:5173" }));
    no(c.PreviewGrant.safeParse({ ...preview, url: "http://192.168.1.20:5173/", frameOrigin: "http://192.168.1.20:5173" }));
    no(c.PreviewGrant.safeParse({ ...preview, url: "http://rahuls-mac.local:5173/", frameOrigin: "http://rahuls-mac.local:5173" }));
  });

  it("a message is compared with a well-formed origin, exactly", () => {
    const frame = {};
    expect(c.fromExpectedOrigin({ origin: PHONE.apps, source: frame }, PHONE.apps, frame)).toBe(true);
    expect(c.fromExpectedOrigin({ origin: "http://192.168.1.20:3003", source: frame }, PHONE.apps, frame)).toBe(false);
    expect(c.fromExpectedOrigin({ origin: PHONE.apps, source: {} }, PHONE.apps, frame)).toBe(false);
    expect(c.fromExpectedOrigin({ origin: "http://evil.test", source: frame }, "http://evil.test", frame)).toBe(false);
    expect(c.fromExpectedOrigin({ origin: "*", source: frame }, "*", frame)).toBe(false);
  });

  it("the apps host may name a network shell in its policy, once the list was made for the mode", () => {
    expect(c.appsHostPolicy(c.exactOrigins(PHONE.shell, "local_demo"))).toContain(`frame-ancestors ${PHONE.shell}`);
    expect(c.appsHostPolicy(c.exactOrigins(PHONE.shell, "strict"))).toContain("frame-ancestors 'none'");
    expect(c.appsHostPolicy(["http://rms.example.com"])).toContain("frame-ancestors 'none'");
  });
});

describe("the checks a publish runs", () => {
  it("are the build checks, wrapped by source and bundle, in order", () => {
    expect(c.PUBLISH_CHECKS).toEqual(["source", ...c.CheckName.options, "bundle"]);
    for (const s of c.SAFETY_CHECKS) expect(c.PUBLISH_CHECKS).toContain(s);
  });

  it("the owner hears one of two plain sentences, and never a check name", () => {
    expect(c.checkWords(["types"])).toBe(c.CHECK_WORDS.broken);
    expect(c.checkWords(["build", "bundle"])).toBe(c.CHECK_WORDS.broken);
    expect(c.checkWords(["types", "safety"])).toBe(c.CHECK_WORDS.safety);
    expect(c.checkWords(["scrub"])).toBe(c.CHECK_WORDS.safety);
    const ownerText = [...Object.values(c.CHECK_WORDS), ...c.PUBLISH_STEPS.map((s) => s.label)].join(" ");
    expect(ownerText).not.toMatch(/\bT[0-3]\b|_|\b(locked|deps|imports|manifest|bundle|sandbox|schema|token|origin|sql)\b/i);
  });

  it("the steps have one id each, in the listed order", () => {
    expect(c.PUBLISH_STEPS.map((s) => s.id)).toEqual(c.PublishStepId.options);
  });
});

describe("changes: owner words and maintainer words stay apart", () => {
  const notice = { id: `chg_${hex}`, summary: "Published a mini-app for your team", status: "needs_your_ok", at: now, appName: "Money", detail: ["It will read your sales days"], canConfirm: true };

  it("an owner's change has no room for a tier, a signal or who decided", () => {
    ok(c.OwnerChangeItem.safeParse(notice));
    for (const key of ["tier", "signals", "decision", "decidedBy", "staffId", "summaryForMaintainers", "held", "orgId", "origin"]) {
      no(c.OwnerChangeItem.safeParse({ ...notice, [key]: "T3" }));
    }
  });

  it("a held action names only what it holds", () => {
    ok(c.HeldAction.safeParse({ kind: "list_listing", listingId: lst, number: 1 }));
    ok(c.HeldAction.safeParse({ kind: "publish_app", appId: app, versionId: ver }));
    no(c.HeldAction.safeParse({ kind: "list_listing", listingId: lst, number: 1, orgId: org }));
    no(c.HeldAction.safeParse({ kind: "list_listing", listingId: lst, number: 0 }));
    no(c.HeldAction.safeParse({ kind: "list_listing", listingId: app, number: 1 }));
    no(c.HeldAction.safeParse({ kind: "run_sql", sql: "select 1" }));
    no(c.HeldAction.safeParse({ kind: "publish_app", appId: app, versionId: ver, status: "published" }));
  });

  it("a detector's answer cannot list a signal twice, and evidence has safe defaults", () => {
    ok(c.DetectedChange.safeParse({ signals: ["first_publish"], tier: "T2", facts: [] }));
    no(c.DetectedChange.safeParse({ signals: ["first_publish", "first_publish"], tier: "T2", facts: [] }));
    no(c.DetectedChange.safeParse({ signals: ["made_up"], tier: "T0", facts: [] }));
    const parsed = c.ChangeEvidence.parse({ origin: "publish" });
    expect(parsed).toMatchObject({ modelChanges: [], sensitiveModels: [], failedChecks: [], firstPublish: false, publicShare: false });
  });
});

describe("the Marketplace never says who made a listing", () => {
  const listing = { id: lst, title: "Money at a glance", summary: "Sales, costs and what is left.", category: "money", requiredModels: ["sales_day"], requiredConnections: ["demo_pos"], installCount: 2 };
  const detail = {
    ...listing,
    whatItDoes: ["Shows this week's sales"],
    needs: [{ model: "sales_day", name: "Sales days", access: "read", have: true }],
    connections: [{ id: "demo_pos", name: "Demo POS", connected: false }],
    installed: false,
    confirmText: "This adds Money at a glance to your RMS menu. It will use your own sales days.",
  };
  const PUBLISHER_KEYS = ["publisher", "publisherOrgId", "publisher_org_id", "orgId", "org_id", "org", "restaurant", "restaurantName", "sourceAppId", "source_app_id", "appId", "madeBy", "owner", "embedding"];

  it("a listing, its detail, a card and a recommendation are valid to begin with", () => {
    ok(c.PublicListing.safeParse(listing));
    ok(c.PublicListingDetail.safeParse(detail));
    ok(c.MarketplaceCard.safeParse({ listing, installed: false }));
    ok(c.Recommendation.safeParse({ listing, reasons: ["Uses the sales you already bring in"] }));
    ok(c.MarketplaceHome.safeParse({ recommended: [{ listing, reasons: ["Uses the sales you already bring in"] }], listings: [{ listing, installed: false }] }));
  });

  it.each(PUBLISHER_KEYS)("no shape another restaurant receives accepts %s, at any level", (key) => {
    const bad = { ...listing, [key]: org };
    no(c.PublicListing.safeParse(bad));
    no(c.PublicListingDetail.safeParse({ ...detail, [key]: org }));
    no(c.PublicListingDetail.safeParse({ ...detail, needs: [{ ...detail.needs[0], [key]: org }] }));
    no(c.PublicListingDetail.safeParse({ ...detail, connections: [{ ...detail.connections[0], [key]: org }] }));
    no(c.MarketplaceCard.safeParse({ listing: bad, installed: false }));
    no(c.MarketplaceCard.safeParse({ listing, installed: false, [key]: org }));
    no(c.Recommendation.safeParse({ listing: bad, reasons: ["x"] }));
    no(c.Recommendation.safeParse({ listing, reasons: ["x"], [key]: org }));
    no(c.MarketplaceHome.safeParse({ recommended: [], listings: [{ listing: bad, installed: false }] }));
    no(c.MarketplaceHome.safeParse({ recommended: [], listings: [], [key]: org }));
  });

  it("a recommendation always has a reason, and never a score", () => {
    no(c.Recommendation.safeParse({ listing, reasons: [] }));
    no(c.Recommendation.safeParse({ listing, reasons: ["x"], score: 0.9 }));
    expect(c.RECOMMENDATION_RULES.minSimilarInstalls).toBeGreaterThanOrEqual(3);
  });

  it("a scrub report cannot say data or memory was kept", () => {
    const report = { format: 1, removed: { data: true, connections: 0, jobsAndTools: 0, memory: true }, scannedFiles: 3, findings: [], verdict: "clean" };
    ok(c.ScrubReport.safeParse(report));
    no(c.ScrubReport.safeParse({ ...report, removed: { ...report.removed, data: false } }));
    no(c.ScrubReport.safeParse({ ...report, removed: { ...report.removed, memory: false } }));
    for (const rule of c.SCRUB_BLOCKS) expect(c.ScrubRule.options).toContain(rule);
  });

  it("an install maps a table to a plain table name only", () => {
    ok(c.ModelMapping.safeParse({ sales_day: { to: "sales_day", how: "already_had" } }));
    no(c.ModelMapping.safeParse({ sales_day: { to: "o_aaaaaaaaaaaa.sales_day", how: "created" } }));
    no(c.ModelMapping.safeParse({ sales_day: { to: "sales_day", how: "created", schema: "o_aaaaaaaaaaaa" } }));
    no(c.ModelMapping.safeParse({ "Sales Day": { to: "sales_day", how: "created" } }));
  });
});

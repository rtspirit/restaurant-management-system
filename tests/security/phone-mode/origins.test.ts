// Phone mode (ADR 0010): which browser origins the API answers.
//
// Attacks run against the REAL API app, in process, with phone mode's settings: the laptop's web
// app in WEB_URL, the console in ADMIN_URL and the phone's address in WEB_EXTRA_ORIGINS.
// What must hold: a listed origin is answered by exact match, nothing else is, the caller's own
// Origin is never echoed back, cookies are never allowed, and a bad setting closes the door
// instead of opening it.
import { Hono } from "hono";
import { cors } from "hono/cors";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import api from "../../../apps/api/src/index.js";

const LAPTOP = "http://127.0.0.1:3000";
const CONSOLE = "http://127.0.0.1:3001";
const PHONE_IP = "http://192.168.1.5:3000";
const PHONE_NAME = "http://demo-mac.local:3000";

const KEYS = ["WEB_URL", "ADMIN_URL", "WEB_EXTRA_ORIGINS"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const settings = (values: Partial<Record<(typeof KEYS)[number], string>>) => {
  for (const k of KEYS) {
    if (values[k] === undefined) delete process.env[k];
    else process.env[k] = values[k];
  }
};
const phoneMode = () => settings({ WEB_URL: LAPTOP, ADMIN_URL: CONSOLE, WEB_EXTRA_ORIGINS: `${PHONE_IP},${PHONE_NAME}` });
beforeEach(phoneMode);
afterAll(() => settings(saved));

/** Routes the web app may call from a browser, the console's routes, and routes no browser may call. */
const WEB_PATHS = ["/auth/me", "/auth/onboarding", "/data/v1/catalog", "/agent/v1/runs", "/ask/v1/questions", "/connections/v1/connections", "/memory/v1/profile"];
const CONSOLE_PATHS = ["/admin/v1/overview"];
const NO_BROWSER_PATHS = ["/health", "/mcp/demo-pos", "/no-such-route"];

/** Look-alikes of the two phone addresses and of the laptop address. None is on the list. */
const HOSTILE = [
  "http://evil.test",
  "http://192.168.1.5.evil.test",
  "http://192.168.1.5.evil.test:3000",
  "http://192.168.1.5:3000.evil.test",
  "http://192.168.1.5:3000@evil.test",
  "http://user@192.168.1.5:3000",
  "http://user:pass@192.168.1.5:3000",
  "http://192.168.1.5.:3000", // trailing dot
  "HTTP://192.168.1.5:3000", // upper-case scheme
  "http://192.168.1.5:3001", // another port
  "http://192.168.1.5:03000",
  "http://192.168.1.5", // no port
  "https://192.168.1.5:3000", // another scheme
  "http://192.168.1.50:3000",
  "http://192.168.1.6:3000", // another device on the same network
  "http://192.168.001.005:3000",
  "http://3232235781:3000", // the same address written as one number
  "http://0xc0.0xa8.1.5:3000",
  "http://[::ffff:192.168.1.5]:3000",
  "http://192.168.1.5:3000/",
  "http://192.168.1.5:3000/x",
  "http://192.168.1.5:3000?x",
  "http://192.168.1.5:3000#x",
  "http://192.168.1.5:3000,http://evil.test",
  "http://192.168.1.5:3000, http://evil.test",
  "http://evil.test, http://192.168.1.5:3000",
  "http://DEMO-MAC.local:3000", // upper-case name
  "http://demo-mac.local.:3000",
  "http://demo-mac.local:3001",
  "http://demo-mac.local",
  "http://demo-mac.local.evil.test:3000",
  "http://evil-demo-mac.local:3000",
  "http://demo-mac.localhost:3000",
  "http://localhost:3000", // not the same origin as 127.0.0.1
  "http://127.0.0.1:3000.evil.test",
  "http://127.0.0.1.evil.test:3000",
  "http://0.0.0.0:3000",
  "null",
  "*",
  "file://",
  "about:blank",
  "undefined",
];

type AppLike = { request: (path: string, init?: RequestInit) => Response | Promise<Response> };
type Seen = { grants: boolean; credentials: boolean; reflected: boolean; allowOrigin: string | null };

/** A preflight, a GET and a POST from one origin. Says whether any answer lets that origin in. */
const knock = async (app: AppLike, path: string, origin: string): Promise<Seen> => {
  const answers = [
    await app.request(path, { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type, cookie" } }),
    await app.request(path, { method: "GET", headers: { origin, cookie: "sb-127-auth-token=x" } }),
    await app.request(path, { method: "POST", headers: { origin, "content-type": "text/plain" }, body: "{}" }),
  ];
  const seen: Seen = { grants: false, credentials: false, reflected: false, allowOrigin: null };
  for (const res of answers) {
    const allow = res.headers.get("access-control-allow-origin");
    if (allow !== null) {
      seen.grants = true;
      seen.allowOrigin = allow;
    }
    if (res.headers.get("access-control-allow-credentials") !== null) seen.credentials = true;
    // The caller's own words must not come back in any header (a reflected origin, a redirect, a cookie).
    res.headers.forEach((value, name) => {
      if (name !== "vary" && origin.length > 4 && value.includes(origin)) seen.reflected = true;
    });
    if (res.headers.get("set-cookie") !== null) seen.credentials = true;
  }
  return seen;
};

/** Every hostile origin that got anything from any of the paths. Empty means all were refused. */
const letIn = async (app: AppLike, paths: string[], origins: string[]): Promise<string[]> => {
  const out: string[] = [];
  for (const path of paths) {
    for (const origin of origins) {
      const seen = await knock(app, path, origin);
      if (seen.grants || seen.credentials || seen.reflected) out.push(`${path} <- ${JSON.stringify(origin)}`);
    }
  }
  return out;
};

describe("these attacks can fail: a careless origin rule is caught", () => {
  it("an API that echoes the caller's origin is caught for every hostile origin", async () => {
    const careless = new Hono().use("*", cors({ origin: (o) => o, credentials: true })).get("/x", (c) => c.text("ok"));
    const caught = await letIn(careless, ["/x"], HOSTILE);
    expect(caught).toHaveLength(HOSTILE.length);
  });

  it("an API that matches the start of the origin is caught by the look-alikes", async () => {
    const careless = new Hono().use("*", cors({ origin: (o) => (o.startsWith(PHONE_IP) || o.toLowerCase() === PHONE_NAME ? o : null) })).get("/x", (c) => c.text("ok"));
    const caught = await letIn(careless, ["/x"], HOSTILE);
    expect(caught).toContain(`/x <- "http://192.168.1.5:3000.evil.test"`);
    expect(caught).toContain(`/x <- "http://192.168.1.5:3000@evil.test"`);
    expect(caught).toContain(`/x <- "http://DEMO-MAC.local:3000"`);
  });
});

describe("phone mode: the allowed origins are an exact list", () => {
  it("the laptop and both phone addresses are answered on the web app's routes, with their own exact origin", async () => {
    for (const path of WEB_PATHS) {
      for (const origin of [LAPTOP, PHONE_IP, PHONE_NAME]) {
        const seen = await knock(api, path, origin);
        expect(seen.allowOrigin, `${path} <- ${origin}`).toBe(origin);
      }
    }
  });

  it("no look-alike origin is answered on any route", async () => {
    expect(await letIn(api, [...WEB_PATHS, ...CONSOLE_PATHS, ...NO_BROWSER_PATHS], HOSTILE)).toEqual([]);
  }, 60_000);

  it("cookies are never allowed, not even for a listed origin", async () => {
    for (const path of [...WEB_PATHS, ...CONSOLE_PATHS]) {
      for (const origin of [LAPTOP, PHONE_IP, PHONE_NAME, CONSOLE]) {
        const seen = await knock(api, path, origin);
        expect(seen.credentials, `${path} <- ${origin}`).toBe(false);
      }
    }
  });

  it("the phone's address does not open the console's routes, and the console's address does not open the web app's", async () => {
    expect(await letIn(api, CONSOLE_PATHS, [PHONE_IP, PHONE_NAME, LAPTOP])).toEqual([]);
    expect(await letIn(api, WEB_PATHS, [CONSOLE])).toEqual([]);
    expect((await knock(api, "/admin/v1/overview", CONSOLE)).allowOrigin).toBe(CONSOLE);
  });

  it("routes no browser may call answer no origin at all, listed or not", async () => {
    expect(await letIn(api, NO_BROWSER_PATHS, [LAPTOP, PHONE_IP, PHONE_NAME, CONSOLE])).toEqual([]);
  });

  it("a request with no Origin is given no allow header", async () => {
    for (const path of WEB_PATHS) {
      const res = await api.request(path, { method: "OPTIONS", headers: { "access-control-request-method": "GET" } });
      expect(res.headers.get("access-control-allow-origin"), path).toBeNull();
    }
  });

  it("without phone mode, the phone's address is refused", async () => {
    settings({ WEB_URL: LAPTOP, ADMIN_URL: CONSOLE });
    expect(await letIn(api, WEB_PATHS, [PHONE_IP, PHONE_NAME])).toEqual([]);
    expect((await knock(api, "/auth/me", LAPTOP)).allowOrigin).toBe(LAPTOP);
  });
});

describe("phone mode: a bad setting closes the door", () => {
  /** Whatever the setting says, none of these may ever be let in. */
  const NEVER = [...HOSTILE, "http://x.local:3000", "http://anything.local:3000", "http://10.0.0.9:3000"];

  const BAD_EXTRA = [
    "*",
    "null",
    "http://*",
    "http://*:3000",
    "http://*.local:3000",
    "*.local",
    "http://",
    "http://:3000",
    "192.168.1.5:3000", // no scheme
    "//192.168.1.5:3000",
    "ftp://192.168.1.5:3000",
    "file:///",
    "about:blank",
    "javascript:alert(1)",
    "data:text/html,x",
    "http://evil.test/path", // a path is refused, so the host is not listed either
    "http://evil.test?x=1",
    "http://evil.test#x",
    "http://user@evil.test",
    "http://user:pass@evil.test",
    "http://192.168.1.5:3000@evil.test",
    "true",
    "1",
    "undefined",
    " ",
    ",",
    ",,,*,,null,,",
    "http://evil.test http://192.168.1.5:3000",
    `http://${"a".repeat(300)}.test`,
  ];

  for (const bad of BAD_EXTRA) {
    it(`WEB_EXTRA_ORIGINS=${JSON.stringify(bad.length > 40 ? `${bad.slice(0, 40)}...` : bad)} lets nobody new in`, async () => {
      settings({ WEB_URL: LAPTOP, ADMIN_URL: CONSOLE, WEB_EXTRA_ORIGINS: bad });
      expect(await letIn(api, ["/auth/me", "/data/v1/catalog", "/admin/v1/overview"], [...NEVER, bad, PHONE_IP, PHONE_NAME])).toEqual([]);
      // The web app itself still works.
      expect((await knock(api, "/auth/me", LAPTOP)).allowOrigin).toBe(LAPTOP);
    });
  }

  it("a long list is cut short: an origin past the fourth extra entry is refused", async () => {
    const many = Array.from({ length: 12 }, (_, i) => `http://10.0.0.${i + 1}:3000`);
    settings({ WEB_URL: LAPTOP, ADMIN_URL: CONSOLE, WEB_EXTRA_ORIGINS: many.join(",") });
    expect(await letIn(api, ["/auth/me"], many.slice(4))).toEqual([]);
  });

  for (const bad of [undefined, "", "*", "null", "not an address", "http://", "ftp://127.0.0.1:3000", "http://*:3000", "http://user:pass@127.0.0.1:3000", "http://127.0.0.1:3000/path", "http://127.0.0.1:3000?x=1"]) {
    it(`WEB_URL=${JSON.stringify(bad)} and no extra origins lets nobody in`, async () => {
      settings({ ADMIN_URL: CONSOLE, ...(bad === undefined ? {} : { WEB_URL: bad }) });
      expect(await letIn(api, WEB_PATHS, [...NEVER, LAPTOP, PHONE_IP, PHONE_NAME, ...(bad ? [bad] : [])])).toEqual([]);
    });
  }

  it("a bad WEB_URL does not stop the listed phone address, and still lets no look-alike in", async () => {
    settings({ WEB_URL: "*", ADMIN_URL: CONSOLE, WEB_EXTRA_ORIGINS: PHONE_IP });
    expect((await knock(api, "/auth/me", PHONE_IP)).allowOrigin).toBe(PHONE_IP);
    expect(await letIn(api, ["/auth/me"], [...NEVER, LAPTOP])).toEqual([]);
  });
});

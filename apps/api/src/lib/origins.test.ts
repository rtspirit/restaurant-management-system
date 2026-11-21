import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createAuthRoutes } from "../routes/auth.js";
import { webCors } from "./http.js";
import { allowWebOrigin, exactOrigin, webOrigins } from "./origins.js";

const LAPTOP = "http://127.0.0.1:3000";
const PHONE = "http://192.168.1.5:3000";
const saved = { web: process.env.WEB_URL, extra: process.env.WEB_EXTRA_ORIGINS };
afterEach(() => {
  for (const [k, v] of [["WEB_URL", saved.web], ["WEB_EXTRA_ORIGINS", saved.extra]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Look-alikes and tricks that must never be allowed, whatever the list says. */
const REFUSED = [
  "http://evil.example",
  "http://192.168.1.5.evil.test",
  "http://192.168.1.5.evil.test:3000",
  "http://192.168.1.5:3001", // same host, different port
  "http://192.168.1.5", // same host, no port
  "https://192.168.1.5:3000", // different scheme
  "http://192.168.1.50:3000",
  "http://evil.test#@192.168.1.5:3000",
  "null",
  "",
  "*",
];

describe("allowed browser origins", () => {
  it("takes only plain http(s) origins from configuration", () => {
    expect(exactOrigin("http://192.168.1.5:3000/")).toBe(PHONE);
    expect(exactOrigin(" http://Mac.local:3000 ")).toBe("http://mac.local:3000");
    for (const bad of ["*", "http://*.local:3000", "http://u:p@192.168.1.5:3000", "http://192.168.1.5:3000/app", "http://192.168.1.5:3000?x=1", "ftp://192.168.1.5", "null", "not an address", ""]) {
      expect(exactOrigin(bad), bad).toBeNull();
    }
  });

  it("is WEB_URL alone when no extra origins are set", () => {
    expect(webOrigins({ WEB_URL: LAPTOP })).toEqual([LAPTOP]);
    expect(webOrigins({})).toEqual([]);
  });

  it("adds the listed extra origins, skips bad entries, and caps the list", () => {
    expect(webOrigins({ WEB_URL: LAPTOP, WEB_EXTRA_ORIGINS: `${PHONE}, *, http://u:p@x.test, ${PHONE}` })).toEqual([LAPTOP, PHONE]);
    const many = Array.from({ length: 10 }, (_, i) => `http://10.0.0.${i}:3000`).join(",");
    expect(webOrigins({ WEB_URL: LAPTOP, WEB_EXTRA_ORIGINS: many })).toHaveLength(5);
  });

  it("allows a listed origin by exact match and refuses everything else", () => {
    const env = { WEB_URL: LAPTOP, WEB_EXTRA_ORIGINS: PHONE };
    expect(allowWebOrigin(LAPTOP, env)).toBe(LAPTOP);
    expect(allowWebOrigin(PHONE, env)).toBe(PHONE);
    expect(allowWebOrigin(undefined, env)).toBeNull();
    for (const origin of REFUSED) expect(allowWebOrigin(origin, env), origin).toBeNull();
  });

  it("refuses an unlisted origin even when it is on the same network", () => {
    expect(allowWebOrigin("http://192.168.1.6:3000", { WEB_URL: LAPTOP, WEB_EXTRA_ORIGINS: PHONE })).toBeNull();
    expect(allowWebOrigin(PHONE, { WEB_URL: LAPTOP })).toBeNull();
  });
});

describe("the cross-origin rules that use the list", () => {
  const routes = () => {
    const t = new Hono();
    t.use("/data/*", webCors());
    t.get("/data/x", (c) => c.json({ ok: true }));
    // Not called: only the cross-origin layer in front of the auth routes is exercised.
    t.route("/auth", createAuthRoutes({ createDemoRestaurant: undefined }));
    return t;
  };

  for (const path of ["/data/x", "/auth/me"]) {
    it(`${path}: answers the phone origin, never a look-alike, never with cookies`, async () => {
      process.env.WEB_URL = LAPTOP;
      process.env.WEB_EXTRA_ORIGINS = PHONE;
      for (const origin of [LAPTOP, PHONE]) {
        const pre = await routes().request(path, { method: "OPTIONS", headers: { origin, "access-control-request-method": "GET", "access-control-request-headers": "authorization" } });
        expect(pre.headers.get("access-control-allow-origin"), origin).toBe(origin);
        expect(pre.headers.get("access-control-allow-credentials")).toBeNull();
      }
      for (const origin of REFUSED.filter((o) => o !== "")) {
        const pre = await routes().request(path, { method: "OPTIONS", headers: { origin, "access-control-request-method": "GET", "access-control-request-headers": "authorization" } });
        expect(pre.headers.get("access-control-allow-origin"), origin).toBeNull();
      }
    });
  }

  it("without phone mode, the phone origin is refused", async () => {
    process.env.WEB_URL = LAPTOP;
    delete process.env.WEB_EXTRA_ORIGINS;
    const pre = await routes().request("/data/x", { method: "OPTIONS", headers: { origin: PHONE, "access-control-request-method": "GET" } });
    expect(pre.headers.get("access-control-allow-origin")).toBeNull();
  });
});

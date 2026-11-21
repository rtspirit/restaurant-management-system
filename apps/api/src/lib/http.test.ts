import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import app from "../index.js";
import { apiError, safeHeaders, webCors, webOrigin } from "./http.js";

const WEB = "http://web.w2.rms.test:3000";
const saved = process.env.WEB_URL;
afterEach(() => {
  if (saved === undefined) delete process.env.WEB_URL;
  else process.env.WEB_URL = saved;
});

const tiny = () => {
  const t = new Hono();
  t.use("*", webCors());
  t.use("*", safeHeaders());
  t.get("/x", (c) => c.json({ ok: true }));
  t.get("/no", (c) => apiError(c, "forbidden", "You do not have access to this."));
  return t;
};

describe("shared HTTP helpers", () => {
  it("allows the web app's origin only, never a wildcard, never with cookies", async () => {
    process.env.WEB_URL = `${WEB}/`;
    expect(webOrigin()).toBe(WEB);
    const pre = await tiny().request("/x", { method: "OPTIONS", headers: { origin: WEB, "access-control-request-method": "POST", "access-control-request-headers": "authorization" } });
    expect(pre.headers.get("access-control-allow-origin")).toBe(WEB);
    expect(pre.headers.get("access-control-allow-credentials")).toBeNull();
    for (const origin of ["http://evil.example", `${WEB}.evil.example`, "null", "https://sb-abc123.vercel.run"]) {
      const res = await tiny().request("/x", { headers: { origin } });
      expect(res.headers.get("access-control-allow-origin"), origin).toBeNull();
    }
  });

  it("allows nobody when the web address is not set", async () => {
    delete process.env.WEB_URL;
    const res = await tiny().request("/x", { headers: { origin: WEB } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("sets the safe headers and the shared error envelope", async () => {
    const res = await tiny().request("/no");
    expect(res.status).toBe(403);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    const body = (await res.json()) as { error: { code: string; message: string; requestId: string } };
    expect(body.error.code).toBe("forbidden");
    expect(body.error.requestId.length).toBeGreaterThan(8);
  });
});

describe("the API app", () => {
  it("mounts the Wave 2 routes, and they give nothing away before they are built", async () => {
    for (const path of ["/agent/v1/runs", "/ask/v1/ask", "/connections/v1", "/memory/v1/duplicates", "/mcp/demo-pos"]) {
      const res = await app.request(path, { method: "POST", body: "{}" });
      expect([401, 404], path).toContain(res.status);
    }
  });

  it("lets the web app, and only it, call the Data API from a browser", async () => {
    process.env.WEB_URL = WEB;
    const pre = (origin: string) =>
      app.request("/data/v1/query", { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" } });
    expect((await pre(WEB)).headers.get("access-control-allow-origin")).toBe(WEB);
    expect((await pre("https://sb-abc123.vercel.run")).headers.get("access-control-allow-origin")).toBeNull();
    expect((await pre("http://evil.example")).headers.get("access-control-allow-origin")).toBeNull();
    // A call with no token is still refused, whatever the origin.
    const res = await app.request("/data/v1/query", { method: "POST", headers: { origin: WEB }, body: "{}" });
    expect(res.status).toBe(401);
  });
});

// The apps host's own rules, with a made-up store. No database, no network.
import { describe, expect, it } from "vitest";
import { APPS_HOST_HEADERS } from "@rms/contracts";
import { type ServedFile, createAppsHost } from "./app.js";

const hex = "a".repeat(32);
const app = `app_${hex}`;
const ver = `ver_${hex}`;
const SHELL = "http://127.0.0.1:3000";
const OWN = "localhost:3002";
const text = (s: string) => new TextEncoder().encode(s);

const make = (shellOrigins: string[] = [SHELL]) => {
  const asked: string[] = [];
  const files: Record<string, ServedFile> = {
    "index.html": { bytes: text("<!doctype html><title>Money</title>"), contentType: "text/html; charset=utf-8", sha256: "c".repeat(64), size: 35 },
    "assets/index-abc.js": { bytes: text("console.log(1)"), contentType: "text/javascript; charset=utf-8", sha256: "d".repeat(64), size: 14 },
  };
  const host = createAppsHost({
    read: async (appId, versionId, path) => {
      asked.push(`${appId}/${versionId}/${path}`);
      return appId === app && versionId === ver ? (files[path] ?? null) : null;
    },
    shellOrigins: () => shellOrigins,
    ownHosts: () => [OWN],
  });
  // Every request in these tests is addressed to the apps host's own name unless it says otherwise.
  const request = (path: string, init: RequestInit = {}) => host.request(path, { ...init, headers: { host: OWN, ...(init.headers as Record<string, string> | undefined) } });
  return { host: { request }, raw: host, asked };
};

const expectFixedHeaders = (res: Response, framers = SHELL) => {
  for (const [name, value] of Object.entries(APPS_HOST_HEADERS)) expect(res.headers.get(name), name).toBe(value);
  const policy = res.headers.get("content-security-policy") ?? "";
  expect(policy).toContain("connect-src 'none'");
  expect(policy).toContain("default-src 'none'");
  expect(policy).toContain(`frame-ancestors ${framers}`);
  expect(res.headers.get("set-cookie")).toBeNull();
  expect(res.headers.get("access-control-allow-origin")).toBeNull();
};

describe("the apps host", () => {
  it("serves a published file with its type and the full policy", async () => {
    const { host } = make();
    const res = await host.request(`/a/${app}/${ver}/assets/index-abc.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await res.text()).toBe("console.log(1)");
    expectFixedHeaders(res);
  });

  it("an address that ends at the version is the start page", async () => {
    const { host, asked } = make();
    for (const path of [`/a/${app}/${ver}/`, `/a/${app}/${ver}`]) {
      const res = await host.request(path);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("<title>Money</title>");
    }
    expect(asked).toEqual([`${app}/${ver}/index.html`, `${app}/${ver}/index.html`]);
  });

  it("answers not found, with the policy, for anything else, and never asks the store", async () => {
    const { host, asked } = make();
    for (const path of [
      "/", "/a", `/a/${app}`, `/a/${app}/x`, `/a/${app}/${ver}/../index.html`, `/a/${app}/${ver}/..%2f..%2fversions/1.bundle`, `/a/${app}/${ver}/%2e%2e/index.html`,
      `/a/${app}/${ver}//index.html`, `/a/${app}/${ver}/index.html.map`, `/a/${app}/${ver}/.env`, `/orgs/org_${hex}/apps/${app}/versions/1.bundle`, `/a/${app}/${ver}/orgs/x.js/..`,
    ]) {
      const res = await host.request(path);
      expect(res.status, path).toBe(404);
      expectFixedHeaders(res);
    }
    expect(asked).toEqual([]);
  });

  it("answers not found for a version the store does not hand over", async () => {
    const { host } = make();
    const res = await host.request(`/a/${app}/ver_${"b".repeat(32)}/index.html`);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not found.");
    expectFixedHeaders(res);
  });

  it("refuses every method but GET and HEAD, and reads no body", async () => {
    const { host, asked } = make();
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const res = await host.request(`/a/${app}/${ver}/index.html`, { method, ...(method === "OPTIONS" ? {} : { body: "x" }) });
      expect(res.status, method).toBe(405);
      expectFixedHeaders(res);
    }
    expect(asked).toEqual([]);
    const head = await host.request(`/a/${app}/${ver}/index.html`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("takes nothing from a cookie, a query or a header", async () => {
    const { host, asked } = make();
    const res = await host.request(`/a/${app}/${ver}/index.html?key=orgs/x&app=other`, { headers: { cookie: "session=abc", authorization: "Bearer abc", origin: "https://evil.test" } });
    expect(res.status).toBe(200);
    expect(asked).toEqual([`${app}/${ver}/index.html`]);
    expectFixedHeaders(res);
  });

  it("with no RMS address configured, nobody may frame a mini-app", async () => {
    for (const origins of [[], ["*"], ["not an origin"]]) {
      const { host } = make(origins);
      const res = await host.request(`/a/${app}/${ver}/index.html`);
      expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    }
  });

  it("answers only under its own name: under the web app's name, or any other, it serves nothing", async () => {
    const { raw, asked } = make();
    for (const other of ["127.0.0.1:3002", "127.0.0.1:3000", "localhost:3000", "localhost", "LOCALHOST:3002", "localhost:3002.evil.test", "evil.test", "192.168.1.20:3002", "rahuls-mac.local:3002", ""]) {
      for (const path of [`/a/${app}/${ver}/index.html`, "/health", "/"]) {
        const res = await raw.request(path, { headers: { host: other } });
        expect(res.status, `${other} ${path}`).toBe(421);
        expect(await res.text()).toBe("Not here.");
        expectFixedHeaders(res);
      }
    }
    expect(asked).toEqual([]);
  });

  it("with no name configured it answers nothing at all", async () => {
    const host = createAppsHost({ read: async () => null, shellOrigins: () => [SHELL], ownHosts: () => [] });
    expect((await host.request(`/a/${app}/${ver}/index.html`, { headers: { host: OWN } })).status).toBe(421);
    expect((await host.request("/health", { headers: { host: OWN } })).status).toBe(421);
  });

  it("a store failure is a plain refusal with the policy, and no detail", async () => {
    const host = createAppsHost({ read: async () => Promise.reject(new Error("password authentication failed for user rms_admin")), shellOrigins: () => [SHELL], ownHosts: () => [OWN] });
    const res = await host.request(`/a/${app}/${ver}/index.html`, { headers: { host: OWN } });
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("This is not available just now.");
    expectFixedHeaders(res);
  });
});

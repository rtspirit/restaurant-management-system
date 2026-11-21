// Which sites the web app may show inside a frame (`frame-src` in apps/web/next.config.ts).
import { describe, expect, it } from "vitest";
import config, { frameSources } from "../../next.config";

describe("the sites the web app may frame", () => {
  it("with nothing set, no site at all", () => {
    expect(frameSources({})).toBe("'none'");
    expect(frameSources({ PREVIEW_URL: "", APPS_URL: "  " })).toBe("'none'");
  });

  it("lists the preview host and the apps host as exact origins, and nothing else", () => {
    expect(frameSources({ PREVIEW_URL: "http://127.0.0.1:5173/", APPS_URL: "https://apps.rms.example/some/path?x=1" })).toBe("http://127.0.0.1:5173 https://apps.rms.example");
    expect(frameSources({ PREVIEW_URL: "http://127.0.0.1:5173" })).toBe("http://127.0.0.1:5173");
    expect(frameSources({ APPS_URL: "https://apps.rms.example" })).toBe("https://apps.rms.example");
  });

  it("takes several preview addresses, once each", () => {
    expect(frameSources({ PREVIEW_URL: "http://127.0.0.1:5173, http://127.0.0.1:5673 ,http://127.0.0.1:5173" })).toBe("http://127.0.0.1:5173 http://127.0.0.1:5673");
  });

  it("never lets a wildcard, a keyword or another scheme through", () => {
    for (const bad of ["*", "https://*.vercel.run", "https:", "'self'", "data:", "blob:", "javascript:alert(1)", "not an address", "'unsafe-inline'; script-src *"]) {
      expect(frameSources({ PREVIEW_URL: bad, APPS_URL: bad }), bad).toBe("'none'");
    }
    // A bad entry does not take the good one with it, and cannot add a second rule.
    expect(frameSources({ PREVIEW_URL: "https://*.vercel.run,http://127.0.0.1:5173", APPS_URL: "x; script-src *" })).toBe("http://127.0.0.1:5173");
  });

  it("is sent on every page, beside the rule that nobody may frame RMS", async () => {
    const rules = await config.headers?.();
    const policy = rules?.[0]?.headers.find((header) => header.key === "Content-Security-Policy")?.value ?? "";
    expect(rules?.[0]?.source).toBe("/:path*");
    expect(policy).toMatch(/^frame-ancestors 'none'; frame-src \S/);
  });
});

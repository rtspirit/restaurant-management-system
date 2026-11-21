// Which sites the web app may show inside a frame (`frame-src` in apps/web/next.config.ts).
import { describe, expect, it } from "vitest";
import config, { frameSources, frameWildcard } from "../../next.config";

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
    for (const bad of ["*", "https://*.com", "http://*.x.y", "https://a.*.b.c", "https:", "'self'", "data:", "blob:", "javascript:alert(1)", "not an address", "'unsafe-inline'; script-src *"]) {
      expect(frameSources({ PREVIEW_URL: bad, APPS_URL: bad }), bad).toBe("'none'");
    }
    // A bad entry does not take the good one with it, and cannot add a second rule.
    expect(frameSources({ PREVIEW_URL: "https://*.com,http://127.0.0.1:5173", APPS_URL: "x; script-src *" })).toBe("http://127.0.0.1:5173");
  });

  it("the one pattern allowed: https, a single leading wildcard label, a suffix of two labels or more", () => {
    expect(frameWildcard("https://*.sandbox.example")).toBe("https://*.sandbox.example");
    expect(frameWildcard("  HTTPS://*.Sandbox.Example  ")).toBe("https://*.sandbox.example");
    expect(frameWildcard("https://*.a.b.c")).toBe("https://*.a.b.c");
    for (const bad of [
      "*",
      "http://*.x.y", // not https
      "https://*.com", // one label: every site under .com
      "https://a.*.b.c", // the wildcard is not the first label
      "https://*.*.b.c",
      "https://*a.b.c",
      "https://a*.b.c",
      "https://*.b.c:8443",
      "https://*.b.c/path",
      "https://*.b..c",
      "https://*.-b.c",
      "https://*.b.c; script-src *",
      "https://*",
      "https://*.",
      "*.b.c",
      "wss://*.b.c",
      "",
    ]) {
      expect(frameWildcard(bad), bad).toBeNull();
    }
  });

  it("the sandbox suffix is listed as that one pattern, beside the exact origins", () => {
    expect(frameSources({ PREVIEW_FRAME_SUFFIX: "sandbox.example" })).toBe("https://*.sandbox.example");
    expect(frameSources({ PREVIEW_FRAME_SUFFIX: ".sandbox.example" })).toBe("https://*.sandbox.example");
    expect(frameSources({ PREVIEW_URL: "http://127.0.0.1:5173", APPS_URL: "https://apps.rms.example", PREVIEW_FRAME_SUFFIX: "sandbox.example" })).toBe(
      "http://127.0.0.1:5173 https://apps.rms.example https://*.sandbox.example",
    );
    // The same pattern may be written out in the list. Listed twice, it is sent once.
    expect(frameSources({ PREVIEW_URL: "https://*.sandbox.example", PREVIEW_FRAME_SUFFIX: "sandbox.example" })).toBe("https://*.sandbox.example");
  });

  it("a suffix that is too wide, or is not a plain domain, lists nothing", () => {
    for (const bad of ["com", "*", "*.sandbox.example", "https://sandbox.example", "sandbox.example/x", "sandbox.example:443", "a b.c", "x.y; script-src *"]) {
      expect(frameSources({ PREVIEW_FRAME_SUFFIX: bad }), bad).toBe("'none'");
    }
    // Any other wildcard in the list is still left out.
    expect(frameSources({ PREVIEW_URL: "http://*.x.y,https://*.com,https://a.*.b.c,*", APPS_URL: "https://*" })).toBe("'none'");
  });

  it("is sent on every page, beside the rule that nobody may frame RMS", async () => {
    const rules = await config.headers?.();
    const policy = rules?.[0]?.headers.find((header) => header.key === "Content-Security-Policy")?.value ?? "";
    expect(rules?.[0]?.source).toBe("/:path*");
    expect(policy).toMatch(/^frame-ancestors 'none'; frame-src \S/);
  });
});

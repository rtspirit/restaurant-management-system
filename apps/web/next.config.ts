import type { NextConfig } from "next";

/**
 * The only sites this app will show inside a frame: the build preview's host and the apps
 * host. Exact origins from the settings, never a wildcard. A mini-app that sends its own frame
 * to any other site is refused by the browser, so nothing can pose as RMS inside the Preview pane.
 *
 *   PREVIEW_URL  where build previews are served from. One address, or several separated by
 *                commas. Local development: http://127.0.0.1:5173
 *   APPS_URL     the apps host for published mini-apps. Left out, it is not listed.
 *
 * With neither set, no site at all may be framed. Read when the app is built.
 */
export function frameSources(env: Record<string, string | undefined> = process.env): string {
  const origins = [...(env.PREVIEW_URL ?? "").split(","), env.APPS_URL ?? ""].flatMap((value) => {
    try {
      const url = new URL(value.trim());
      // An origin exactly as a browser reports it. Anything with a wildcard or another scheme is left out.
      return (url.protocol === "https:" || url.protocol === "http:") && !url.hostname.includes("*") && !url.hostname.includes("%") ? [url.origin] : [];
    } catch {
      return [];
    }
  });
  const unique = [...new Set(origins)];
  return unique.length > 0 ? unique.join(" ") : "'none'";
}

// Never allow these pages to be shown inside another site's frame (clickjacking), name the only
// sites these pages may frame, and keep sign-in pages out of caches. Applies to every route.
const securityHeaders = [
  { key: "Content-Security-Policy", value: `frame-ancestors 'none'; frame-src ${frameSources()}` },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

const config: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  // Workspace packages that ship TypeScript or TSX source.
  transpilePackages: ["@rms/ui"],
  // The environment file lives at the repo root.
  outputFileTracingRoot: new URL("../..", import.meta.url).pathname,
};

export default config;

import type { NextConfig } from "next";

/**
 * The only sites this app will show inside a frame: the build preview's host and the apps
 * host. Exact origins from the settings, never a wildcard. A mini-app that sends its own frame
 * to any other site is refused by the browser, so nothing can pose as RMS inside the Preview pane.
 *
 *   PREVIEW_URL           where build previews are served from. One address, or several
 *                         separated by commas. Local development: http://127.0.0.1:5173
 *   APPS_URL              the apps host for published mini-apps. Left out, it is not listed.
 *   PREVIEW_FRAME_SUFFIX  the domain build sandboxes get their addresses under. Each sandbox
 *                         has a new address, so this one entry is a pattern: it is listed as
 *                         `https://*.<suffix>`. Left out, no pattern is listed.
 *
 * With none set, no site at all may be framed. Read when the app is built.
 *
 * The pattern only lets the browser LOAD such a frame. It grants nothing: the shell still talks
 * to exactly one origin, the one the server named in the grant (`canLoadGrant` and the frame
 * host compare origins exactly), so a frame on any other sandbox gets no answer and no data.
 */
export function frameSources(env: Record<string, string | undefined> = process.env): string {
  const exact = [...(env.PREVIEW_URL ?? "").split(","), env.APPS_URL ?? ""].flatMap((value) => {
    const entry = value.trim();
    // The one pattern form is welcome in the list too. Everything else must be an exact origin.
    const pattern = frameWildcard(entry);
    if (pattern) return [pattern];
    try {
      const url = new URL(entry);
      // An origin exactly as a browser reports it. Any other wildcard or scheme is left out.
      return (url.protocol === "https:" || url.protocol === "http:") && !url.hostname.includes("*") && !url.hostname.includes("%") ? [url.origin] : [];
    } catch {
      return [];
    }
  });
  const suffix = (env.PREVIEW_FRAME_SUFFIX ?? "").trim().replace(/^\./, "");
  const sandbox = suffix === "" ? null : frameWildcard(`https://*.${suffix}`);
  const unique = [...new Set(sandbox ? [...exact, sandbox] : exact)];
  return unique.length > 0 ? unique.join(" ") : "'none'";
}

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const WILDCARD = new RegExp(`^https://\\*\\.(${LABEL}(?:\\.${LABEL})+)$`);

/**
 * The ONE pattern `frame-src` may hold: `https://*.<suffix>`. https only, a single wildcard as
 * the whole first label, and a suffix of at least two labels (so never `https://*.com`). No
 * port, no path. Returns the pattern as it will be sent, or null for anything else.
 */
export function frameWildcard(value: string): string | null {
  const match = WILDCARD.exec(value.trim().toLowerCase());
  return match ? `https://*.${match[1]}` : null;
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

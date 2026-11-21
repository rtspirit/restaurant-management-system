import type { NextConfig } from "next";


// Never allow these pages to be shown inside another site's frame (clickjacking), and keep
// sign-in pages out of caches. Applies to every route.
const securityHeaders = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
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

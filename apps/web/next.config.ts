import type { NextConfig } from "next";

const config: NextConfig = {
  // Workspace packages that ship TypeScript or TSX source.
  transpilePackages: ["@rms/ui"],
  // The environment file lives at the repo root.
  outputFileTracingRoot: new URL("../..", import.meta.url).pathname,
};

export default config;

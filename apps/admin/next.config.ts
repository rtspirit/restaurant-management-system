import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import type { NextConfig } from "next";

// The environment file lives at the repo root. Only the public values the console needs are
// taken from it (sign-in service URL and publishable key, API URL); no secret enters this app.
// Values already in the environment (Vercel project settings) win over the file.
const rootEnv = new URL("../../.env.local", import.meta.url).pathname;
const fromFile: Record<string, string | undefined> = existsSync(rootEnv) ? parseEnv(readFileSync(rootEnv, "utf8")) : {};
const publicEnv: Record<string, string> = {};
for (const key of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "NEXT_PUBLIC_API_URL"]) {
  const value = process.env[key] ?? fromFile[key];
  if (value) publicEnv[key] = value;
}

const config: NextConfig = {
  env: publicEnv,
  // Workspace packages that ship TypeScript or TSX source.
  transpilePackages: ["@rms/ui"],
  outputFileTracingRoot: new URL("../..", import.meta.url).pathname,
};

export default config;

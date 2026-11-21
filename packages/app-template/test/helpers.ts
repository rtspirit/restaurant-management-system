// Test helpers: a throwaway copy of the template that still resolves its packages.
//
// The copy lives under packages/app-template/.test-apps/ (git-ignored), so Node, Vite and the
// TypeScript compiler find react, @rms/ui, @rms/sdk and the rest by walking up to this package's
// own node_modules. Nothing is installed and nothing outside this package is written.
import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const TEMPLATE_DIR = fileURLToPath(new URL("..", import.meta.url));
const TEST_APPS = join(TEMPLATE_DIR, ".test-apps");

/** The template's own files, as a bundle would hold them, plus a starter manifest file. */
const TEMPLATE_ENTRIES = ["index.html", "package.json", "tsconfig.json", "vite.config.ts", "AGENTS.md", "rms.config.ts", "src"];

export const makeTempApp = (): { dir: string; cleanup: () => void } => {
  const dir = join(TEST_APPS, `h-${randomBytes(6).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  for (const entry of TEMPLATE_ENTRIES) cpSync(join(TEMPLATE_DIR, entry), join(dir, entry), { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

export const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createNetServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });

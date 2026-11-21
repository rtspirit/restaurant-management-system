// Step 9: the bundle installs and works on its own, the way the sandbox will use it.
// Unpacked OUTSIDE this repository, so nothing resolves from the workspace by accident.
// Needs the public npm registry and about a minute, so it runs only when asked:
//   pnpm --filter @rms/app-template bundle && RMS_BUNDLE_TEST=1 pnpm --filter @rms/app-template exec vitest run test/bundle.slow.test.ts
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderManifestFile } from "@rms/generators";
import { afterAll, describe, expect, it } from "vitest";
import { demoCatalog } from "../../generators/src/testing/fixtures.js";
import { TEMPLATE_DIR } from "./helpers.js";

const BUNDLE = join(TEMPLATE_DIR, "bundle", "template.tgz");
const run = process.env.RMS_BUNDLE_TEST === "1";
const dir = mkdtempSync(join(tmpdir(), "h-bundle-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const sh = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { cwd: dir, encoding: "utf8", timeout: 300_000, env: { ...process.env, npm_config_registry: "https://registry.npmjs.org/" } });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
};

describe.skipIf(!run)("the template bundle", () => {
  it("holds none of the runner's files and no tests", () => {
    expect(existsSync(BUNDLE), "build it first: pnpm --filter @rms/app-template bundle").toBe(true);
    const list = execFileSync("tar", ["-tzf", BUNDLE], { encoding: "utf8" }).split("\n").map((l) => l.replace(/^\.\//, "")).filter(Boolean);
    for (const banned of ["rms.config.ts", ".env.local", ".rms/", "test/", "node_modules/", "dist/"]) expect(list.some((p) => p === banned || p.startsWith(banned)), banned).toBe(false);
    expect(list.filter((p) => p.startsWith("vendor/") && p.endsWith(".tgz")).sort()).toEqual(["vendor/rms-contracts-0.0.0.tgz", "vendor/rms-generators-0.0.0.tgz", "vendor/rms-sdk-0.0.0.tgz", "vendor/rms-ui-0.0.0.tgz"]);
  });

  it("installs with npm ci, then locks, generates, builds and passes rms check", () => {
    execFileSync("tar", ["-xzf", BUNDLE, "-C", dir]);
    const ci = sh("npm", ["ci", "--no-audit", "--no-fund"]);
    expect(ci.code, ci.err).toBe(0);

    // What the runner writes, in its order.
    writeFileSync(join(dir, "rms.config.ts"), renderManifestFile({ name: "Vendors", models: [{ use: "vendor", access: "write" }], namedQueries: ["sales_by_day"] }));
    mkdirSync(join(dir, ".rms"), { recursive: true });
    writeFileSync(join(dir, ".rms/catalog.json"), JSON.stringify(demoCatalog()));
    writeFileSync(join(dir, ".env.local"), "VITE_RMS_SHELL_ORIGIN=http://localhost:3000\n");
    const lock = sh("npx", ["--no-install", "rms", "lock"]);
    expect(lock.code, lock.out + lock.err).toBe(0);

    const gen = sh("npx", ["--no-install", "rms", "gen", "list_detail", "--model", "vendor", "--screen", "vendors", "--title", "Vendors", "--form"]);
    expect(gen.code, gen.out).toBe(0);
    expect(JSON.parse(gen.out)).toMatchObject({ ok: true, route: "/vendors" });

    const build = sh("npm", ["run", "build"]);
    expect(build.code, build.err).toBe(0);
    expect(readdirSync(join(dir, "dist"))).toContain("index.html");

    const check = sh("npx", ["--no-install", "rms", "check"]);
    const out = JSON.parse(check.out) as { ok: boolean; results: unknown[] };
    expect(out.ok, JSON.stringify(out.results, null, 2)).toBe(true);
    expect(check.code).toBe(0);
  }, 600_000);
});

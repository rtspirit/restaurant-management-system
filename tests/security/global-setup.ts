// Runs once before the suite and once after it, whatever the tests did.
// Before: clean up anything a failed run left, then build the test world.
// After: remove the world and check nothing is left behind.
import { readFileSync } from "node:fs";
import type { TestProject } from "vitest/node";
import { type Sql, adminDb, closeAll } from "@rms/db";
import { assertLocalTarget, loadEnv, repoPath } from "./helpers/env.js";
import { type SuiteUser, type UserKey, createSuiteUsers, deleteSuiteUsers } from "./helpers/signin.js";
import { createWorld, destroyWorld, leftovers } from "./helpers/world.js";

declare module "vitest" {
  export interface ProvidedContext {
    /** Supabase Auth users made for this run: id, email and a one-hour access token each. */
    suiteUsers: Record<UserKey, SuiteUser>;
  }
}

/** An attack that got through and was not rolled back would show here: an extension that was not there before. */
const extraExtensions = async (admin: Sql): Promise<string[]> => {
  const baseline = (JSON.parse(readFileSync(repoPath("tests/security/extensions.baseline.json"), "utf8")) as { extensions: string[] }).extensions;
  const rows = await admin<{ extname: string }[]>`select extname from pg_catalog.pg_extension`;
  return rows.map((r) => r.extname).filter((e) => !baseline.includes(e));
};

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  loadEnv();
  assertLocalTarget();
  const admin = adminDb();

  const clean = async () => {
    await destroyWorld(admin);
    await deleteSuiteUsers();
  };

  await clean();

  // `RMS_SECURITY_CLEAN_ONLY=1 pnpm test:security` removes anything an interrupted run left behind, and stops.
  if (process.env.RMS_SECURITY_CLEAN_ONLY === "1") {
    const left = await leftovers(admin);
    await closeAll();
    process.stdout.write(`Security suite cleanup only: ${left.rows} rows, ${left.schemas} schemas, ${left.roles} roles left. No tests were run.\n`);
    process.exit(left.rows + left.schemas + left.roles === 0 ? 0 : 1);
  }
  try {
    const users = await createSuiteUsers();
    await createWorld(admin, { ownerA: users.ownerA.id, staffA: users.staffA.id, ownerB: users.ownerB.id, maintainer: users.maintainer.id, nobody: users.nobody.id });
    project.provide("suiteUsers", users);
  } catch (e) {
    await clean().catch(() => {});
    await closeAll();
    throw e;
  }

  return async () => {
    try {
      await clean();
      const left = await leftovers(admin);
      if (left.rows + left.schemas + left.roles > 0) {
        throw new Error(`Security suite left data behind: ${left.rows} rows, ${left.schemas} schemas, ${left.roles} roles`);
      }
      const extra = await extraExtensions(admin);
      if (extra.length > 0) {
        throw new Error(`Security suite found database extensions that are not in the baseline after the run: ${extra.join(", ")}. An attack test committed, or someone installed one. Remove it.`);
      }
    } finally {
      await closeAll();
    }
  };
}

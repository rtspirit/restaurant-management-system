// Runs once before the suite and once after it, whatever the tests did.
// Before: clean up anything a failed run left, then build the test world.
// After: remove the world and check nothing is left behind.
import type { TestProject } from "vitest/node";
import { adminDb, closeAll } from "@rms/db";
import { assertLocalTarget, loadEnv } from "./helpers/env.js";
import { type SuiteUser, type UserKey, createSuiteUsers, deleteSuiteUsers } from "./helpers/signin.js";
import { createWorld, destroyWorld, leftovers } from "./helpers/world.js";

declare module "vitest" {
  export interface ProvidedContext {
    /** Supabase Auth users made for this run: id, email and a one-hour access token each. */
    suiteUsers: Record<UserKey, SuiteUser>;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  loadEnv();
  assertLocalTarget();
  const admin = adminDb();

  const clean = async () => {
    await destroyWorld(admin);
    await deleteSuiteUsers();
  };

  await clean();
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
    } finally {
      await closeAll();
    }
  };
}

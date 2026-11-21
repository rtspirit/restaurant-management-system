// Runs inside every test file before its tests.
import { afterAll } from "vitest";
import { closeConnections } from "./helpers/actors.js";
import { assertLocalTarget, loadEnv } from "./helpers/env.js";

loadEnv();
assertLocalTarget();

afterAll(async () => {
  await closeConnections();
});

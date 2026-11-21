import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ChangeSignal, SIGNAL_TIER, tierForSignals } from "@rms/contracts";
import { adminDb, closeAll } from "./index.js";

const envFile = resolve(import.meta.dirname, "../../../.env.local");
if (existsSync(envFile)) process.loadEnvFile(envFile);
const hasDb = Boolean(process.env.DATABASE_ADMIN_URL);

describe.skipIf(!hasDb)("the database derives the tier the same way the code does", () => {
  afterAll(closeAll);

  it("agrees on every single signal", async () => {
    for (const signal of ChangeSignal.options) {
      const [row] = await adminDb()<{ tier: string }[]>`select platform.tier_for_signals(${[signal]}::text[]) as tier`;
      expect(row?.tier, signal).toBe(SIGNAL_TIER[signal]);
    }
  });

  it("agrees on combinations and on no signals", async () => {
    const sets: (typeof ChangeSignal.options)[number][][] = [[], ["screen_change", "first_publish"], ["first_publish", "public_share"], ["theme_change"], ["new_model", "new_index"]];
    for (const s of sets) {
      const [row] = await adminDb()<{ tier: string }[]>`select platform.tier_for_signals(${s}::text[]) as tier`;
      expect(row?.tier).toBe(tierForSignals(s));
    }
  });

  it("refuses a signal it does not know", async () => {
    await expect(adminDb()`select platform.tier_for_signals(array['made_up_signal'])`).rejects.toEqual(expect.objectContaining({ code: "23514" }));
  });
});

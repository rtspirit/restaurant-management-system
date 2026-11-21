// The starting detector. Task O extends this file with one test per rule in the list on `DetectedChange`.
import { describe, expect, it } from "vitest";
import { AppManifest, DetectedChange, tierForSignals } from "@rms/contracts";
import { detectSignals } from "./detect.js";

const manifest = AppManifest.parse({ name: "Money", models: [{ use: "sales_day", access: "read" }] });

describe("detectSignals, the starting rules", () => {
  it("a first publish is held for the owner", () => {
    const d = detectSignals({ origin: "publish", firstPublish: true, manifest: { before: null, after: manifest } });
    expect(d.signals).toEqual(["first_publish"]);
    expect(d.tier).toBe("T2");
  });

  it("a public share is held for a maintainer", () => {
    const d = detectSignals({ origin: "share", publicShare: true });
    expect(d.signals).toContain("public_share");
    expect(d.tier).toBe("T3");
  });

  it("a failed safety check is recorded for a maintainer, and an ordinary failure is not", () => {
    expect(detectSignals({ origin: "publish", failedChecks: ["safety"] }).signals).toContain("security_check_blocked");
    expect(detectSignals({ origin: "share", failedChecks: ["scrub"] }).signals).toContain("security_check_blocked");
    expect(detectSignals({ origin: "publish", failedChecks: ["types", "build"] }).signals).not.toContain("security_check_blocked");
  });

  it("publishing again with nothing else to say is a screen change", () => {
    const d = detectSignals({ origin: "publish", manifest: { before: manifest, after: manifest } });
    expect(d.signals).toEqual(["screen_change"]);
    expect(d.tier).toBe("T1");
  });

  it("never takes away a signal the caller already has, and the tier always follows the signals", () => {
    const d = detectSignals({ origin: "publish", firstPublish: true }, ["new_connection", "public_share"]);
    expect(d.signals).toEqual(expect.arrayContaining(["new_connection", "public_share", "first_publish"]));
    expect(d.tier).toBe(tierForSignals(d.signals));
    expect(DetectedChange.safeParse(d).success).toBe(true);
  });
});

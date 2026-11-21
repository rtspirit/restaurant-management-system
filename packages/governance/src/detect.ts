// Detectors: turn the facts of a real change into signals. Rules only, no model. Task O owns this file.
// Brief: docs/briefs/wave3.md, task O. The full rule list is the comment on `DetectedChange` in
// packages/contracts/src/changes.ts.
//
// STARTING VERSION, written with the Wave 3 preparation so publish (N) and sharing (P) can call
// it today. It knows the rules that need no comparing: a first publish, a public share, a
// failed safety check, and "something on a screen changed". Task O adds the manifest, model and
// dependency rules and a test for every line of the list.
import { ChangeEvidence, type ChangeFact, type ChangeSignal, type DetectedChange, SAFETY_CHECKS, tierForSignals } from "@rms/contracts";

/**
 * The signals for one change. Pure. `already` are signals the caller has for its own reasons:
 * a detector adds to them and never takes one away, so nothing here can lower a tier.
 */
export const detectSignals = (evidence: ChangeEvidence, already: readonly ChangeSignal[] = []): DetectedChange => {
  const e = ChangeEvidence.parse(evidence);
  const signals = new Set<ChangeSignal>(already);
  const facts: ChangeFact[] = [];

  if (e.firstPublish) signals.add("first_publish");
  if (e.publicShare) signals.add("public_share");
  const blocked = e.failedChecks.filter((c) => c === "scrub" || (SAFETY_CHECKS as readonly string[]).includes(c));
  if (blocked.length > 0) {
    signals.add("security_check_blocked");
    facts.push({ label: "Blocked by", value: blocked.join(", ") });
  }
  if (signals.size === 0 || (e.manifest && !e.firstPublish && !e.publicShare)) signals.add("screen_change");

  const list = [...signals];
  return { signals: list, tier: tierForSignals(list), facts };
};

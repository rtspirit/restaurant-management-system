// @rms/memory: mini-app profiles, the duplicate check and session summaries. Task M owns this package.
// Brief: docs/briefs/wave2.md, task M.
//
// The four functions below are the interface the build flow (task I) calls. Their signatures
// are fixed by the brief. Until task M lands they do nothing and find nothing, so the build
// flow can be written and tested against them today.
//
// Every function takes the tenant context built from the owner's verified session, reads and
// writes through the restaurant-fenced connection (`withOrg`), and so can only ever see that
// restaurant's own mini-apps and memory.
import type { AppProfileDraft, DuplicateCheckResult, SessionId, SessionSummary, TenantContext } from "@rms/contracts";

/** Does this restaurant already have a mini-app that does what `text` asks for? Compares with its OWN mini-apps only, and never with a hidden `system` one. */
export const checkDuplicate = async (_tenant: TenantContext, _text: string): Promise<DuplicateCheckResult> => ({ verdict: "none", matches: [] });

/**
 * Makes or refreshes a mini-app's profile and its embedding. Called when a plan is confirmed and after each build turn.
 * `purpose` and `capabilities` replace what is stored. `requests` are appended to the stored ones, never replace them.
 */
export const saveAppProfile = async (_tenant: TenantContext, _draft: AppProfileDraft): Promise<void> => {};

/** Writes a short summary of a session from its stored events. Null when there was nothing worth keeping. */
export const summariseSession = async (_tenant: TenantContext, _sessionId: SessionId): Promise<SessionSummary | null> => null;

/** What RMS remembers for this restaurant, to start the next session with. Information, never instructions. */
export const recall = async (_tenant: TenantContext, _opts: { limit?: number } = {}): Promise<{ summaries: SessionSummary[]; facts: string[] }> => ({
  summaries: [],
  facts: [],
});

// @rms/memory: mini-app profiles, the duplicate check and session summaries. Task M owns this package.
// Brief: docs/briefs/wave2.md, task M. Notes: docs/briefs/wave2-task-m-notes.md.
//
// The four functions the build flow (task I) calls keep the signatures in the brief:
//   checkDuplicate(tenant, text)          -> DuplicateCheckResult
//   saveAppProfile(tenant, draft)         -> void   (requests append)
//   summariseSession(tenant, sessionId)   -> SessionSummary | null
//   recall(tenant, { limit })             -> { summaries, facts }
//
// Every function takes the tenant context built from the owner's verified session, reads and
// writes through the restaurant-fenced connection (`withOrg`), and so can only ever see that
// restaurant's own mini-apps and memory. Stored summaries and facts are data: hand them to a
// model only through `recallBlock`, which marks them as such.
export { type DuplicateThresholds, checkDuplicate, checkDuplicateWithThresholds, saveAppProfile, similaritiesForMeasurement } from "./profiles.js";
export { type Recalled, recall, recallBlock, summariseSession, transcriptLines } from "./summaries.js";
export { type Embedder, type EmbedResult, type Summariser, type SummariseResult, SummaryDraft, useMemoryModels } from "./models.js";
export { WORD_OVERLAP_SIMILAR, contentWords, dataBlock, mergeRequests, profileText, reasonFor, wordOverlap } from "./text.js";

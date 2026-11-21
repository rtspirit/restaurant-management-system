// @rms/memory: mini-app profiles, the duplicate check and session summaries. Task M owns this package.
// Brief: docs/briefs/wave2.md, task M. Notes: docs/briefs/wave2-task-m-notes.md.
//
// The functions the build flow (task I) and the API call. Signatures as in the brief:
//   checkDuplicate(tenant, text)          -> DuplicateCheckResult
//   saveAppProfile(tenant, draft)         -> void   (requests append)
//   summariseSession(tenant, sessionId)   -> SessionSummary | null
//   recall(tenant, { limit })             -> { summaries, facts }
//   recallBlock(recalled)                 -> text for a prompt, marked as data
//
// Every function takes the tenant context built from the owner's verified session and works
// through the restaurant-fenced connection (`withOrg`). Raw scores and test seams are NOT here:
// they live in `@rms/memory/testing`, for tests only.
export { checkDuplicate, saveAppProfile } from "./profiles.js";
export { type Recalled, recall, recallBlock, summariseSession } from "./summaries.js";

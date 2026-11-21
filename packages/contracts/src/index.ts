// @rms/contracts: shared zod schemas and types. Owned by the lead. Ask the lead for changes.
// 0.4.0 (Wave 2): build sessions and the event stream, the frame hand-off, the build agent's
// tools and the app template, connections and Demo POS, Ask, memory and duplicates.
// 0.4.1 (task M, approved by the lead): the duplicate check is shortlist-then-confirm.
// DUPLICATE_THRESHOLDS gains `shortlistFloor`; `same`/`similar` are now the embedding-only
// fallback values; new DuplicateJudgement, JUDGEMENT_VERDICT, DUPLICATE_CONFIRM_TIMEOUT_MS.
// Request and result shapes are unchanged.
export const CONTRACTS_VERSION = "0.4.1";

export * from "./ids.js";
export * from "./auth.js";
export * from "./models.js";
export * from "./data-api.js";
export * from "./manifest.js";
export * from "./agent.js";
export * from "./frame.js";
export * from "./build.js";
export * from "./mcp.js";
export * from "./ask.js";
export * from "./memory.js";
export * from "./governance.js";
export * from "./platform.js";
export * from "./storage.js";

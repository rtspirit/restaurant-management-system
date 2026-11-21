// @rms/memory/testing: for tests only. Model stand-ins, raw similarity scores and the check with
// chosen thresholds. Product code imports from "@rms/memory" and never from here: a score must
// never reach a route or an owner.
export { type DuplicateThresholds, checkDuplicateWithThresholds, similaritiesForMeasurement } from "./profiles.js";
export { transcriptLines } from "./summaries.js";
export {
  defaultJudge,
  type Embedder,
  type EmbedResult,
  type Judge,
  JudgeAnswer,
  type JudgeResult,
  MODEL_CALL_TIMEOUT_MS,
  type Summariser,
  type SummariseResult,
  SummaryDraft,
  useMemoryModels,
} from "./models.js";
export { WORD_OVERLAP_SIMILAR, checkedEmbedding, contentWords, dataBlock, mergeRequests, profileText, reasonFor, wordOverlap } from "./text.js";

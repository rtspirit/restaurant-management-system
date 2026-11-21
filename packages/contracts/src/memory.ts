import { z } from "zod";
import { AppId, SessionId } from "./ids.js";

/**
 * Memory, demo size: a profile per mini-app (for "you already have this") and a short summary
 * per finished session.
 *
 * Rules:
 *   - Everything here belongs to ONE restaurant. Profiles and summaries are read and written
 *     through the restaurant-fenced connection (`withOrg`), so the database itself refuses
 *     another restaurant's rows. A duplicate check compares a request with the caller's own
 *     mini-apps and nothing else. Marketplace matches are a different feature (Wave 3).
 *   - Embeddings are made on the server through OpenRouter with `RMS_EMBED_MODEL`.
 *   - A similarity score never leaves the server (ADR 0002, decision 9).
 *   - A summary is written from the stored owner-facing events. It is information for the next
 *     session, never an instruction to it.
 */

/** Length of every embedding. Fixed by the `vector(1536)` columns. Changing the model means re-embedding. */
export const EMBEDDING_DIMENSIONS = 1536;
export const Embedding = z.array(z.number()).length(EMBEDDING_DIMENSIONS);
export type Embedding = z.infer<typeof Embedding>;

/**
 * What a mini-app is for (`platform.app_profiles`). Written when its plan is confirmed and
 * again after each build turn.
 * The embedding is made from `purpose`, `capabilities` and `requests` joined with new lines.
 */
export const AppProfile = z.object({
  appId: AppId,
  appName: z.string().max(40),
  /** One or two plain sentences. */
  purpose: z.string().min(1).max(400),
  /** What it can do, one short line each. From the plan's screens. */
  capabilities: z.array(z.string().max(120)).max(12),
  /** What the owner asked for, in their own words. Newest last. */
  requests: z.array(z.string().max(400)).max(10),
  updatedAt: z.iso.datetime(),
});
export type AppProfile = z.infer<typeof AppProfile>;

/**
 * What the build flow hands over to make or refresh a profile. `purpose` and `capabilities`
 * REPLACE what is stored. `requests` are APPENDED to the stored ones (newest last, an exact
 * repeat is not added twice, the oldest are dropped past ten). Saving a profile never loses an
 * earlier request.
 */
export const AppProfileDraft = AppProfile.omit({ updatedAt: true, appName: true });
export type AppProfileDraft = z.infer<typeof AppProfileDraft>;

/**
 * The duplicate check, in order (contracts 0.4.1):
 *   1. Word for word: the request equals an earlier request after `normaliseRequest`: "same", no model call.
 *   2. Shortlist: up to `maxMatches` of the restaurant's own mini-apps whose similarity (cosine,
 *      0 to 1: whole profile or best single line) is at or above `shortlistFloor`, plus any the
 *      word-overlap check finds when the embedding call fails.
 *   3. Confirm: one short chat-model call (RMS_ASK_MODEL) judges each shortlisted mini-app as a
 *      `DuplicateJudgement`, within `DUPLICATE_CONFIRM_TIMEOUT_MS`.
 *   4. Fallback, when the confirm call fails, times out or answers off-schema: the embedding
 *      score alone, "same" at or above `same`, "similar" at or above `similar` (conservative values).
 * Measured with openai/text-embedding-3-small: see docs/briefs/wave2-task-m-notes.md.
 */
export const DUPLICATE_THRESHOLDS = { shortlistFloor: 0.35, same: 0.65, similar: 0.45, maxMatches: 3 } as const;

/** Most time the confirm call may take before the check falls back to the embedding score. */
export const DUPLICATE_CONFIRM_TIMEOUT_MS = 5000;

/** The model's judgement of one shortlisted mini-app: it already does this, it does part of it, or it is something else. */
export const DuplicateJudgement = z.enum(["same", "overlaps", "different"]);
export type DuplicateJudgement = z.infer<typeof DuplicateJudgement>;

/** How a judgement shows in `DuplicateCheckResult`. "overlaps" is "similar": the owner is offered "add to it". */
export const JUDGEMENT_VERDICT = { same: "same", overlaps: "similar", different: "none" } as const satisfies Record<DuplicateJudgement, "same" | "similar" | "none">;

/** Lower case, letters and digits only, single spaces. Two requests that agree after this are the same request. */
export const normaliseRequest = (text: string): string =>
  text.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export const DuplicateCheckRequest = z.strictObject({ text: z.string().min(1).max(4000) });
export type DuplicateCheckRequest = z.infer<typeof DuplicateCheckRequest>;

/** What the owner is told. No scores. `reason` is plain words, for example "It already shows your sales, costs and what is left each week." */
export const DuplicateCheckResult = z.object({
  verdict: z.enum(["same", "similar", "none"]),
  matches: z.array(z.object({
    appId: AppId,
    appName: z.string().max(40),
    reason: z.string().max(200),
    published: z.boolean(),
  })).max(DUPLICATE_THRESHOLDS.maxMatches),
});
export type DuplicateCheckResult = z.infer<typeof DuplicateCheckResult>;

/** A finished session in a few lines (`platform.org_memory`, kind "session_summary"). */
export const SessionSummary = z.object({
  sessionId: SessionId,
  appId: AppId.nullable(),
  /** What was asked for and what happened, in plain words. */
  text: z.string().min(1).max(600),
  /** Lasting facts worth keeping, for example "Their week runs Monday to Sunday." Stored as kind "fact". */
  facts: z.array(z.string().max(200)).max(5),
  createdAt: z.iso.datetime(),
});
export type SessionSummary = z.infer<typeof SessionSummary>;

/** Memory routes on the API origin. Owner's RMS session. Owner only. */
export const MEMORY_ROUTES = {
  duplicates: "/memory/v1/duplicates", // POST DuplicateCheckRequest -> DuplicateCheckResult
  summaries: "/memory/v1/summaries", // GET -> { summaries: SessionSummary[] }, newest first, at most 20
} as const;

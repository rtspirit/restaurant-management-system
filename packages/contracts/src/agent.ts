import { z } from "zod";
import { AppId, RunId, SessionId } from "./ids.js";
import { AppManifest } from "./manifest.js";

export const AgentMode = z.enum(["build", "ask"]);
export type AgentMode = z.infer<typeof AgentMode>;

/** What the owner sees for a build step. Plain words only. */
export const StepState = z.enum(["pending", "active", "done", "failed"]);

/** The plan the owner confirms before anything is built. Every string is owner-facing. */
export const BuildPlan = z.object({
  appName: z.string().max(40),
  summary: z.string().max(280),
  screens: z.array(z.string().max(120)).min(1).max(8),
  keeps: z.array(z.string().max(120)).max(8),
  readsFromRms: z.array(z.string().max(120)).max(8),
  connectsTo: z.array(z.string().max(120)).max(4),
  assumptions: z.array(z.string().max(200)).max(6),
});
export type BuildPlan = z.infer<typeof BuildPlan>;

export const DuplicateMatch = z.object({
  appId: AppId,
  appName: z.string(),
  reason: z.string().max(200),
  /** 0..1 similarity. Shown to nobody. Used to decide whether to interrupt. */
  score: z.number().min(0).max(1),
});

/**
 * Events streamed to the browser during a run. `seq` is strictly increasing per run so a
 * dropped connection resumes with `?after=<seq>`. Owner-facing text never contains code,
 * file paths, table names or raw error text: the server maps internal events to these.
 */
const ev = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.object({ type: z.literal(type), seq: z.number().int().nonnegative(), at: z.iso.datetime(), ...shape });

export const AgentEvent = z.discriminatedUnion("type", [
  ev("run.started", { runId: RunId, sessionId: SessionId, mode: AgentMode }),
  ev("message.delta", { text: z.string() }),
  ev("message.done", { text: z.string() }),
  /** At most three before the agent shows something. */
  ev("question", { id: z.string(), text: z.string().max(200), choices: z.array(z.string().max(60)).max(4).optional() }),
  ev("duplicate.found", { matches: z.array(DuplicateMatch).min(1).max(3) }),
  ev("marketplace.match", { listings: z.array(z.object({ listingId: z.string(), title: z.string(), reason: z.string().max(200) })).max(3) }),
  ev("plan.proposed", { plan: BuildPlan }),
  ev("plan.confirmed", {}),
  ev("step", { id: z.string(), label: z.string().max(80), state: StepState }),
  ev("preview.ready", { url: z.url(), manifest: AppManifest }),
  ev("answer.table", { columns: z.array(z.string()), rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))).max(200) }),
  ev("needs.confirm", { id: z.string(), text: z.string().max(240) }),
  /** `text` is a plain explanation. The real error goes to logs with the run id. */
  ev("run.failed", { text: z.string().max(240), retryable: z.boolean() }),
  ev("run.done", { changeSetId: z.string().optional() }),
]);
export type AgentEvent = z.infer<typeof AgentEvent>;

export const StartRunRequest = z.strictObject({
  sessionId: SessionId.optional(),
  mode: AgentMode,
  appId: AppId.optional(),
  text: z.string().min(1).max(4000),
  /** Answers to earlier `question` or `needs.confirm` events. */
  replyTo: z.string().optional(),
});
export type StartRunRequest = z.infer<typeof StartRunRequest>;

/**
 * Provider-neutral driver. OpenAIDriver (Codex) today. A Claude driver can be added later
 * without touching callers.
 */
export type DriverEvent =
  | { kind: "text"; text: string }
  | { kind: "tool_start"; tool: string; summary: string }
  | { kind: "tool_end"; tool: string; ok: boolean }
  | { kind: "file_change"; path: string; change: "add" | "update" | "delete" }
  | { kind: "usage"; inputTokens: number; outputTokens: number }
  | { kind: "error"; message: string }
  | { kind: "done" };

export interface AgentDriver {
  readonly provider: "openai" | "anthropic";
  run(input: {
    prompt: string;
    workdir: string;
    model: string;
    resumeThreadId?: string;
    signal?: AbortSignal;
  }): AsyncIterable<DriverEvent>;
}

/** Ask agent query tool. Note: no org, schema or role parameter. Ever. */
export const AskQueryToolInput = z.strictObject({
  sql: z.string().min(1).max(8000),
  purpose: z.string().max(200),
});
export const ASK_QUERY_LIMITS = { timeoutMs: 5000, maxRows: 500, maxStatements: 1 } as const;

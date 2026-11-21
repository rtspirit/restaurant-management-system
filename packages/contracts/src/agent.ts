import { z } from "zod";
import { AppId, RunId, SessionId } from "./ids.js";

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

/**
 * Events streamed to the browser during a run. `seq` is strictly increasing per run (unique on
 * run + seq in storage) so a dropped connection resumes with `?after=<seq>`. A Vercel function
 * ends after 300 seconds on Hobby, so resuming is the normal case, not the exception.
 *
 * Every string here is owner-facing: no code, file paths, table or model names, scores or raw
 * error text. The server maps internal driver events to these.
 */
const ev = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.object({ type: z.literal(type), seq: z.number().int().nonnegative(), at: z.iso.datetime(), ...shape });

export const AgentEvent = z.discriminatedUnion("type", [
  ev("run.started", { runId: RunId, sessionId: SessionId, mode: AgentMode }),
  ev("message.delta", { text: z.string() }),
  ev("message.done", { text: z.string() }),
  /** At most three per build before the agent shows something. */
  ev("question", { id: z.string().min(1), text: z.string().max(200), choices: z.array(z.string().max(60)).max(4).optional() }),
  ev("duplicate.found", { id: z.string().min(1), matches: z.array(z.object({ appId: AppId, appName: z.string(), reason: z.string().max(200) })).min(1).max(3) }),
  ev("marketplace.match", { id: z.string().min(1), listings: z.array(z.object({ listingId: z.string(), title: z.string(), reason: z.string().max(200) })).min(1).max(3) }),
  ev("plan.proposed", { id: z.string().min(1), plan: BuildPlan }),
  ev("plan.confirmed", {}),
  ev("step", { id: z.string(), label: z.string().max(80), state: StepState }),
  ev("preview.ready", { url: z.url(), appId: AppId }),
  ev("answer.table", { columns: z.array(z.string()), rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))).max(200) }),
  ev("needs.confirm", { id: z.string().min(1), text: z.string().max(240) }),
  /** `text` is a plain explanation. The real error goes to logs with the run id. */
  ev("run.failed", { text: z.string().max(240), retryable: z.boolean() }),
  /** The function is about to time out. The client reconnects and the run continues. */
  ev("run.paused", {}),
  ev("run.done", {}),
]);
export type AgentEvent = z.infer<typeof AgentEvent>;

/** The owner's reply to an event that carried an `id`. */
export const RunReply = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("answer"), to: z.string(), text: z.string().max(1000) }),
  z.strictObject({ kind: z.literal("confirm"), to: z.string(), ok: z.boolean() }),
  /** For `duplicate.found` and `marketplace.match`. */
  z.strictObject({ kind: z.literal("choose"), to: z.string(), choice: z.enum(["open_existing", "add_to_existing", "install_listing", "build_anyway"]), ref: z.string().optional() }),
]);
export type RunReply = z.infer<typeof RunReply>;

export const StartRunRequest = z.strictObject({
  sessionId: SessionId.optional(),
  mode: AgentMode,
  appId: AppId.optional(),
  text: z.string().min(1).max(4000).optional(),
  reply: RunReply.optional(),
}).refine((r) => Boolean(r.text) !== Boolean(r.reply), "Send either text or a reply");
export type StartRunRequest = z.infer<typeof StartRunRequest>;

export const StartRunResponse = z.object({ sessionId: SessionId, runId: RunId, eventsUrl: z.string() });
export type StartRunResponse = z.infer<typeof StartRunResponse>;

/** Agent routes on the API origin. Authenticated by the owner's RMS session, never by a body field. */
export const AGENT_ROUTES = {
  start: "/agent/v1/runs", // POST StartRunRequest -> StartRunResponse
  events: "/agent/v1/runs/:runId/events", // GET, server-sent events, ?after=<seq>
  cancel: "/agent/v1/runs/:runId/cancel", // POST
} as const;

/**
 * Provider-neutral driver. OpenAIDriver (Codex) today. A Claude driver can be added later
 * without touching callers. Driver events are internal: they never go to the browser as is.
 */
export type DriverEvent =
  | { kind: "thread"; threadId: string }
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
    /** From an earlier `thread` event, to continue the same conversation after a pause. */
    resumeThreadId?: string;
    signal?: AbortSignal;
  }): AsyncIterable<DriverEvent>;
}

/**
 * Ask agent query tool. No org, schema or role parameter, ever: the server takes the
 * restaurant from the signed-in session. Demo: the Ask agent is owner-only (ADR 0002).
 */
export const AskQueryToolInput = z.strictObject({
  sql: z.string().min(1).max(8000),
  purpose: z.string().max(200),
});
export const ASK_QUERY_LIMITS = { timeoutMs: 5000, maxRows: 500, maxStatements: 1 } as const;

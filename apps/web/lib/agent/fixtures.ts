// Recorded build sessions: lists of events exactly as the stream sends them (contracts,
// AgentEvent). Written by hand until the real stream exists (task I). The gallery draws the
// build screen from these, the reducer tests replay them, and the practice API speaks in the
// same words. Seeded and fictional: Marigold Kitchen.
import type { AgentEvent, BuildPlan } from "@rms/contracts";

/** An event before it is stored: no number and no time yet. */
type Distribute<T> = T extends unknown ? Omit<T, "seq" | "at"> : never;
export type EventBody = Distribute<AgentEvent>;

const LIVE = new Set<string>(["message.delta", "run.paused"]);

/** Numbers a list of events the way the server does: stored events count up from 1, live-only ones carry the last number. */
export function record(bodies: readonly EventBody[], startAt = "2026-11-21T15:04:00.000Z"): AgentEvent[] {
  let seq = 0;
  const t0 = Date.parse(startAt);
  return bodies.map((body, index) => {
    if (!LIVE.has(body.type)) seq += 1;
    return { ...body, seq, at: new Date(t0 + index * 2_000).toISOString() } as AgentEvent;
  });
}

// Ids in task J's range. They name nothing in any database.
const hex = (n: number) => `0193a3c0000070008000${n.toString(16).padStart(12, "0")}`;
export const FIXTURE_SESSION = `ses_${hex(0x60)}` as const;
const run = (n: number) => `run_${hex(0x60 + n)}` as const;
export const FIXTURE_APP = `app_${hex(0x6a)}` as const;
const EXISTING_APP = `app_${hex(0x6b)}` as const;

export const MONEY_PLAN: BuildPlan = {
  appName: "Money",
  summary: "A weekly look at what came in, what it cost you, and what is left.",
  screens: ["Money in, day by day", "What food, drink and staff cost you", "What’s left each week", "Prime cost, the number most owners watch"],
  keeps: [],
  readsFromRms: ["Your sales days", "Your locations"],
  connectsTo: [],
  assumptions: ["Your week runs Monday to Sunday.", "A day ends at 4am, so late tables count for the night before."],
};

const started = (n: number): EventBody => ({ type: "run.started", runId: run(n), sessionId: FIXTURE_SESSION, mode: "build" });

/** "I want to see how much money I'm making": two questions, a plan, three steps, a preview, then one change. */
const MONEY: EventBody[] = [
  started(1),
  { type: "user.message", text: "I want to see how much money I’m making" },
  { type: "question", id: "q1", text: "Which locations?", choices: ["Both", "Downtown", "Riverside"] },
  { type: "run.waiting", for: "reply" },
  started(2),
  { type: "user.reply", reply: { kind: "answer", to: "q1", text: "Both" } },
  { type: "question", id: "q2", text: "How often do you want to look?", choices: ["Every week", "Every day", "Every month"] },
  { type: "run.waiting", for: "reply" },
  started(3),
  { type: "user.reply", reply: { kind: "answer", to: "q2", text: "Every week" } },
  { type: "plan.proposed", id: "p1", plan: MONEY_PLAN },
  { type: "run.waiting", for: "reply" },
  started(4),
  { type: "user.reply", reply: { kind: "confirm", to: "p1", ok: true } },
  { type: "plan.confirmed" },
  { type: "step", id: "s1", label: "Setting up your sales days", state: "active" },
  { type: "step", id: "s1", label: "Set up your sales days", state: "done" },
  { type: "step", id: "s2", label: "Building your weekly screen", state: "active" },
  { type: "step", id: "s2", label: "Built your weekly screen", state: "done" },
  { type: "step", id: "s3", label: "Checking the numbers add up", state: "active" },
  { type: "step", id: "s3", label: "Checked the numbers add up", state: "done" },
  { type: "preview.ready", appId: FIXTURE_APP, appName: "Money" },
  { type: "message.done", text: "Money is ready to try. Tell me if anything looks off." },
  { type: "run.waiting", for: "review" },
  started(5),
  { type: "user.message", text: "Put Riverside first" },
  { type: "step", id: "c1", label: "Making that change", state: "active" },
  { type: "step", id: "c1", label: "Made that change", state: "done" },
  { type: "preview.ready", appId: FIXTURE_APP, appName: "Money" },
  { type: "message.done", text: "Done. Riverside comes first now." },
  { type: "run.waiting", for: "review" },
];

const upTo = (count: number): AgentEvent[] => record(MONEY.slice(0, count));

/** Asking for something the restaurant already has. */
const DUPLICATE: EventBody[] = [
  started(1),
  { type: "user.message", text: "Show me what I’m making each week" },
  {
    type: "duplicate.found",
    id: "d1",
    matches: [{ appId: EXISTING_APP, appName: "Money", reason: "It already shows your sales, your costs and what is left, week by week." }],
  },
  { type: "run.waiting", for: "reply" },
];

/** The build stops part-way and says so in plain words. */
const FAILURE: EventBody[] = [
  ...MONEY.slice(0, 20),
  { type: "run.failed", text: "That took too long and was stopped. Nothing you had is lost. Say “carry on” and I’ll pick it up.", retryable: true },
];

/** A change that needs a yes first. */
const CONFIRM: EventBody[] = [
  ...MONEY.slice(0, 24),
  started(5),
  { type: "user.message", text: "Take the Riverside figures out" },
  { type: "needs.confirm", id: "c9", text: "Money will show Downtown only. Riverside’s figures stay in RMS and you can bring them back." },
  { type: "run.waiting", for: "reply" },
];

export type RecordedState = "first" | "question" | "duplicate" | "plan" | "progress" | "preview" | "changed" | "confirm" | "failure" | "dropped";

/** Each state the build screen can be in, as the events that lead to it. */
export const RECORDED: Record<RecordedState, AgentEvent[]> = {
  first: upTo(2),
  question: upTo(8),
  duplicate: record(DUPLICATE),
  plan: upTo(12),
  progress: upTo(20),
  preview: upTo(24),
  changed: upTo(31),
  confirm: record(CONFIRM),
  failure: record(FAILURE),
  // The connection went while the second step was being built. The screen keeps its place.
  dropped: upTo(18),
};

export const RECORDED_STATES = Object.keys(RECORDED) as RecordedState[];

/** The whole Money session, start to finish. */
export const MONEY_SESSION: AgentEvent[] = record(MONEY);

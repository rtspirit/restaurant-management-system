// Events in, what the owner sees out. Pure: no clock, no network, no browser.
//
// The build screen is drawn from this and nothing else, so replaying a session's stored events
// from the start gives exactly the screen a person who watched it live ended on. That is what
// "never loses their place" rests on, and what the tests beside this file check.
import { LIVE_ONLY_EVENTS, type AgentEvent, type BuildPlan, type RunReply } from "@rms/contracts";

type Choice = Extract<RunReply, { kind: "choose" }>["choice"];

export type ThreadStep = { id: string; label: string; state: "done" | "now" | "todo" };

/** One thing in the conversation, top to bottom. */
export type ThreadItem =
  | { kind: "you"; key: string; text: string }
  | { kind: "rms"; key: string; text: string }
  /** A question RMS asked. `answer` is set once the owner has replied: it then folds into a quiet chip. */
  | { kind: "question"; key: string; id: string; text: string; choices: string[]; answer: string | null }
  | { kind: "duplicate"; key: string; id: string; matches: { appId: string; appName: string; reason: string }[]; choice: Choice | null }
  | { kind: "marketplace"; key: string; id: string; listings: { listingId: string; title: string; reason: string }[]; choice: Choice | null }
  | { kind: "plan"; key: string; id: string; plan: BuildPlan; confirmed: boolean }
  /** `halted`: the work stopped short, so anything not done reads "Did not finish" instead of "Not started". */
  | { kind: "steps"; key: string; steps: ThreadStep[]; halted: boolean }
  | { kind: "failed"; key: string; text: string; retryable: boolean }
  | { kind: "stopped"; key: string };

/** What the latest run is doing, in the screen's terms. */
export type RunPhase =
  /** Nothing has been sent yet, or the session has no run. */
  | "idle"
  /** RMS is working: the composer gives way to Stop. */
  | "working"
  /** The owner's turn: a question, a plan, or a preview to try. */
  | "your-turn"
  | "failed"
  | "cancelled"
  | "done";

/** The one earlier event that is waiting for the owner's reply. */
export type Pending =
  | { kind: "question"; id: string; choices: string[] }
  | { kind: "duplicate"; id: string }
  | { kind: "marketplace"; id: string }
  | { kind: "plan"; id: string }
  | { kind: "confirm"; id: string; text: string };

export type BuildView = {
  /** The highest stored `seq` applied. Reconnect with `?after=` this. */
  lastSeq: number;
  items: ThreadItem[];
  /** RMS's words while they are still arriving. Live only: gone after a reconnect, replaced by the finished message. */
  typing: string;
  runId: string | null;
  phase: RunPhase;
  /** Set while `phase` is "your-turn". */
  waitingFor: "reply" | "review" | null;
  pending: Pending | null;
  /** How many runs have started. A run token dies with its run, so the preview asks for a new one on each. */
  runCount: number;
  /** The latest preview. `version` goes up each time it is rebuilt, so the frame knows to reload. */
  preview: { appId: string; appName: string; version: number } | null;
  /** A change the owner asked for has just landed on a preview they had already seen. "Undo that" is offered. */
  canUndo: boolean;
  /** This run began with the owner's own words (not a reply) while a preview already existed. */
  changeRun: boolean;
};

export const EMPTY_VIEW: BuildView = {
  lastSeq: 0,
  items: [],
  typing: "",
  runId: null,
  phase: "idle",
  waitingFor: null,
  pending: null,
  runCount: 0,
  preview: null,
  canUndo: false,
  changeRun: false,
};

/** What happened to one event. Anything but "applied" and "live" leaves the view exactly as it was. */
export type Outcome =
  | "applied"
  /** A live-only event (`message.delta`, `run.paused`): shown, but it never moves the place. */
  | "live"
  /** Already seen (its `seq` is not above the last one). Ignored. */
  | "duplicate"
  /** A stored event that skips ahead. Refused: the stream client reconnects from `lastSeq`. */
  | "gap";

const isLiveOnly = (event: AgentEvent): boolean => (LIVE_ONLY_EVENTS as readonly string[]).includes(event.type);

/** The words shown for a choice the owner made, as their own message would read. */
export const CHOICE_WORDS: Record<Choice, string> = {
  open_existing: "Open the one I have",
  add_to_existing: "Add to the one I have",
  install_listing: "Use that one",
  build_anyway: "Build a separate one",
};

const STEP_STATE = { pending: "todo", active: "now", done: "done", failed: "todo" } as const;

const replaceLast = <T extends ThreadItem["kind"]>(
  items: ThreadItem[],
  kind: T,
  match: (item: Extract<ThreadItem, { kind: T }>) => boolean,
  change: (item: Extract<ThreadItem, { kind: T }>) => ThreadItem,
): ThreadItem[] => {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item && item.kind === kind && match(item as Extract<ThreadItem, { kind: T }>)) {
      const next = items.slice();
      next[i] = change(item as Extract<ThreadItem, { kind: T }>);
      return next;
    }
  }
  return items;
};

/** A run stopped short: a step still turning is put down, and the card says it did not finish. */
const settleSteps = (items: ThreadItem[]): ThreadItem[] => {
  const last = items.findLast((item) => item.kind === "steps");
  if (!last || last.kind !== "steps" || !last.steps.some((step) => step.state === "now")) return items;
  return replaceLast(items, "steps", (item) => item.key === last.key, (item) => ({
    ...item,
    halted: true,
    steps: item.steps.map((step) => (step.state === "now" ? { ...step, state: "todo" } : step)),
  }));
};

function applyReply(view: BuildView, reply: RunReply, key: string): BuildView {
  if (reply.kind === "answer") {
    const answered = replaceLast(view.items, "question", (item) => item.id === reply.to && item.answer === null, (item) => ({ ...item, answer: reply.text }));
    // An answer to something we never showed still reads as the owner's own words.
    return { ...view, items: answered === view.items ? [...view.items, { kind: "you", key, text: reply.text }] : answered, pending: null };
  }
  if (reply.kind === "choose") {
    const chosen = replaceLast(
      replaceLast(view.items, "duplicate", (item) => item.id === reply.to, (item) => ({ ...item, choice: reply.choice })),
      "marketplace",
      (item) => item.id === reply.to,
      (item) => ({ ...item, choice: reply.choice }),
    );
    return { ...view, items: [...chosen, { kind: "you", key, text: CHOICE_WORDS[reply.choice] }], pending: null };
  }
  // confirm: a plan, or a "this will happen" dialog.
  const wasPlan = view.items.some((item) => item.kind === "plan" && item.id === reply.to);
  const items = wasPlan && reply.ok ? replaceLast(view.items, "plan", (item) => item.id === reply.to, (item) => ({ ...item, confirmed: true })) : view.items;
  const text = wasPlan ? (reply.ok ? "Build it" : "Change something") : reply.ok ? "Yes, go ahead" : "No, leave it";
  return { ...view, items: [...items, { kind: "you", key, text }], pending: null };
}

/** Applies one event. Never throws, never changes its input. */
export function applyEvent(view: BuildView, event: AgentEvent): { view: BuildView; outcome: Outcome } {
  if (isLiveOnly(event)) {
    if (event.type === "message.delta") return { view: { ...view, typing: view.typing + event.text }, outcome: "live" };
    return { view, outcome: "live" }; // run.paused: nothing to see. The stream client reconnects.
  }
  if (event.seq <= view.lastSeq) return { view, outcome: "duplicate" };
  if (event.seq !== view.lastSeq + 1) return { view, outcome: "gap" };

  const key = `e${event.seq}`;
  const base: BuildView = { ...view, lastSeq: event.seq };
  const done = (next: BuildView): { view: BuildView; outcome: Outcome } => ({ view: next, outcome: "applied" });

  switch (event.type) {
    case "run.started":
      return done({ ...base, runId: event.runId, phase: "working", waitingFor: null, pending: null, typing: "", runCount: view.runCount + 1, canUndo: false, changeRun: false });
    case "user.message":
      return done({ ...base, items: [...view.items, { kind: "you", key, text: event.text }], changeRun: view.preview !== null });
    case "user.reply":
      return done(applyReply(base, event.reply, key));
    case "message.done":
      return done({ ...base, typing: "", items: [...view.items, { kind: "rms", key, text: event.text }] });
    case "question":
      return done({
        ...base,
        items: [...view.items, { kind: "question", key, id: event.id, text: event.text, choices: event.choices ?? [], answer: null }],
        pending: { kind: "question", id: event.id, choices: event.choices ?? [] },
      });
    case "duplicate.found":
      return done({ ...base, items: [...view.items, { kind: "duplicate", key, id: event.id, matches: event.matches, choice: null }], pending: { kind: "duplicate", id: event.id } });
    case "marketplace.match":
      return done({ ...base, items: [...view.items, { kind: "marketplace", key, id: event.id, listings: event.listings, choice: null }], pending: { kind: "marketplace", id: event.id } });
    case "plan.proposed":
      return done({ ...base, items: [...view.items, { kind: "plan", key, id: event.id, plan: event.plan, confirmed: false }], pending: { kind: "plan", id: event.id } });
    case "plan.confirmed": {
      const latest = view.items.findLast((item) => item.kind === "plan");
      return done({ ...base, pending: null, items: latest ? replaceLast(view.items, "plan", (item) => item.key === latest.key, (item) => ({ ...item, confirmed: true })) : view.items });
    }
    case "step": {
      const step: ThreadStep = { id: event.id, label: event.label, state: STEP_STATE[event.state] };
      const halted = event.state === "failed";
      const last = view.items[view.items.length - 1];
      // Steps of one stretch of work share a card. Anything said in between starts a new one.
      if (last && last.kind === "steps") {
        const known = last.steps.some((s) => s.id === step.id);
        const steps = known ? last.steps.map((s) => (s.id === step.id ? step : s)) : [...last.steps, step];
        return done({ ...base, items: [...view.items.slice(0, -1), { ...last, steps, halted: last.halted || halted }] });
      }
      return done({ ...base, items: [...view.items, { kind: "steps", key, steps: [step], halted }] });
    }
    case "preview.ready":
      return done({ ...base, preview: { appId: event.appId, appName: event.appName, version: (view.preview?.version ?? 0) + 1 } });
    case "needs.confirm":
      return done({ ...base, pending: { kind: "confirm", id: event.id, text: event.text } });
    case "run.waiting":
      return done({ ...base, phase: "your-turn", waitingFor: event.for, typing: "", canUndo: event.for === "review" && view.changeRun });
    case "run.failed":
      return done({ ...base, phase: "failed", waitingFor: null, pending: null, typing: "", items: [...settleSteps(view.items), { kind: "failed", key, text: event.text, retryable: event.retryable }] });
    case "run.cancelled":
      return done({ ...base, phase: "cancelled", waitingFor: null, pending: null, typing: "", items: [...settleSteps(view.items), { kind: "stopped", key }] });
    case "run.done":
      return done({ ...base, phase: "done", waitingFor: null, pending: null, typing: "" });
    default:
      // Ask-only events (a table, a source line) have no place on the build screen. They still count.
      return done(base);
  }
}

/** The view after a list of events, in the order given. */
export function reduceEvents(events: readonly AgentEvent[], from: BuildView = EMPTY_VIEW): BuildView {
  let view = from;
  for (const event of events) view = applyEvent(view, event).view;
  return view;
}

/** After a reconnect the half-arrived words are gone: the finished message comes with the replay. */
export const afterReconnect = (view: BuildView): BuildView => (view.typing === "" ? view : { ...view, typing: "" });

/** A run that is still being worked on, as the stream client needs to know it. */
export const isWorking = (view: BuildView): boolean => view.phase === "working";

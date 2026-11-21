// One build session, as the screen needs it: load it, replay its conversation from the first
// event, follow the live stream, reconnect when it drops, and send what the owner says.
//
// No React in here, so every path can be tested by itself. `use-build-session.ts` is a thin
// wrapper that subscribes a component to `getSnapshot()`.
import type { AgentEvent, RunReply } from "@rms/contracts";
import { AgentApiError, type AgentApi } from "./client";
import { afterReconnect, applyEvent, CHOICE_WORDS, EMPTY_VIEW, settleRun, skipEvent, type BuildView } from "./reducer";
import { followSession, type Following, type FollowOptions, type StreamStatus } from "./stream";

export type SessionLoad =
  | "loading"
  | "ready"
  /** No such build, or it belongs to someone else. The same answer either way. */
  | "not-found"
  | "signed-out"
  /** RMS did not answer. */
  | "unavailable";

export type SessionSnapshot = {
  load: SessionLoad;
  view: BuildView;
  connection: StreamStatus;
  /** Something the owner tried did not go through, in plain words. */
  problem: string | null;
  /** The owner's own words, shown at once while they are on their way. */
  sending: string | null;
  busy: boolean;
  stopping: boolean;
  /** The stored conversation has been replayed in full. */
  settled: boolean;
  /** These routes can run a failed build again without the owner typing anything. */
  canRetry: boolean;
};

export type SessionActions = {
  say: (text: string) => void;
  answer: (questionId: string, text: string) => void;
  choose: (id: string, choice: "open_existing" | "add_to_existing" | "build_anyway", ref?: string) => void;
  buildPlan: (planId: string) => void;
  confirm: (id: string, ok: boolean) => void;
  retry: () => void;
  undo: () => void;
  stop: () => void;
};

export type BuildSessionController = {
  getSnapshot: () => SessionSnapshot;
  subscribe: (listener: () => void) => () => void;
  /** Loads the session and starts following it. Call again to try again after "unavailable". */
  start: () => void;
  /** Stops listening. The controller can be started again. */
  dispose: () => void;
  actions: SessionActions;
};

const SOMETHING_WRONG = "RMS could not do that just now. Try again in a moment.";
const isWorkingStatus = (status: string | undefined): boolean => status === "running" || status === "paused";

export const INITIAL_SNAPSHOT: SessionSnapshot = {
  load: "loading",
  view: EMPTY_VIEW,
  connection: "idle",
  problem: null,
  sending: null,
  busy: false,
  stopping: false,
  settled: false,
  canRetry: false,
};

export function createBuildSession(api: AgentApi, sessionId: string, options: { sleep?: FollowOptions["sleep"] } = {}): BuildSessionController {
  let snapshot: SessionSnapshot = { ...INITIAL_SNAPSHOT, canRetry: api.retry !== undefined };
  const listeners = new Set<() => void>();
  let following: Following | null = null;
  /** The highest stored `seq` the session had when it was loaded. Null until it has loaded. */
  let target: number | null = null;
  let streamEnded = false;
  let inFlight = false;
  /** Goes up on every start and dispose, so an answer that arrives late for an old one is dropped. */
  let life = 0;
  let notifying = false;

  // Events arrive in bursts (a whole replay in one piece). Listeners hear about a burst once.
  const notify = () => {
    if (notifying) return;
    notifying = true;
    queueMicrotask(() => {
      notifying = false;
      for (const listener of [...listeners]) listener();
    });
  };
  const set = (patch: Partial<SessionSnapshot>) => {
    const next = { ...snapshot, ...patch };
    next.settled = streamEnded || (target !== null && next.view.lastSeq >= target);
    snapshot = next;
    notify();
  };

  const follow = (working: boolean) => {
    following?.stop();
    const mine = life;
    const handle: { it: Following | null } = { it: null };
    const current = () => mine === life && following !== null && following === handle.it;
    streamEnded = false;
    handle.it = followSession({
      open: (after, signal) => api.events(sessionId, after, signal),
      after: snapshot.view.lastSeq,
      working,
      ...(options.sleep ? { sleep: options.sleep } : {}),
      onEvent: (event: AgentEvent) => {
        if (mine !== life) return;
        const patch: Partial<SessionSnapshot> = { view: applyEvent(snapshot.view, event).view };
        if (event.type === "user.message" || event.type === "user.reply") patch.sending = null;
        if (event.type === "run.cancelled" || event.type === "run.started") patch.stopping = false;
        set(patch);
      },
      onSkip: (seq) => {
        if (mine === life) set({ view: skipEvent(snapshot.view, seq) });
      },
      onStatus: (status) => {
        if (!current()) return;
        set(status === "reconnecting" ? { connection: status, view: afterReconnect(snapshot.view) } : { connection: status });
      },
      stillWorking: async () => isWorkingStatus((await api.session(sessionId)).run?.status),
    });
    following = handle.it;
    void handle.it.ended.then(async (end) => {
      if (!current()) return;
      streamEnded = true;
      if (end === "signed-out") return set({ load: "signed-out" });
      if (end === "not-found") return set({ load: "not-found" });
      if (end === "refused") return set({ problem: SOMETHING_WRONG });
      if (end !== "finished") return;
      set({ sending: null });
      // Nothing more is coming, yet the screen still shows RMS working: the stop event was one
      // this screen could not read. Ask how the run really ended.
      if (snapshot.view.phase !== "working") return;
      const status = await api.session(sessionId).then((s) => s.run?.status ?? null, () => undefined);
      if (current() && status !== undefined) set({ view: settleRun(snapshot.view, status), stopping: false });
    });
  };

  const start = () => {
    life += 1;
    const mine = life;
    following?.stop();
    following = null;
    target = null;
    streamEnded = false;
    inFlight = false;
    set({ ...INITIAL_SNAPSHOT, canRetry: api.retry !== undefined });
    void (async () => {
      try {
        const session = await api.session(sessionId);
        if (mine !== life) return;
        target = session.lastSeq;
        set({ load: "ready" });
        follow(isWorkingStatus(session.run?.status));
      } catch (error) {
        if (mine !== life) return;
        const code = error instanceof AgentApiError ? error.code : "unavailable";
        set({ load: code === "not_found" || code === "forbidden" ? "not-found" : code === "unauthenticated" ? "signed-out" : "unavailable" });
      }
    })();
  };

  /** Starts a run and follows it. One at a time: a second press while one is on its way does nothing. */
  const begin = async (echo: string | null, call: () => Promise<unknown>) => {
    if (inFlight) return;
    inFlight = true;
    const mine = life;
    set({ busy: true, problem: null, sending: echo });
    try {
      await call();
      if (mine !== life) return;
      follow(true);
    } catch (error) {
      if (mine !== life) return;
      const known = error instanceof AgentApiError ? error : null;
      set({ sending: null, problem: known ? known.message : SOMETHING_WRONG });
      // "Still working on the last thing": so there is a run this screen is not watching (the
      // stream had ended, or another tab or a reload started it). Watch it, or the screen
      // would sit there with nothing arriving.
      if (known?.code === "busy") follow(true);
    } finally {
      if (mine === life) {
        inFlight = false;
        set({ busy: false });
      }
    }
  };

  const send = (request: { text: string } | { reply: RunReply }, echo: string) =>
    void begin(echo, () => api.start({ sessionId: sessionId as `ses_${string}`, mode: "build", ...request }));

  const actions: SessionActions = {
    say: (text) => send({ text }, text),
    answer: (to, text) => send({ reply: { kind: "answer", to, text } }, text),
    choose: (to, choice, ref) => send({ reply: { kind: "choose", to, choice, ...(ref ? { ref } : {}) } }, CHOICE_WORDS[choice]),
    buildPlan: (to) => send({ reply: { kind: "confirm", to, ok: true } }, "Build it"),
    confirm: (to, ok) => send({ reply: { kind: "confirm", to, ok } }, ok ? "Yes, go ahead" : "No, leave it"),
    // Trying again is its own call, never a typed message: the words "try again" sent as text
    // would be stored as an answer to a question, or as a change to the plan.
    retry: () => {
      const retry = api.retry;
      const runId = snapshot.view.runId;
      if (!retry || !runId || snapshot.view.phase !== "failed") return;
      void begin(null, () => retry(runId));
    },
    undo: () => send({ text: "Undo that last change" }, "Undo that last change"),
    stop: () => {
      const runId = snapshot.view.runId;
      if (!runId) return;
      const mine = life;
      set({ stopping: true, problem: null });
      api.cancel(runId).catch((error: unknown) => {
        if (mine === life) set({ stopping: false, problem: error instanceof AgentApiError ? error.message : SOMETHING_WRONG });
      });
    },
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start,
    dispose: () => {
      life += 1;
      following?.stop();
      following = null;
    },
    actions,
  };
}

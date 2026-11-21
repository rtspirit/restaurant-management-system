// A practice stand-in for the build routes, running in the browser. It exists so the build
// screen can be made and shown before the real stream (task I) is merged. Nothing is built,
// nothing is saved, no model is called, and nothing leaves this browser.
//
// It keeps the real stream's habits, so the screen is exercised the way the real thing will
// exercise it (contracts: agent.ts, "How a build works" in docs/briefs/wave2.md):
//   - one run per thing the owner sends, numbered events across the whole session
//   - the request that reads the stream is the one that moves the run along
//   - a stream ends after a stop event, after `run.paused`, or when nothing is running
//   - `run.paused` arrives part-way through every build, as it will after 270 seconds for real
//   - sending while a run is working is refused as busy
//   - a preview token dies with its run
//
// `practiceControls` lets a test or a demo cut the connection or make a build stop short.
import {
  DATA_ROUTES,
  EVENT_STREAM,
  type AgentEvent,
  type BuildPlan,
  type FrameContext,
  type PreviewGrant,
  type RunReply,
  type RunStatus,
  type SessionView,
  type StartRunRequest,
  type StartRunResponse,
} from "@rms/contracts";
import { AgentApiError, type AgentApi, type PracticeProfile } from "./client";
import { MONEY_PLAN, type EventBody } from "./fixtures";

type Beat =
  /** Wait, then store and send one event. */
  | { wait: number; event: EventBody }
  /** The function is about to time out: send `run.paused` and end this stream. */
  | { wait: number; pause: true };

type Recipe = "money" | "suppliers";

type PracticeRun = { runId: string; status: RunStatus; beats: Beat[] };

type PracticeSession = {
  sessionId: string;
  recipe: Recipe;
  request: string;
  events: AgentEvent[];
  run: PracticeRun | null;
  /** Where the conversation has got to. */
  stage: "start" | "duplicate" | "q1" | "q2" | "plan" | "built" | "closed";
  plan: BuildPlan | null;
  appId: `app_${string}` | null;
  appName: string | null;
  /** The token for the latest run's preview. A new run gets a new one. */
  token: string;
};

/** Switches for tests and demos. All off unless set. */
export const practiceControls = {
  /** How fast the practice run goes: 1 is a watchable pace, 0 is instant. */
  speed: 1,
  /** While true the connection is "down": open streams break and new ones fail. */
  offline: false,
  /** The next build stops short with a plain message. Clears itself. */
  failNextBuild: false,
  /** Where a practice preview is served from. Never `localhost` (contracts, frame.ts). */
  previewUrl: process.env.NEXT_PUBLIC_RMS_PRACTICE_PREVIEW_URL ?? "http://127.0.0.1:5673/",
};

const STORE_KEY = "rms.practice.build";
const hex = (length: number): string => {
  const bytes = new Uint8Array(length / 2);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};
// Shaped like real public ids (prefix and 32 hex characters). They name nothing in any database.
const newId = <P extends string>(prefix: P) => `${prefix}_0193a3c0${hex(24)}` as `${P}_${string}`;
const PRACTICE_UUID = (n: number) => `0193a3c0-0000-7000-8000-0000000000${(0x60 + n).toString(16)}`;

type Store = { sessions: Record<string, PracticeSession>; built: { request: string; appId: `app_${string}`; appName: string }[] };
let memory: Store | null = null;
let profile: PracticeProfile = {
  restaurantName: "Marigold Kitchen",
  brandColour: null,
  userName: "Asha Verma",
  role: "owner",
  locations: [{ name: "Downtown" }, { name: "Riverside" }],
};
/** Which open stream is moving each session's run along. In memory only: a reload frees it. */
const drivers = new Map<string, symbol>();
/** Lets `cancel` wake a stream that is waiting between beats. */
const wakers = new Map<string, Set<() => void>>();
/** Rows typed into a practice preview, by information name. Gone on reload. */
const rows = new Map<string, Record<string, unknown>[]>();

function load(): Store {
  if (memory) return memory;
  memory = { sessions: {}, built: [] };
  try {
    const saved = typeof sessionStorage === "undefined" ? null : sessionStorage.getItem(STORE_KEY);
    if (saved) memory = JSON.parse(saved) as Store;
  } catch {
    // Private mode, or something else wrote here. Start clean.
  }
  return memory;
}

function save(): void {
  try {
    // Like the real thing, a preview token is never written to browser storage: it is left out
    // here and a new one is made when the preview is next asked for.
    if (memory && typeof sessionStorage !== "undefined") sessionStorage.setItem(STORE_KEY, JSON.stringify(memory, (key, value: unknown) => (key === "token" ? "" : value)));
  } catch {
    // Not being able to keep a practice run is not worth telling anyone about.
  }
}

/** Forgets every practice session. For tests. */
export function resetPractice(): void {
  memory = { sessions: {}, built: [] };
  drivers.clear();
  wakers.clear();
  rows.clear();
  practiceControls.speed = 1;
  practiceControls.offline = false;
  practiceControls.failNextBuild = false;
  save();
}

const wake = (sessionId: string) => wakers.get(sessionId)?.forEach((fn) => fn());

function append(session: PracticeSession, body: EventBody): AgentEvent {
  const seq = (session.events[session.events.length - 1]?.seq ?? 0) + 1;
  const event = { ...body, seq, at: new Date().toISOString() } as AgentEvent;
  session.events.push(event);
  save();
  return event;
}

const normal = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const recipeFor = (text: string): Recipe => (/money|making|profit|sales|earn|cost/i.test(text) ? "money" : "suppliers");

const SUPPLIER_PLAN: BuildPlan = {
  appName: "Suppliers",
  summary: "One place for everyone you buy from, with how to reach them.",
  screens: ["A list of your suppliers", "Add, change or remove one"],
  keeps: ["Each supplier’s name, phone number and what they deliver"],
  readsFromRms: ["Your locations"],
  connectsTo: [],
  assumptions: ["Both locations share one list.", "Only you can add or remove a supplier. Managers can read the list."],
};

const QUESTIONS: Record<Recipe, [EventBody, EventBody]> = {
  money: [
    { type: "question", id: "q1", text: "Which locations?", choices: ["Both", "Downtown", "Riverside"] },
    { type: "question", id: "q2", text: "How often do you want to look?", choices: ["Every week", "Every day", "Every month"] },
  ],
  suppliers: [
    { type: "question", id: "q1", text: "Is this one list for both locations, or one each?", choices: ["One list for both", "One each"] },
    { type: "question", id: "q2", text: "Anything you want to note about each one, like what they deliver?" },
  ],
};

const STEPS: Record<Recipe, [string, string][]> = {
  money: [
    ["Setting up your sales days", "Set up your sales days"],
    ["Building your weekly screen", "Built your weekly screen"],
    ["Checking the numbers add up", "Checked the numbers add up"],
  ],
  suppliers: [
    ["Setting up your supplier list", "Set up your supplier list"],
    ["Building the screen", "Built the screen"],
    ["Checking it works", "Checked it works"],
  ],
};

const STOP_STATUS: Partial<Record<AgentEvent["type"], RunStatus>> = { "run.waiting": "waiting", "run.done": "done", "run.failed": "failed", "run.cancelled": "cancelled" };

const waiting = (wait: number, on: "reply" | "review"): Beat => ({ wait, event: { type: "run.waiting", for: on } });

/** RMS says something: the words arrive a few at a time, then the finished message. */
function say(text: string, wait = 500): Beat[] {
  const words = text.split(" ");
  const beats: Beat[] = [];
  for (let i = 0; i < words.length; i += 3) {
    beats.push({ wait: i === 0 ? wait : 90, event: { type: "message.delta", text: `${i === 0 ? "" : " "}${words.slice(i, i + 3).join(" ")}` } });
  }
  beats.push({ wait: 90, event: { type: "message.done", text } });
  return beats;
}

function buildBeats(session: PracticeSession): Beat[] {
  const appId = session.appId ?? newId("app");
  const appName = session.plan?.appName ?? "Your mini-app";
  session.appId = appId;
  session.appName = appName;
  const steps = STEPS[session.recipe];
  const beats: Beat[] = [{ wait: 300, event: { type: "plan.confirmed" } }];
  const fail = practiceControls.failNextBuild;
  practiceControls.failNextBuild = false;
  steps.forEach(([doing, did], index) => {
    const id = `s${index + 1}`;
    beats.push({ wait: 500, event: { type: "step", id, label: doing, state: "active" } });
    // Part-way through, the function "times out". The screen reconnects and nothing is lost.
    if (index === 1) beats.push({ wait: 900, pause: true });
    if (fail && index === steps.length - 1) return;
    beats.push({ wait: 1_400, event: { type: "step", id, label: did, state: "done" } });
  });
  if (fail) {
    beats.push({ wait: 1_400, event: { type: "run.failed", text: "That took too long and was stopped. Nothing you had is lost. Say “carry on” and I’ll pick it up.", retryable: true } });
    return beats;
  }
  beats.push({ wait: 500, event: { type: "preview.ready", appId, appName } });
  beats.push(...say(session.recipe === "suppliers" ? "Here’s your supplier list. Add one to try it, or tell me what to change." : `${appName} is ready to try. Tell me if anything looks off.`, 200));
  beats.push(waiting(100, "review"));
  return beats;
}

/** What the run does next, decided from where the conversation is and what was just sent. */
function script(session: PracticeSession, sent: { text?: string; reply?: RunReply }): Beat[] {
  const store = load();
  const [q1, q2] = QUESTIONS[session.recipe];
  const askFirst = (): Beat[] => {
    session.stage = "q1";
    return [{ wait: 900, event: q1 }, waiting(100, "reply")];
  };
  const propose = (extra?: string): Beat[] => {
    const base = session.plan ?? (session.recipe === "money" ? MONEY_PLAN : SUPPLIER_PLAN);
    session.plan = extra ? { ...base, assumptions: [...base.assumptions, `You also asked for this: ${extra}`.slice(0, 200)].slice(-6) } : base;
    session.stage = "plan";
    return [{ wait: 1_100, event: { type: "plan.proposed", id: `p${session.events.length}`, plan: session.plan } }, waiting(100, "reply")];
  };

  if (sent.reply) {
    const reply = sent.reply;
    if (reply.kind === "choose") {
      if (reply.choice === "build_anyway") {
        session.appId = null;
        session.appName = null;
        return askFirst();
      }
      if (reply.choice === "open_existing") {
        session.stage = "closed";
        return [...say("It’s in Mini-apps, under the same name. Nothing new was built."), { wait: 100, event: { type: "run.done" } }];
      }
      // Carry on inside the one they already have.
      session.stage = "built";
      return [...say("Tell me what you’d like to add to it."), waiting(100, "reply")];
    }
    if (reply.kind === "answer") {
      if (session.stage === "q1") {
        session.stage = "q2";
        return [{ wait: 900, event: q2 }, waiting(100, "reply")];
      }
      return propose();
    }
    if (reply.ok && session.stage === "plan") {
      session.stage = "built";
      const beats = buildBeats(session);
      // Remembered, so asking for the same thing again gets "you already have this".
      if (session.appId && session.appName) store.built.push({ request: normal(session.request), appId: session.appId, appName: session.appName });
      return beats;
    }
    return [...say(reply.ok ? "Done." : "No problem. Tell me what to change."), waiting(100, session.stage === "built" ? "review" : "reply")];
  }

  const text = sent.text ?? "";
  if (session.stage === "start") {
    // Something RMS cannot do yet, said plainly rather than half-built.
    if (/\bprint/i.test(text)) return [{ wait: 900, event: { type: "run.failed", text: "I can’t set up printing yet. Tell me what else it should do and I’ll build that.", retryable: false } }];
    const match = store.built.find((b) => b.request === normal(text));
    if (match) {
      session.stage = "duplicate";
      session.appId = match.appId;
      session.appName = match.appName;
      const reason = "You asked for exactly this before, and it is already in your Mini-apps.";
      return [
        { wait: 900, event: { type: "duplicate.found", id: "d1", matches: [{ appId: match.appId, appName: match.appName, reason }] } },
        waiting(100, "reply"),
      ];
    }
    return askFirst();
  }
  if (session.stage === "q1" || session.stage === "q2" || session.stage === "duplicate") return propose(text);
  if (session.stage === "plan") return propose(text);
  if (session.stage === "built") {
    const lastStop = session.events.findLast((e) => e.type in STOP_STATUS);
    if (lastStop?.type === "run.failed" && session.plan) return buildBeats(session).slice(1);
    const undo = /\bundo\b|put it back/i.test(text);
    const appId = session.appId ?? newId("app");
    return [
      { wait: 600, event: { type: "step", id: `c${session.events.length}`, label: undo ? "Putting it back" : "Making that change", state: "active" } },
      { wait: 1_600, event: { type: "step", id: `c${session.events.length}`, label: undo ? "Put it back" : "Made that change", state: "done" } },
      { wait: 300, event: { type: "preview.ready", appId, appName: session.appName ?? "Your mini-app" } },
      ...say(undo ? "I’ve put it back the way it was." : "Done. Take a look.", 200),
      waiting(100, "review"),
    ];
  }
  return [...say("This one is finished. Start a new one from the Build tab."), { wait: 100, event: { type: "run.done" } }];
}

const active = (run: PracticeRun | null): boolean => run !== null && (run.status === "running" || run.status === "paused");

function find(sessionId: string): PracticeSession {
  const session = load().sessions[sessionId];
  if (!session) throw new AgentApiError("not_found", "That build could not be found.");
  return session;
}

const frame = (event: AgentEvent, stored: boolean): string =>
  `${stored ? `id: ${event.seq}\n` : ""}event: ${EVENT_STREAM.event}\ndata: ${JSON.stringify(event)}\n\n`;

/** One open stream: replay, then move the run along if nobody else is, then end. */
function openStream(session: PracticeSession, after: number, signal: AbortSignal): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const me = Symbol("stream");
  let cursor = after;
  const nap = (ms: number) =>
    new Promise<void>((resolve) => {
      const set = wakers.get(session.sessionId) ?? new Set();
      wakers.set(session.sessionId, set);
      const done = () => {
        clearTimeout(timer);
        set.delete(done);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms * practiceControls.speed);
      set.add(done);
      signal.addEventListener("abort", done, { once: true });
    });

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (text: string) => controller.enqueue(encoder.encode(text));
      const flush = () => {
        for (const event of session.events) {
          if (event.seq > cursor) {
            send(frame(event, true));
            cursor = event.seq;
          }
        }
      };
      try {
        send(": keep-alive\n\n");
        for (;;) {
          flush();
          if (signal.aborted) break;
          if (practiceControls.offline) throw new TypeError("network");
          const run = session.run;
          if (!run || !active(run)) break;
          if (!drivers.has(session.sessionId)) drivers.set(session.sessionId, me);
          if (drivers.get(session.sessionId) !== me) {
            await nap(250); // someone else is moving it along: just follow what gets stored
            continue;
          }
          run.status = "running";
          const beat = run.beats[0];
          if (!beat) {
            // A script always ends with a stop event. If one did not, the owner still gets their turn.
            run.status = "waiting";
            append(session, { type: "run.waiting", for: "reply" });
            continue;
          }
          await nap(beat.wait);
          if (signal.aborted || !active(session.run) || session.run !== run) continue;
          if (practiceControls.offline) throw new TypeError("network");
          run.beats.shift();
          if ("pause" in beat) {
            run.status = "paused";
            save();
            flush();
            send(frame({ type: "run.paused", seq: cursor, at: new Date().toISOString() }, false));
            break;
          }
          if (beat.event.type === "message.delta") {
            send(frame({ ...beat.event, seq: cursor, at: new Date().toISOString() } as AgentEvent, false));
            continue;
          }
          const stop = STOP_STATUS[beat.event.type];
          if (stop) run.status = stop;
          append(session, beat.event);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        if (drivers.get(session.sessionId) === me) drivers.delete(session.sessionId);
      }
    },
  });
}

function context(session: PracticeSession): FrameContext {
  return {
    app: { id: session.appId ?? newId("app"), name: session.appName ?? "Your mini-app" },
    env: "draft",
    user: { name: profile.userName || "You", role: profile.role },
    restaurant: { name: profile.restaurantName, brandColour: profile.brandColour },
    locations: profile.locations.slice(0, 8).map((location, index) => ({ id: PRACTICE_UUID(index + 1), name: location.name })),
    currency: "USD",
    locale: "en-US",
  };
}

/** A tiny Data API for the practice preview: it remembers what was typed and nothing else. */
function practiceData(route: string, body: unknown): { status: number; body: unknown } {
  const b = (body ?? {}) as { model?: string; ops?: { op: string; model: string; id?: string; values?: Record<string, unknown> }[] };
  if (route === DATA_ROUTES.catalog) {
    return {
      status: 200,
      body: {
        models: [
          {
            ref: "vendor",
            name: "Suppliers",
            description: "Everyone you buy from.",
            access: "write",
            fields: [
              { key: "name", label: "Name", type: "text", required: true },
              { key: "phone", label: "Phone", type: "text", required: false },
              { key: "delivers", label: "What they deliver", type: "text", required: false },
            ],
          },
        ],
        namedQueries: [],
        actions: [],
      },
    };
  }
  if (route === DATA_ROUTES.query) return { status: 200, body: { rows: rows.get(b.model ?? "") ?? [], nextCursor: null, masked: [] } };
  if (route === DATA_ROUTES.batch) {
    const results = (b.ops ?? []).map((op) => {
      const list = rows.get(op.model) ?? [];
      rows.set(op.model, list);
      const id = op.id ?? `0193a3c0-${hex(4)}-7${hex(4).slice(1)}-8${hex(4).slice(1)}-${hex(12)}`;
      const at = list.findIndex((row) => row.id === id);
      if (op.op === "delete") {
        if (at !== -1) list.splice(at, 1);
      } else if (at !== -1) {
        list[at] = { ...list[at], ...op.values };
      } else {
        list.push({ id, ...op.values });
      }
      return { op: op.op, model: op.model, id };
    });
    return { status: 200, body: { results } };
  }
  if (route === DATA_ROUTES.named) return { status: 200, body: { columns: [], rows: [], masked: [] } };
  return { status: 200, body: { affected: 0 } };
}

export const practiceAgentApi: AgentApi = {
  practice: true,

  describe(next) {
    profile = next;
  },

  async start(request: StartRunRequest): Promise<StartRunResponse> {
    if (practiceControls.offline) throw new AgentApiError("unavailable", "RMS is not answering just now. Try again in a moment.");
    const store = load();
    let session: PracticeSession;
    if (request.sessionId) {
      session = find(request.sessionId);
      if (active(session.run)) throw new AgentApiError("busy", "RMS is still working on the last thing. Stop it first, or wait a moment.");
      if (session.run?.status === "waiting") {
        session.run.status = "done";
        append(session, { type: "run.done" });
      }
    } else {
      const text = request.text ?? "";
      session = { sessionId: newId("ses"), recipe: recipeFor(text), request: text, events: [], run: null, stage: "start", plan: null, appId: null, appName: null, token: "" };
      store.sessions[session.sessionId] = session;
    }
    const runId = newId("run");
    session.run = { runId, status: "running", beats: [] };
    session.token = `practice-run-${hex(32)}`;
    append(session, { type: "run.started", runId, sessionId: session.sessionId as `ses_${string}`, mode: "build" });
    if (request.reply) append(session, { type: "user.reply", reply: request.reply });
    else append(session, { type: "user.message", text: request.text ?? "" });
    session.run.beats = script(session, request.reply ? { reply: request.reply } : { text: request.text ?? "" });
    save();
    wake(session.sessionId);
    return { sessionId: session.sessionId as `ses_${string}`, runId, eventsUrl: `/agent/v1/sessions/${session.sessionId}/events` };
  },

  async session(sessionId): Promise<SessionView> {
    if (practiceControls.offline) throw new AgentApiError("unavailable", "RMS is not answering just now. Try again in a moment.");
    const session = find(sessionId);
    const run = session.run;
    return {
      sessionId: session.sessionId as `ses_${string}`,
      mode: "build",
      status: session.stage === "closed" ? "closed" : "open",
      appId: session.appId,
      appName: session.appName,
      run: run ? { runId: run.runId as `run_${string}`, status: run.status } : null,
      lastSeq: session.events[session.events.length - 1]?.seq ?? 0,
      previewAvailable: session.stage === "built" && run !== null && ["running", "paused", "waiting"].includes(run.status) && session.events.some((e) => e.type === "preview.ready"),
    };
  },

  async events(sessionId, after, signal): Promise<Response> {
    if (practiceControls.offline) throw new TypeError("network");
    const session = load().sessions[sessionId];
    if (!session) return new Response(null, { status: 404 });
    return new Response(openStream(session, after, signal), { status: 200, headers: { "content-type": EVENT_STREAM.contentType } });
  },

  async preview(sessionId): Promise<PreviewGrant> {
    if (practiceControls.offline) throw new AgentApiError("unavailable", "RMS is not answering just now. Try again in a moment.");
    const session = find(sessionId);
    const run = session.run;
    if (!run || !["running", "paused", "waiting"].includes(run.status) || !session.events.some((e) => e.type === "preview.ready")) {
      throw new AgentApiError("unavailable", "The preview is not running just now.");
    }
    const url = new URL(practiceControls.previewUrl);
    if (session.token === "") session.token = `practice-run-${hex(32)}`;
    return {
      kind: "preview",
      appId: session.appId ?? newId("app"),
      appName: session.appName ?? "Your mini-app",
      url: url.href,
      frameOrigin: url.origin,
      token: session.token,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      context: context(session),
      runId: run.runId as `run_${string}`,
    };
  },

  async cancel(runId): Promise<void> {
    const session = Object.values(load().sessions).find((s) => s.run?.runId === runId);
    if (!session || !session.run) throw new AgentApiError("not_found", "That build could not be found.");
    if (!active(session.run)) return;
    session.run.status = "cancelled";
    session.run.beats = [];
    append(session, { type: "run.cancelled" });
    wake(session.sessionId);
  },

  async data(route, token, body) {
    if (practiceControls.offline) throw new TypeError("network");
    const live = token !== "" && Object.values(load().sessions).some((s) => s.token === token && s.run !== null && ["running", "paused", "waiting"].includes(s.run.status));
    if (!live) return { status: 401, body: { error: { code: "unauthenticated", message: "Please open this again from RMS.", requestId: "practice" } } };
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      return { status: 400, body: { error: { code: "invalid_request", message: "That could not be read.", requestId: "practice" } } };
    }
    return practiceData(route, parsed);
  },
};

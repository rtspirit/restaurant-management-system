// The build session's behaviour, without a screen: this is what `useBuildSession` runs.
import type { AgentEvent, RunStatus, SessionView, StartRunRequest } from "@rms/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentApiError, type AgentApi } from "./client";
import { MONEY_SESSION } from "./fixtures";
import { practiceAgentApi, practiceControls, resetPractice } from "./mock";
import { createBuildSession, type BuildSessionController, type SessionSnapshot } from "./session";

const SESSION = "ses_0193a3c0000070008000000000000060";
const RUN = "run_0193a3c0000070008000000000000061";
const stored = (event: AgentEvent) => `id: ${event.seq}\nevent: agent\ndata: ${JSON.stringify(event)}\n\n`;
/** A stored event from a server newer than this screen: it has its number, and a shape nobody here knows. */
const unreadable = (seq: number) => `id: ${seq}\nevent: agent\ndata: ${JSON.stringify({ type: "run.rested", seq, at: "2026-11-21T15:04:00.000Z", until: "tomorrow" })}\n\n`;

const body = (pieces: string[]): Response => {
  const encoder = new TextEncoder();
  let i = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const piece = pieces[i];
        i += 1;
        if (piece !== undefined) controller.enqueue(encoder.encode(piece));
        else controller.close();
      },
    }),
    { status: 200 },
  );
};

const view = (status: RunStatus, lastSeq: number): SessionView => ({ sessionId: SESSION, mode: "build", status: "open", appId: null, appName: null, run: { runId: RUN, status }, lastSeq, previewAvailable: false });

/** Routes that answer from a script: `streams[n]` is what the nth opening of the event stream sends. */
function scripted(options: { statuses: RunStatus[]; streams: Array<(after: number) => string[]>; start?: AgentApi["start"]; retry?: AgentApi["retry"] }) {
  const opened: number[] = [];
  const started: StartRunRequest[] = [];
  let asked = 0;
  const api: AgentApi = {
    practice: false,
    session: async () => {
      const status = options.statuses[Math.min(asked, options.statuses.length - 1)] ?? "waiting";
      asked += 1;
      return view(status, 0);
    },
    events: async (_id, after) => {
      opened.push(after);
      const next = options.streams[opened.length - 1];
      return next ? body(next(after)) : body([]);
    },
    start: async (request) => {
      started.push(request);
      if (options.start) return options.start(request);
      return { sessionId: SESSION, runId: RUN, eventsUrl: "" };
    },
    preview: async () => {
      throw new AgentApiError("unavailable", "The preview is not running just now.");
    },
    cancel: async () => undefined,
    data: async () => ({ status: 200, body: {} }),
    ...(options.retry ? { retry: options.retry } : {}),
  };
  return { api, opened, started };
}

const until = async (controller: BuildSessionController, done: (s: SessionSnapshot) => boolean, what: string): Promise<SessionSnapshot> => {
  for (let i = 0; i < 400; i += 1) {
    if (done(controller.getSnapshot())) return controller.getSnapshot();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`never happened: ${what} (phase ${controller.getSnapshot().view.phase}, seq ${controller.getSnapshot().view.lastSeq})`);
};
const noWait = async () => undefined;
const build = MONEY_SESSION.slice(0, 24);

beforeEach(() => {
  resetPractice();
  practiceControls.speed = 0;
});

describe("an event this screen cannot read", () => {
  it("in the middle of a run it is stepped over: the stream is opened once and everything after it arrives", async () => {
    // Event 17 cannot be read. Without stepping over it, 18 onwards are gaps for ever.
    const pieces = build.map((event) => (event.seq === 17 ? unreadable(17) : stored(event)));
    const { api, opened } = scripted({ statuses: ["running"], streams: [() => pieces] });
    const controller = createBuildSession(api, SESSION, { sleep: noWait });
    controller.start();
    const end = await until(controller, (s) => s.view.phase === "your-turn" && s.connection === "idle", "the run to finish");
    expect(end.view.lastSeq).toBe(24);
    expect(end.view.preview).toMatchObject({ appName: "Money", version: 1 });
    expect(opened).toEqual([0]);
    expect(end.settled).toBe(true);
    controller.dispose();
  });

  it("when it is the stop event, the screen does not stay on Stop: it asks the session how the run ended", async () => {
    // The run's last event (run.waiting, 24) cannot be read.
    const pieces = [...build.slice(0, 23).map(stored), unreadable(24)];
    const { api, opened } = scripted({ statuses: ["running", "waiting"], streams: [() => pieces] });
    const controller = createBuildSession(api, SESSION, { sleep: noWait });
    controller.start();
    const end = await until(controller, (s) => s.view.phase !== "working" && s.connection === "idle" && s.view.lastSeq === 24, "the screen to leave Stop");
    expect(end.view.phase).toBe("your-turn");
    expect(end.view.waitingFor).toBe("review");
    // It did not knock again and again at the same place.
    expect(opened).toEqual([0]);
    controller.dispose();
  });

  it("a run that failed with an unreadable last event ends as a plain failure, with no step left turning", async () => {
    const pieces = [...build.slice(0, 20).map(stored), unreadable(21)];
    const { api } = scripted({ statuses: ["running", "failed"], streams: [() => pieces] });
    const controller = createBuildSession(api, SESSION, { sleep: noWait });
    controller.start();
    const end = await until(controller, (s) => s.view.phase === "failed", "the failure to show");
    expect(end.view.items.at(-1)).toMatchObject({ kind: "failed", retryable: false });
    expect(end.view.items.find((item) => item.kind === "steps")?.steps.some((step) => step.state === "now")).toBe(false);
    controller.dispose();
  });
});

describe("sending while RMS is busy", () => {
  it("a busy answer says so and opens the stream again, so the run it was busy with is watched", async () => {
    const first = build.slice(0, 12); // a plan is waiting
    const later = build.slice(12); // meanwhile (another tab) the plan was confirmed and built
    const { api, opened, started } = scripted({
      statuses: ["waiting"],
      streams: [() => first.map(stored), () => later.map(stored)],
      start: async () => {
        throw new AgentApiError("busy", "I'm still working on the last thing you asked.");
      },
    });
    const controller = createBuildSession(api, SESSION, { sleep: noWait });
    controller.start();
    await until(controller, (s) => s.view.lastSeq === 12 && s.connection === "idle", "the plan to show");
    expect(opened).toEqual([0]);

    controller.actions.say("Add the tips too");
    const end = await until(controller, (s) => s.view.lastSeq === 24 && s.connection === "idle", "the other run to be followed");
    expect(started).toHaveLength(1);
    expect(opened).toEqual([0, 12]); // reopened, from where the screen was
    expect(end.problem).toBe("I'm still working on the last thing you asked.");
    expect(end.sending).toBeNull();
    expect(end.busy).toBe(false);
    expect(end.view.preview?.version).toBe(1);
    controller.dispose();
  });

  it("any other refusal shows its plain words and opens nothing", async () => {
    const { api, opened } = scripted({
      statuses: ["waiting"],
      streams: [() => build.slice(0, 12).map(stored)],
      start: async () => {
        throw new AgentApiError("limit", "That is too much at once. Please try again in a moment.");
      },
    });
    const controller = createBuildSession(api, SESSION, { sleep: noWait });
    controller.start();
    await until(controller, (s) => s.view.lastSeq === 12 && s.connection === "idle", "the plan to show");
    controller.actions.say("Add the tips too");
    const end = await until(controller, (s) => s.problem !== null && !s.busy, "the refusal to show");
    expect(end.problem).toBe("That is too much at once. Please try again in a moment.");
    expect(opened).toEqual([0]);
    controller.dispose();
  });
});

describe("try again", () => {
  const failed: AgentEvent[] = [...build.slice(0, 20), { type: "run.failed", seq: 21, at: "2026-11-21T15:04:42.000Z", text: "That took too long and was stopped.", retryable: true }];

  it("uses the retry call with the failed run's id, and never sends the words as a message", async () => {
    const retry = vi.fn(async () => ({ sessionId: SESSION, runId: RUN, eventsUrl: "" }) as const);
    const { api, opened, started } = scripted({ statuses: ["failed"], streams: [() => failed.map(stored), () => []], retry });
    const controller = createBuildSession(api, SESSION, { sleep: noWait });
    controller.start();
    const before = await until(controller, (s) => s.view.phase === "failed" && s.connection === "idle", "the failure to show");
    expect(before.canRetry).toBe(true);
    controller.actions.retry();
    await until(controller, () => opened.length === 2, "the stream to be followed again");
    expect(retry).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledWith(before.view.runId);
    expect(started).toEqual([]);
    expect(controller.getSnapshot().sending).toBeNull();
    controller.dispose();
  });

  it("without a retry call there is no Try again, and pressing it anyway sends nothing", async () => {
    const { api, opened, started } = scripted({ statuses: ["failed"], streams: [() => failed.map(stored)] });
    const controller = createBuildSession(api, SESSION, { sleep: noWait });
    controller.start();
    const before = await until(controller, (s) => s.view.phase === "failed" && s.connection === "idle", "the failure to show");
    expect(before.canRetry).toBe(false);
    controller.actions.retry();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started).toEqual([]);
    expect(opened).toEqual([0]);
    controller.dispose();
  });

  it("only a failed run can be tried again", async () => {
    const retry = vi.fn(async () => ({ sessionId: SESSION, runId: RUN, eventsUrl: "" }) as const);
    const { api } = scripted({ statuses: ["waiting"], streams: [() => build.slice(0, 12).map(stored)], retry });
    const controller = createBuildSession(api, SESSION, { sleep: noWait });
    controller.start();
    await until(controller, (s) => s.view.lastSeq === 12 && s.connection === "idle", "the plan to show");
    controller.actions.retry();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(retry).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("on the practice routes: a build that stopped short is run again and no message from the owner is stored", async () => {
    const api = practiceAgentApi;
    const { sessionId } = await api.start({ mode: "build", text: "Keep a list of my suppliers" });
    const controller = createBuildSession(api, sessionId, { sleep: noWait });
    controller.start();
    const pending = async () => (await until(controller, (s) => s.view.pending !== null && s.connection === "idle" && !s.busy, "something to answer")).view.pending;
    controller.actions.answer((await pending())?.id ?? "", "One list for both");
    await until(controller, (s) => s.view.items.filter((item) => item.kind === "question").length === 2 && s.view.pending !== null, "the second question");
    controller.actions.answer((await pending())?.id ?? "", "Nothing else");
    const plan = await until(controller, (s) => s.view.pending?.kind === "plan" && s.connection === "idle" && !s.busy, "the plan");
    practiceControls.failNextBuild = true;
    controller.actions.buildPlan(plan.view.pending?.id ?? "");
    const stopped = await until(controller, (s) => s.view.phase === "failed" && s.connection === "idle" && !s.busy, "the build to stop short");
    expect(stopped.canRetry).toBe(true);
    const messagesBefore = stopped.view.items.filter((item) => item.kind === "you").length;

    controller.actions.retry();
    const end = await until(controller, (s) => s.view.phase === "your-turn" && s.view.preview !== null && s.connection === "idle", "the build to finish");
    expect(end.view.preview?.version).toBe(1);
    expect(end.view.items.filter((item) => item.kind === "you")).toHaveLength(messagesBefore);
    expect(JSON.stringify(end.view.items)).not.toMatch(/try again/i);
    controller.dispose();
  });
});

describe("opening a session", () => {
  it("someone else's session is not found, and nothing is followed", async () => {
    const { api, opened } = scripted({ statuses: ["waiting"], streams: [] });
    api.session = async () => {
      throw new AgentApiError("not_found", "That build could not be found.");
    };
    const controller = createBuildSession(api, SESSION);
    controller.start();
    await until(controller, (s) => s.load === "not-found", "not found");
    expect(opened).toEqual([]);
    controller.dispose();
  });

  it("when RMS does not answer it says so, and trying again loads it", async () => {
    let down = true;
    const { api } = scripted({ statuses: ["waiting"], streams: [() => build.slice(0, 12).map(stored)] });
    const session = api.session;
    api.session = async (id) => {
      if (down) throw new AgentApiError("unavailable", "RMS is not answering just now.");
      return session(id);
    };
    const controller = createBuildSession(api, SESSION, { sleep: noWait });
    controller.start();
    await until(controller, (s) => s.load === "unavailable", "unavailable");
    down = false;
    controller.start();
    const end = await until(controller, (s) => s.load === "ready" && s.view.lastSeq === 12, "the session to load");
    expect(end.view.pending?.kind).toBe("plan");
    controller.dispose();
  });

  it("after it is put away, nothing that arrives late changes it", async () => {
    let release: (v: SessionView) => void = () => undefined;
    const { api, opened } = scripted({ statuses: ["waiting"], streams: [() => build.map(stored)] });
    api.session = () => new Promise<SessionView>((resolve) => (release = resolve));
    const controller = createBuildSession(api, SESSION);
    controller.start();
    controller.dispose();
    release(view("waiting", 24));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(opened).toEqual([]);
    expect(controller.getSnapshot().load).toBe("loading");
  });
});

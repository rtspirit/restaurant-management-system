// The practice API through the real stream client and reducer: the same path the screen takes.
import { AgentEvent, PreviewGrant, SessionView, type RunReply } from "@rms/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { AgentApiError } from "./client";
import { practiceAgentApi as api, practiceControls, resetPractice } from "./mock";
import { EMPTY_VIEW, applyEvent, reduceEvents, type BuildView } from "./reducer";
import { followSession } from "./stream";

type Seen = { view: BuildView; events: AgentEvent[]; outcomes: string[]; opened: number[]; waits: number[] };

const fresh = (): Seen => ({ view: EMPTY_VIEW, events: [], outcomes: [], opened: [], waits: [] });

/** Follows the session until its run stops, like the screen does. */
async function follow(sessionId: string, seen: Seen, working = true): Promise<string> {
  const following = followSession({
    open: (after, signal) => {
      seen.opened.push(after);
      return api.events(sessionId, after, signal);
    },
    after: seen.view.lastSeq,
    working,
    onEvent: (event) => {
      const result = applyEvent(seen.view, event);
      seen.view = result.view;
      seen.outcomes.push(result.outcome);
      seen.events.push(event);
    },
    sleep: async (ms) => {
      seen.waits.push(ms);
      // Whatever broke the connection is over by the time we knock again.
      practiceControls.offline = false;
    },
  });
  return following.ended;
}

async function send(sessionId: string, seen: Seen, what: { text: string } | { reply: RunReply }): Promise<void> {
  await api.start({ sessionId: sessionId as `ses_${string}`, mode: "build", ...what });
  expect(await follow(sessionId, seen)).toBe("finished");
}

async function begin(text: string): Promise<{ sessionId: string; seen: Seen }> {
  const { sessionId } = await api.start({ mode: "build", text });
  const seen = fresh();
  expect(await follow(sessionId, seen)).toBe("finished");
  return { sessionId, seen };
}

const pendingId = (seen: Seen): string => {
  if (!seen.view.pending) throw new Error("nothing is waiting");
  return seen.view.pending.id;
};

/** From the first message to a preview: two questions, a plan, a build. */
async function buildSuppliers(text = "Keep a list of my suppliers") {
  const { sessionId, seen } = await begin(text);
  await send(sessionId, seen, { reply: { kind: "answer", to: pendingId(seen), text: "One list for both" } });
  await send(sessionId, seen, { reply: { kind: "answer", to: pendingId(seen), text: "What they deliver" } });
  await send(sessionId, seen, { reply: { kind: "confirm", to: pendingId(seen), ok: true } });
  return { sessionId, seen };
}

beforeEach(() => {
  resetPractice();
  practiceControls.speed = 0;
});

describe("a practice build, through the real stream client", () => {
  it("goes from the first message to a preview, and every event is a real AgentEvent in order", async () => {
    const { sessionId, seen } = await buildSuppliers();

    expect(seen.view.phase).toBe("your-turn");
    expect(seen.view.waitingFor).toBe("review");
    expect(seen.view.preview).toMatchObject({ appName: "Suppliers", version: 1 });
    expect(seen.view.runCount).toBe(4);

    const stored = seen.events.filter((e) => e.type !== "message.delta" && e.type !== "run.paused");
    expect(stored.map((e) => e.seq)).toEqual(stored.map((_, i) => i + 1));
    for (const event of seen.events) expect(AgentEvent.safeParse(event).success).toBe(true);
    expect(seen.outcomes).not.toContain("gap");
    expect(seen.outcomes).not.toContain("duplicate");

    const view = await api.session(sessionId);
    expect(SessionView.safeParse(view).success).toBe(true);
    expect(view).toMatchObject({ lastSeq: seen.view.lastSeq, previewAvailable: true, run: { status: "waiting" } });
  });

  it("asks no more than three questions before it shows a plan, and the plan says what was assumed", async () => {
    const { seen } = await buildSuppliers();
    const types = seen.events.map((e) => e.type);
    expect(types.slice(0, types.indexOf("plan.proposed")).filter((t) => t === "question").length).toBeLessThanOrEqual(3);
    const plan = seen.view.items.find((item) => item.kind === "plan");
    expect(plan?.plan.assumptions.length).toBeGreaterThan(0);
    expect(plan?.confirmed).toBe(true);
  });

  it("the build is paused part-way, as a function is after 270 seconds, and carries on in the next request", async () => {
    const { seen } = await buildSuppliers();
    expect(seen.events.filter((e) => e.type === "run.paused")).toHaveLength(1);
    // The stream was opened once per run, plus once more to carry on after the pause.
    expect(seen.opened).toHaveLength(5);
    expect(seen.waits).toEqual([]);
    const steps = seen.view.items.find((item) => item.kind === "steps");
    expect(steps?.steps.map((s) => s.state)).toEqual(["done", "done", "done"]);
  });

  it("a reload replays the whole conversation from the first event and lands on the same screen", async () => {
    const { sessionId, seen } = await buildSuppliers();
    const again = fresh();
    expect(await follow(sessionId, again, false)).toBe("finished");
    expect(again.opened).toEqual([0]);
    expect(again.view).toEqual(seen.view);
    expect(again.view).toEqual(reduceEvents(again.events));
  });

  it("a dropped connection mid-build recovers from the last seq with nothing lost or doubled", async () => {
    const { sessionId, seen } = await begin("Keep a list of my suppliers");
    await send(sessionId, seen, { reply: { kind: "answer", to: pendingId(seen), text: "One list for both" } });
    await send(sessionId, seen, { reply: { kind: "answer", to: pendingId(seen), text: "Nothing else" } });
    await api.start({ sessionId: sessionId as `ses_${string}`, mode: "build", reply: { kind: "confirm", to: pendingId(seen), ok: true } });

    // Cut the connection as soon as the first step shows.
    const following = followSession({
      open: (after, signal) => {
        seen.opened.push(after);
        return api.events(sessionId, after, signal);
      },
      after: seen.view.lastSeq,
      working: true,
      onEvent: (event) => {
        const result = applyEvent(seen.view, event);
        seen.view = result.view;
        seen.outcomes.push(result.outcome);
        seen.events.push(event);
        if (event.type === "step" && seen.waits.length === 0) practiceControls.offline = true;
      },
      sleep: async (ms) => {
        seen.waits.push(ms);
        if (seen.waits.length === 2) practiceControls.offline = false; // down for two tries
      },
    });
    expect(await following.ended).toBe("finished");

    expect(seen.waits.slice(0, 2)).toEqual([500, 1000]);
    expect(seen.outcomes).not.toContain("gap");
    expect(seen.outcomes).not.toContain("duplicate");
    expect(seen.view.preview?.version).toBe(1);
    const again = fresh();
    await follow(sessionId, again, false);
    expect(again.view).toEqual(seen.view);
  });

  it("sending while RMS is working is refused as busy, in plain words", async () => {
    const { sessionId } = await api.start({ mode: "build", text: "Keep a list of my suppliers" });
    const refused = await api.start({ sessionId, mode: "build", text: "And another thing" }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(AgentApiError);
    expect((refused as AgentApiError).code).toBe("busy");
    expect((refused as AgentApiError).message).toMatch(/still working/);
  });

  it("Stop ends the run with one stop event and leaves no step turning", async () => {
    const { sessionId, seen } = await begin("Keep a list of my suppliers");
    await send(sessionId, seen, { reply: { kind: "answer", to: pendingId(seen), text: "One list for both" } });
    await send(sessionId, seen, { reply: { kind: "answer", to: pendingId(seen), text: "Nothing else" } });
    const { runId } = await api.start({ sessionId: sessionId as `ses_${string}`, mode: "build", reply: { kind: "confirm", to: pendingId(seen), ok: true } });
    practiceControls.speed = 1;
    const ended = follow(sessionId, seen);
    await new Promise((resolve) => setTimeout(resolve, 900));
    await api.cancel(runId);
    expect(await ended).toBe("finished");
    expect(seen.view.phase).toBe("cancelled");
    expect(seen.events.filter((e) => e.type === "run.cancelled")).toHaveLength(1);
    expect(seen.view.items.at(-1)?.kind).toBe("stopped");
    expect(seen.view.items.find((item) => item.kind === "steps")?.steps.some((s) => s.state === "now")).toBe(false);
    expect((await api.session(sessionId)).run?.status).toBe("cancelled");
    // Nothing more happens until the owner says so.
    const after = fresh();
    await follow(sessionId, after, false);
    expect(after.view).toEqual(seen.view);
  });

  it("a build that stops short says so plainly and can be tried again", async () => {
    practiceControls.failNextBuild = true;
    const { sessionId, seen } = await buildSuppliers();
    expect(seen.view.phase).toBe("failed");
    const failed = seen.view.items.at(-1);
    expect(failed).toMatchObject({ kind: "failed", retryable: true });
    expect(failed && "text" in failed ? failed.text : "").not.toMatch(/error|exception|timeout|stack|\d{3}/i);
    // Trying again is its own call. The words are never sent as a message.
    if (!api.retry || !seen.view.runId) throw new Error("the practice routes can retry");
    await api.retry(seen.view.runId);
    expect(await follow(sessionId, seen)).toBe("finished");
    expect(seen.view.phase).toBe("your-turn");
    expect(seen.view.preview?.version).toBe(1);
    expect(seen.events.filter((e) => e.type === "user.message")).toHaveLength(1);
    // A run that did not fail cannot be tried again.
    expect(await api.retry(seen.view.runId ?? "").catch((error: unknown) => (error as AgentApiError).code)).toBe("invalid_request");
  });

  it("something RMS cannot do yet is refused in plain words, not half-built", async () => {
    const { seen } = await begin("Print my supplier list every Monday");
    expect(seen.view.phase).toBe("failed");
    expect(seen.view.items.at(-1)).toMatchObject({ kind: "failed", retryable: false });
  });

  it("asking for the same thing again says you already have this", async () => {
    await buildSuppliers("Keep a list of my suppliers");
    const { sessionId, seen } = await begin("keep a list of my SUPPLIERS!");
    expect(seen.view.pending?.kind).toBe("duplicate");
    const found = seen.view.items.find((item) => item.kind === "duplicate");
    expect(found?.matches[0]?.appName).toBe("Suppliers");
    await send(sessionId, seen, { reply: { kind: "choose", to: pendingId(seen), choice: "build_anyway" } });
    expect(seen.view.pending?.kind).toBe("question");
  });

  it("a change after the preview rebuilds it and offers undo", async () => {
    const { sessionId, seen } = await buildSuppliers();
    await send(sessionId, seen, { text: "Add a phone number" });
    expect(seen.view.preview?.version).toBe(2);
    expect(seen.view.canUndo).toBe(true);
    await send(sessionId, seen, { text: "Undo that last change" });
    expect(seen.view.items.findLast((item) => item.kind === "rms")).toMatchObject({ text: "I’ve put it back the way it was." });
  });
});

describe("the practice preview", () => {
  it("hands out a real PreviewGrant from 127.0.0.1, never localhost", async () => {
    const { sessionId } = await buildSuppliers();
    const grant = await api.preview(sessionId);
    expect(PreviewGrant.safeParse(grant).success).toBe(true);
    expect(new URL(grant.url).hostname).toBe("127.0.0.1");
    expect(grant.context).toMatchObject({ env: "draft", restaurant: { name: "Marigold Kitchen" } });
  });

  it("has no preview to hand out before one is built", async () => {
    const { sessionId } = await begin("Keep a list of my suppliers");
    expect(await api.preview(sessionId).catch((error: unknown) => (error as AgentApiError).code)).toBe("unavailable");
    expect((await api.session(sessionId)).previewAvailable).toBe(false);
  });

  it("a token dies with its run: the old one is refused once a new run starts", async () => {
    const { sessionId, seen } = await buildSuppliers();
    const first = await api.preview(sessionId);
    const add = JSON.stringify({ ops: [{ op: "insert", model: "vendor", values: { name: "Green Valley Produce", phone: "555-0142" } }] });
    expect((await api.data("/data/v1/batch", first.token, add)).status).toBe(200);
    expect(await api.data("/data/v1/query", first.token, JSON.stringify({ model: "vendor" }))).toMatchObject({ status: 200, body: { rows: [{ name: "Green Valley Produce" }] } });

    await send(sessionId, seen, { text: "Add a phone number" });
    const second = await api.preview(sessionId);
    expect(second.token).not.toBe(first.token);
    expect(second.runId).not.toBe(first.runId);
    expect(await api.data("/data/v1/query", first.token, "{}")).toMatchObject({ status: 401, body: { error: { code: "unauthenticated" } } });
    expect((await api.data("/data/v1/query", second.token, JSON.stringify({ model: "vendor" }))).status).toBe(200);
  });

  it("someone else's session is simply not found", async () => {
    const missing = "ses_0193a3c0000070008000000000000069";
    expect(await api.session(missing).catch((error: unknown) => (error as AgentApiError).code)).toBe("not_found");
    expect((await api.events(missing, 0, new AbortController().signal)).status).toBe(404);
  });
});

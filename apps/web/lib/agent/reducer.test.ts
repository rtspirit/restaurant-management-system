import { AgentEvent } from "@rms/contracts";
import { describe, expect, it } from "vitest";
import { MONEY_SESSION, RECORDED, RECORDED_STATES, record, type EventBody } from "./fixtures";
import { EMPTY_VIEW, afterReconnect, applyEvent, reduceEvents, type BuildView } from "./reducer";

const view = (state: keyof typeof RECORDED): BuildView => reduceEvents(RECORDED[state]);
const kinds = (v: BuildView) => v.items.map((item) => item.kind);

describe("the recorded sessions", () => {
  it("every recorded event is a real AgentEvent, numbered with no gaps", () => {
    for (const state of RECORDED_STATES) {
      const events = RECORDED[state];
      events.forEach((event, index) => {
        expect(AgentEvent.safeParse(event).success, `${state} #${index}`).toBe(true);
        expect(event.seq).toBe(index + 1);
      });
    }
  });

  it("no recorded words show the machinery: no code, paths, commands or error text", () => {
    const words = JSON.stringify(RECORDED_STATES.map((state) => RECORDED[state].map((e) => ({ ...e, runId: "", sessionId: "", appId: "", at: "" }))));
    expect(words).not.toMatch(/[{};]\s*$|=>|\bSELECT\b|\bnull\b|undefined|Error:|\/[a-z]+\/[a-z]+|\.tsx?\b|npm |pnpm /);
  });
});

describe("replay and live agree", () => {
  it("replaying from 0 gives the same screen as watching it live, deltas, pauses and all", () => {
    const replayed = reduceEvents(MONEY_SESSION);

    // Live: the same stored events, with words arriving in pieces, a pause, and a reconnect that
    // re-sends a few events the screen already has.
    let live = EMPTY_VIEW;
    const at = "2026-11-21T15:04:00.000Z";
    for (const event of MONEY_SESSION) {
      if (event.type === "message.done") {
        live = applyEvent(live, { type: "message.delta", seq: live.lastSeq, at, text: event.text.slice(0, 5) }).view;
        live = applyEvent(live, { type: "message.delta", seq: live.lastSeq, at, text: event.text.slice(5) }).view;
        expect(live.typing).toBe(event.text);
      }
      live = applyEvent(live, event).view;
      if (event.seq === 18) {
        live = applyEvent(live, { type: "run.paused", seq: 18, at }).view;
        live = afterReconnect(live);
        for (const again of MONEY_SESSION.slice(14, 18)) live = applyEvent(live, again).view;
      }
    }
    expect(live).toEqual(replayed);
    expect(replayed.lastSeq).toBe(MONEY_SESSION.length);
  });

  it("replaying in two halves, as after a reload part-way, ends in the same place", () => {
    const half = reduceEvents(MONEY_SESSION.slice(0, 13));
    expect(reduceEvents(MONEY_SESSION.slice(13), half)).toEqual(reduceEvents(MONEY_SESSION));
  });
});

describe("numbering", () => {
  it("an event seen before is ignored and changes nothing", () => {
    const before = view("plan");
    for (const event of RECORDED.plan) {
      const result = applyEvent(before, event);
      expect(result.outcome).toBe("duplicate");
      expect(result.view).toBe(before);
    }
  });

  it("an event that skips ahead is refused and changes nothing", () => {
    const before = view("question");
    const ahead = RECORDED.plan[10];
    if (!ahead) throw new Error("fixture");
    const result = applyEvent(before, ahead);
    expect(result.outcome).toBe("gap");
    expect(result.view).toBe(before);
    expect(result.view.lastSeq).toBe(8);
  });

  it("live-only events never move the place", () => {
    const before = view("progress");
    const delta = applyEvent(before, { type: "message.delta", seq: 999, at: "2026-11-21T15:04:00.000Z", text: "Nearly" });
    expect(delta.outcome).toBe("live");
    expect(delta.view.lastSeq).toBe(before.lastSeq);
    expect(delta.view.typing).toBe("Nearly");
    const paused = applyEvent(before, { type: "run.paused", seq: 999, at: "2026-11-21T15:04:00.000Z" });
    expect(paused.outcome).toBe("live");
    expect(paused.view).toBe(before);
  });

  it("half-arrived words are dropped on a reconnect, and the finished message replaces them", () => {
    const typing = applyEvent(view("progress"), { type: "message.delta", seq: 20, at: "2026-11-21T15:04:00.000Z", text: "Mon" }).view;
    expect(afterReconnect(typing).typing).toBe("");
  });
});

describe("what the owner sees", () => {
  it("first message: their words, and RMS working", () => {
    const v = view("first");
    expect(kinds(v)).toEqual(["you"]);
    expect(v.phase).toBe("working");
    expect(v.pending).toBeNull();
  });

  it("a question waits for an answer, and an answered one folds away", () => {
    const v = view("question");
    expect(v.phase).toBe("your-turn");
    expect(v.waitingFor).toBe("reply");
    expect(v.pending).toEqual({ kind: "question", id: "q2", choices: ["Every week", "Every day", "Every month"] });
    const questions = v.items.filter((item) => item.kind === "question");
    expect(questions.map((q) => q.answer)).toEqual(["Both", null]);
  });

  it("you already have this: the match, its reason, and a choice to make", () => {
    const v = view("duplicate");
    expect(v.pending).toEqual({ kind: "duplicate", id: "d1" });
    const found = v.items.find((item) => item.kind === "duplicate");
    expect(found?.matches[0]?.appName).toBe("Money");
    const chosen = reduceEvents(record([{ type: "user.reply", reply: { kind: "choose", to: "d1", choice: "build_anyway" } }]).map((e) => ({ ...e, seq: 5 })), v);
    expect(chosen.pending).toBeNull();
    expect(chosen.items.at(-1)).toMatchObject({ kind: "you", text: "Build a separate one" });
  });

  it("the plan shows what was assumed and waits to be confirmed", () => {
    const v = view("plan");
    const plan = v.items.find((item) => item.kind === "plan");
    expect(plan?.confirmed).toBe(false);
    expect(plan?.plan.assumptions.length).toBeGreaterThan(0);
    expect(v.pending).toEqual({ kind: "plan", id: "p1" });
    // No more than three questions came before it.
    expect(v.items.filter((item) => item.kind === "question").length).toBeLessThanOrEqual(3);
  });

  it("progress: one card of steps, done and in progress as words, never a colour", () => {
    const v = view("progress");
    const steps = v.items.find((item) => item.kind === "steps");
    expect(steps?.steps.map((s) => s.state)).toEqual(["done", "done", "now"]);
    expect(steps?.steps.map((s) => s.label)).toEqual(["Set up your sales days", "Built your weekly screen", "Checking the numbers add up"]);
    expect(v.items.find((item) => item.kind === "plan")?.confirmed).toBe(true);
    expect(v.phase).toBe("working");
  });

  it("preview ready: the composer is the owner's again, and the preview has a version", () => {
    const v = view("preview");
    expect(v.preview).toMatchObject({ appName: "Money", version: 1 });
    expect(v.phase).toBe("your-turn");
    expect(v.waitingFor).toBe("review");
    expect(v.canUndo).toBe(false);
  });

  it("after a change lands on a preview they had seen, undo is offered and the preview reloads", () => {
    const v = view("changed");
    expect(v.preview?.version).toBe(2);
    expect(v.canUndo).toBe(true);
    expect(v.runCount).toBe(5);
  });

  it("a change that needs a yes waits in a dialog with one sentence", () => {
    const v = view("confirm");
    expect(v.pending?.kind).toBe("confirm");
    expect(v.pending && "text" in v.pending ? v.pending.text : "").toMatch(/Downtown only/);
  });

  it("a failure is plain words, can be tried again, and no step is left turning", () => {
    const v = view("failure");
    expect(v.phase).toBe("failed");
    expect(v.items.at(-1)).toMatchObject({ kind: "failed", retryable: true });
    const steps = v.items.find((item) => item.kind === "steps");
    expect(steps?.steps.some((s) => s.state === "now")).toBe(false);
    expect(steps).toMatchObject({ halted: true });
    expect(steps?.steps.at(-1)).toEqual({ id: "s3", label: "Checking the numbers add up", state: "todo" });
  });

  it("stopping says so, clears whatever was waiting, and leaves no step turning", () => {
    const stopped = reduceEvents(record([{ type: "run.cancelled" } satisfies EventBody]).map((e) => ({ ...e, seq: 21 })), view("progress"));
    expect(stopped.phase).toBe("cancelled");
    expect(stopped.items.at(-1)?.kind).toBe("stopped");
    expect(stopped.items.find((item) => item.kind === "steps")?.steps.some((s) => s.state === "now")).toBe(false);
    expect(stopped.items.find((item) => item.kind === "steps")?.halted).toBe(true);
    // A card whose work finished is never marked.
    expect(reduceEvents(RECORDED.preview).items.find((item) => item.kind === "steps")?.halted).toBe(false);
  });

  it("a step that fails says so in words", () => {
    const failed = reduceEvents(record([{ type: "step", id: "s3", label: "Checking the numbers add up", state: "failed" } satisfies EventBody]).map((e) => ({ ...e, seq: 21 })), view("progress"));
    const card = failed.items.find((item) => item.kind === "steps");
    expect(card?.halted).toBe(true);
    expect(card?.steps.at(-1)).toEqual({ id: "s3", label: "Checking the numbers add up", state: "todo" });
  });

  it("events meant for Ask still count but draw nothing", () => {
    const before = view("preview");
    const after = applyEvent(before, { type: "answer.source", seq: 25, at: "2026-11-21T15:04:00.000Z", text: "Your sales days" });
    expect(after.outcome).toBe("applied");
    expect(after.view.items).toBe(before.items);
    expect(after.view.lastSeq).toBe(25);
  });
});

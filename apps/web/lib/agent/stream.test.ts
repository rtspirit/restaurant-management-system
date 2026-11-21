import type { AgentEvent } from "@rms/contracts";
import { describe, expect, it } from "vitest";
import { MONEY_SESSION } from "./fixtures";
import { createSseParser } from "./sse";
import { backoffMs, followSession, parseAgentEvent, type StreamStatus } from "./stream";

const AT = "2026-11-21T15:04:00.000Z";
const stored = (event: AgentEvent) => `id: ${event.seq}\nevent: agent\ndata: ${JSON.stringify(event)}\n\n`;
const live = (event: AgentEvent) => `event: agent\ndata: ${JSON.stringify(event)}\n\n`;

/** A response whose body sends the given pieces, then ends, or breaks if `breakAfter` is set. */
function body(pieces: string[], breakAfter = false): Response {
  const encoder = new TextEncoder();
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const piece = pieces[i];
      i += 1;
      if (piece !== undefined) controller.enqueue(encoder.encode(piece));
      else if (breakAfter) controller.error(new TypeError("network"));
      else controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Runs `followSession` against a scripted list of connections. Records what was asked for and what came out. */
async function follow(connections: Array<(after: number) => Response | Promise<Response>>, options: { after?: number; working?: boolean; stillWorking?: () => Promise<boolean> } = {}) {
  const asked: number[] = [];
  const events: AgentEvent[] = [];
  const waits: number[] = [];
  const statuses: StreamStatus[] = [];
  const skipped: number[] = [];
  const following = followSession({
    onSkip: (seq) => skipped.push(seq),
    open: async (after) => {
      asked.push(after);
      const next = connections[asked.length - 1];
      if (!next) throw new Error("no more connections scripted");
      return next(after);
    },
    after: options.after ?? 0,
    working: options.working ?? true,
    onEvent: (event) => events.push(event),
    onStatus: (status) => statuses.push(status),
    ...(options.stillWorking ? { stillWorking: options.stillWorking } : {}),
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  const end = await following.ended;
  return { end, asked, events, waits, statuses, skipped, lastSeq: following.lastSeq() };
}

const firstRun = MONEY_SESSION.slice(0, 4); // run.started, user.message, question, run.waiting
const build = MONEY_SESSION.slice(12, 24); // run 4: confirm ... preview.ready, message, run.waiting

describe("the SSE reader", () => {
  it("reads messages across pieces of any size, with comments and both line endings", () => {
    const parser = createSseParser();
    const text = `: keep-alive\n\nid: 7\r\nevent: agent\r\ndata: {"a":1}\r\n\r\nevent: agent\ndata: one\ndata: two\n\n`;
    const out = [];
    for (const char of text) out.push(...parser.push(char));
    expect(out).toEqual([
      { id: "7", event: "agent", data: '{"a":1}' },
      { id: null, event: "agent", data: "one\ntwo" },
    ]);
  });

  it("keeps an unfinished message until the rest arrives", () => {
    const parser = createSseParser();
    expect(parser.push("event: agent\ndata: {")).toEqual([]);
    expect(parser.push('"a":1}\n')).toEqual([]);
    expect(parser.push("\n")).toEqual([{ id: null, event: "agent", data: '{"a":1}' }]);
  });
});

describe("parsing", () => {
  it("anything that is not an AgentEvent is dropped", () => {
    expect(parseAgentEvent("not json")).toBeNull();
    expect(parseAgentEvent(JSON.stringify({ type: "run.done", seq: 1 }))).toBeNull(); // no time
    expect(parseAgentEvent(JSON.stringify({ type: "shell.command", seq: 1, at: AT, command: "rm -rf" }))).toBeNull();
    expect(parseAgentEvent(JSON.stringify({ type: "run.done", seq: 1, at: AT }))).toEqual({ type: "run.done", seq: 1, at: AT });
  });
});

describe("following a session", () => {
  it("backs off from half a second to five seconds", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(backoffMs)).toEqual([500, 1000, 2000, 4000, 5000, 5000, 5000]);
  });

  it("passes events on in order and stops when the run stops", async () => {
    const result = await follow([() => body([": keep-alive\n\n", ...firstRun.map(stored)])]);
    expect(result.end).toBe("finished");
    expect(result.asked).toEqual([0]);
    expect(result.events).toEqual(firstRun);
    expect(result.lastSeq).toBe(4);
    expect(result.waits).toEqual([]);
    expect(result.statuses).toEqual(["live", "idle"]);
  });

  it("replays a stopped session from the start and does not knock again", async () => {
    const result = await follow([() => body(MONEY_SESSION.slice(0, 12).map(stored))], { working: false });
    expect(result.end).toBe("finished");
    expect(result.events.length).toBe(12);
    expect(result.asked).toEqual([0]);
  });

  it("on run.paused it reconnects at once with ?after=<last seq>, and the run carries on", async () => {
    const paused: AgentEvent = { type: "run.paused", seq: 18, at: AT };
    const result = await follow(
      [() => body([...build.slice(0, 6).map(stored), live(paused)]), () => body(build.slice(6).map(stored))],
      { after: 12 },
    );
    expect(result.end).toBe("finished");
    expect(result.asked).toEqual([12, 18]);
    expect(result.waits).toEqual([]); // no waiting: the server asked for it
    expect(result.events.filter((e) => e.type !== "run.paused")).toEqual(build);
    expect(result.statuses).not.toContain("reconnecting");
  });

  it("after a dropped connection it reconnects with ?after=<last seq> and nothing is lost or doubled", async () => {
    const result = await follow(
      [
        () => body(build.slice(0, 5).map(stored), true), // breaks mid-build
        () => Promise.reject(new TypeError("offline")), // still down
        () => Promise.reject(new TypeError("offline")),
        // Back: the server replays a little more than asked for. The extra is ignored.
        () => body(build.slice(3).map(stored)),
      ],
      { after: 12 },
    );
    expect(result.end).toBe("finished");
    expect(result.asked).toEqual([12, 17, 17, 17]);
    expect(result.waits).toEqual([500, 1000, 2000]);
    expect(result.events).toEqual(build);
    expect(result.events.map((e) => e.seq)).toEqual([13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]);
    expect(result.statuses).toContain("reconnecting");
    expect(result.statuses.at(-1)).toBe("idle");
  });

  it("an event that goes missing sends it back for the gap, not past it", async () => {
    const result = await follow([() => body([...build.slice(0, 2).map(stored), ...build.slice(3, 5).map(stored)]), () => body(build.slice(2).map(stored))], { after: 12 });
    expect(result.asked).toEqual([12, 14]);
    expect(result.events).toEqual(build);
  });

  it("a stored event that cannot be read is stepped over, not waited on for ever", async () => {
    // Event 15 comes from a newer server: it has its number and a shape this screen does not know.
    const strange = `id: 15\nevent: agent\ndata: ${JSON.stringify({ type: "run.rested", seq: 15, at: AT })}\n\n`;
    const result = await follow([() => body([...build.slice(0, 2).map(stored), strange, ...build.slice(3).map(stored)])], { after: 12 });
    expect(result.end).toBe("finished");
    expect(result.asked).toEqual([12]); // one connection: no reconnecting at the same place
    expect(result.waits).toEqual([]);
    expect(result.skipped).toEqual([15]);
    expect(result.events.map((e) => e.seq)).toEqual([13, 14, 16, 17, 18, 19, 20, 21, 22, 23, 24]);
    expect(result.lastSeq).toBe(24);
  });

  it("when the unreadable one is the stop event, it asks the session and ends instead of knocking for ever", async () => {
    const garbled = "id: 24\nevent: agent\ndata: {not json\n\n";
    let asks = 0;
    const result = await follow([() => body([...build.slice(0, 11).map(stored), garbled])], {
      after: 12,
      stillWorking: async () => {
        asks += 1;
        return false;
      },
    });
    expect(result.end).toBe("finished");
    expect(result.asked).toEqual([12]);
    expect(result.skipped).toEqual([24]);
    expect(result.lastSeq).toBe(24);
    expect(asks).toBe(1);
  });

  it("an unreadable message is only stepped over when it is the very next one", async () => {
    const noNumber = "event: agent\ndata: {not json\n\n";
    const old = "id: 13\nevent: agent\ndata: {not json\n\n";
    const ahead = "id: 19\nevent: agent\ndata: {not json\n\n";
    const result = await follow([() => body([...build.slice(0, 2).map(stored), noNumber, old, ahead]), () => body(build.slice(2).map(stored))], { after: 12 });
    expect(result.skipped).toEqual([]);
    expect(result.asked).toEqual([12, 14]); // the one from further ahead is a gap: ask again from here
    expect(result.events).toEqual(build);
  });

  it("words still arriving are passed on but never move the place", async () => {
    const delta: AgentEvent = { type: "message.delta", seq: 22, at: AT, text: "Money is" };
    const result = await follow([() => body([...build.slice(0, 10).map(stored), live(delta), ...build.slice(10).map(stored)])], { after: 12 });
    expect(result.events.map((e) => e.type)).toContain("message.delta");
    expect(result.lastSeq).toBe(24);
  });

  it("a quiet end while RMS was thought to be working asks the session before knocking again", async () => {
    const result = await follow([() => body(build.slice(0, 3).map(stored)), () => body([])], { after: 12, stillWorking: async () => false });
    expect(result.end).toBe("finished");
    expect(result.asked).toEqual([12, 15]);
  });

  it("signed out and not found end it for good", async () => {
    expect((await follow([() => new Response(null, { status: 401 })])).end).toBe("signed-out");
    expect((await follow([() => new Response(null, { status: 404 })])).end).toBe("not-found");
    expect((await follow([() => new Response(null, { status: 403 })])).end).toBe("refused");
  });

  it("a server that is struggling is tried again, not given up on", async () => {
    const result = await follow([() => new Response(null, { status: 503 }), () => body(firstRun.map(stored))]);
    expect(result.end).toBe("finished");
    expect(result.waits).toEqual([500]);
  });

  it("stop() ends it without another connection", async () => {
    const never = new ReadableStream<Uint8Array>({ start() {} });
    const asked: number[] = [];
    const following = followSession({
      open: async (after) => {
        asked.push(after);
        return new Response(never, { status: 200 });
      },
      after: 3,
      working: true,
      onEvent: () => undefined,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    following.stop();
    // The other end never says another word. Stopping lets go of it anyway.
    expect(await following.ended).toBe("stopped");
    expect(asked).toEqual([3]);
  });
});

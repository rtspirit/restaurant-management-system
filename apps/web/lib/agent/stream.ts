// Follows one build session's event stream and never loses its place.
//
// The server ends a stream after a stop event, after `run.paused` (a function stops after 300
// seconds), or when nothing is running. Connections also simply drop. Either way this reconnects
// with `?after=<last stored seq>` and carries on, for as long as the latest run is still being
// worked on. Nothing here knows about React or the screen.
import { AgentEvent, EVENT_STREAM, LIVE_ONLY_EVENTS, RUN_STOP_EVENTS } from "@rms/contracts";
import { readSse } from "./sse";

/** Wait before reconnect number `attempt` (0 is the first): 0.5s, 1s, 2s, 4s, then 5s each time. */
export const backoffMs = (attempt: number): number => Math.min(5_000, 500 * 2 ** Math.max(0, attempt));

export type StreamStatus =
  /** Connected and listening. */
  | "live"
  /** The connection dropped while RMS was working. Trying again. */
  | "reconnecting"
  /** Nothing is running, so there is nothing to listen for. */
  | "idle";

/** Why following stopped for good. The screen turns each into plain words. */
export type StreamEnd = "finished" | "stopped" | "signed-out" | "not-found" | "refused";

export type FollowOptions = {
  /** Opens the stream after `after`. The real one is `GET events?after=`, with the bearer header. */
  open: (after: number, signal: AbortSignal) => Promise<Response>;
  /** The highest stored `seq` already on screen. 0 to replay everything. */
  after: number;
  /** True when the latest run is `running` or `paused`, from the session view. Events keep it up to date from there. */
  working: boolean;
  /** Each event, in order. Stored events arrive exactly once and with no gaps. */
  onEvent: (event: AgentEvent) => void;
  /**
   * A stored event arrived that this screen cannot read (a newer server, a damaged message). It
   * is stepped over so the stream does not stall on it: `seq` is the number it carried.
   */
  onSkip?: (seq: number) => void;
  onStatus?: (status: StreamStatus) => void;
  /** Asked when a stream ends quietly while we believed RMS was working. False means it is not. */
  stillWorking?: () => Promise<boolean>;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

export type Following = {
  /** Stop listening. Safe to call more than once. */
  stop: () => void;
  /** Settles when following ends, with why. Never rejects. */
  ended: Promise<StreamEnd>;
  /** The highest stored `seq` passed on so far. */
  lastSeq: () => number;
};

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });

const isStored = (event: AgentEvent): boolean => !(LIVE_ONLY_EVENTS as readonly string[]).includes(event.type);
const isStop = (event: AgentEvent): boolean => (RUN_STOP_EVENTS as readonly string[]).includes(event.type);

/** Parses one message's data. Anything that is not an `AgentEvent` is dropped. */
export function parseAgentEvent(data: string): AgentEvent | null {
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return null;
  }
  const parsed = AgentEvent.safeParse(json);
  return parsed.success ? parsed.data : null;
}

export function followSession(options: FollowOptions): Following {
  const { open, onEvent, onSkip, onStatus, stillWorking } = options;
  const sleep = options.sleep ?? defaultSleep;
  const abort = new AbortController();
  let last = options.after;
  let working = options.working;

  const run = async (): Promise<StreamEnd> => {
    let attempt = 0;
    while (!abort.signal.aborted) {
      let paused = false;
      let dropped = false;
      let moved = false;
      /** Something was stepped over on this connection, so what we believe about the run may be stale. */
      let unread = false;
      try {
        const response = await open(last, abort.signal);
        if (response.status === 401) return "signed-out";
        if (response.status === 404) return "not-found";
        if (response.status === 403 || response.status === 400) return "refused";
        if (!response.ok || !response.body) throw new Error("stream unavailable");
        onStatus?.("live");
        for await (const message of readSse(response.body, abort.signal)) {
          if (abort.signal.aborted) return "stopped";
          if (message.event !== EVENT_STREAM.event) continue;
          const event = parseAgentEvent(message.data);
          if (!event) {
            // It cannot be read. If it is the very next stored event, step over it: holding the
            // place would make every later event a gap, and the screen would never move again.
            // (If it was the stop event, the quiet end below asks the session what happened.)
            const seq = message.id !== null && /^\d{1,15}$/.test(message.id) ? Number(message.id) : null;
            if (seq === null || seq <= last) continue;
            if (seq !== last + 1) {
              dropped = true;
              break;
            }
            last = seq;
            moved = true;
            unread = true;
            onSkip?.(seq);
            continue;
          }
          if (isStored(event)) {
            if (event.seq <= last) continue; // seen already
            if (event.seq !== last + 1) {
              dropped = true; // one went missing: ask again from where we are
              break;
            }
            last = event.seq;
            moved = true;
            if (event.type === "run.started") working = true;
            if (isStop(event)) working = false;
          } else if (event.type === "run.paused") {
            paused = true;
          }
          onEvent(event);
        }
      } catch {
        if (abort.signal.aborted) return "stopped";
        dropped = true;
      }
      if (abort.signal.aborted) return "stopped";

      // The server said "reconnect at once": the run carries on in the next request.
      if (paused && !dropped) {
        attempt = 0;
        continue;
      }
      if (!dropped) {
        if (!working) return "finished";
        // It ended quietly while we thought RMS was working. Check before knocking again.
        if ((!moved || unread) && stillWorking) {
          const really = await stillWorking().catch(() => true);
          if (abort.signal.aborted) return "stopped";
          if (!really) return "finished";
        }
      }
      if (moved) attempt = 0;
      onStatus?.("reconnecting");
      await sleep(backoffMs(attempt), abort.signal);
      attempt += 1;
    }
    return "stopped";
  };

  const ended = run()
    .catch((): StreamEnd => "stopped")
    .then((end) => {
      onStatus?.("idle");
      return end;
    });

  return { stop: () => abort.abort(), ended, lastSeq: () => last };
}

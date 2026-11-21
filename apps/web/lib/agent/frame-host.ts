// The shell side of the mini-app hand-off (ADR 0008, contracts frame.ts).
//
// A framed mini-app holds no token and calls nothing. It posts `rms.data` to the shell. This
// host, and only this host, makes the Data API call with the frame's own token and posts the
// answer back. It is a security boundary, so it is small and every rule has a test beside it:
//
//   one grant, one frame, one origin   a host is made for one frame element and one grant
//   separate sites                     a frame on the shell's own host is never loaded
//   routes by name                     the frame names one of five routes, never an address
//   body cap                           an oversized body is answered here and never sent on
//   the token stays put                in a variable in here: never rendered, stored, logged
//                                      or posted, and never the owner's own session token
import { DATA_ROUTES, FRAME_LIMITS, FRAME_PROTOCOL, FrameGrant, FrameToShell, fromExpectedOrigin, isSeparateSite, type DataError, type ShellToFrame } from "@rms/contracts";
import type { DataCall } from "./client";

/** The one frame element a host is bound to. In the browser this is the `iframe` itself. */
export type FrameElement = { readonly contentWindow: unknown };
type FrameWindow = { postMessage: (message: unknown, targetOrigin: string) => void };
type MessageLike = { origin: string; source: unknown; data: unknown };
/** Where frame messages arrive. In the browser this is `window`. */
export type MessageSource = {
  addEventListener: (type: "message", listener: (event: MessageLike) => void) => void;
  removeEventListener: (type: "message", listener: (event: MessageLike) => void) => void;
};

export type FrameHostOptions = {
  frame: FrameElement;
  grant: FrameGrant;
  /** The shell's own origin: `window.location.origin`. */
  shellOrigin: string;
  /** `window`. */
  messages: MessageSource;
  call: DataCall;
  /** The mini-app has loaded and been told where it is. */
  onReady?: () => void;
  /**
   * The Data API refused the token. Get a new grant and hand it to `replaceGrant`. Answer true
   * when that worked: the call is then tried once more. Otherwise the frame gets the refusal.
   */
  onUnauthenticated?: () => Promise<boolean>;
};

export type FrameHost = {
  /** The origin this host listens to and answers. Fixed for its life. */
  readonly frameOrigin: string;
  /**
   * A newer grant for the same frame (a refresh, a new run). Same origin: the token is swapped
   * and this answers true. Another origin: nothing changes and this answers false. Throw this
   * host away and make a new one.
   */
  replaceGrant: (grant: FrameGrant) => boolean;
  /** The restaurant's colour changed. */
  setTheme: (brandColour: string | null) => void;
  /** Forget the token, stop listening, answer nothing more. */
  dispose: () => void;
};

/** True when this grant may be put in a frame by a shell at `shellOrigin`. */
export const canLoadGrant = (grant: unknown, shellOrigin: string): grant is FrameGrant => {
  const parsed = FrameGrant.safeParse(grant);
  return parsed.success && isSeparateSite(parsed.data.frameOrigin, shellOrigin);
};

/** Under two minutes left (or unreadable): time to ask for a new grant. */
export const grantNeedsRefresh = (grant: { expiresAt: string }, now: number): boolean => {
  const until = Date.parse(grant.expiresAt);
  return !Number.isFinite(until) || until - now < 120_000;
};

const dataError = (code: DataError["error"]["code"], message: string): DataError => ({ error: { code, message, requestId: "shell" } });
const TOO_BIG = dataError("invalid_request", "That is too much to send at once.");
const UNREADABLE = dataError("invalid_request", "That could not be sent. Check what was typed and try again.");
const TOO_MANY = dataError("limit", "Too much is happening at once. Try again in a moment.");
const NO_ANSWER = dataError("internal", "RMS is not answering just now. Try again in a moment.");

const isFrameWindow = (value: unknown): value is FrameWindow =>
  typeof value === "object" && value !== null && typeof (value as { postMessage?: unknown }).postMessage === "function";

/**
 * Binds one grant to one frame. Returns null, and loads nothing, when the grant does not parse
 * or its frame would share a site with the shell.
 */
export function createFrameHost(options: FrameHostOptions): FrameHost | null {
  const { frame, shellOrigin, messages, call, onReady, onUnauthenticated } = options;
  if (!canLoadGrant(options.grant, shellOrigin)) return null;

  const frameOrigin = options.grant.frameOrigin;
  // The token lives here and nowhere else.
  let token = options.grant.token;
  let context = options.grant.context;
  let disposed = false;
  let ready = false;
  let inFlight = 0;
  const queue: Array<{ id: string; path: string; body: string }> = [];
  const aborts = new Set<AbortController>();

  const post = (message: ShellToFrame) => {
    if (disposed) return;
    // Only ever to the bound frame's own window, at the one origin the server named.
    const target = frame.contentWindow;
    if (!isFrameWindow(target)) return;
    // Belt and braces: whatever a result holds, the token never goes to a frame.
    if (token !== "" && JSON.stringify(message).includes(token)) {
      if (message.type === "rms.data.result") target.postMessage({ rms: FRAME_PROTOCOL, type: "rms.data.result", id: message.id, status: 500, body: NO_ANSWER } satisfies ShellToFrame, frameOrigin);
      return;
    }
    target.postMessage(message, frameOrigin);
  };

  const answer = (id: string, status: number, body: unknown) => post({ rms: FRAME_PROTOCOL, type: "rms.data.result", id, status, body });

  const callOnce = async (path: string, body: string): Promise<{ status: number; body: unknown }> => {
    const abort = new AbortController();
    aborts.add(abort);
    const timer = setTimeout(() => abort.abort(), FRAME_LIMITS.requestTimeoutMs);
    try {
      return await call(path, token, body, abort.signal);
    } catch {
      return { status: 500, body: NO_ANSWER };
    } finally {
      clearTimeout(timer);
      aborts.delete(abort);
    }
  };

  const run = async (job: { id: string; path: string; body: string }) => {
    inFlight += 1;
    try {
      let result = await callOnce(job.path, job.body);
      if (result.status === 401 && !disposed && onUnauthenticated) {
        const renewed = await onUnauthenticated().catch(() => false);
        if (renewed && !disposed) result = await callOnce(job.path, job.body);
      }
      answer(job.id, result.status >= 200 && result.status <= 599 ? result.status : 500, result.body);
    } finally {
      inFlight -= 1;
      const next = queue.shift();
      if (next && !disposed) void run(next);
    }
  };

  const onMessage = (event: MessageLike) => {
    if (disposed) return;
    // From the one frame this host was made for, at the one origin the server named. Else: silence.
    if (!fromExpectedOrigin(event, frameOrigin, frame.contentWindow)) return;
    const parsed = FrameToShell.safeParse(event.data);
    if (!parsed.success) return;
    const message = parsed.data;

    if (message.type === "rms.ready") {
      post({ rms: FRAME_PROTOCOL, type: "rms.init", context });
      if (!ready) {
        ready = true;
        onReady?.();
      }
      return;
    }

    // A data call before the mini-app has said hello and been told where it is: dropped.
    if (!ready) return;
    // By name, from the fixed list. There is no way to pass an address or a path.
    if (!Object.hasOwn(DATA_ROUTES, message.route)) return;
    const path = DATA_ROUTES[message.route];
    // Serialised once: what is measured is what is sent. A message can carry things JSON cannot
    // (a big integer, a value that contains itself). That must never throw in here: it would be
    // an error on the RMS page and no answer for the frame. It is refused like any bad request.
    let body: string;
    try {
      body = JSON.stringify(message.body === undefined ? {} : message.body);
    } catch {
      answer(message.id, 400, UNREADABLE);
      return;
    }
    if (typeof body !== "string") {
      answer(message.id, 400, UNREADABLE);
      return;
    }
    if (new TextEncoder().encode(body).length > FRAME_LIMITS.maxBodyBytes) {
      answer(message.id, 400, TOO_BIG);
      return;
    }
    const job = { id: message.id, path, body };
    if (inFlight < FRAME_LIMITS.maxInFlight) void run(job);
    else if (queue.length < FRAME_LIMITS.maxQueued) queue.push(job);
    else answer(message.id, 429, TOO_MANY);
  };

  messages.addEventListener("message", onMessage);

  return {
    frameOrigin,
    replaceGrant(grant) {
      if (disposed || !canLoadGrant(grant, shellOrigin) || grant.frameOrigin !== frameOrigin) return false;
      token = grant.token;
      context = grant.context;
      return true;
    },
    setTheme(brandColour) {
      if (ready) post({ rms: FRAME_PROTOCOL, type: "rms.theme", brandColour });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      messages.removeEventListener("message", onMessage);
      token = "";
      queue.length = 0;
      for (const abort of aborts) abort.abort();
      aborts.clear();
    },
  };
}

// The frame side of the hand-off in @rms/contracts frame.ts (ADR 0008).
//
// Rules, all enforced here and tested:
//   - Outside a frame, or with no valid shell origin, nothing is sent: "not connected".
//   - Messages go to `window.parent` only, with the exact shell origin as the target. Never "*".
//   - A message is acted on only when `fromExpectedOrigin(event, shellOrigin, window.parent)`
//     holds AND it parses with the strict `ShellToFrame` schema. Everything else is dropped
//     without an answer: other origins, other windows, extra keys, unknown types, and
//     anything but `rms.init` before `rms.init`.
//   - No token, no network: this file only posts messages.
import { FRAME_LIMITS, FRAME_PROTOCOL, type FrameContext, type FrameToShell, Origin, ShellToFrame, fromExpectedOrigin } from "@rms/contracts";
import { DataClient } from "./client";

type MessageListener = (event: MessageEvent) => void;

/** The parts of `window` the SDK uses. Tests pass a fake. */
export type FrameWindow = {
  readonly parent: { postMessage(message: unknown, targetOrigin: string): void } | null;
  addEventListener(type: "message", listener: MessageListener): void;
  removeEventListener(type: "message", listener: MessageListener): void;
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type NotConnectedReason = "not_framed" | "no_shell_origin" | "no_answer";

export type Connection =
  | { connected: false; reason: NotConnectedReason }
  | {
      connected: true;
      context: FrameContext;
      client: DataClient;
      /** Called when the shell sends a new restaurant colour. Returns a function that stops listening. */
      onTheme(listener: (brandColour: string | null) => void): () => void;
      /** Stops listening. Pending requests fail. */
      close(): void;
    };

export type ConnectOptions = {
  /** The one origin accepted as the parent. The template passes `import.meta.env.VITE_RMS_SHELL_ORIGIN`. */
  shellOrigin: string | undefined;
  /** Defaults to the real `window`. */
  window?: FrameWindow;
};

const realWindow = (): FrameWindow | null => (typeof window === "undefined" ? null : (window as unknown as FrameWindow));

/**
 * Connects to the RMS shell. Resolves once: connected after `rms.init`, or not connected when
 * this page is not inside a frame, has no valid shell origin, or the shell never answers.
 */
export const connect = (options: ConnectOptions): Promise<Connection> => {
  const win = options.window ?? realWindow();
  if (win === null || win.parent === null || win.parent === (win as unknown)) return Promise.resolve({ connected: false, reason: "not_framed" });
  const parent = win.parent;
  const shellOrigin = options.shellOrigin;
  if (shellOrigin === undefined || !Origin.safeParse(shellOrigin).success) return Promise.resolve({ connected: false, reason: "no_shell_origin" });

  const post = (message: FrameToShell): void => parent.postMessage(message, shellOrigin);

  return new Promise<Connection>((resolve) => {
    let context: FrameContext | null = null;
    let tries = 0;
    let timer: unknown = null;
    const themeListeners = new Set<(brandColour: string | null) => void>();
    const client = new DataClient({ post, setTimeout: (h, ms) => win.setTimeout(h, ms), clearTimeout: (h) => win.clearTimeout(h) });

    const onMessage: MessageListener = (event) => {
      if (!fromExpectedOrigin(event, shellOrigin, parent)) return;
      const parsed = ShellToFrame.safeParse(event.data);
      if (!parsed.success) return;
      const message = parsed.data;
      if (context === null) {
        if (message.type !== "rms.init") return;
        context = message.context;
        if (timer !== null) win.clearTimeout(timer);
        resolve({
          connected: true,
          context,
          client,
          onTheme: (listener) => {
            themeListeners.add(listener);
            return () => themeListeners.delete(listener);
          },
          close: () => {
            win.removeEventListener("message", onMessage);
            client.closeAll();
          },
        });
        return;
      }
      if (message.type === "rms.data.result") client.settle(message.id, message.status, message.body);
      else if (message.type === "rms.theme") for (const listener of themeListeners) listener(message.brandColour);
      // A second rms.init is dropped: one frame, one context.
    };
    win.addEventListener("message", onMessage);

    const announce = (): void => {
      if (context !== null) return;
      if (tries >= FRAME_LIMITS.readyRetries) {
        win.removeEventListener("message", onMessage);
        resolve({ connected: false, reason: "no_answer" });
        return;
      }
      tries += 1;
      post({ rms: FRAME_PROTOCOL, type: "rms.ready" });
      timer = win.setTimeout(announce, FRAME_LIMITS.readyEveryMs);
    };
    announce();
  });
};

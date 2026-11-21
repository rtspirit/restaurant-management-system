import { z } from "zod";
import { Role, StoreEnv } from "./auth.js";
import { AppId, RunId } from "./ids.js";

/**
 * How a mini-app's screens talk to RMS. Used today for the build preview (the frame is served
 * from the build sandbox's dev server), and unchanged later for published mini-apps (the frame
 * is served from the apps host).
 *
 * The mini-app runs in a frame inside the RMS shell. It NEVER holds a token and never calls the
 * network itself. It asks the shell, with `postMessage`, to make a Data API call for it. The
 * shell holds the token (a run token for a preview, an app token for a published mini-app) in
 * memory, makes the call, and posts the answer back.
 *
 * Why the shell makes the call (decided for Wave 2, see docs/briefs/wave2-notes.md):
 *   - mini-app code is written by an agent. A token it never sees cannot be leaked by it.
 *   - a preview frame is served from a public sandbox address. A browser will not let such a
 *     page call an API on the developer's own machine without a permission prompt, so previews
 *     would not work in local development. The shell and the API are on the same side, so the
 *     relay works everywhere.
 *   - the Data API needs to accept browser calls from ONE origin (the RMS web app), not from
 *     every sandbox address.
 *
 * Origin checks. Both sides MUST do all of these, and drop anything else without answering:
 *   Shell:  `event.source` is the frame's own `contentWindow` AND `event.origin` equals
 *           `PreviewGrant.frameOrigin` exactly. It posts only to that origin, never to "*".
 *   Frame:  `event.source` is `window.parent` AND `event.origin` equals the shell origin the
 *           mini-app was built with (`FRAME_ENV.shellOrigin`). It posts only to that origin,
 *           never to "*". Opened outside a frame, it shows "Open this from RMS" and does nothing.
 *   Both:   the message parses with the strict schema below. Unknown types and extra keys are dropped.
 *
 * What a frame can never say: which restaurant, user, role, store or token to use. There is no
 * such field. The shell uses the token it got for THIS frame and nothing else: never the
 * owner's own session.
 */
export const FRAME_PROTOCOL = 1;

/** The five Data API routes, by name. The shell maps the name to `DATA_ROUTES[name]`. A frame cannot name a URL. */
export const FrameDataRoute = z.enum(["query", "batch", "named", "action", "catalog"]);
export type FrameDataRoute = z.infer<typeof FrameDataRoute>;

const messageId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const base = { rms: z.literal(FRAME_PROTOCOL) };

/** Frame to shell. */
export const FrameToShell = z.discriminatedUnion("type", [
  /** Sent when the mini-app has loaded, and again every 500 ms (at most 20 times) until `rms.init` arrives. */
  z.strictObject({ ...base, type: z.literal("rms.ready") }),
  /**
   * One Data API call. `body` is passed on as the request body exactly as it is and is checked
   * by the Data API's own strict shapes. The shell answers with `rms.data.result` and the same `id`.
   */
  z.strictObject({ ...base, type: z.literal("rms.data"), id: messageId, route: FrameDataRoute, body: z.unknown() }),
]);
export type FrameToShell = z.infer<typeof FrameToShell>;

/** What the shell tells a mini-app about where it is running. Display values only: nothing here grants access. */
export const FrameContext = z.strictObject({
  app: z.strictObject({ id: AppId, name: z.string().max(40) }),
  /** "draft" in a preview (sample numbers), "live" once published. Shown to the user, enforced by the token, not by this. */
  env: StoreEnv,
  user: z.strictObject({ name: z.string().max(80), role: Role }),
  restaurant: z.strictObject({ name: z.string().max(80), brandColour: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable() }),
  /** The locations this user may see, for a location picker. Raw uuids, as rows use them. */
  locations: z.array(z.strictObject({ id: z.uuid(), name: z.string().max(80) })).max(100),
  currency: z.string().regex(/^[A-Z]{3}$/),
  locale: z.string().max(20),
});
export type FrameContext = z.infer<typeof FrameContext>;

/** Shell to frame. */
export const ShellToFrame = z.discriminatedUnion("type", [
  z.strictObject({ ...base, type: z.literal("rms.init"), context: FrameContext }),
  /** `status` and `body` are the Data API's reply as it came: a response shape, or a `DataError`. */
  z.strictObject({ ...base, type: z.literal("rms.data.result"), id: messageId, status: z.number().int().min(200).max(599), body: z.unknown() }),
  /** The restaurant's colour changed. The mini-app re-themes without a reload. */
  z.strictObject({ ...base, type: z.literal("rms.theme"), brandColour: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable() }),
]);
export type ShellToFrame = z.infer<typeof ShellToFrame>;

/** An origin exactly as a browser reports it: scheme, host and optional port. No path, no trailing slash. */
export const Origin = z
  .string()
  .max(200)
  .regex(/^https?:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/)
  .refine((o) => o.startsWith("https://") || /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(o), "Only https, or http on this machine");
export type Origin = z.infer<typeof Origin>;

/**
 * What the web app gets when it asks to show a preview (`AGENT_ROUTES.preview`), and later a
 * published mini-app. Asked for again when `expiresAt` is under two minutes away, when the Data
 * API answers `unauthenticated`, and after every new run (a run token dies with its run).
 *
 * `token` stays in the shell's memory. It is never put in the frame's address, in a message to
 * the frame, in a cookie, or in browser storage.
 */
export const PreviewGrant = z.object({
  appId: AppId,
  appName: z.string().max(40),
  runId: RunId,
  /** The address to put in the frame. */
  url: z.url(),
  /** The one origin the shell accepts frame messages from. Always the origin of `url`, worked out by the server. */
  frameOrigin: Origin,
  token: z.string().min(20),
  expiresAt: z.iso.datetime(),
  context: FrameContext,
}).refine((g) => {
  try {
    return new URL(g.url).origin === g.frameOrigin;
  } catch {
    return false;
  }
}, "frameOrigin must be the origin of url");
export type PreviewGrant = z.infer<typeof PreviewGrant>;

/** True only for a message the given side may act on. One implementation of the origin rule for both sides. */
export const fromExpectedOrigin = (event: { origin: string; source: unknown }, expectedOrigin: string, expectedSource: unknown): boolean =>
  event.source !== null && event.source === expectedSource && Origin.safeParse(expectedOrigin).success && event.origin === expectedOrigin;

/**
 * Settings baked into a mini-app when it is built or served. Public values only.
 * `shellOrigin`: the one origin the mini-app accepts as its parent (the RMS web app's origin).
 */
export const FRAME_ENV = { shellOrigin: "VITE_RMS_SHELL_ORIGIN" } as const;

/** What the frame element must carry. No camera, microphone, location or other feature is granted. */
export const FRAME_ATTRIBUTES = { sandbox: "allow-scripts allow-same-origin allow-forms", referrerPolicy: "no-referrer", allow: "" } as const;

/** Limits both sides keep, so a broken or hostile frame cannot pile work onto the shell. */
export const FRAME_LIMITS = { maxInFlight: 4, maxQueued: 50, requestTimeoutMs: 20_000, readyRetries: 20, readyEveryMs: 500 } as const;

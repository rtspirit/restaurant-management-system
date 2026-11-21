import { z } from "zod";
import { Role, StoreEnv } from "./auth.js";
import { AppId, AppVersionId, RunId } from "./ids.js";

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
 * Why the shell makes the call (ADR 0008):
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
 *           the grant's `frameOrigin` exactly. It posts only to that origin, never to "*".
 *   Frame:  `event.source` is `window.parent` AND `event.origin` equals the shell origin the
 *           mini-app was built with (`FRAME_ENV.shellOrigin`). It posts only to that origin,
 *           never to "*". Opened outside a frame, it shows "Open this from RMS" and does nothing.
 *   Both:   the message parses with the strict schema below. Unknown types and extra keys are dropped.
 *
 * What a frame can never say: which restaurant, user, role, store or token to use, or which
 * address to call. There is no such field. It names one of five routes from a fixed list
 * (`FrameDataRoute`), never a URL or a path.
 *
 * One grant, one frame. A grant is bound to the one frame element it was asked for (its
 * `contentWindow`) and to one origin (`frameOrigin`). The shell uses that grant's token for
 * that frame's requests and for nothing else: never for another frame, never the owner's own
 * session token (the Data API refuses a session token anyway). When the frame element is
 * replaced, or a new grant has another origin, the old binding is thrown away with its token.
 *
 * Separate sites. The frame must never be served from the shell's own host, or from a parent
 * or child of it (`isSeparateSite`), because cookies ignore the port: a page on
 * `localhost:5173` can read the cookies of the web app on `localhost:3000`, and the owner's
 * sign-in lives there. So in local development the web app is on `localhost` and every preview
 * is opened from `127.0.0.1`, never from `localhost`. A grant whose frame host is `localhost`
 * does not parse.
 *
 * Size. A relayed request body over `FRAME_LIMITS.maxBodyBytes` is answered with an
 * `invalid_request` result by the shell and is never sent on.
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

const hostOf = (origin: string): string | null => {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
};

/**
 * True when a frame at `frameOrigin` shares no cookies with a shell at `shellOrigin`: the hosts
 * differ, and neither is a parent domain of the other. Checked by the server when it makes a
 * grant (against the web app's address) and by the shell before it loads the frame (against
 * its own `window.location.origin`). False for anything that does not parse.
 */
export const isSeparateSite = (frameOrigin: string, shellOrigin: string): boolean => {
  if (!Origin.safeParse(frameOrigin).success || !Origin.safeParse(shellOrigin).success) return false;
  const frame = hostOf(frameOrigin);
  const shell = hostOf(shellOrigin);
  if (frame === null || shell === null || frame === shell) return false;
  return !frame.endsWith(`.${shell}`) && !shell.endsWith(`.${frame}`);
};

const grantShape = {
  appId: AppId,
  appName: z.string().max(40),
  /** The address to put in the frame. */
  url: z.url(),
  /** The one origin the shell accepts frame messages from. Always the origin of `url`, worked out by the server. */
  frameOrigin: Origin,
  /** Stays in the shell's memory. Never in the frame's address, a message to the frame, a cookie, or browser storage. */
  token: z.string().min(20),
  expiresAt: z.iso.datetime(),
  context: FrameContext,
};

const grantHolds = (g: { url: string; frameOrigin: string }): boolean => {
  try {
    return new URL(g.url).origin === g.frameOrigin && hostOf(g.frameOrigin) !== "localhost";
  } catch {
    return false;
  }
};
const GRANT_RULE = "frameOrigin must be the origin of url, and a frame is never served from localhost";

/**
 * What the web app gets when it asks to show a BUILD PREVIEW (`AGENT_ROUTES.preview`). The
 * token is a run token: draft store, one mini-app, one run. Asked for again when `expiresAt` is
 * under two minutes away, when the Data API answers `unauthenticated`, and after every new run
 * (a run token dies with its run).
 */
export const PreviewGrant = z.object({ kind: z.literal("preview"), ...grantShape, runId: RunId }).refine(grantHolds, GRANT_RULE);
export type PreviewGrant = z.infer<typeof PreviewGrant>;

/**
 * The same hand-off for a PUBLISHED mini-app (Wave 3). The token is an app token: live store,
 * one mini-app, one published version. `url` is on the apps host. Everything else, including
 * every message in this file, is the same, so the shell's frame code does not change.
 */
export const AppGrant = z.object({ kind: z.literal("app"), ...grantShape, versionId: AppVersionId }).refine(grantHolds, GRANT_RULE);
export type AppGrant = z.infer<typeof AppGrant>;

/** Either grant. The shell's frame host takes this. */
export const FrameGrant = z.union([PreviewGrant, AppGrant]);
export type FrameGrant = z.infer<typeof FrameGrant>;

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
export const FRAME_LIMITS = {
  maxInFlight: 4,
  maxQueued: 50,
  requestTimeoutMs: 20_000,
  readyRetries: 20,
  readyEveryMs: 500,
  /** The most one relayed request body may weigh, as JSON text. A full batch of 500 small rows fits. */
  maxBodyBytes: 512_000,
} as const;

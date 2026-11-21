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

// ------------------------------------------------------------------ local and phone demo origins (ADR 0012)

/**
 * The demo runs on one laptop, and on a phone on the same Wi-Fi. There a PUBLISHED mini-app is
 * served by the apps host on the same machine as the RMS web app, over plain http. The rule
 * that matters does not change: the frame and the shell are on DIFFERENT HOSTS, because cookies
 * ignore the port and the sign-in cookies can be read by page script. One machine has more than
 * one name, and a cookie set for one name is never sent to, or readable from, another:
 *
 *   on the laptop   shell http://127.0.0.1:3000             apps host http://localhost:3002
 *   on the phone    shell http://<laptop-name>.local:3000   apps host http://<network address>:3002
 *
 * (either way round is as safe: what counts is that the two hosts differ.)
 *
 * The laptop pair needs nothing new: both are loopback origins, which `Origin` already accepts.
 *
 * The phone pair is plain http on a network address. That is allowed ONLY in local demo mode,
 * and ONLY for the exact origins written in the local demo list. There is no pattern: not "any
 * private address", not "any `.local` name". An origin that is not on the list, letter for
 * letter, is not an origin.
 *
 * Build previews are not part of this: `PreviewGrant` and `isSeparateSite` keep the strict
 * rule, in every mode.
 */

/**
 * A plain-http origin, written exactly as a browser reports it. This is only a SHAPE. On its
 * own it allows nothing: see `originAllowed`.
 */
export const HttpOrigin = z
  .string()
  .max(200)
  .regex(/^http:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/)
  // An address a browser would rewrite (a short or zero-padded number, a default port) is not
  // an origin anyone will ever send.
  .refine((o) => {
    try {
      return new URL(o).origin === o;
    } catch {
      return false;
    }
  }, "Not written the way a browser reports an origin");
export type HttpOrigin = z.infer<typeof HttpOrigin>;

/**
 * Well-formed: an `Origin`, or a plain-http origin. This says an address is SHAPED like one RMS
 * could use. It never says the address may be used: that is `originAllowed` and `canFrameApp`.
 * Used where an origin was already decided on by the server: an app grant's frame origin, the
 * shell origin a mini-app was built with, the origin a message is compared with.
 */
export const AnyOrigin = z.union([Origin, HttpOrigin]);
export type AnyOrigin = z.infer<typeof AnyOrigin>;

/**
 * The switch and the list.
 *   RMS_LOCAL_DEMO=1            switches local demo mode on. Server-side. Never set for a deployed
 *                               server, and a deployed server ignores it anyway (`hostedMarkers`
 *                               are settings the hosting platforms set themselves).
 *   RMS_LOCAL_DEMO_ORIGINS      the exact plain-http origins allowed in that mode, comma-separated.
 * The web app is BUILT with the two `NEXT_PUBLIC_` copies for the demo, and without them otherwise.
 */
export const LOCAL_DEMO = {
  flagEnv: "RMS_LOCAL_DEMO",
  originsEnv: "RMS_LOCAL_DEMO_ORIGINS",
  publicFlagEnv: "NEXT_PUBLIC_RMS_LOCAL_DEMO",
  publicOriginsEnv: "NEXT_PUBLIC_RMS_LOCAL_DEMO_ORIGINS",
  on: "1",
  hostedMarkers: ["VERCEL", "RAILWAY_ENVIRONMENT"],
  maxOrigins: 8,
} as const;

/**
 * Which origins count. `localOrigins` is empty unless local demo mode is on, and then it holds
 * exactly the listed plain-http origins. Make one with `originRules` or `originRulesFrom`,
 * never by hand in product code.
 */
export type OriginRules = { readonly localDemo: boolean; readonly localOrigins: readonly string[] };

export const STRICT_ORIGINS: OriginRules = { localDemo: false, localOrigins: [] };

/**
 * The rules from a flag and a list, as text. Local demo mode is on only when the flag is exactly
 * "1" and `hosted` is false. Each list entry must be a plain-http origin exactly as a browser
 * reports it: anything else (a wildcard, a path, https, a typo) is dropped, never guessed at.
 */
export const originRulesFrom = (flag: string | undefined, list: string | undefined, hosted = false): OriginRules => {
  if (flag !== LOCAL_DEMO.on || hosted) return STRICT_ORIGINS;
  const localOrigins: string[] = [];
  for (const part of (list ?? "").split(",")) {
    const text = part.trim();
    if (HttpOrigin.safeParse(text).success && !localOrigins.includes(text)) localOrigins.push(text);
  }
  return { localDemo: true, localOrigins: localOrigins.slice(0, LOCAL_DEMO.maxOrigins) };
};

/** The rules for a server, from its own environment. */
export const originRules = (env: Record<string, string | undefined>): OriginRules =>
  originRulesFrom(env[LOCAL_DEMO.flagEnv], env[LOCAL_DEMO.originsEnv], LOCAL_DEMO.hostedMarkers.some((m) => Boolean(env[m])));

/** True when `origin` may be used at all: an `Origin` always, anything else only when it is on the local demo list, exactly. */
export const originAllowed = (origin: string, rules: OriginRules): boolean =>
  Origin.safeParse(origin).success || (rules.localDemo && HttpOrigin.safeParse(origin).success && rules.localOrigins.includes(origin));

/** Different hosts, and neither a parent domain of the other: no cookie set for one is sent to, or readable from, the other. */
const hostsAreSeparate = (a: string, b: string): boolean => {
  const x = hostOf(a);
  const y = hostOf(b);
  if (x === null || y === null || x === y) return false;
  return !x.endsWith(`.${y}`) && !y.endsWith(`.${x}`);
};

/**
 * May a shell at `shellOrigin` show a PUBLISHED mini-app from `frameOrigin`? The one rule for
 * published mini-apps, used by the server when it makes an `AppGrant` and by the shell before
 * it loads the frame. All of:
 *   - both origins may be used at all (`originAllowed`)
 *   - the frame origin is EXACTLY one of the configured apps-host origins (`appsOrigins`, from settings)
 *   - the hosts differ, and neither is a parent domain of the other (a different port is not enough)
 *   - no step down: a shell on https only ever frames https
 * Build previews do not use this. They keep `isSeparateSite`.
 */
export const canFrameApp = (input: { frameOrigin: string; shellOrigin: string; appsOrigins: readonly string[]; rules: OriginRules }): boolean => {
  const { frameOrigin, shellOrigin, appsOrigins, rules } = input;
  if (!originAllowed(frameOrigin, rules) || !originAllowed(shellOrigin, rules)) return false;
  if (!appsOrigins.includes(frameOrigin)) return false;
  if (shellOrigin.startsWith("https://") && !frameOrigin.startsWith("https://")) return false;
  return hostsAreSeparate(frameOrigin, shellOrigin);
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

const appGrantHolds = (g: { url: string; frameOrigin: string }): boolean => {
  try {
    return new URL(g.url).origin === g.frameOrigin;
  } catch {
    return false;
  }
};

/**
 * The same hand-off for a PUBLISHED mini-app (Wave 3). The token is an app token: live store,
 * one mini-app, one published version. `url` is on the apps host. Every message in this file
 * is the same.
 *
 * What differs is the origin rule (ADR 0012). A preview grant's shape refuses a `localhost`
 * frame, because a preview is checked without knowing the shell's address and the web app was
 * assumed to be on `localhost`. An app grant has no such shortcut: its frame origin may be any
 * well-formed origin (`AnyOrigin`), and whether it may be LOADED is `canFrameApp`, which takes
 * the shell's own origin, the configured apps-host origins and the mode. The server checks it
 * before it makes the grant. The shell checks it again before it loads the frame. A shell
 * that loads an app grant without `canFrameApp` is a bug.
 */
export const AppGrant = z
  .object({ kind: z.literal("app"), ...grantShape, frameOrigin: AnyOrigin, versionId: AppVersionId })
  .refine(appGrantHolds, "frameOrigin must be the origin of url");
export type AppGrant = z.infer<typeof AppGrant>;

/** Either grant. The shell's frame host takes this. */
export const FrameGrant = z.union([PreviewGrant, AppGrant]);
export type FrameGrant = z.infer<typeof FrameGrant>;

/**
 * True only for a message the given side may act on. One implementation of the origin rule for both sides.
 * `expectedOrigin` must be well-formed (`AnyOrigin`): this is an exact comparison with an origin the
 * caller already decided to trust (a grant that passed its own rule, or the shell origin a mini-app
 * was built with). It is not the place that decides trust.
 */
export const fromExpectedOrigin = (event: { origin: string; source: unknown }, expectedOrigin: string, expectedSource: unknown): boolean =>
  event.source !== null && event.source === expectedSource && AnyOrigin.safeParse(expectedOrigin).success && event.origin === expectedOrigin;

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

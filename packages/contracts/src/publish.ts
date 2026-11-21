import { z } from "zod";
import { StepState } from "./agent.js";
import { CheckName } from "./build.js";
import { AnyOrigin, type OriginRules, STRICT_ORIGINS, originAllowed } from "./frame.js";
import { OwnerChangeNotice } from "./governance.js";
import { AppId, AppVersionId } from "./ids.js";
import { BUNDLE_ENTRY, BundleIndex, BundlePath } from "./objects.js";

/**
 * Publishing a mini-app, serving it, and opening it inside RMS (Wave 3, task N).
 *
 * What publish does, in this order. The order is the contract:
 *   1. read the version's SOURCE from the object store (`AppSource`: only the files the agent may write)
 *   2. make a CLEAN copy of RMS's own template, add the manifest from the version row and that
 *      source. Nothing else from the build sandbox is used: not its locked files, not its
 *      installed packages, not its built files
 *   3. run EVERY check again (`PUBLISH_CHECKS`). One failure stops the publish. The owner cannot
 *      override it. A failed safety check is recorded for the maintainers
 *   4. store the built files (`BundleIndex`)
 *   5. record the change. A first publish needs the owner's yes, which is the confirm they just pressed
 *   6. bring the mini-app's tables live, mark the version published, add it to the navigation
 *
 * Until step 6 nothing a staff member or the Data API can see has changed.
 *
 * Serving. The built files are served by the apps host (`APPS_HOST`), a separate server on its
 * own origin, so a mini-app's files never share an origin, or cookies, with RMS. The apps host
 * finds the files itself from (mini-app, published version). It never takes a storage key from
 * an address. It sets no cookie and reads none.
 *
 * Opening. The RMS shell asks `PUBLISH_ROUTES.open` and gets an `AppGrant` (frame.ts): the
 * frame address on the apps host and an app token bound to that one mini-app and that one
 * published version. The shell keeps the token and makes the frame's Data API calls (ADR 0008).
 */

// ------------------------------------------------------------------ the checks, shared by build and publish

/**
 * Every check a publish runs, in order.
 *   source   the stored source is only files the agent may write, within the size limits (`AppSource`)
 *   locked … build   the seven build checks (`CheckName` in build.ts), run on the clean copy
 *   bundle   the built files are only allowed kinds, within the size limits, with a start page (`BundleIndex`)
 * Sharing runs the same list and then `scrub` (marketplace.ts).
 */
export const PublishCheckName = z.enum(["source", ...CheckName.options, "bundle"]);
export type PublishCheckName = z.infer<typeof PublishCheckName>;
export const PUBLISH_CHECKS = PublishCheckName.options;

/**
 * A failure of one of these means something tried to get past a safety rule. It is recorded as
 * a change with the signal `security_check_blocked` (held for a maintainer). Any other failure
 * is just a mini-app that does not build yet.
 */
export const SAFETY_CHECKS = ["source", "locked", "deps", "imports", "safety"] as const satisfies readonly PublishCheckName[];

/** One check's outcome. For maintainers and logs. The owner never sees a check name or a problem line. */
export const PublishCheckResult = z.object({
  check: z.union([PublishCheckName, z.literal("scrub")]),
  ok: z.boolean(),
  problems: z.array(z.object({ file: z.string().max(300).optional(), line: z.number().int().optional(), message: z.string().max(400) })).max(50),
});
export type PublishCheckResult = z.infer<typeof PublishCheckResult>;

/** What the owner is told when a publish, a share or an install stops at a check. Two sentences, no detail. */
export const CHECK_WORDS = {
  safety: "RMS found something in this mini-app that is not allowed, so it was not published. We have been told and will take a look.",
  broken: "This mini-app did not pass its checks, so it was not published. Ask RMS to fix it, then try again.",
} as const;

/** The plain sentence for a list of failed checks. */
export const checkWords = (failed: readonly string[]): string =>
  failed.some((c) => (SAFETY_CHECKS as readonly string[]).includes(c) || c === "scrub") ? CHECK_WORDS.safety : CHECK_WORDS.broken;

// ------------------------------------------------------------------ publish

/** The owner pressed Publish and then confirmed the one sentence they were shown. Nothing else can be sent. */
export const PublishRequest = z.strictObject({ confirm: z.literal(true) });
export type PublishRequest = z.infer<typeof PublishRequest>;

/** Going back to the version that was live before. The owner confirmed the one sentence they were shown. */
export const RollbackRequest = z.strictObject({ confirm: z.literal(true) });
export type RollbackRequest = z.infer<typeof RollbackRequest>;

/** The steps the owner watches, in order, with the words they see. */
export const PUBLISH_STEPS = [
  { id: "check", label: "Checking it is safe" },
  { id: "build", label: "Getting the screens ready" },
  { id: "save", label: "Saving it" },
  { id: "records", label: "Getting your records ready" },
  { id: "menu", label: "Adding it to your RMS menu" },
] as const;

export const PublishStepId = z.enum(["check", "build", "save", "records", "menu"]);
export type PublishStepId = z.infer<typeof PublishStepId>;

/**
 * One step, as the owner sees it. Same fields as the build conversation's `step` event, so the
 * same stepper draws it. Progress is NOT an event stream: the publish request answers once,
 * when it is finished, and the page reads `PublishStatus` every couple of seconds meanwhile.
 */
export const PublishStep = z.object({ id: PublishStepId, label: z.string().max(80), state: StepState });
export type PublishStep = z.infer<typeof PublishStep>;

/**
 *   not_ready        nothing has been built for this mini-app yet
 *   ready            there are built screens that are not live yet (never published, or changed since)
 *   publishing       a publish is running now
 *   published        what is live is the newest
 *   waiting_for_rms  held until RMS has looked at it
 *   failed           the last try stopped at a check. `message` says so in plain words
 */
export const PublishState = z.enum(["not_ready", "ready", "publishing", "published", "waiting_for_rms", "failed"]);
export type PublishState = z.infer<typeof PublishState>;

/** Where a mini-app stands. Every string is owner-facing. */
export const PublishStatus = z.object({
  appId: AppId,
  appName: z.string().max(40),
  /** Its address inside RMS: `/apps/<slug>`. */
  slug: z.string().max(49),
  state: PublishState,
  /** True when some version of it is live right now, whatever `state` says about newer work. */
  live: z.boolean(),
  /**
   * The one sentence the owner confirms before a publish, for example
   * "This adds Money to your RMS menu for your whole team. It reads your sales and staff costs."
   * Null when there is nothing to publish.
   */
  confirmText: z.string().max(240).nullable(),
  steps: z.array(PublishStep).max(PUBLISH_STEPS.length),
  message: z.string().max(240).nullable(),
  publishedAt: z.iso.datetime().nullable(),
  /** True when an earlier version can be put back. `rollbackText` is the sentence to confirm. */
  canRollBack: z.boolean(),
  rollbackText: z.string().max(240).nullable(),
});
export type PublishStatus = z.infer<typeof PublishStatus>;

export const PublishResult = z.object({
  status: z.enum(["published", "waiting_for_rms", "failed"]),
  appId: AppId,
  appName: z.string().max(40),
  slug: z.string().max(49),
  /** Plain words, always present: "Money is now in your RMS menu." or one of `CHECK_WORDS`. */
  message: z.string().max(240),
  /** The change this made, as the owner sees it. Null when the publish stopped before anything changed. */
  change: OwnerChangeNotice.nullable(),
});
export type PublishResult = z.infer<typeof PublishResult>;

/**
 * What is kept on a version about its publish (`platform.app_versions.checks`). Server-side
 * only: written by the platform login, never sent to an owner's browser as it is.
 */
export const VersionChecks = z.object({
  /** Set while a publish is running, so a second one is refused as `busy`. Stale after `PUBLISH_LIMITS.staleAfterMs`. */
  startedAt: z.iso.datetime().nullable(),
  steps: z.array(PublishStep).max(PUBLISH_STEPS.length),
  results: z.array(PublishCheckResult).max(12),
  bundle: BundleIndex.nullable(),
});
export type VersionChecks = z.infer<typeof VersionChecks>;

export const PUBLISH_LIMITS = {
  /** A publish must finish inside one request. The clean build is stopped at this point and the publish fails. */
  buildTimeoutMs: 180_000,
  /** A `startedAt` older than this is a publish that died. The next one may start. */
  staleAfterMs: 300_000,
  /** How often the page reads `PublishStatus` while a publish runs. */
  pollEveryMs: 2_000,
} as const;

// ------------------------------------------------------------------ the RMS menu

/** A published mini-app in the RMS navigation. Shown to every member of the restaurant. */
export const NavApp = z.object({
  id: AppId,
  /** Its address inside RMS is `/apps/<slug>`. Unique within the restaurant. */
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,48}$/),
  name: z.string().max(40),
  /** The short word in the menu. From the manifest's nav slot, or the name. */
  label: z.string().max(24),
  icon: z.string().max(32).nullable(),
  /** One plain sentence on what it is for. */
  summary: z.string().max(280),
});
export type NavApp = z.infer<typeof NavApp>;

/** Never includes a draft, a paused, a deleted or a hidden `system` mini-app. */
export const NavAppsResponse = z.object({ apps: z.array(NavApp).max(40) });
export type NavAppsResponse = z.infer<typeof NavAppsResponse>;

// ------------------------------------------------------------------ the apps host

/**
 * The server that hands out built mini-app files. It runs on its own origin, away from the RMS
 * web app and the API.
 *
 * Addresses come from settings, never from code: `APPS_URL` is where the apps host is reached
 * (the API uses it to make grants, the web app gets the same value as `NEXT_PUBLIC_APPS_URL`),
 * and `WEB_URL` is the RMS web app, the only site allowed to show a mini-app in a frame. Each
 * may be one address or a short comma-separated list (`exactOrigins`). Exact matches only. No
 * wildcards. The apps host must be a different HOST from the web app, not just a different
 * port (`canFrameApp` in frame.ts, ADR 0012): on the laptop the web app is on `127.0.0.1` and
 * the apps host on `localhost`, and for a phone the two use the laptop's two network names.
 *
 * An address is `<apps host>/a/<app id>/<version id>/<path>`. The apps host serves a file only
 * when that version is the mini-app's published version right now.
 *
 * The apps host answers ONLY under its own configured name (`appsHostNames`). It listens on
 * every address of the machine, so without this it would also answer under the web app's name,
 * where a mini-app's script could read the owner's sign-in cookie. A request whose `Host` is
 * anything else gets `421` and no file.
 */
export const APPS_HOST = {
  urlEnv: "APPS_URL",
  publicUrlEnv: "NEXT_PUBLIC_APPS_URL",
  shellEnv: "WEB_URL",
  /** The local port, when `APPS_URL` does not name one. Different from the web app (3000) and the console (3001). */
  defaultPort: 3002,
  prefix: "/a",
  entry: BUNDLE_ENTRY,
  maxOrigins: 4,
} as const;

/**
 * Turns one settings value into exact origins. The value is one address or a comma-separated
 * list. Anything that may not be used under the rules is dropped, never guessed at: a plain-http
 * network address counts only in local demo mode, and only when it is on the local demo list
 * letter for letter (`originAllowed` in frame.ts). At most `APPS_HOST.maxOrigins`, no repeats,
 * no wildcards.
 */
export const exactOrigins = (value: string | undefined | null, rules: OriginRules = STRICT_ORIGINS): string[] => {
  const out: string[] = [];
  for (const part of (value ?? "").split(",")) {
    const text = part.trim();
    if (text === "" || text.includes("*")) continue;
    let origin: string;
    try {
      origin = new URL(text).origin;
    } catch {
      continue;
    }
    if (originAllowed(origin, rules) && !out.includes(origin)) out.push(origin);
  }
  return out.slice(0, APPS_HOST.maxOrigins);
};

/** The exact `Host` values the apps host answers to: host and port of each configured origin, as a browser sends them. */
export const appsHostNames = (appsOrigins: readonly string[]): string[] =>
  appsOrigins.flatMap((origin) => {
    try {
      return AnyOrigin.safeParse(origin).success ? [new URL(origin).host] : [];
    } catch {
      return [];
    }
  });

/** The frame address of a published version. `appsOrigin` is one entry of `exactOrigins(APPS_URL, rules)`. */
export const appFrameUrl = (appsOrigin: string, appId: AppId, versionId: AppVersionId): string =>
  `${AnyOrigin.parse(appsOrigin)}${APPS_HOST.prefix}/${AppId.parse(appId)}/${AppVersionId.parse(versionId)}/`;

/**
 * Reads an apps-host address path. Null for anything else: the apps host answers "not found".
 * An address ending at the version (with or without the last slash) means the start page.
 */
export const parseAppsHostPath = (pathname: string): { appId: AppId; versionId: AppVersionId; path: BundlePath } | null => {
  if (pathname.length > 400 || pathname.includes("\\") || pathname.includes("%") || pathname.includes("\0")) return null;
  const m = /^\/a\/(app_[0-9a-f]{32})\/(ver_[0-9a-f]{32})(?:\/(.*))?$/.exec(pathname);
  if (!m) return null;
  const rest = m[3] === undefined || m[3] === "" ? APPS_HOST.entry : m[3];
  const path = BundlePath.safeParse(rest);
  if (!path.success) return null;
  return { appId: m[1] as AppId, versionId: m[2] as AppVersionId, path: path.data };
};

/**
 * The content policy every apps-host answer carries, as a response header. A built mini-app may
 * load its own files and nothing else, may call nothing on the network (`connect-src 'none'`:
 * data comes only through the RMS shell), may send no form anywhere, and may be framed only by
 * the RMS web app. With no shell origin configured, nobody may frame it.
 * Inline styles are allowed because the design system sets some from code. Inline scripts are not.
 */
export const appsHostPolicy = (shellOrigins: readonly string[]): string => {
  // The list was already made by `exactOrigins` under the server's rules. This only keeps a
  // malformed entry from ever being written into a header.
  const framers = shellOrigins.filter((o) => AnyOrigin.safeParse(o).success);
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    `frame-ancestors ${framers.length > 0 ? framers.join(" ") : "'none'"}`,
  ].join("; ");
};

/** The other headers on every apps-host answer. Never a `set-cookie`. */
export const APPS_HOST_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-read=()",
  "cross-origin-resource-policy": "same-origin",
  "cache-control": "no-store",
} as const;

// ------------------------------------------------------------------ routes

/**
 * Publish routes on the API origin, behind the member's RMS session. The restaurant, the user
 * and the role come from that session and nothing else. `:appId` names a mini-app: it is looked
 * up fenced to the caller's own restaurant, so someone else's id is simply not found. The hidden
 * `system` mini-app is not found either.
 *
 * `nav` and `open` are for every member (a published mini-app is for the whole team, and the
 * app token carries that member's own role and locations). Everything else is owner-only.
 */
export const PUBLISH_ROUTES = {
  nav: "/publish/v1/nav", // GET -> NavAppsResponse
  status: "/publish/v1/apps/:appId", // GET -> PublishStatus
  publish: "/publish/v1/apps/:appId", // POST PublishRequest -> PublishResult (answers when the publish is finished)
  rollback: "/publish/v1/apps/:appId/rollback", // POST RollbackRequest -> PublishResult
  open: "/publish/v1/apps/:appId/open", // POST, no body -> AppGrant (frame.ts)
} as const;

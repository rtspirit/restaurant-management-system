import { z } from "zod";
import { PublicListing, Recommendation } from "./governance.js";
import { AppId, Ident } from "./ids.js";
import { ModelAccess } from "./models.js";
import { SourcePath } from "./objects.js";

/**
 * The Marketplace (Wave 3, task P): sharing a mini-app, what the platform takes out first,
 * what other restaurants see, installing, and "Recommended for you".
 *
 * What travels with a shared mini-app: its screens (source) and the NAMES of the standard
 * tables it uses. What never travels: any row of data, any connection, any secret, anything
 * RMS remembers about the restaurant, and the restaurant's name or id. No shape another
 * restaurant can receive has a field for who made a listing.
 *
 * Today's limits, said plainly:
 *   - a mini-app that keeps its own kind of record (a custom `x_` model) cannot be shared yet.
 *     So `requiredModels` holds standard model keys only, and an install never copies a table shape.
 *   - updates from the original do not reach installers.
 *   - recommendations are rules. No model, no nightly job: they are worked out when the tab opens.
 */

export const ListingCategory = z.enum(["money", "suppliers", "stock", "staff", "sales", "other"]);
export type ListingCategory = z.infer<typeof ListingCategory>;

// ------------------------------------------------------------------ sharing

/**
 * The owner chooses to share one of their own PUBLISHED mini-apps and has confirmed the one
 * sentence they were shown. The title and summary are theirs to write: both are scanned like
 * the source, and a maintainer reads them before anything is listed.
 */
export const ShareRequest = z.strictObject({
  title: z.string().trim().min(3).max(60),
  summary: z.string().trim().min(10).max(280),
  category: ListingCategory,
  confirm: z.literal(true),
});
export type ShareRequest = z.infer<typeof ShareRequest>;

/**
 * What the scan looks for in the source, the title and the summary.
 *   own_name      the restaurant's name, a location's name or address, a staff member's name (from its set-up data)
 *   email, phone, street_address, web_address, long_number
 *   secret_like   something shaped like a key, a token or a password
 */
export const ScrubRule = z.enum(["own_name", "email", "phone", "street_address", "web_address", "long_number", "secret_like"]);
export type ScrubRule = z.infer<typeof ScrubRule>;

/** Which rules stop a share outright. The others are shown to the maintainer, who decides. */
export const SCRUB_BLOCKS = ["own_name", "email", "phone", "secret_like"] as const satisfies readonly ScrubRule[];

/**
 * One thing the scan found. Maintainer-only. `excerpt` never holds the whole match: the middle
 * is replaced with dots, so a real phone number or key is not copied into the report.
 */
export const ScrubFinding = z.object({
  rule: ScrubRule,
  /** A source file, or "title" or "summary". */
  where: z.union([SourcePath, z.enum(["title", "summary"])]),
  line: z.number().int().min(1).optional(),
  excerpt: z.string().max(60),
  blocks: z.boolean(),
});
export type ScrubFinding = z.infer<typeof ScrubFinding>;

/**
 * What the scrub did and found, kept on the listing version (`listing_versions.scan_report`).
 * Maintainer-only. `removed` records what was taken out before anything was stored: these are
 * facts about the copy, checked by tests, not promises.
 */
export const ScrubReport = z.object({
  format: z.literal(1),
  removed: z.object({
    /** The copy holds no rows: only source files and a manifest. Always true. */
    data: z.literal(true),
    /** How many connections were taken out of the manifest. */
    connections: z.number().int().nonnegative(),
    /** How many jobs and Ask tools were taken out of the manifest. */
    jobsAndTools: z.number().int().nonnegative(),
    /** Nothing RMS remembers (profiles, summaries, facts, the owner's requests) is copied. Always true. */
    memory: z.literal(true),
  }),
  scannedFiles: z.number().int().nonnegative(),
  findings: z.array(ScrubFinding).max(100),
  /** clean: nothing found. flagged: found something a maintainer should read. blocked: not sent for review at all. */
  verdict: z.enum(["clean", "flagged", "blocked"]),
});
export type ScrubReport = z.infer<typeof ScrubReport>;

/**
 *   private          not shared (the default, always)
 *   waiting_for_rms  shared, and waiting for RMS to check it
 *   listed           other restaurants can see and install it
 *   declined         RMS said no. It stays private
 */
export const ShareState = z.enum(["private", "waiting_for_rms", "listed", "declined"]);
export type ShareState = z.infer<typeof ShareState>;

/** Where one of the owner's mini-apps stands on sharing, with the words to confirm. Owner-facing. */
export const ShareStatus = z.object({
  appId: AppId,
  appName: z.string().max(40),
  state: ShareState,
  /** False with a plain reason when it cannot be shared (not published yet, or it keeps its own kind of record). */
  canShare: z.boolean(),
  reason: z.string().max(240).nullable(),
  /** A starting title and summary, from the mini-app's own name and purpose. */
  suggested: z.object({ title: z.string().max(60), summary: z.string().max(280), category: ListingCategory }),
  /** The sentence the owner confirms: what will be shared, and what never is. */
  confirmText: z.string().max(280),
});
export type ShareStatus = z.infer<typeof ShareStatus>;

export const ShareResult = z.object({
  status: z.enum(["waiting_for_rms", "needs_changes", "failed"]),
  /** Plain words: "Sent to RMS to check. You will see it here when it is listed." */
  message: z.string().max(240),
  /** For `needs_changes`: what to fix, in plain words, never a file name or a rule name. */
  problems: z.array(z.string().max(200)).max(5),
});
export type ShareResult = z.infer<typeof ShareResult>;

// ------------------------------------------------------------------ what other restaurants see

/** A table a listing needs, in the viewer's own terms. */
export const ListingNeed = z.strictObject({
  model: Ident,
  /** The table's everyday name, for example "Sales days". */
  name: z.string().max(60),
  access: ModelAccess,
  /** True when the VIEWER's restaurant already has this table. Says nothing about anyone else. */
  have: z.boolean(),
});
export type ListingNeed = z.infer<typeof ListingNeed>;

/**
 * One listing, opened by a restaurant that might install it. Everything about the mini-app,
 * nothing about who made it: like `PublicListing`, this shape has no publisher field of any
 * kind, and it is strict, so one cannot be added by accident.
 */
export const PublicListingDetail = z.strictObject({
  ...PublicListing.shape,
  /** What it does, one short plain line each. */
  whatItDoes: z.array(z.string().max(120)).max(8),
  needs: z.array(ListingNeed).max(40),
  /** Systems it can take numbers from. `connected`: the VIEWER has that connection. */
  connections: z.array(z.strictObject({ id: Ident, name: z.string().max(60), connected: z.boolean() })).max(6),
  /** True when the viewer's restaurant has installed it already. */
  installed: z.boolean(),
  /** The sentence the viewer confirms before installing. */
  confirmText: z.string().max(280),
});
export type PublicListingDetail = z.infer<typeof PublicListingDetail>;

/** A card in the Marketplace tab. */
export const MarketplaceCard = z.strictObject({ listing: PublicListing, installed: z.boolean() });
export type MarketplaceCard = z.infer<typeof MarketplaceCard>;

/**
 * The Marketplace tab. `recommended` may be empty (then the row is not drawn). A listing in
 * `recommended` is also in `listings`. Only listings that are public AND approved are ever in
 * either. A restaurant's own shared mini-app is never recommended to itself.
 */
export const MarketplaceHome = z.strictObject({ recommended: z.array(Recommendation).max(6), listings: z.array(MarketplaceCard).max(60) });
export type MarketplaceHome = z.infer<typeof MarketplaceHome>;

/**
 * How a recommendation is scored. Rules only. A score never leaves the server: the owner sees
 * reasons, best first.
 *   - `minScore`: below this a listing is not recommended (it still shows in the full list).
 *   - `minSimilarInstalls`: "popular with places like yours" is only said when at least this
 *     many DIFFERENT restaurants of the same kind installed it, so the reason can never point
 *     at one restaurant.
 */
export const RECOMMENDATION_RULES = {
  maxRecommended: 6,
  maxReasons: 3,
  minScore: 2,
  minSimilarInstalls: 3,
  points: { hasEveryTable: 3, hasSomeTables: 1, hasConnection: 2, fitsServiceStyle: 1, popularWithSimilar: 2 },
} as const;

// ------------------------------------------------------------------ installing

/** The viewer confirmed the listing's `confirmText`. The listing is named in the address, and nothing else can be sent. */
export const InstallRequest = z.strictObject({ confirm: z.literal(true) });
export type InstallRequest = z.infer<typeof InstallRequest>;

/**
 * Which of the installer's tables each required table was matched to, kept on the install
 * (`installs.model_mapping`). Today a required table is always a standard one, so it maps to
 * the same key: `already_had` when the restaurant had it, `created` when the install made it.
 */
export const ModelMapping = z.record(Ident, z.strictObject({ to: Ident, how: z.enum(["already_had", "created"]) }));
export type ModelMapping = z.infer<typeof ModelMapping>;

export const InstallResult = z.object({
  status: z.enum(["installed", "already_installed", "failed"]),
  /** The new mini-app in the installer's own restaurant. Null when it failed. */
  appId: AppId.nullable(),
  slug: z.string().max(49).nullable(),
  appName: z.string().max(40),
  /** Plain words: "Money is now in your RMS menu. It uses your own sales and staff costs." */
  message: z.string().max(240),
  /** One plain line per table: "Uses your sales days" or "Added a place for supplier bills". */
  tables: z.array(z.string().max(120)).max(40),
});
export type InstallResult = z.infer<typeof InstallResult>;

/**
 * Marketplace routes on the API origin, behind the member's RMS session. Owner-only today.
 * `:listingId` is looked up through the public listings view only (listed and public), so an
 * unlisted, private or made-up id is simply not found. `:appId` is fenced to the caller's own
 * restaurant.
 */
export const MARKETPLACE_ROUTES = {
  home: "/marketplace/v1", // GET -> MarketplaceHome
  listing: "/marketplace/v1/listings/:listingId", // GET -> PublicListingDetail
  install: "/marketplace/v1/listings/:listingId/install", // POST InstallRequest -> InstallResult
  shareStatus: "/marketplace/v1/apps/:appId/share", // GET -> ShareStatus
  share: "/marketplace/v1/apps/:appId/share", // POST ShareRequest -> ShareResult
} as const;

// @rms/marketplace: sharing a mini-app, the scrub, listings, installing and recommendations. Task P owns this package.
// Brief: docs/briefs/wave3.md, task P. Contract: marketplace.ts in @rms/contracts.
//
// The signatures below are the interface the API routes and the console (task O) call. They are
// fixed by the brief. Until task P lands they find nothing and do nothing, so the other tasks
// can be written and tested against them today.
//
// Every function takes the tenant context built from a verified RMS session. A listing is only
// ever read through `platform.public_listings` (listed and public, no publisher) when the
// answer goes to another restaurant.
import type {
  AppId,
  AppManifest,
  AppSource,
  HeldAction,
  InstallResult,
  ListingId,
  ListingReview,
  MarketplaceHome,
  PublicListingDetail,
  ScrubReport,
  ShareRequest,
  ShareResult,
  ShareStatus,
  TenantContext,
} from "@rms/contracts";
import type { Sql } from "@rms/db";
import type { HeldHandler } from "@rms/governance";

export class MarketplaceError extends Error {
  constructor(readonly reason: "not_found" | "forbidden" | "unavailable") {
    super(`marketplace: ${reason}`);
  }
}

/** What the scan compares the source with: the restaurant's own names, from its set-up data. Never stored, never sent on. */
export type ScrubKnown = { restaurantName: string; locationNames: string[]; addresses: string[]; staffNames: string[]; phones: string[] };

/**
 * Makes the copy that may leave a restaurant, and reports what it found. Pure: no database, no
 * model. The copy holds source files and a manifest with its connections, jobs and Ask tools
 * taken out. It never holds a row of data or anything RMS remembers.
 */
export const scrubForSharing = (
  input: { source: AppSource; manifest: AppManifest; title: string; summary: string },
  _known: ScrubKnown,
): { source: AppSource; manifest: AppManifest; report: ScrubReport } => ({
  source: input.source,
  manifest: input.manifest,
  report: { format: 1, removed: { data: true, connections: 0, jobsAndTools: 0, memory: true }, scannedFiles: 0, findings: [], verdict: "blocked" },
});

/** Where one of the owner's own mini-apps stands on sharing. Owner only. Null when it is not theirs. */
export const shareStatus = async (_tenant: TenantContext, _appId: AppId): Promise<ShareStatus | null> => null;

/**
 * Shares one of the owner's own published mini-apps: scrub, the same checks as publish, store
 * the scrubbed copy, record a change that waits for a maintainer and holds `list_listing`.
 * Nothing is visible to another restaurant until that change is approved.
 */
export const shareApp = async (_tenant: TenantContext, _appId: AppId, _request: ShareRequest, _opts: { requestId?: string | null } = {}): Promise<ShareResult> => ({
  status: "failed",
  message: "Sharing is not switched on yet.",
  problems: [],
});

/** The Marketplace tab: recommended listings with reasons, and every listed listing. */
export const marketplaceHome = async (_tenant: TenantContext): Promise<MarketplaceHome> => ({ recommended: [], listings: [] });

/** One listed listing, in the viewer's own terms. Null when it is not listed and public. */
export const listingDetail = async (_tenant: TenantContext, _listingId: ListingId): Promise<PublicListingDetail | null> => null;

/**
 * Installs a listed listing into the caller's own restaurant: copies the scrubbed source into a
 * new mini-app there, makes sure the tables it needs exist, and publishes it through the normal
 * publish path (`publishApp` from @rms/publish). The new mini-app reads the installer's data only.
 */
export const installListing = async (_tenant: TenantContext, _listingId: ListingId, _opts: { requestId?: string | null } = {}): Promise<InstallResult> => ({
  status: "failed",
  appId: null,
  slug: null,
  appName: "",
  message: "Installing is not switched on yet.",
  tables: [],
});

/**
 * What happens to a held public share when a maintainer decides. The console's decision
 * (task O) calls this inside its own transaction. Approve: the listing becomes listed. Reject:
 * it goes back to private. Both check first that the listing belongs to the change's own
 * restaurant and is still waiting.
 */
export const heldListingHandler: HeldHandler<Extract<HeldAction, { kind: "list_listing" }>> = {
  approve: async () => {
    throw new MarketplaceError("unavailable");
  },
  reject: async () => {
    throw new MarketplaceError("unavailable");
  },
};

/** What a maintainer reads before deciding a share. Platform login only. */
export const listingReview = async (_adminSql: Sql, _listingId: ListingId, _number: number): Promise<ListingReview | null> => null;

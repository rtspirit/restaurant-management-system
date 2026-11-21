// @rms/publish: publishing a mini-app, opening a published one, and rolling one back. Task N owns this package.
// Brief: docs/briefs/wave3.md, task N. Contract: publish.ts and objects.ts in @rms/contracts.
//
// The signatures below are the interface the API routes, the Marketplace (task P) and the
// console (task O) call. They are fixed by the brief. Until task N lands they answer "not
// built yet", so the other tasks can be written and tested against them today.
//
// Every function takes the tenant context built from a verified RMS session. Nothing here
// takes a restaurant, a user, a role, a key or an address from a request.
import type { AppGrant, AppId, AppManifest, AppSource, NavApp, PublishCheckResult, PublishResult, PublishStatus, TenantContext } from "@rms/contracts";
import type { BuiltFile } from "@rms/db";

export class PublishError extends Error {
  constructor(readonly reason: "not_found" | "forbidden" | "busy" | "not_ready" | "unavailable") {
    super(`publish: ${reason}`);
  }
}

/**
 * What the clean build made. `ok` is true only when every check in `PUBLISH_CHECKS` passed.
 * `results` is for maintainers and logs: an owner only ever hears `checkWords(...)`.
 */
export type BuildOutcome = {
  ok: boolean;
  results: PublishCheckResult[];
  /** The built files. Empty unless `ok`. */
  files: BuiltFile[];
  /** The dependency lists of the `package.json` the checks saw, for the detectors. */
  dependencies: { dependencies: string[]; devDependencies: string[] };
};

/**
 * Runs every publish check on a source and a manifest, in a clean copy of RMS's own template,
 * and builds the static files. Changes nothing in the database. Publish calls it, and so does
 * sharing (task P), which must pass the same checks on the scrubbed source.
 */
export const checkAndBuild = async (_tenant: TenantContext, _input: { manifest: AppManifest; source: AppSource }): Promise<BuildOutcome> => {
  throw new PublishError("unavailable");
};

export type PublishOptions = {
  /** "install" when the Marketplace publishes a mini-app it has just copied into the installer's restaurant. */
  origin?: "publish" | "install";
  requestId?: string | null;
};

/**
 * Publishes the mini-app's current draft version: reads its saved source, runs `checkAndBuild`,
 * stores the built files, records the change (the caller's confirm is the owner's yes), brings
 * its tables live, marks the version published and adds it to the RMS menu. Owner only.
 * Never throws for a failed check: that is a `PublishResult` with status "failed" and plain words.
 */
export const publishApp = async (_tenant: TenantContext, _appId: AppId, _opts: PublishOptions = {}): Promise<PublishResult> => {
  throw new PublishError("unavailable");
};

/** Where a mini-app stands, with the sentence to confirm. Owner only. */
export const publishStatus = async (_tenant: TenantContext, _appId: AppId): Promise<PublishStatus> => {
  throw new PublishError("unavailable");
};

/** Puts the version that was live before back. One transaction. Owner only. */
export const rollbackApp = async (_tenant: TenantContext, _appId: AppId, _opts: { requestId?: string | null } = {}): Promise<PublishResult> => {
  throw new PublishError("unavailable");
};

/** The restaurant's published mini-apps, for the RMS menu. Any member. Never a draft, paused, deleted or hidden one. */
export const navApps = async (_tenant: TenantContext): Promise<NavApp[]> => [];

/**
 * What the shell needs to show a published mini-app in a frame: the address on the apps host
 * and an app token for this member, this mini-app and its published version. Any member.
 * Refuses unless `canFrameApp` allows the apps host's origin inside the RMS web app's (a
 * different host, not just a different port: ADR 0012), and unless the built files were made
 * for the RMS address in use.
 */
export const openApp = async (_tenant: TenantContext, _appId: AppId, _who: { email: string | null }): Promise<AppGrant> => {
  throw new PublishError("unavailable");
};

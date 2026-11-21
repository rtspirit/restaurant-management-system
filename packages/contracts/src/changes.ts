import { z } from "zod";
import { ChangeOrigin, ChangeSet, ChangeSignal, OwnerChangeNotice, Tier } from "./governance.js";
import { AppId, AppVersionId, Ident, ListingId } from "./ids.js";
import { AppManifest } from "./manifest.js";
import { ModelChange } from "./models.js";
import { PublishCheckName, PublishCheckResult } from "./publish.js";

/**
 * Wave 3, task O: turning what really happened into signals, the owner's side of a change, and
 * what happens to a held action when someone decides.
 *
 * Two audiences, two sets of shapes, never mixed:
 *   - owners get plain words: `OwnerChangeItem`, `OwnerChangesResponse`. No tier, no signal name.
 *   - maintainers get their own words: `DetectedChange`, `HeldAction`, `ChangeDetail`.
 */

// ------------------------------------------------------------------ detectors (maintainer side, server only)

/**
 * What a detector is given: the facts of one change, gathered by the code that made it
 * (publish, share, install). Never built from request text.
 */
export const ChangeEvidence = z.object({
  origin: ChangeOrigin,
  /** The manifest before (the version that was live, or null when nothing was) and after. */
  manifest: z.object({ before: AppManifest.nullable(), after: AppManifest }).optional(),
  /** Model changes that go live with this change. */
  modelChanges: z.array(ModelChange).max(60).default([]),
  /** Models in the manifest (after) that hold a field tagged payroll or financial. Worked out from the definitions by the caller. */
  sensitiveModels: z.array(Ident).max(40).default([]),
  /** The dependency lists of the `package.json` the checks saw. */
  dependencies: z.object({ dependencies: z.array(z.string().max(120)).max(60), devDependencies: z.array(z.string().max(120)).max(60) }).optional(),
  /** Checks that failed. A publish with a failed check never goes live: this only decides what is recorded. */
  failedChecks: z.array(z.union([PublishCheckName, z.literal("scrub")])).max(12).default([]),
  /** True when this mini-app has never been live in this restaurant before (a first publish, or an install). */
  firstPublish: z.boolean().default(false),
  /** True when this change offers a mini-app to other restaurants. */
  publicShare: z.boolean().default(false),
});
export type ChangeEvidence = z.input<typeof ChangeEvidence>;

/** One line a maintainer reads to decide, for example { label: "New write access", value: "ledger_entry" }. Maintainer words. */
export const ChangeFact = z.object({ label: z.string().max(60), value: z.string().max(200) });
export type ChangeFact = z.infer<typeof ChangeFact>;

/**
 * What a detector answers. Rules only, no model. The rules (task O implements every line, and
 * a test checks each):
 *
 *   firstPublish                                            first_publish
 *   publicShare                                             public_share
 *   a failed check in SAFETY_CHECKS, or a failed scrub      security_check_blocked
 *   manifest: a model gains write access (new, or read to write)        new_write_access
 *   manifest: a new action                                  new_action
 *   manifest: a new job                                     new_job
 *   manifest: a new connection, or a new tool on one        new_connection
 *   manifest: anything else differs, or nothing at all      screen_change
 *   model change use_template / create_custom_model         new_model
 *   model change add_field, optional / required             new_optional_field / new_required_field
 *   model change add_unique / add_index                     new_unique_rule / new_index
 *   sensitiveModels is not empty AND (first publish, or one of them is new to the manifest,
 *     or one of them gains write access)                    touches_payroll_or_financial
 *   dependencies: a name outside ALLOWED_APP_DEPENDENCIES   new_dependency
 *
 * A detector may add a signal. It never removes one a caller already has, and the tier is
 * always `tierForSignals(signals)`: nothing can lower it.
 */
export const DetectedChange = z
  .object({ signals: z.array(ChangeSignal).max(20), tier: Tier, facts: z.array(ChangeFact).max(30) })
  .refine((d) => new Set(d.signals).size === d.signals.length, "A signal is listed twice");
export type DetectedChange = z.infer<typeof DetectedChange>;

// ------------------------------------------------------------------ hold and resume (maintainer side, server only)

/**
 * An action that is recorded and NOT done, waiting for someone's yes. Kept on the change set
 * (`platform.change_sets.held_action`, which only the platform login can write or read).
 * When the change is approved or confirmed, the action is carried out by the task that owns
 * its kind, in the same transaction as the decision. When it is rejected, it is cancelled the
 * same way. Before either, the handler checks again that the thing it names still belongs to
 * the change's own restaurant and is still waiting: the ids here are a pointer, not a permission.
 *
 *   list_listing   a public share. Approve: the listing becomes visible to other restaurants.
 *                  Reject: it goes back to private. Owned by task P.
 *   publish_app    a publish that needs a maintainer first. Declared so a held publish needs no
 *                  new shape later. Nothing creates one today.
 *
 * A change with no held action (a blocked safety check, for example) has nothing to carry out:
 * deciding it only closes it. A kind with no handler cannot be approved.
 */
export const HeldAction = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("list_listing"), listingId: ListingId, number: z.number().int().min(1) }),
  z.strictObject({ kind: z.literal("publish_app"), appId: AppId, versionId: AppVersionId }),
]);
export type HeldAction = z.infer<typeof HeldAction>;
export type HeldActionKind = HeldAction["kind"];

/**
 *   none         the change held nothing
 *   waiting      held, not decided yet
 *   carried_out  approved, and the action was done
 *   cancelled    rejected, and the action was undone
 */
export const HeldState = z.enum(["none", "waiting", "carried_out", "cancelled"]);
export type HeldState = z.infer<typeof HeldState>;

// ------------------------------------------------------------------ the owner's side

/**
 * One change as the owner sees it, with enough to say yes to it. Plain words only.
 * `detail`: what will happen, or what happened, one short line each ("It will read your sales days").
 * `canConfirm`: it is waiting for this owner's yes. False for staff, always.
 */
export const OwnerChangeItem = z.strictObject({
  ...OwnerChangeNotice.shape,
  appName: z.string().max(40).nullable(),
  detail: z.array(z.string().max(160)).max(6),
  canConfirm: z.boolean(),
});
export type OwnerChangeItem = z.infer<typeof OwnerChangeItem>;

/** `waiting`: changes that need the owner's OK, oldest first. `recent`: everything else, newest first. */
export const OwnerChangesResponse = z.object({ waiting: z.array(OwnerChangeItem).max(50), recent: z.array(OwnerChangeItem).max(50) });
export type OwnerChangesResponse = z.infer<typeof OwnerChangesResponse>;

/** The owner says yes to one waiting change. There is no other answer to send: "not now" sends nothing. */
export const ConfirmChangeRequest = z.strictObject({ confirm: z.literal(true) });
export type ConfirmChangeRequest = z.infer<typeof ConfirmChangeRequest>;

export const ConfirmChangeResponse = z.object({ change: OwnerChangeItem });
export type ConfirmChangeResponse = z.infer<typeof ConfirmChangeResponse>;

/**
 * The owner's routes, on the API origin, behind the member's RMS session. `list` shows the
 * restaurant's own changes to any member (staff see them with `canConfirm` false). `confirm` is
 * owner-only. `:changeId` is looked up fenced to the caller's own restaurant.
 */
export const CHANGES_ROUTES = {
  list: "/changes/v1", // GET -> OwnerChangesResponse
  confirm: "/changes/v1/:changeId/confirm", // POST ConfirmChangeRequest -> ConfirmChangeResponse
} as const;

// ------------------------------------------------------------------ the maintainer's side

/**
 * What a maintainer needs to decide a Marketplace share. Maintainer-only (the console may see
 * which restaurant asked). `source` is the scrubbed source: paths and sizes here, text on request.
 */
export const ListingReview = z.object({
  listingId: ListingId,
  number: z.number().int().min(1),
  title: z.string().max(60),
  summary: z.string().max(280),
  category: z.string().max(40),
  requiredModels: z.array(Ident).max(40),
  requiredConnections: z.array(Ident).max(6),
  /** Every check the share ran, the scrub included, with its findings. */
  checks: z.array(PublishCheckResult).max(12),
  files: z.array(z.object({ path: z.string().max(200), bytes: z.number().int().nonnegative() })).max(80),
});
export type ListingReview = z.infer<typeof ListingReview>;

/** One change, opened in the console: enough to decide without leaving the page. */
export const ChangeDetail = z.object({
  change: ChangeSet,
  restaurantName: z.string(),
  appName: z.string().nullable(),
  facts: z.array(ChangeFact).max(30),
  held: HeldAction.nullable(),
  heldState: HeldState,
  /** In plain maintainer words: what Approve will do and what Reject will do, right now. */
  onApprove: z.string().max(200),
  onReject: z.string().max(200),
  /** Present when the change holds a Marketplace listing. */
  review: ListingReview.nullable(),
});
export type ChangeDetail = z.infer<typeof ChangeDetail>;

/** The console's decision, as sent. The maintainer is the signed-in staff user, never a field. */
export const DecideChangeRequest = z.strictObject({ decision: z.enum(["approve", "reject"]), note: z.string().max(1000).optional() });
export type DecideChangeRequest = z.infer<typeof DecideChangeRequest>;

export const DecideChangeResponse = z.object({ change: ChangeSet, heldState: HeldState });
export type DecideChangeResponse = z.infer<typeof DecideChangeResponse>;

/** Console routes on the API origin, behind a maintainer's session (`requireStaff`). The first three exist since Wave 1. */
export const ADMIN_ROUTES = {
  feed: "/admin/feed", // GET -> { items, nextBefore }
  queue: "/admin/queue", // GET -> { items }
  decide: "/admin/changes/:changeId/decision", // POST DecideChangeRequest -> DecideChangeResponse
  detail: "/admin/changes/:changeId", // GET -> ChangeDetail
} as const;

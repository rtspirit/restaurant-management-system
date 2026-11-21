import { z } from "zod";
import { AppId, ChangeSetId, Ident, ListingId, OrgId } from "./ids.js";

export const Tier = z.enum(["T0", "T1", "T2", "T3"]);
export type Tier = z.infer<typeof Tier>;

/** What the policy table does with each tier. */
export const TIER_POLICY = {
  T0: { action: "apply", notify: false, hold: false },
  T1: { action: "apply", notify: false, hold: false },
  T2: { action: "apply_after_owner_confirm", notify: true, hold: false },
  T3: { action: "hold_for_maintainer", notify: true, hold: true },
} as const satisfies Record<Tier, { action: string; notify: boolean; hold: boolean }>;

/** Rule-based signals. Demo: rules only, no model-written summary. */
export const ChangeSignal = z.enum([
  "theme_change",
  "screen_change",
  "new_model",
  "new_optional_field",
  "new_index",
  "new_required_field",
  "new_unique_rule",
  "new_connection",
  "new_write_access",
  "new_action",
  "new_job",
  "role_change",
  "first_publish",
  "touches_payroll_or_financial",
  "public_share",
  "new_dependency",
  "security_check_blocked",
]);
export type ChangeSignal = z.infer<typeof ChangeSignal>;

export const SIGNAL_TIER: Record<ChangeSignal, Tier> = {
  theme_change: "T0",
  screen_change: "T1",
  new_model: "T1",
  new_optional_field: "T1",
  new_index: "T1",
  new_required_field: "T2",
  new_unique_rule: "T2",
  new_connection: "T2",
  new_write_access: "T2",
  new_action: "T2",
  new_job: "T2",
  role_change: "T2",
  first_publish: "T2",
  touches_payroll_or_financial: "T2",
  public_share: "T3",
  new_dependency: "T3",
  security_check_blocked: "T3",
};

/** The one way to turn signals into a tier: the highest wins. No signals = T0. */
export const tierForSignals = (signals: readonly ChangeSignal[]): Tier =>
  signals.reduce<Tier>((top, s) => (SIGNAL_TIER[s] > top ? SIGNAL_TIER[s] : top), "T0");

export const ChangeOrigin = z.enum(["build", "publish", "settings", "connection", "share", "install", "system"]);
export const ChangeDecision = z.enum(["applied", "pending_owner", "pending_maintainer", "approved", "rejected"]);

/** A change set as the maintainer console sees it. Tier codes are maintainer words. */
export const ChangeSet = z
  .object({
    id: ChangeSetId,
    orgId: OrgId,
    appId: AppId.nullable(),
    origin: ChangeOrigin,
    signals: z.array(ChangeSignal),
    tier: Tier,
    /** Plain summary written by rules. */
    summary: z.string(),
    decision: ChangeDecision,
    createdAt: z.iso.datetime(),
    decidedAt: z.iso.datetime().nullable(),
  })
  .refine((c) => c.tier === tierForSignals(c.signals), "Tier does not match the signals");
export type ChangeSet = z.infer<typeof ChangeSet>;

/** The same change as the owner sees it: plain words, no tier codes, no signal names. */
export const OwnerChangeNotice = z.strictObject({
  id: ChangeSetId,
  summary: z.string().max(240),
  status: z.enum(["done", "needs_your_ok", "waiting_for_rms", "approved", "declined"]),
  at: z.iso.datetime(),
});
export type OwnerChangeNotice = z.infer<typeof OwnerChangeNotice>;

/**
 * A marketplace listing as other restaurants see it. There is no publisher field of any
 * kind in this shape, on purpose: the restaurant that made it is never named or returned.
 * `requiredModels` holds library model keys only. A custom model travels as a shape inside
 * the listing version, under a neutral generated key, never under the publisher's own key.
 */
export const PublicListing = z.strictObject({
  id: ListingId,
  title: z.string().max(60),
  summary: z.string().max(280),
  category: z.string().max(40),
  requiredModels: z.array(Ident).max(40),
  requiredConnections: z.array(Ident).max(6),
  installCount: z.number().int().nonnegative(),
});
export type PublicListing = z.infer<typeof PublicListing>;

export const Recommendation = z.strictObject({
  listing: PublicListing,
  /** Shown to the owner, for example "Uses your sales days" or "Popular with pizza places your size". */
  reasons: z.array(z.string().max(120)).min(1).max(3),
});
export type Recommendation = z.infer<typeof Recommendation>;

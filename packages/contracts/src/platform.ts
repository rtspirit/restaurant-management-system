import { z } from "zod";
import { Actor, Role } from "./auth.js";
import { ChangeSetId, OrgId, ParentModelKey } from "./ids.js";

/** Shapes shared between sign-up (A), parent data (B), the Data API (D) and the console (F). */

export const ServiceStyle = z.enum(["full_service", "counter_service", "quick_service", "bar", "cafe", "food_truck"]);
export type ServiceStyle = z.infer<typeof ServiceStyle>;

export const PriceBand = z.enum(["low", "mid", "high", "premium"]);

/** The five onboarding questions. Everything else in the profile comes from parent data. */
export const OnboardingAnswers = z.strictObject({
  restaurantName: z.string().min(1).max(80),
  serviceStyle: ServiceStyle,
  cuisine: z.string().min(1).max(60),
  locationCount: z.number().int().min(1).max(50),
  systemsUsed: z.array(z.string().max(40)).max(8),
});
export type OnboardingAnswers = z.infer<typeof OnboardingAnswers>;

/** Parent data: what RMS holds about the restaurant. Read-only to the restaurant and the agent. */
export const RestaurantProfile = z.object({
  name: z.string(),
  concept: z.string(),
  cuisine: z.string(),
  serviceStyle: ServiceStyle,
  seats: z.number().int().nonnegative(),
  priceBand: PriceBand,
  systemsUsed: z.array(z.string()),
  brandColour: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable(),
  logoUrl: z.string().nullable(),
});
export type RestaurantProfile = z.infer<typeof RestaurantProfile>;

/** Defaults used when a location has none. */
export const LOCATION_DEFAULTS = { dayCutoff: "04:00", currency: "USD", timezone: "America/New_York" } as const;

/** `area.verb`, for example "data.insert", "app.publish", "listing.approve". */
export const AuditAction = z.string().regex(/^[a-z_]+\.[a-z_]+$/);

/**
 * Audit entry. Append-only. Written by the Data API and every platform service in the same
 * transaction as the change, read by the maintainer console. `meta` never holds field values
 * tagged personal, payroll or financial: counts, keys and ids only.
 */
export const AuditEntry = z.object({
  id: z.uuid(),
  orgId: OrgId,
  actor: Actor,
  action: AuditAction,
  targetType: z.string().max(60),
  targetId: z.string().max(120).nullable(),
  meta: z.record(z.string(), z.unknown()),
  requestId: z.string().nullable(),
  at: z.iso.datetime(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

/** Outbox: one row per thing to announce, written in the same transaction as the change. */
export const OutboxTopic = z.enum(["change_set.created", "change_set.decided", "app.published", "listing.submitted", "listing.decided", "connection.synced"]);

export const OutboxMessage = z.object({
  topic: OutboxTopic,
  orgId: OrgId,
  changeSetId: ChangeSetId.nullable(),
  payload: z.record(z.string(), z.unknown()),
});
export type OutboxMessage = z.infer<typeof OutboxMessage>;

/** The two seeded demo restaurants a new owner can be given. */
export const DemoTemplate = z.enum(["marigold", "slice_yard"]);
export type DemoTemplate = z.infer<typeof DemoTemplate>;

/** What `GET /auth/me` returns: the signed-in user and their restaurant, or null before onboarding. */
export const MyRestaurant = z.object({
  id: OrgId,
  name: z.string(),
  role: Role,
  brandColour: z.string().nullable(),
  locations: z.array(z.object({ id: z.string(), name: z.string() })),
  ready: z.boolean(),
});
export type MyRestaurant = z.infer<typeof MyRestaurant>;

export const MeResponse = z.object({
  user: z.object({ id: z.string(), email: z.string().nullable() }),
  restaurant: MyRestaurant.nullable(),
});
export type MeResponse = z.infer<typeof MeResponse>;

/**
 * What `GET /auth/parent/:model` returns: one of the restaurant's set-up lists (menu, staff,
 * locations and so on) for RMS's own screens. The restaurant is the signed-in member's own.
 * Row values use the Data API's field formats. A column the member's role may not see is
 * named in `masked` and is absent from `columns` and from every row.
 */
export const ParentListResponse = z.object({
  model: ParentModelKey,
  name: z.string(),
  columns: z.array(z.object({ key: z.string(), label: z.string(), type: z.string() })),
  rows: z.array(z.record(z.string(), z.unknown())),
  masked: z.array(z.string()),
});
export type ParentListResponse = z.infer<typeof ParentListResponse>;

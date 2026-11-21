// Task A owns this file. Export a Hono app. It is mounted at /auth by src/index.ts (lead-owned).
//
// Sign-up and onboarding. Identity always comes from the verified Supabase access token
// (`requireUser`). The body never names a user, restaurant or role.
import { Hono } from "hono";
import { cors } from "hono/cors";
import { OnboardingAnswers, type Role, type ServiceStyle, toPublicId } from "@rms/contracts";
import { type Sql, type Tx, adminDb, apiDb, newUuid, withOrg } from "@rms/db";
import { type SignedInUser, type UserEnv, membershipsFor, requireUser } from "@rms/auth";
import * as seed from "@rms/seed";

/** The interface task B exports from `@rms/seed` (wave 1 brief, task A section). */
export type DemoTemplate = "marigold" | "slice_yard";
export type CreateDemoRestaurant = (
  adminSql: Sql,
  opts: { template: DemoTemplate },
) => Promise<{ orgUuid: string; storePrefix: string; name: string }>;

export type AuthRouteDeps = { createDemoRestaurant: CreateDemoRestaurant | undefined };

/** Which demo restaurant a new owner gets, from their answer about service style. */
export const templateFor = (style: ServiceStyle): DemoTemplate => (style === "counter_service" ? "slice_yard" : "marigold");

export type RestaurantView = {
  id: string;
  name: string;
  role: Role;
  brandColour: string | null;
  locations: { id: string; name: string }[];
  ready: boolean;
};

export type MeResponse = {
  user: { id: string; email: string | null };
  restaurant: RestaurantView | null;
};

const fail = (code: string, message: string) => ({ error: { code, message, requestId: crypto.randomUUID() } });

/**
 * The signed-in user's restaurant, read through the restaurant-facing login fenced to the org
 * found from the user's own membership row. Returns null when they have not onboarded.
 */
const restaurantFor = async (user: SignedInUser): Promise<RestaurantView | null> => {
  const [m] = await membershipsFor(user.userUuid);
  if (!m) return null;
  return withOrg(apiDb(), m.orgUuid, async (tx) => {
    const [org] = await tx<{ name: string; brand_colour: string | null }[]>`
      select name, brand_colour from platform.organizations where id = ${m.orgUuid}`;
    // No member_locations rows means every location.
    const locations = await tx<{ id: string; name: string }[]>`
      select l.id, l.name from platform.locations l
      where l.org_id = ${m.orgUuid}
        and (not exists (select 1 from platform.member_locations ml where ml.member_id = ${m.memberUuid})
             or l.id in (select ml.location_id from platform.member_locations ml where ml.member_id = ${m.memberUuid}))
      order by l.name`;
    return {
      id: toPublicId("org", m.orgUuid),
      name: org?.name ?? m.orgName,
      role: m.role,
      brandColour: org?.brand_colour ?? null,
      locations: locations.map((l) => ({ id: toPublicId("loc", l.id), name: l.name })),
      ready: m.storeReady,
    };
  });
};

/** One onboarding at a time per user, across every server instance (transaction-scoped lock). */
const lockUser = (tx: Tx, userUuid: string) =>
  tx`select pg_advisory_xact_lock(hashtextextended(${`rms.onboard:${userUuid}`}, 0))`;

export const createAuthRoutes = (deps: AuthRouteDeps) => {
  const routes = new Hono<UserEnv>();

  // The web app calls the API from another origin. Only that origin, no cookies (the token
  // travels in the Authorization header), no wildcard.
  routes.use(
    "*",
    cors({
      origin: (origin) => {
        const web = process.env.WEB_URL?.replace(/\/$/, "");
        return web && origin === web ? origin : null;
      },
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["authorization", "content-type"],
      credentials: false,
      maxAge: 600,
    }),
  );

  routes.get("/me", requireUser, async (c) => {
    const user = c.get("user");
    const body: MeResponse = {
      user: { id: toPublicId("usr", user.userUuid), email: user.email },
      restaurant: await restaurantFor(user),
    };
    return c.json(body);
  });

  routes.post("/onboarding", requireUser, async (c) => {
    const user = c.get("user");
    const raw = await c.req.json().catch(() => undefined);
    const parsed = OnboardingAnswers.safeParse(raw);
    if (!parsed.success) return c.json(fail("invalid_request", "Some answers are missing or not in the right form."), 400);

    // Already onboarded: return what they have. Never a second restaurant.
    const existing = await restaurantFor(user);
    if (existing) return c.json({ restaurant: existing, created: false });

    const create = deps.createDemoRestaurant;
    if (!create) return c.json(fail("not_ready", "Setting up restaurants is not available yet. Please try again later."), 503);

    // Demo: every new owner gets a copy of a seeded fictional restaurant. The name the owner
    // typed (answers.restaurantName) is deliberately NOT used: the seeded restaurant keeps its
    // fictional name so its parent data (menu, staff, licences) stays consistent.
    const admin = adminDb();
    const made = await create(admin, { template: templateFor(parsed.data.serviceStyle) });

    // Add the owner under a per-user lock, re-checking membership inside the lock, so two
    // onboarding requests racing for one user cannot both get a restaurant.
    const won = await admin.begin(async (tx) => {
      await lockUser(tx, user.userUuid);
      const [has] = await tx<{ id: string }[]>`
        select m.id from platform.members m join platform.organizations o on o.id = m.org_id
        where m.user_id = ${user.userUuid} and m.status = 'active' and o.status = 'active' limit 1`;
      if (has) return false;
      await tx`insert into platform.members (id, org_id, user_id, role) values (${newUuid()}, ${made.orgUuid}, ${user.userUuid}, 'owner')`;
      return true;
    });

    if (!won) {
      // Lost the race: the restaurant just made belongs to nobody. Take its store down and
      // switch it off so it can never be reached.
      await admin`select platform.drop_store(${made.orgUuid})`;
      await admin`update platform.organizations set status = 'suspended' where id = ${made.orgUuid}`;
    }

    const restaurant = await restaurantFor(user);
    return c.json({ restaurant, created: won }, won ? 201 : 200);
  });

  return routes;
};

// Task B's `createDemoRestaurant` is picked up once `@rms/seed` exports it. Until then
// onboarding answers 503 in plain words.
export const authRoutes = createAuthRoutes({
  createDemoRestaurant: (seed as Partial<{ createDemoRestaurant: CreateDemoRestaurant }>).createDemoRestaurant,
});

// Task A owns this file. Export a Hono app. It is mounted at /auth by src/index.ts (lead-owned).
//
// Sign-up and onboarding. Identity always comes from the verified Supabase access token
// (`requireUser`). The body never names a user, restaurant or role.
import { Hono } from "hono";
import { cors } from "hono/cors";
import { type DemoTemplate, type MeResponse, type MyRestaurant, OnboardingAnswers, type ServiceStyle, toPublicId } from "@rms/contracts";
import { type Sql, adminDb, apiDb, newUuid, withOrg } from "@rms/db";
import { type SignedInUser, type UserEnv, membershipsFor, requireUser } from "@rms/auth";
import * as seed from "@rms/seed";

/** The interface task B exports from `@rms/seed` (wave 1 brief, task A section). */
export type CreateDemoRestaurant = (
  adminSql: Sql,
  opts: { template: DemoTemplate },
) => Promise<{ orgUuid: string; storePrefix: string; name: string }>;

export type AuthRouteDeps = { createDemoRestaurant: CreateDemoRestaurant | undefined };

/** Which demo restaurant a new owner gets, from their answer about service style. */
export const templateFor = (style: ServiceStyle): DemoTemplate => (style === "counter_service" ? "slice_yard" : "marigold");

const fail = (code: string, message: string) => ({ error: { code, message, requestId: crypto.randomUUID() } });

/**
 * The signed-in user's restaurant, read through the restaurant-facing login fenced to the org
 * found from the user's own membership row. Returns null when they have not onboarded.
 */
const restaurantFor = async (user: SignedInUser): Promise<MyRestaurant | null> => {
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

/**
 * Switches off an org that nobody owns: suspended first, then its store dropped. An org with
 * any member is never touched.
 */
const retireIfOwnerless = async (admin: Sql, orgUuid: string): Promise<void> => {
  const suspended = await admin`
    update platform.organizations o set status = 'suspended'
    where o.id = ${orgUuid} and not exists (select 1 from platform.members m where m.org_id = o.id)
    returning o.id`;
  if (suspended.length > 0) await admin`select platform.drop_store(${orgUuid})`;
};

type Outcome = "exists" | "busy" | "blocked" | "not_ready" | "not_fresh" | "created";

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

    const admin = adminDb();
    const create = deps.createDemoRestaurant;
    let made: string | undefined; // an org created by this request and not yet owned
    let committed = false;
    let outcome: Outcome;
    try {
      // One transaction holds the per-user lock across the whole flow. Try, never wait, so
      // parallel requests do not pile up on the small admin pool and build nothing.
      outcome = await admin.begin(async (tx): Promise<Outcome> => {
        const [lock] = await tx<{ got: boolean }[]>`
          select pg_try_advisory_xact_lock(hashtextextended(${`rms.onboard:${user.userUuid}`}, 0)) as got`;
        if (!lock?.got) return "busy";

        const rows = await tx<{ member_status: string; org_status: string }[]>`
          select m.status as member_status, o.status as org_status
          from platform.members m join platform.organizations o on o.id = m.org_id
          where m.user_id = ${user.userUuid}`;
        if (rows.some((r) => r.member_status === "active" && r.org_status === "active")) return "exists";
        // Removed, invited, or only in a suspended restaurant: no fresh restaurant for them.
        if (rows.length > 0) return "blocked";
        if (!create) return "not_ready";

        // Demo: every new owner gets a copy of a seeded fictional restaurant. The name the owner
        // typed (answers.restaurantName) is deliberately NOT used: the seeded restaurant keeps
        // its fictional name so its parent data (menu, staff, licences) stays consistent.
        // createDemoRestaurant uses its own connections; this transaction only holds the lock.
        const result = await create(admin, { template: templateFor(parsed.data.serviceStyle) });
        const [owned] = await tx<{ n: number }[]>`select count(*)::int as n from platform.members where org_id = ${result.orgUuid}`;
        // Must be a brand-new restaurant. One that already has people is not ours to touch.
        if ((owned?.n ?? 0) > 0) return "not_fresh";
        made = result.orgUuid;

        await tx`insert into platform.members (id, org_id, user_id, role) values (${newUuid()}, ${result.orgUuid}, ${user.userUuid}, 'owner')`;
        return "created";
      });
      committed = true;
    } finally {
      // Anything failed after the restaurant was made (or the commit itself): switch it off.
      if (made && !committed) await retireIfOwnerless(admin, made);
    }

    switch (outcome) {
      case "busy":
        return c.json(fail("busy", "Your restaurant is being set up. Give it a moment."), 409);
      case "blocked":
        return c.json(fail("not_allowed", "This account cannot set up a restaurant. Contact support."), 403);
      case "not_ready":
        return c.json(fail("not_ready", "Setting up restaurants is not available yet. Please try again later."), 503);
      case "not_fresh":
        console.error(JSON.stringify({ path: c.req.path, error: "createDemoRestaurant returned an org that already has members" }));
        return c.json(fail("internal", "Something went wrong on our side. Please try again."), 500);
      case "exists":
      case "created": {
        const restaurant = await restaurantFor(user);
        return c.json({ restaurant, created: outcome === "created" }, outcome === "created" ? 201 : 200);
      }
    }
  });

  return routes;
};

// Task B's `createDemoRestaurant` is picked up once `@rms/seed` exports it. Until then
// onboarding answers 503 in plain words. The lead switches this to a direct import at integration.
export const authRoutes = createAuthRoutes({
  createDemoRestaurant: (seed as Partial<{ createDemoRestaurant: CreateDemoRestaurant }>).createDemoRestaurant,
});

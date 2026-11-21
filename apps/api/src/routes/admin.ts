// Task F owns this file. Export a Hono app. It is mounted at /admin by src/index.ts (lead-owned).
// Maintainer console API. Every route is behind requireStaff and reads with the platform login:
// maintainers see every restaurant. Nothing here is scoped by a restaurant the client names.
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { ChangeDecision, ChangeSetId, OrgId, Tier, toPublicId } from "@rms/contracts";
import { type StaffEnv, requireStaff } from "@rms/auth";
import { adminDb } from "@rms/db";
import { GovernanceError, decideByStaff, listFeed, listQueue } from "@rms/governance";

export const adminRoutes = new Hono<StaffEnv>();

const consoleOrigin = (): string | null => {
  const url = process.env.ADMIN_URL;
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

// The console runs on its own origin and sends the staff user's access token as a bearer
// header. Exactly one origin is allowed, never a wildcard, and no cookies are involved.
adminRoutes.use(
  "*",
  cors({
    origin: (origin) => {
      const allowed = consoleOrigin();
      return allowed !== null && origin === allowed ? allowed : null;
    },
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["authorization", "content-type"],
    maxAge: 600,
  }),
);
adminRoutes.use("*", requireStaff);

const fail = (status: 400 | 404 | 409, code: string, message: string) =>
  new Response(JSON.stringify({ error: { code, message, requestId: crypto.randomUUID() } }), {
    status,
    headers: { "content-type": "application/json" },
  });

const FeedQuery = z.strictObject({
  tier: Tier.optional(),
  decision: ChangeDecision.optional(),
  org: OrgId.optional(),
  before: ChangeSetId.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

adminRoutes.get("/feed", async (c) => {
  const q = FeedQuery.safeParse(c.req.query());
  if (!q.success) return fail(400, "bad_request", "Those filters are not valid.");
  const page = await listFeed(adminDb(), {
    tier: q.data.tier,
    decision: q.data.decision,
    orgUuid: q.data.org,
    before: q.data.before,
    limit: q.data.limit,
  });
  return c.json(page);
});

adminRoutes.get("/queue", async (c) => c.json({ items: await listQueue(adminDb()) }));

const DecisionBody = z.strictObject({
  decision: z.enum(["approve", "reject"]),
  note: z.string().max(1000).optional(),
});

adminRoutes.post("/changes/:id/decision", async (c) => {
  const id = ChangeSetId.safeParse(c.req.param("id"));
  if (!id.success) return fail(404, "not_found", "That change was not found.");
  const body = DecisionBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return fail(400, "bad_request", "Choose approve or reject. A note can be up to 1000 characters.");
  try {
    const change = await decideByStaff(adminDb(), {
      changeSetId: id.data,
      staffUuid: c.var.staff.staffUuid,
      staffActor: { type: "user", id: toPublicId("usr", c.var.user.userUuid) },
      decision: body.data.decision,
      note: body.data.note ?? null,
    });
    return c.json({ change });
  } catch (e) {
    if (e instanceof GovernanceError) {
      return e.reason === "not_found"
        ? fail(404, "not_found", "That change was not found.")
        : fail(409, "conflict", "This change is not waiting for a decision.");
    }
    throw e;
  }
});

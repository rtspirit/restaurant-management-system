// GET /auth/parent/:model: a restaurant's own parent data (menu, staff, locations and the
// other set-up lists), for RMS's own screens. Read-only.
//
// `requireSession` verifies the Supabase access token and builds the tenant context from the
// user's membership row. The restaurant, the role and the locations come from there and from
// nowhere else. The one thing the address carries is WHICH of the ten fixed lists to read, and
// `readParent` checks it against that list. What a role may not see (staff pay and contact
// details, for staff) is left out by the same rules the Data API uses.
import { type SessionEnv, requireSession } from "@rms/auth";
import { handleParentRead } from "@rms/data";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export const parentRoutes = new Hono<SessionEnv>();

// `handleParentRead` counts the request toward the restaurant's cap on requests in flight (the
// same count the Data API keeps), and always returns a reply in plain words.
parentRoutes.get("/parent/:model", requireSession, async (c) => {
  const reply = await handleParentRead(c.var.tenant, c.req.param("model"), crypto.randomUUID());
  return c.json(reply.body as object, reply.status as ContentfulStatusCode);
});

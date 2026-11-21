// RMS API. Lead-owned: only the lead edits this file. Each task owns its own file in routes/.
// Deployed as Vercel functions (zero config: default-exported Hono app).
import { Hono } from "hono";
import { adminRoutes } from "./routes/admin.js";
import { authRoutes } from "./routes/auth.js";
import { dataRoutes } from "./routes/data.js";

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true }));
app.route("/auth", authRoutes);
app.route("/data", dataRoutes);
app.route("/admin", adminRoutes);

// Never leak internals. Routes turn known failures into plain-word errors themselves.
app.onError((err, c) => {
  const requestId = crypto.randomUUID();
  console.error(JSON.stringify({ requestId, path: c.req.path, error: err instanceof Error ? err.message : "unknown" }));
  return c.json({ error: { code: "internal", message: "Something went wrong on our side. Please try again.", requestId } }, 500);
});

export default app;

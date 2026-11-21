// RMS API. Lead-owned: only the lead edits this file. Each task owns its own file in routes/.
// Deployed as Vercel functions (zero config: default-exported Hono app).
import { Hono } from "hono";
import { webCors } from "./lib/http.js";
import { adminRoutes } from "./routes/admin.js";
import { agentRoutes } from "./routes/agent.js";
import { askRoutes } from "./routes/ask.js";
import { authRoutes } from "./routes/auth.js";
import { connectionRoutes } from "./routes/connections.js";
import { dataRoutes } from "./routes/data.js";
import { demoPosRoutes } from "./routes/mcp-demo-pos.js";
import { memoryRoutes } from "./routes/memory.js";

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true }));
app.route("/auth", authRoutes);

// The RMS shell makes Data API calls from the browser on behalf of a mini-app's frame (the
// frame itself never holds a token: see frame.ts in @rms/contracts). So the web app's origin,
// and only that origin, may call /data from a browser. No sandbox or mini-app origin ever may.
app.use("/data/*", webCors());
app.route("/data", dataRoutes);

app.route("/admin", adminRoutes);

// Wave 2
app.route("/agent", agentRoutes);
app.route("/ask", askRoutes);
app.route("/connections", connectionRoutes);
app.route("/memory", memoryRoutes);
app.route("/mcp/demo-pos", demoPosRoutes);

// Never leak internals. Routes turn known failures into plain-word errors themselves.
app.onError((err, c) => {
  const requestId = crypto.randomUUID();
  console.error(JSON.stringify({ requestId, path: c.req.path, error: err instanceof Error ? err.message : "unknown" }));
  return c.json({ error: { code: "internal", message: "Something went wrong on our side. Please try again.", requestId } }, 500);
});

export default app;

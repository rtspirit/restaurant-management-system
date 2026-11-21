// Runs the apps host as a local server. The port comes from APPS_URL (default 3002), so it is
// always a different origin from the RMS web app (3000) and the console (3001). It listens on
// every address of this machine, and answers only requests sent to its own name (APPS_URL).
import { serve } from "@hono/node-server";
import { APPS_HOST, exactOrigins, originRules } from "@rms/contracts";
import app from "./index.js";

const configured = exactOrigins(process.env[APPS_HOST.urlEnv], originRules(process.env))[0];
const port = Number(process.env.APPS_PORT ?? (configured ? new URL(configured).port : "")) || APPS_HOST.defaultPort;

serve({ fetch: app.fetch, port }, () => console.log(`RMS apps host on port ${port}${configured ? ` (${configured})` : ""}`));

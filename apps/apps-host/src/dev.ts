// Runs the apps host as a local server. The port comes from APPS_URL (default 3002), so it is
// always a different origin from the RMS web app (3000) and the console (3001). It listens on
// every address of this machine, so the same server answers on each of the laptop's names.
import { serve } from "@hono/node-server";
import { APPS_HOST, exactOrigins, originMode } from "@rms/contracts";
import app from "./index.js";

const configured = exactOrigins(process.env[APPS_HOST.urlEnv], originMode(process.env))[0];
const port = Number(process.env.APPS_PORT ?? (configured ? new URL(configured).port : "")) || APPS_HOST.defaultPort;

serve({ fetch: app.fetch, port }, () => console.log(`RMS apps host on port ${port}${configured ? ` (${configured})` : ""}`));

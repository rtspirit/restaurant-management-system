// Local development server only. Not used on Vercel.
import { serve } from "@hono/node-server";
import app from "./index.js";

const port = Number(process.env.API_PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => console.log(`RMS API on http://127.0.0.1:${port}`));

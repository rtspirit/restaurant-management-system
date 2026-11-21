// Local development server only. Not used on Vercel.
import { serve } from "@hono/node-server";
import app from "./index.js";

const port = Number(process.env.API_PORT ?? 8787);
// This laptop only, unless phone mode (scripts/demo-phone.sh, ADR 0010) asks for more.
const hostname = process.env.API_HOST ?? "127.0.0.1";
serve({ fetch: app.fetch, port, hostname }, () => console.log(`RMS API on http://${hostname}:${port}`));

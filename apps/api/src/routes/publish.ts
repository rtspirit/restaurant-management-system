// Task N owns this file. Brief: docs/briefs/wave3.md, task N.
// Mounted at /publish by src/index.ts (lead-owned), so the full paths match PUBLISH_ROUTES in @rms/contracts.
//
// Publishing a mini-app, the RMS menu, and the grant the shell needs to show a published
// mini-app in a frame. Identity comes from `requireSession` only. `nav` and `open` are for
// every member of the restaurant. Everything else is owner-only.
import { Hono } from "hono";
import { safeHeaders, webCors } from "../lib/http.js";

export const publishRoutes = new Hono();

publishRoutes.use("*", webCors());
publishRoutes.use("*", safeHeaders());

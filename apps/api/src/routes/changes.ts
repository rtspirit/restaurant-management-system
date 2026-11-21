// Task O owns this file. Brief: docs/briefs/wave3.md, task O.
// Mounted at /changes by src/index.ts (lead-owned), so the full paths match CHANGES_ROUTES in @rms/contracts.
//
// The owner's side of a change: what is waiting for their OK, what happened lately, and the
// confirm. Plain words only: no tier, no signal name, no maintainer's name ever leaves these
// routes. Identity comes from `requireSession` only. Confirming is owner-only.
import { Hono } from "hono";
import { safeHeaders, webCors } from "../lib/http.js";

export const changesRoutes = new Hono();

changesRoutes.use("*", webCors());
changesRoutes.use("*", safeHeaders());

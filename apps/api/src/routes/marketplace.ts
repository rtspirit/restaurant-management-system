// Task P owns this file. Brief: docs/briefs/wave3.md, task P.
// Mounted at /marketplace by src/index.ts (lead-owned), so the full paths match MARKETPLACE_ROUTES in @rms/contracts.
//
// The Marketplace tab, one listing, installing, and sharing one of the owner's own mini-apps.
// Identity comes from `requireSession` only. Owner-only today. No answer from these routes can
// say which restaurant made a listing: the shapes have no field for it.
import { Hono } from "hono";
import { safeHeaders, webCors } from "../lib/http.js";

export const marketplaceRoutes = new Hono();

marketplaceRoutes.use("*", webCors());
marketplaceRoutes.use("*", safeHeaders());

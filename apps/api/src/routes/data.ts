// Task D owns this file. Export a Hono app. It is mounted at /data by src/index.ts (lead-owned).
import { Hono } from "hono";

export const dataRoutes = new Hono();

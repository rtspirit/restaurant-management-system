// Task F owns this file. Export a Hono app. It is mounted at /admin by src/index.ts (lead-owned).
import { Hono } from "hono";

export const adminRoutes = new Hono();

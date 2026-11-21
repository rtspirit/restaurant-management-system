// Task A owns this file. Export a Hono app. It is mounted at /auth by src/index.ts (lead-owned).
import { Hono } from "hono";

export const authRoutes = new Hono();

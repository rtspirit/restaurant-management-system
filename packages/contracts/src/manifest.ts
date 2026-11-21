import { z } from "zod";
import { Ident } from "./ids.js";
import { ModelAccess } from "./models.js";

/**
 * A mini-app's manifest (`rms.config.ts`, via `defineApp`). The Data API checks every request
 * against it, and governance reads its diffs to decide the tier of a change.
 */

export const ManifestModel = z.strictObject({
  /** A child model key, or "parent.<key>" for parent data. Parent models are read-only. */
  use: z.string().regex(/^(parent\.)?[a-z][a-z0-9_]{0,47}$/),
  access: ModelAccess,
}).refine((m) => !(m.use.startsWith("parent.") && m.access === "write"), { message: "Parent data is read-only." });

export const ManifestSlot = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("nav"), label: z.string().max(24).optional(), icon: z.string().max(32).optional() }),
  z.strictObject({ type: z.literal("dashboard-widget"), component: z.string().regex(/^[A-Z][A-Za-z0-9]{0,40}$/) }),
]);

export const ManifestConnection = z.strictObject({
  id: Ident,
  tools: z.array(z.string().min(1).max(64)).min(1),
  access: ModelAccess,
});

/** Demo: jobs are platform-run named queries on a schedule. No custom server logic today. */
export const ManifestJob = z.strictObject({
  name: Ident,
  cron: z.string().min(9).max(64),
  namedQuery: Ident,
});

export const AppManifest = z.strictObject({
  name: z.string().min(1).max(40),
  description: z.string().max(280).optional(),
  slots: z.array(ManifestSlot).default([{ type: "nav" }]),
  models: z.array(ManifestModel).default([]),
  namedQueries: z.array(Ident).default([]),
  connections: z.array(ManifestConnection).default([]),
  jobs: z.array(ManifestJob).default([]),
  /** Named queries offered to the Ask agent as tools. */
  tools: z.array(Ident).default([]),
});
export type AppManifest = z.infer<typeof AppManifest>;
export type AppManifestInput = z.input<typeof AppManifest>;

export const defineApp = (manifest: AppManifestInput): AppManifestInput => manifest;

/** Files in the app template that the build agent may never change. Checked at build and publish. */
export const LOCKED_TEMPLATE_FILES = [
  "src/rms/auth.ts",
  "src/rms/data-client.ts",
  "src/rms/shell.tsx",
  "package.json",
  "pnpm-lock.yaml",
  "eslint.config.js",
  "tsconfig.json",
] as const;

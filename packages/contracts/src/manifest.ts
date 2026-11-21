import { z } from "zod";
import { Ident, ModelRef, isParentRef } from "./ids.js";
import { ModelAccess } from "./models.js";

/**
 * A mini-app's manifest (`rms.config.ts`, via `defineApp`). The Data API checks every request
 * against it, and governance reads its diffs to decide the tier of a change.
 */

export const ManifestModel = z
  .strictObject({ use: ModelRef, access: ModelAccess })
  .refine((m) => !(isParentRef(m.use) && m.access === "write"), { message: "Parent data is read-only." });

export const ManifestSlot = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("nav"), label: z.string().max(24).optional(), icon: z.string().max(32).optional() }),
  z.strictObject({ type: z.literal("dashboard-widget"), component: z.string().regex(/^[A-Z][A-Za-z0-9]{0,40}$/) }),
]);

export const ManifestConnection = z.strictObject({
  id: Ident,
  tools: z.array(z.string().min(1).max(64)).min(1).max(20),
  access: ModelAccess,
});

/** Demo: a job runs a named action or a named query on a schedule. No custom server logic today. */
export const ManifestJob = z.strictObject({
  name: Ident,
  cron: z.string().min(9).max(64),
  run: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("action"), key: Ident }),
    z.strictObject({ kind: z.literal("query"), key: Ident }),
  ]),
});

export const AppManifest = z.strictObject({
  name: z.string().min(1).max(40),
  description: z.string().max(280).optional(),
  slots: z.array(ManifestSlot).max(6).default([{ type: "nav" }]),
  models: z.array(ManifestModel).max(40).default([]),
  /** Named queries this mini-app may call. Each needs read access to all the models it reads. */
  namedQueries: z.array(Ident).max(40).default([]),
  /** Named actions this mini-app may call. Each needs write access to all the models it writes. */
  actions: z.array(Ident).max(20).default([]),
  connections: z.array(ManifestConnection).max(6).default([]),
  jobs: z.array(ManifestJob).max(10).default([]),
  /** Named queries offered to the Ask agent as tools. Must also be in `namedQueries`. */
  tools: z.array(Ident).max(20).default([]),
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

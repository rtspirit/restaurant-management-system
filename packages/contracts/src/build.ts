import { z } from "zod";
import { Ident, ModelRef } from "./ids.js";
import { ModelAccess, ModelChange } from "./models.js";

/**
 * The app template and the tools the build agent may use. Shared by the template and the
 * generators (task H), the sandbox and runner (task I), and the publish checks (Wave 3).
 *
 * Demo scope: a mini-app is SCREENS ONLY. No server code, no database access, no network calls
 * of its own. Data comes only through `@rms/sdk`, which asks the RMS shell (frame.ts).
 */

// ------------------------------------------------------------------ the app template

/**
 * Files and folders the build agent may never change. An entry ending in "/" is a whole folder.
 * Checked three times: by `check` inside the sandbox (to tell the agent early), by the runner
 * from OUTSIDE the sandbox after every turn (the one that counts), and again at publish.
 */
export const LOCKED_TEMPLATE_FILES = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "vite.config.ts",
  "index.html",
  "AGENTS.md",
  "rms.config.ts",
  "src/main.tsx",
  "src/rms/",
  "vendor/",
  ".rms/",
] as const;

const normalisePath = (path: string): string | null => {
  if (path.length === 0 || path.length > 300 || path.includes("\0") || path.includes("\\")) return null;
  const parts = path.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.length === 0 || parts.includes("..") || path.startsWith("/")) return null;
  return parts.join("/");
};

/** True when the agent may not change `path` (relative to the app folder). A path that cannot be trusted counts as locked. */
export const isLockedPath = (path: string): boolean => {
  const p = normalisePath(path);
  if (p === null) return true;
  return LOCKED_TEMPLATE_FILES.some((entry) => (entry.endsWith("/") ? p === entry.slice(0, -1) || p.startsWith(entry) : p === entry));
};

/** Where the agent writes. Anything outside these folders is refused by `check`, locked or not. */
export const EDITABLE_TEMPLATE_FOLDERS = ["src/screens/", "src/components/"] as const;

export const isEditablePath = (path: string): boolean => {
  const p = normalisePath(path);
  return p !== null && !isLockedPath(p) && EDITABLE_TEMPLATE_FOLDERS.some((folder) => p.startsWith(folder));
};

/** The only packages mini-app code may import. Nothing installs at build time. */
export const ALLOWED_APP_IMPORTS = ["react", "react/jsx-runtime", "@rms/ui", "@rms/sdk"] as const;

/**
 * Everything the template's `package.json` may list. `check` and publish fail on anything else.
 * The agent cannot add a dependency: that is a platform request (tier T3).
 */
export const ALLOWED_APP_DEPENDENCIES = {
  dependencies: ["react", "react-dom", "@rms/ui", "@rms/sdk"],
  devDependencies: ["@rms/contracts", "@rms/generators", "@types/react", "@types/react-dom", "@vitejs/plugin-react", "typescript", "vite"],
} as const;

/**
 * The template as the runner sees it. The template is a Vite and React app that builds to
 * static files. Inside the sandbox it is installed with npm from a self-contained bundle (our
 * own packages are packed into `vendor/`), so the commands are npm commands.
 */
export const APP_TEMPLATE = {
  /** The app folder inside the sandbox. */
  workdir: "/vercel/app",
  /**
   * The manifest as a file. WRITTEN BY THE PLATFORM from the confirmed plan, locked, and never
   * read back: the copy the Data API enforces is `platform.app_versions.manifest`.
   */
  manifestFile: "rms.config.ts",
  /** Platform-written facts for the agent and the tools: the catalog and the hashes of the locked files. */
  catalogFile: ".rms/catalog.json",
  lockedHashesFile: ".rms/locked.json",
  /** The screen list the generators keep up to date. The shell in `src/rms/` reads it to draw navigation. */
  screensFile: "src/screens/index.ts",
  devPort: 5173,
  outDir: "dist",
  commands: {
    dev: ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173", "--strictPort"],
    build: ["npm", "run", "build"],
    check: ["npx", "--no-install", "rms", "check"],
  },
  /** The generator and tool command, from `@rms/generators`. See BUILD_TOOL_CLI. */
  bin: "rms",
} as const;

// ------------------------------------------------------------------ the build agent's tools

/**
 * Four tools. Each has one typed input and one typed output.
 *
 * | Tool                    | Where it runs                           | Who calls it                          |
 * |-------------------------|-----------------------------------------|---------------------------------------|
 * | `catalog_lookup`        | platform (models), sandbox (the rest)   | the planner, and the build agent      |
 * | `propose_model_changes` | platform ONLY                           | the planner, before the owner confirms |
 * | `run_generator`         | sandbox                                 | the build agent                       |
 * | `check`                 | sandbox, then again outside it          | the build agent, then the runner      |
 *
 * `propose_model_changes` is not available inside the sandbox today: the sandbox cannot reach
 * RMS at all (its only open address is the model provider). If the agent finds mid-build that
 * it needs different information, it says so, and the owner's next message starts a new plan.
 *
 * Inside the sandbox every tool is the same command (`BUILD_TOOL_CLI`).
 */
export const BuildToolName = z.enum(["catalog_lookup", "propose_model_changes", "run_generator", "check"]);
export type BuildToolName = z.infer<typeof BuildToolName>;

/**
 * The command line, from the app folder:
 *
 *   npx --no-install rms catalog --json '<CatalogLookupInput>'
 *   npx --no-install rms gen     --json '<RunGeneratorInput>'     (or --file <path to a JSON file>)
 *   npx --no-install rms check   [--json '<CheckInput>']
 *
 * Short forms for the common cases (the command turns them into the same typed input):
 *   rms catalog models [words to search for]
 *   rms gen list_detail --model vendor --screen vendors --title "Vendors" [--fields name,phone]
 *
 * Output: exactly ONE JSON object on stdout, the tool's output shape. Nothing else on stdout.
 * Exit code 0 = ok, 1 = the tool ran and said no (`ok: false`), 2 = the input did not parse.
 */
export const BUILD_TOOL_CLI = {
  command: ["npx", "--no-install", "rms"],
  subcommands: { catalog_lookup: "catalog", run_generator: "gen", check: "check" },
  exit: { ok: 0, refused: 1, badInput: 2 },
} as const;

// ---- catalog_lookup

export const CatalogKind = z.enum(["components", "patterns", "generators", "models", "named_queries", "actions"]);
export type CatalogKind = z.infer<typeof CatalogKind>;

export const CatalogLookupInput = z.strictObject({
  kind: CatalogKind,
  /** Plain words to search names and descriptions. Omitted = list everything of this kind. */
  search: z.string().max(80).optional(),
  /** One entry in full, by its name or key. */
  name: z.string().max(60).optional(),
});
export type CatalogLookupInput = z.infer<typeof CatalogLookupInput>;

const CatalogField = z.object({ key: z.string(), label: z.string(), type: z.string(), required: z.boolean(), values: z.array(z.string()).optional(), refersTo: z.string().optional() });

/** A component or a pattern from `@rms/ui`. `example` is a short usage snippet the agent can copy. */
export const UiCatalogEntry = z.object({
  kind: z.enum(["component", "pattern"]),
  name: z.string().max(60),
  summary: z.string().max(280),
  props: z.array(z.object({ name: z.string(), type: z.string().max(200), required: z.boolean(), note: z.string().max(200).optional() })).max(40),
  example: z.string().max(2000),
});
export type UiCatalogEntry = z.infer<typeof UiCatalogEntry>;

/**
 * A model the mini-app could use.
 *   in_app      already in this mini-app's manifest
 *   in_use      this restaurant already has it (another mini-app, or a connection, filled it)
 *   available   a standard model this restaurant has not started using yet
 *   parent      RMS's own information about the restaurant. Read-only, always.
 * Reuse first: `in_use` before `available`, and both before a new custom model.
 */
export const ModelCatalogEntry = z.object({
  kind: z.literal("model"),
  ref: z.string(),
  name: z.string(),
  description: z.string(),
  state: z.enum(["in_app", "in_use", "available", "parent"]),
  /** The most this mini-app could be given. Parent models are always "read". */
  access: ModelAccess,
  fields: z.array(CatalogField).max(100),
});
export type ModelCatalogEntry = z.infer<typeof ModelCatalogEntry>;

export const NamedCatalogEntry = z.object({
  kind: z.enum(["named_query", "action"]),
  key: z.string(),
  name: z.string(),
  description: z.string(),
  params: z.array(z.object({ key: z.string(), type: z.string(), required: z.boolean() })),
  /** Named queries only. */
  columns: z.array(z.object({ key: z.string(), label: z.string(), type: z.string() })).optional(),
});
export type NamedCatalogEntry = z.infer<typeof NamedCatalogEntry>;

export const GeneratorName = z.enum(["list_detail", "form", "dashboard", "report_table"]);
export type GeneratorName = z.infer<typeof GeneratorName>;

export const GeneratorCatalogEntry = z.object({
  kind: z.literal("generator"),
  name: GeneratorName,
  summary: z.string().max(280),
  /** A complete example input, as JSON text. */
  example: z.string().max(2000),
});
export type GeneratorCatalogEntry = z.infer<typeof GeneratorCatalogEntry>;

export const CatalogEntry = z.union([UiCatalogEntry, ModelCatalogEntry, NamedCatalogEntry, GeneratorCatalogEntry]);
export type CatalogEntry = z.infer<typeof CatalogEntry>;

export const CatalogLookupOutput = z.object({
  ok: z.literal(true),
  kind: CatalogKind,
  entries: z.array(CatalogEntry).max(60),
  /** True when there were more matches than fit. Search with more words. */
  more: z.boolean(),
});
export type CatalogLookupOutput = z.infer<typeof CatalogLookupOutput>;

/**
 * What the runner writes to `APP_TEMPLATE.catalogFile` before a turn. The components, patterns
 * and generators come from the template itself. The models, named queries and actions are the
 * ones in THIS mini-app's manifest: the build agent works with what the plan gave it.
 */
export const SandboxCatalog = z.object({
  writtenAt: z.iso.datetime(),
  models: z.array(ModelCatalogEntry).max(40),
  namedQueries: z.array(NamedCatalogEntry).max(40),
  actions: z.array(NamedCatalogEntry).max(20),
});
export type SandboxCatalog = z.infer<typeof SandboxCatalog>;

// ---- propose_model_changes

/**
 * The agent proposes. The platform validates, compiles and applies, to the DRAFT store only.
 * The agent never sends SQL and never sees any. Rules the platform enforces (and tests):
 *   - `use_template`: any standard model. Always preferred.
 *   - `create_custom_model`: the key starts with "x_", pack "custom", check rules only, and it
 *     may not copy or shadow a standard model.
 *   - `add_field`: optional fields only.
 *   - at most `MAX_MODEL_CHANGES` changes in one proposal.
 * Draft becomes live at publish, never before.
 */
export const MAX_MODEL_CHANGES = 12;
export const CUSTOM_MODEL_PREFIX = "x_";

export const ProposeModelChangesInput = z
  .strictObject({
    changes: z.array(ModelChange).min(1).max(MAX_MODEL_CHANGES),
    /** Why these are needed, in plain words. Shown to the owner in the plan under "what it will keep". */
    why: z.string().min(1).max(280),
  })
  .refine(
    (p) => p.changes.every((c) => c.op !== "create_custom_model" || c.definition.key.startsWith(CUSTOM_MODEL_PREFIX)),
    `A new model's key must start with "${CUSTOM_MODEL_PREFIX}"`,
  );
export type ProposeModelChangesInput = z.infer<typeof ProposeModelChangesInput>;

export const ProposeModelChangesOutput = z.object({
  /** True only when every change was accepted. On false, nothing was applied. */
  ok: z.boolean(),
  results: z.array(z.object({
    index: z.number().int().nonnegative(),
    model: z.string(),
    outcome: z.enum(["created", "already_there", "changed", "refused"]),
    /** For the agent, in plain words. For a refusal it says what to do instead. Never database text. */
    message: z.string().max(280),
  })),
  /** Plain lines for the plan's "what it will keep". */
  ownerSummary: z.array(z.string().max(120)).max(8),
});
export type ProposeModelChangesOutput = z.infer<typeof ProposeModelChangesOutput>;

// ---- run_generator

/** A screen's name: its folder under `src/screens/` and its address inside the mini-app. */
export const ScreenName = z.string().regex(/^[a-z][a-z0-9-]{0,30}$/);
export type ScreenName = z.infer<typeof ScreenName>;

const screenBase = { screen: ScreenName, title: z.string().min(1).max(40) };
const statFormat = z.enum(["money", "number", "percent", "text"]);

/**
 * A generator writes one working screen from a pattern and adds it to the screen list. It only
 * ever writes inside `src/screens/<screen>/` and `APP_TEMPLATE.screensFile`. It refuses a model,
 * named query or field that is not in the mini-app's catalog file.
 */
export const RunGeneratorInput = z.discriminatedUnion("generator", [
  /** A list with a detail view. With `form: true` (and write access in the manifest) also add, edit and remove. */
  z.strictObject({ generator: z.literal("list_detail"), ...screenBase, model: ModelRef, fields: z.array(Ident).min(1).max(12).optional(), form: z.boolean().default(false) }),
  /** One form that adds a row. */
  z.strictObject({ generator: z.literal("form"), ...screenBase, model: Ident, fields: z.array(Ident).min(1).max(20).optional() }),
  /** Big figures from a named query, with an optional bar chart from the same rows. */
  z.strictObject({
    generator: z.literal("dashboard"),
    ...screenBase,
    query: Ident,
    stats: z.array(z.strictObject({ label: z.string().min(1).max(40), column: Ident, format: statFormat })).min(1).max(6),
    chart: z.strictObject({ label: z.string().min(1).max(40), category: Ident, value: Ident, format: statFormat }).optional(),
  }),
  /** A table of a named query's rows, with its totals. */
  z.strictObject({ generator: z.literal("report_table"), ...screenBase, query: Ident, columns: z.array(Ident).min(1).max(12).optional() }),
]);
export type RunGeneratorInput = z.infer<typeof RunGeneratorInput>;

export const RunGeneratorOutput = z.object({
  ok: z.boolean(),
  /** Files written, relative to the app folder. */
  files: z.array(z.object({ path: z.string(), change: z.enum(["add", "update"]) })).max(20),
  /** The screen's address inside the mini-app, for example "/vendors". */
  route: z.string().optional(),
  /** What to do next, or why it said no. For the agent. */
  notes: z.array(z.string().max(280)).max(10),
});
export type RunGeneratorOutput = z.infer<typeof RunGeneratorOutput>;

// ---- check

/**
 *   locked    no locked file changed (hashes in `APP_TEMPLATE.lockedHashesFile`), nothing written outside the editable folders
 *   deps      `package.json` lists only ALLOWED_APP_DEPENDENCIES
 *   imports   mini-app code imports only ALLOWED_APP_IMPORTS and its own files
 *   safety    no network calls, no dynamic code, no direct page manipulation, no styles or class names, no storage, no cookies
 *   manifest  every model, named query and action the screens use is in the catalog file
 *   types     the TypeScript compiler passes
 *   build     the static build succeeds
 */
export const CheckName = z.enum(["locked", "deps", "imports", "safety", "manifest", "types", "build"]);
export type CheckName = z.infer<typeof CheckName>;

export const CheckInput = z.strictObject({
  /** Omitted = all of them, in the order above. */
  only: z.array(CheckName).min(1).max(7).optional(),
});
export type CheckInput = z.infer<typeof CheckInput>;

export const CheckOutput = z.object({
  ok: z.boolean(),
  results: z.array(z.object({
    check: CheckName,
    ok: z.boolean(),
    /** For the agent. The owner never sees these: they only ever see "still working" or a plain explanation. */
    problems: z.array(z.object({ file: z.string().optional(), line: z.number().int().optional(), message: z.string().max(400) })).max(50),
  })),
  durationMs: z.number().int().nonnegative(),
});
export type CheckOutput = z.infer<typeof CheckOutput>;

import { z } from "zod";
import { type AppId, type ListingId, type OrgId, toPublicId, toUuid } from "./ids.js";
import { EDITABLE_TEMPLATE_FOLDERS, isEditablePath } from "./build.js";
import { Origin } from "./frame.js";

/**
 * Where a mini-app's code is kept (ADR 0009).
 *
 * The plan's target is a private bucket (01-data-model section 6). Today the same keys live in
 * one database table, `platform.objects`, behind one small interface (`ObjectStore` in
 * `@rms/db`). A bucket later is a new implementation of that interface: no key and no caller
 * changes.
 *
 * Three kinds of object exist today. Nothing else may be stored:
 *
 *   orgs/<org>/apps/<app>/versions/<n>.bundle         a version's SOURCE: the files the agent wrote (`AppSource`)
 *   orgs/<org>/apps/<app>/builds/<n>/screens/<path>   a version's BUILT files, one object per file (`BundleIndex` lists them)
 *   listings/<listing>/<n>.bundle                     scrubbed source for the Marketplace (`AppSource`)
 *
 * `<org>`, `<app>` and `<listing>` are public ids (`org_…`, `app_…`, `lst_…`). `<n>` is the
 * version number. A key is always BUILT by the server from ids it already trusts
 * (`objectKeys`). No route, message or request ever carries a key, a prefix or a path into
 * the store, with one exception: the apps host turns the last part of an address into a
 * `BundlePath`, and only after it has found the published version itself.
 *
 * Who may write what (enforced by the database, migration 20261121120700):
 *   - the restaurant-facing login: the source of its OWN restaurant's DRAFT versions. Nothing else.
 *   - the platform login: built files and listings (publishing and sharing are platform work).
 *   - nobody updates an object. It is written once, or deleted and written again.
 */

const HEX = "[0-9a-f]{32}";
const NUM = "[1-9][0-9]{0,5}";
/** One path segment: starts with a letter or digit, so it can never be "." or "..". */
const SEG = "[A-Za-z0-9][A-Za-z0-9._-]*";

/** The three key forms. The same patterns are a check constraint on `platform.objects.key`. A test compares them. */
export const OBJECT_KEY_PATTERNS = {
  source: `^orgs/org_${HEX}/apps/app_${HEX}/versions/${NUM}\\.bundle$`,
  screen: `^orgs/org_${HEX}/apps/app_${HEX}/builds/${NUM}/screens/${SEG}(/${SEG})*$`,
  listing: `^listings/lst_${HEX}/${NUM}\\.bundle$`,
} as const;

export const OBJECT_LIMITS = {
  /** The most one object may weigh. Also a check constraint in the database. */
  maxObjectBytes: 5_000_000,
  maxKeyLength: 400,
  /** A version's source: what the agent wrote, as text. */
  source: { maxFiles: 80, maxFileBytes: 200_000, maxTotalBytes: 2_000_000 },
  /** A version's built files. */
  screens: { maxFiles: 80, maxFileBytes: 5_000_000, maxTotalBytes: 12_000_000 },
} as const;

export const ObjectKey = z
  .string()
  .min(1)
  .max(OBJECT_LIMITS.maxKeyLength)
  .refine((k) => Object.values(OBJECT_KEY_PATTERNS).some((p) => new RegExp(p).test(k)), "Not a key RMS stores");
export type ObjectKey = z.infer<typeof ObjectKey>;

const versionNumber = (n: number): number => {
  if (!Number.isInteger(n) || n < 1 || n > 999_999) throw new Error("Not a version number");
  return n;
};

// ------------------------------------------------------------------ built files

/**
 * The only kinds of file a built mini-app may hold, and the content type each is served with.
 * The apps host works the type out from the path with this table and nothing else: a stored
 * content type is never trusted for serving. No source maps, no archives, no executables.
 */
export const BUNDLE_CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
} as const;

/** The content type for a built file's path, or null when that kind of file is not allowed. */
export const contentTypeFor = (path: string): string | null => {
  const dot = path.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = path.slice(dot).toLowerCase();
  return Object.hasOwn(BUNDLE_CONTENT_TYPES, ext) ? BUNDLE_CONTENT_TYPES[ext as keyof typeof BUNDLE_CONTENT_TYPES] : null;
};

/** A built file's path inside its version, for example "index.html" or "assets/index-abc123.js". */
export const BundlePath = z
  .string()
  .min(1)
  .max(200)
  .regex(new RegExp(`^${SEG}(/${SEG})*$`))
  .refine((p) => contentTypeFor(p) !== null, "That kind of file is not served");
export type BundlePath = z.infer<typeof BundlePath>;

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const BundleFile = z.strictObject({ path: BundlePath, contentType: z.string().max(80), size: z.number().int().min(1).max(OBJECT_LIMITS.screens.maxFileBytes), sha256: Sha256 });
export type BundleFile = z.infer<typeof BundleFile>;

export const BUNDLE_ENTRY = "index.html";

/**
 * What a published version's built files are. Kept on the version (`app_versions.checks.bundle`)
 * by the publish step, after it has stored every file.
 * `shellOrigin` is the ONE RMS web address the files were built to be framed by: a mini-app
 * accepts messages from that origin and no other (frame.ts). Opened under another RMS address
 * it shows "Open this from RMS", so the open route refuses to hand out a grant for it.
 */
export const BundleIndex = z
  .strictObject({
    format: z.literal(1),
    entry: z.literal(BUNDLE_ENTRY),
    shellOrigin: Origin,
    builtAt: z.iso.datetime(),
    files: z.array(BundleFile).min(1).max(OBJECT_LIMITS.screens.maxFiles),
  })
  .refine((b) => b.files.some((f) => f.path === BUNDLE_ENTRY), "A built mini-app must have its start page")
  .refine((b) => new Set(b.files.map((f) => f.path.toLowerCase())).size === b.files.length, "Two files have the same path")
  .refine((b) => b.files.every((f) => f.contentType === contentTypeFor(f.path)), "A file's type does not match its path")
  .refine((b) => b.files.reduce((sum, f) => sum + f.size, 0) <= OBJECT_LIMITS.screens.maxTotalBytes, "The built mini-app is too big");
export type BundleIndex = z.infer<typeof BundleIndex>;

// ------------------------------------------------------------------ source

/** A source file's path: under the folders the agent may write (build.ts), TypeScript only. */
export const SourcePath = z
  .string()
  .max(200)
  .regex(new RegExp(`^src/(screens|components)/${SEG}(/${SEG})*\\.(ts|tsx)$`))
  .refine((p) => isEditablePath(p) && EDITABLE_TEMPLATE_FOLDERS.some((f) => p.startsWith(f)), "Not a file the agent may write");
export type SourcePath = z.infer<typeof SourcePath>;

export const SOURCE_CONTENT_TYPE = "application/vnd.rms.source+json";

const utf8 = new TextEncoder();

/**
 * A mini-app version's source: ONLY the files the agent may write (`src/screens/`,
 * `src/components/`), as text. The locked files are never stored per mini-app: publish takes
 * them fresh from RMS's own template. The manifest is not in here either: it lives on the
 * version row and is the one the Data API enforces.
 *
 * Stored as JSON text under a `.bundle` key. (The plan says one git bundle per version. Today
 * it is this plain list: ADR 0009.) The same shape is the scrubbed source of a Marketplace listing.
 */
export const AppSource = z
  .strictObject({
    format: z.literal(1),
    files: z.array(z.strictObject({ path: SourcePath, text: z.string() })).min(1).max(OBJECT_LIMITS.source.maxFiles),
  })
  .refine((s) => new Set(s.files.map((f) => f.path.toLowerCase())).size === s.files.length, "Two files have the same path")
  .refine((s) => s.files.every((f) => !f.text.includes("\0")), "A source file is not text")
  .refine((s) => {
    let total = 0;
    for (const f of s.files) {
      const size = utf8.encode(f.text).length;
      if (size > OBJECT_LIMITS.source.maxFileBytes) return false;
      total += size;
    }
    return total <= OBJECT_LIMITS.source.maxTotalBytes;
  }, "The mini-app's source is too big");
export type AppSource = z.infer<typeof AppSource>;

// ------------------------------------------------------------------ keys

/** The ONLY way a key is made. Every argument is an id the server already holds, never request text. */
export const objectKeys = {
  source: (org: OrgId, app: AppId, n: number): ObjectKey => ObjectKey.parse(`orgs/${org}/apps/${app}/versions/${versionNumber(n)}.bundle`),
  /** Everything a build of version `n` stored. Ends with "/". For `list` and `deletePrefix`. */
  screensPrefix: (org: OrgId, app: AppId, n: number): string => `orgs/${org}/apps/${app}/builds/${versionNumber(n)}/screens/`,
  screen: (org: OrgId, app: AppId, n: number, path: BundlePath): ObjectKey =>
    ObjectKey.parse(`${objectKeys.screensPrefix(org, app, n)}${BundlePath.parse(path)}`),
  listing: (listing: ListingId, n: number): ObjectKey => ObjectKey.parse(`listings/${listing}/${versionNumber(n)}.bundle`),
} as const;

export type ParsedObjectKey =
  | { kind: "source"; orgId: OrgId; appId: AppId; number: number }
  | { kind: "screen"; orgId: OrgId; appId: AppId; number: number; path: string }
  | { kind: "listing"; listingId: ListingId; number: number };

/** Reads a key back into its parts. Null for anything that is not one of the three forms. */
export const parseObjectKey = (key: string): ParsedObjectKey | null => {
  if (!ObjectKey.safeParse(key).success) return null;
  const parts = key.split("/");
  if (parts[0] === "listings") return { kind: "listing", listingId: parts[1] as ListingId, number: Number((parts[2] as string).replace(".bundle", "")) };
  const orgId = parts[1] as OrgId;
  const appId = parts[3] as AppId;
  if (parts[4] === "versions") return { kind: "source", orgId, appId, number: Number((parts[5] as string).replace(".bundle", "")) };
  return { kind: "screen", orgId, appId, number: Number(parts[5]), path: parts.slice(7).join("/") };
};

/** The restaurant a key belongs to, as a raw uuid. Null for a listing: a listing belongs to no restaurant's store. */
export const orgUuidOfKey = (key: string): string | null => {
  const parsed = parseObjectKey(key);
  return parsed === null || parsed.kind === "listing" ? null : toUuid(parsed.orgId);
};

/** The key prefix every object of one restaurant starts with. The database checks a row's key against its org with the same rule. */
export const orgKeyPrefix = (orgUuid: string): string => `orgs/${toPublicId("org", orgUuid)}/`;

// The object store: where a mini-app's source and built files are kept (ADR 0009). Lead-owned.
//
// The plan's target is a private bucket. Today the same keys live in `platform.objects`, so a
// local stack with no storage service and the hosted project behave the same. A bucket later
// is another implementation of `ObjectStore`: no key and no caller changes.
//
// Server-side only. Keys are built with `objectKeys` from ids the server already trusts. No
// request, message or route ever passes a key in.
//
// Which connection:
//   - `dbObjectStore(tx)` inside `withOrg(apiDb(), ...)`: the build flow saving the source of the
//     restaurant's own DRAFT version. The database refuses everything else from that login.
//   - `dbObjectStore(adminDb())` (or its transaction): publish, share and install.
import { createHash } from "node:crypto";
import {
  type AppId,
  AppSource,
  type AppVersionId,
  BundleFile,
  BundleIndex,
  BundlePath,
  type ListingId,
  OBJECT_LIMITS,
  ObjectKey,
  type OrgId,
  type Origin,
  SOURCE_CONTENT_TYPE,
  contentTypeFor,
  objectKeys,
  parseObjectKey,
  toUuid,
} from "@rms/contracts";
import type postgres from "postgres";

type Db = postgres.Sql | postgres.TransactionSql;

export type ObjectInfo = { key: string; contentType: string; sha256: string; size: number; createdAt: string };
export type StoredObject = ObjectInfo & { bytes: Uint8Array };

export class ObjectStoreError extends Error {
  constructor(readonly reason: "bad_key" | "bad_prefix" | "too_big" | "bad_type" | "empty" | "bad_content") {
    super(`object store: ${reason}`);
  }
}

/**
 * Put, get, exists, list and delete-by-prefix. Nothing else.
 * `put` replaces: an object is never changed in place, it is deleted and written again.
 */
export interface ObjectStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<ObjectInfo>;
  get(key: string): Promise<StoredObject | null>;
  exists(key: string): Promise<boolean>;
  /** Everything under a prefix, by key. The prefix must be one of the forms in `PREFIX`. */
  list(prefix: string): Promise<ObjectInfo[]>;
  /** Deletes everything under a prefix and returns how many objects went. */
  deletePrefix(prefix: string): Promise<number>;
}

/**
 * The only prefixes that may be listed or deleted: one mini-app, one version's built files, or
 * one listing. Never a whole restaurant, never everything.
 */
const PREFIX = /^(orgs\/org_[0-9a-f]{32}\/apps\/app_[0-9a-f]{32}\/(builds\/[1-9][0-9]{0,5}\/screens\/)?|listings\/lst_[0-9a-f]{32}\/)$/;
const CONTENT_TYPE = /^[a-z0-9.+-]{1,40}\/[a-z0-9.+-]{1,60}(; charset=utf-8)?$/;

const checkedKey = (key: string): string => {
  const parsed = ObjectKey.safeParse(key);
  if (!parsed.success) throw new ObjectStoreError("bad_key");
  return parsed.data;
};
const checkedPrefix = (prefix: string): string => {
  if (!PREFIX.test(prefix)) throw new ObjectStoreError("bad_prefix");
  return prefix;
};

type Row = { key: string; content_type: string; sha256: string; size: number; created_at: Date };
const info = (r: Row): ObjectInfo => ({ key: r.key, contentType: r.content_type, sha256: r.sha256, size: r.size, createdAt: r.created_at.toISOString() });

/** The database-backed store. `db` decides who is asking: see the top of this file. */
export const dbObjectStore = (db: Db): ObjectStore => {
  const sql = db as postgres.Sql;
  const inTx = <T>(fn: (tx: postgres.Sql) => Promise<T>): Promise<T> =>
    "savepoint" in db
      ? ((db as postgres.TransactionSql).savepoint((sp) => fn(sp as unknown as postgres.Sql)) as Promise<T>)
      : (sql.begin((tx) => fn(tx as unknown as postgres.Sql)) as Promise<T>);

  return {
    async put(key, bytes, contentType) {
      const k = checkedKey(key);
      if (!CONTENT_TYPE.test(contentType)) throw new ObjectStoreError("bad_type");
      if (bytes.byteLength === 0) throw new ObjectStoreError("empty");
      if (bytes.byteLength > OBJECT_LIMITS.maxObjectBytes) throw new ObjectStoreError("too_big");
      // The owner columns come from the key itself, never from the caller.
      const parsed = parseObjectKey(k);
      if (!parsed) throw new ObjectStoreError("bad_key");
      const orgUuid = parsed.kind === "listing" ? null : toUuid(parsed.orgId);
      const listingUuid = parsed.kind === "listing" ? toUuid(parsed.listingId) : null;
      const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const sha256 = createHash("sha256").update(buf).digest("hex");
      return inTx(async (tx) => {
        await tx`delete from platform.objects where key = ${k}`;
        const [row] = await tx<Row[]>`
          insert into platform.objects (key, org_id, listing_id, bytes, content_type, sha256, size)
          values (${k}, ${orgUuid}, ${listingUuid}, ${buf}, ${contentType}, ${sha256}, ${buf.byteLength})
          returning key, content_type, sha256, size, created_at`;
        if (!row) throw new Error("Object was not stored");
        return info(row);
      });
    },

    async get(key) {
      const k = checkedKey(key);
      const [row] = await sql<(Row & { bytes: Buffer })[]>`
        select key, content_type, sha256, size, created_at, bytes from platform.objects where key = ${k}`;
      if (!row) return null;
      return { ...info(row), bytes: new Uint8Array(row.bytes.buffer, row.bytes.byteOffset, row.bytes.byteLength) };
    },

    async exists(key) {
      const k = checkedKey(key);
      const rows = await sql`select 1 from platform.objects where key = ${k}`;
      return rows.length > 0;
    },

    async list(prefix) {
      const p = checkedPrefix(prefix);
      const rows = await sql<Row[]>`
        select key, content_type, sha256, size, created_at from platform.objects where starts_with(key, ${p}) order by key limit 1000`;
      return rows.map(info);
    },

    async deletePrefix(prefix) {
      const p = checkedPrefix(prefix);
      const rows = await sql`delete from platform.objects where starts_with(key, ${p}) returning 1`;
      return rows.length;
    },
  };
};

// ------------------------------------------------------------------ source

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder("utf-8", { fatal: true });

const readSource = async (store: ObjectStore, key: string): Promise<AppSource | null> => {
  const found = await store.get(key);
  if (!found) return null;
  // What comes out of the store is checked again: a stored object is data, not a promise.
  if (found.contentType !== SOURCE_CONTENT_TYPE) throw new ObjectStoreError("bad_content");
  let json: unknown;
  try {
    json = JSON.parse(fromUtf8.decode(found.bytes));
  } catch {
    throw new ObjectStoreError("bad_content");
  }
  const parsed = AppSource.safeParse(json);
  if (!parsed.success) throw new ObjectStoreError("bad_content");
  return parsed.data;
};

const writeSource = (store: ObjectStore, key: string, source: AppSource): Promise<ObjectInfo> => {
  const parsed = AppSource.safeParse(source);
  if (!parsed.success) throw new ObjectStoreError("bad_content");
  return store.put(key, utf8.encode(JSON.stringify(parsed.data)), SOURCE_CONTENT_TYPE);
};

/**
 * Saves a version's source: only the files the agent may write, within the size limits
 * (`AppSource`). The build flow calls this at the end of a run, for the DRAFT version it is
 * working on, through the restaurant-fenced connection. Returns the key to put in
 * `app_versions.source_key`.
 */
export const saveSource = async (store: ObjectStore, orgId: OrgId, appId: AppId, number: number, source: AppSource): Promise<ObjectInfo> =>
  writeSource(store, objectKeys.source(orgId, appId, number), source);

/** A version's source, or null when none was saved. Throws when what is stored is not a valid source. */
export const loadSource = (store: ObjectStore, orgId: OrgId, appId: AppId, number: number): Promise<AppSource | null> =>
  readSource(store, objectKeys.source(orgId, appId, number));

/** Scrubbed source for a Marketplace listing. Platform login only. */
export const saveListingSource = (store: ObjectStore, listingId: ListingId, number: number, source: AppSource): Promise<ObjectInfo> =>
  writeSource(store, objectKeys.listing(listingId, number), source);

export const loadListingSource = (store: ObjectStore, listingId: ListingId, number: number): Promise<AppSource | null> =>
  readSource(store, objectKeys.listing(listingId, number));

// ------------------------------------------------------------------ built files

export type BuiltFile = { path: string; bytes: Uint8Array };

/**
 * Stores one version's built files and returns their index. Platform login only (the database
 * refuses built files from the restaurant-facing login). Every path and kind of file is
 * checked, each file and the whole set are held to `OBJECT_LIMITS.screens`, and whatever an
 * earlier build of the same version left is removed first. Call it inside a transaction so a
 * half-stored build is never left behind.
 */
export const saveScreens = async (
  store: ObjectStore,
  orgId: OrgId,
  appId: AppId,
  number: number,
  files: readonly BuiltFile[],
  meta: { shellOrigin: Origin; builtAt: string },
): Promise<BundleIndex> => {
  const limits = OBJECT_LIMITS.screens;
  if (files.length === 0) throw new ObjectStoreError("empty");
  if (files.length > limits.maxFiles) throw new ObjectStoreError("too_big");
  let total = 0;
  const listed: BundleFile[] = [];
  for (const f of files) {
    const path = BundlePath.safeParse(f.path);
    const contentType = contentTypeFor(f.path);
    if (!path.success || contentType === null) throw new ObjectStoreError("bad_type");
    if (f.bytes.byteLength === 0) throw new ObjectStoreError("empty");
    if (f.bytes.byteLength > limits.maxFileBytes) throw new ObjectStoreError("too_big");
    total += f.bytes.byteLength;
    if (total > limits.maxTotalBytes) throw new ObjectStoreError("too_big");
    listed.push({ path: path.data, contentType, size: f.bytes.byteLength, sha256: createHash("sha256").update(f.bytes).digest("hex") });
  }
  const index = BundleIndex.safeParse({ format: 1, entry: "index.html", shellOrigin: meta.shellOrigin, builtAt: meta.builtAt, files: listed });
  if (!index.success) throw new ObjectStoreError("bad_content");

  await store.deletePrefix(objectKeys.screensPrefix(orgId, appId, number));
  for (const [i, f] of files.entries()) {
    const entry = listed[i] as BundleFile;
    await store.put(objectKeys.screen(orgId, appId, number, entry.path), f.bytes, entry.contentType);
  }
  return index.data;
};

export type ServedFile = { bytes: Uint8Array; contentType: string; sha256: string; size: number };

/**
 * One built file of a PUBLISHED mini-app, for the apps host. Found by (mini-app, version,
 * path): the database hands it over only while that version is the mini-app's published
 * version. Never takes a key. The content type comes from the path, not from what was stored.
 * `adminSql` is the platform login.
 */
export const readPublishedScreen = async (adminSql: postgres.Sql, appId: AppId, versionId: AppVersionId, path: string): Promise<ServedFile | null> => {
  const checked = BundlePath.safeParse(path);
  const contentType = contentTypeFor(path);
  if (!checked.success || contentType === null) return null;
  const rows = await adminSql<{ bytes: Buffer; sha256: string; size: number }[]>`
    select bytes, sha256, size from platform.published_screen(${toUuid(appId)}::uuid, ${toUuid(versionId)}::uuid, ${checked.data})`;
  const row = rows[0];
  if (!row) return null;
  return { bytes: new Uint8Array(row.bytes.buffer, row.bytes.byteOffset, row.bytes.byteLength), contentType, sha256: row.sha256, size: row.size };
};

# 0009: Where a mini-app's code is kept

Date: 2026-11-21. Status: decided by the lead (Rahul asked where each mini-app's code is stored). Written with the Wave 3 preparation.

## The target stays the plan's

A private bucket, with the keys from the data model (section 6):

| What | Key |
|---|---|
| A version's source (what the agent wrote) | `orgs/<org>/apps/<app>/versions/<n>.bundle` |
| A version's built files | `orgs/<org>/apps/<app>/builds/<n>/screens/<path>` |
| Scrubbed source of a Marketplace listing | `listings/<listing>/<n>.bundle` |

`app_versions.source_key` and `bundle_key`, `deployments.screens_key` and `listing_versions.bundle_key` point at them.

## Today's shortcut

The same keys, in one database table, `platform.objects`, behind one small interface: `ObjectStore` in `packages/db/src/objects.ts` (put, get, exists, list, delete by prefix). The key shapes and size limits are in `packages/contracts/src/objects.ts`.

Why: the local stack runs without a storage service, and nothing is deployed today. A table works the same on a laptop and on the hosted project, needs no new service, no new key and no new dependency.

What is different from the target, said plainly:

- **A `.bundle` is a JSON list of files today, not a git bundle.** It holds only the files the agent may write (`src/screens/`, `src/components/`). RMS's own template files are never stored per mini-app: publish takes them fresh from the template.
- **Files sit in Postgres as bytes.** One object is at most 5 MB, a version's source 2 MB, a version's built files 12 MB. Fine for a demo. Not where built files should live at scale.
- **Other kinds of object in the plan (diffs, backups, run transcripts, uploads) are not stored yet.** The table refuses any key that is not one of the three above.

## The rules that hold either way

- **A key is built by the server** from ids it already trusts (`objectKeys`). No request, message or route carries a key or a prefix.
- **The restaurant-facing login** can read its own restaurant's objects, and can write or delete only the source of its own DRAFT versions (the build flow saves source at the end of a run). The database enforces it.
- **Built files and listings are written by the platform login**, after the publish or share checks.
- **Nobody updates an object.** It is written once, or deleted and written again. The database checks the stored bytes against their hash and size.
- **The key's restaurant is the row's restaurant.** A check constraint compares them.
- **The apps host never names a key.** It asks for one file by (mini-app, published version, path), through `platform.published_screen`, and gets nothing unless that version is the mini-app's published version at that moment.

## How to swap to a bucket later

1. Write a second `ObjectStore` (Supabase Storage or another S3-style store) with the same five methods. Keep the same keys.
2. Copy the rows of `platform.objects` to the bucket. Point `dbObjectStore` callers at the new store (one function).
3. Move the two database rules that cannot live in a bucket into the store or the bucket's policy: "draft source only for the restaurant login" and "published version only for the apps host".
4. Give the apps host its own login (or a signed, short-lived read address per file) instead of the platform login. It uses the platform login today only because it runs on the same machine and is never deployed. **Do this before the apps host is deployed anywhere.**
5. Drop `platform.objects`.

## Checked

- `packages/db/src/objects.test.ts`: 35 tests against the local database (own draft source only, no cross-restaurant read, write, list or delete, no update for anyone, size and hash rules, the apps host's door).
- `tests/security/db-walls.smoke.sh`: 17 new checks, `FAILS=0`.

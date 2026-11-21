# 0004: Database hardening after the security review

Date: 2026-11-21. Status: decided by the lead. The security reviewer said BLOCK on the first database layer, with nine findings. This records what was closed and what stays open.

## Closed (migration `20261121120200_hardening.sql`, `@rms/db` `ask.ts`)

1. **The Ask login could undo its own limits** (lift the time limit, change its own password, leave settings behind on a pooled connection). Now:
   - Every Ask query runs inside one envelope: read-only transaction, all settings reset, a local 5 second limit, session locks released, then exactly one statement, then rollback. The statement is sent inside a subquery with a bound parameter, so a second statement, a write or a setting change is a syntax error before anything runs.
   - The login is minted per Ask session and stops working after 15 minutes. The role cannot extend that.
   - The database only ever receives a password verifier, never the password.
   - Restaurant roles can no longer create temp tables.
2. **Any role could install or remove database extensions** in a read-write transaction (a Supabase behaviour: extension commands run with elevated rights). There is no reliable SQL wall for this. The wall is that the Ask login only ever runs inside the read-only envelope, where the database refuses it. Tested.
3. **A restaurant's row could point at another restaurant's row** (for example its connection at another restaurant's stored secret). Every such link is now checked on (restaurant, id), 30 links in all.
4. **A restaurant's own server login could write governance fields** (mark a change approved, list a mini-app publicly, change its own store prefix). Now it can only change the columns a restaurant may change, new apps, versions and listings must start as drafts, and a recorded change must carry the decision its tier allows. Publishing, installing, deploying and deciding go through the platform login.
5. **The public listings view could leak unlisted titles** through a cheap function. It is now a barrier view and no longer carries embeddings.
6. **Builds and previews could read real staff pay** from parent data. The draft role now reads names, jobs and dates only.
7. **The local setup script** sent passwords to the database in clear text (they landed in the local database log) and its "is this local?" check could be fooled. Both fixed.

## Still open (undo before real users)

- **Catalog leaks.** Any restaurant role can read other restaurants' table names, column names and rough row counts from the database's own catalogs. Only the Ask parser stops this today. The real fix is the plan's two databases, or one database per cell.
- **The shared server login** (ADR 0003) is worse than first written: SQL running as one restaurant's write role could also reset its role and read other restaurants' platform rows. It still depends on the Data API never running caller-written SQL. Named queries and actions are written by maintainers only.
- **Extensions outside the Ask envelope.** The Data API roles could still install an extension if they ever ran hostile SQL. Same dependency as above.
- **The tier is not re-derived in the database.** The policy checks that tier and decision agree, but the server still computes the tier from the signals.
- **Hosted Supabase checklist**, to do when the project exists: push `config.toml` so the auto-generated API exposes nothing; raise the minimum password length; confirm custom logins and per-session password changes work through the pooler (it may cache credentials); remember the dashboard's read-only user can read everything, including stored secrets (which are encrypted by the app).

## Checked

- `tests/security/db-walls.smoke.sh`: 59 database checks, all pass on a database rebuilt from zero, and it leaves nothing behind.
- `packages/db`: 18 tests, 11 of them on the Ask path with the reviewer's attacks.

## Hosted project: what was checked on 2026-11-21

The database is pushed to the hosted `rms-demo` project and the wall checks pass there (63 checks, run twice).

- **Custom logins through the pooler: work.** `rms_api`, `rms_admin` and the per-restaurant Ask login all connect through the hosted pooler with the username form `<role>.<project ref>`.
- **Changing the Ask login's password takes effect at once.** The old password stops working immediately. So a fresh 15-minute login per Ask session works on hosted.
- **A role name that is dropped and made again does not.** The pooler keeps the old login for that name for a while, and sign-in fails. The product never reuses a store prefix (they are random), and the wall checks now use fresh prefixes each run. Never reuse a store prefix.
- **The sign-in signing secret is not readable from the database on hosted.** On the local stack it is (the public development default), which is why one test is marked "local stack only".
- **No temp tables for restaurant roles: holds on hosted too.**
- Still to do on hosted before the demo: push `config.toml` so the auto-generated API exposes nothing, raise the minimum password length, turn email confirmation on or cap sign-ups.

## Closed after the Wave 1 attack suite (migration `20261121120400_hardening_2.sql`)

- A restaurant's login can change a version or a listing only while it is a draft.
- Two more links are checked by restaurant: a version's parent version, and a memory entry's replacement.
- Removing a store works even if one of its roles left a large object behind.
- An Ask answer is limited by size (about 1 MB), not only by rows.
- The Ask envelope sets the caller's locations itself.

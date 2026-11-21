# 0003: Database roles, row-level security and the local stack

Date: 2026-11-21. Status: decided by the lead.

## Decisions

1. **Development runs on a local Supabase stack in Docker** (`pnpm exec supabase start`, database, sign-in and pooler only). The same migration files go to the hosted project with `supabase db push` once Rahul provides it. No hosted project is touched until then.
2. **Server code never connects as `postgres`.** Two logins:
   - `rms_api`: restaurant-facing requests. Every platform table has row-level security, and `rms_api` only sees rows where `org_id` matches the org set for that transaction (`set_config('rms.org', ..., true)`).
   - `rms_admin`: sign-up, provisioning, jobs, seed, maintainer console.
   Passwords are set outside git (`scripts/dev-db-roles.sh` locally).
3. **One function creates a restaurant's store**: `platform.provision_store(org)`. Three schemas, three roles, all grants. Parent data and the model compiler build on it.
4. **Per-restaurant Ask login.** The docs check confirmed custom logins work through the Supabase pooler, so we take the stronger option: `o_<id>_ask` is its own login, read-only, 5 second limit, member of nothing else. The fallback in section 6 (one login that switches role) is not needed.
5. **Restaurant roles create nothing.** Only `rms_tenant_migrator` creates tables, and it grants access per table. Append-only models get select and insert only.
6. **`public` stays empty.** Helper functions live in `rms`. Platform tables live in `platform`.

## Known limit (undo before real users)

`rms_api` is a member of every restaurant's write role so it can switch into them. Postgres checks that switch against the login, not the current role, so SQL running as restaurant A's write role could switch to restaurant B's. This is safe only because the Data API builds every statement itself and mini-apps cannot send SQL. The wall for writes is therefore the Data API taking the restaurant from the token, exactly as the plan says.

Full fix later: one write login per restaurant, like the Ask login, or a separate database per cell.

The Ask path does not have this limit: its login belongs to one restaurant only.

## Checked

`tests/security/db-walls.smoke.sh` creates two throwaway restaurants and runs 43 checks at the database level (platform row fencing, parent data read-only, no cross-restaurant reads, no role switching for Ask, no table creation). All pass on a database rebuilt from zero. Task G turns this into the CI suite.

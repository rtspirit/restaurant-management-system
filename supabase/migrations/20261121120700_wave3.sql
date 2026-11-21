-- Wave 3: where mini-app code is kept, and actions held for a decision. Lead-owned.
--
-- Everything else Wave 3 needs is already there (apps, app_versions, app_slots, deployments,
-- listings, listing_versions, installs, org_recommendations, change_sets, change_reviews).
-- Checked and NOT added:
--   * a login for the apps host. It runs on the same machine today and reads through the
--     platform login, by (mini-app, published version) only: platform.published_screen below.
--     Before the apps host is ever deployed it gets its own login that can run that one
--     function and nothing else (ADR 0009).
--   * any function the restaurant-facing login can call. The rules below are written out in
--     full in the policies and constraints, so that login still calls exactly two functions.
--   * a nightly job or a score table change for recommendations: they are worked out on request.
--   * anything for custom models in a listing: sharing a mini-app with its own kind of record
--     is refused today.

-- ------------------------------------------------------------------ 1. the object store (ADR 0009)
-- The plan keeps mini-app code in a private bucket (01-data-model section 6). Today the same
-- keys live here, behind the ObjectStore interface in @rms/db, so a local stack with no storage
-- service and the hosted project behave the same. Moving to a bucket later changes that one file.
--
-- Three kinds of key. The patterns MUST match OBJECT_KEY_PATTERNS in
-- packages/contracts/src/objects.ts. packages/db has a test that compares the two.
--   orgs/<org>/apps/<app>/versions/<n>.bundle         a version's source (what the agent wrote)
--   orgs/<org>/apps/<app>/builds/<n>/screens/<path>   a version's built files
--   listings/<listing>/<n>.bundle                     scrubbed source for the Marketplace
-- <org>, <app> and <listing> are public ids: a prefix, then the uuid without its dashes.

create table platform.objects (
  key          text primary key,
  -- The restaurant the object belongs to. For a listing's object this is the restaurant that
  -- shared it: for our records and for clean-up only, like listings.publisher_org_id. It is
  -- never selected by anything that serves another restaurant, and the key does not carry it.
  org_id       uuid not null references platform.organizations(id),
  bytes        bytea not null,
  content_type text not null check (content_type ~ '^[a-z0-9.+-]{1,40}/[a-z0-9.+-]{1,60}(; charset=utf-8)?$'),
  sha256       text not null,
  size         integer not null,
  created_at   timestamptz not null default now(),
  constraint objects_key_form check (
    length(key) <= 400 and (
         key ~ '^orgs/org_[0-9a-f]{32}/apps/app_[0-9a-f]{32}/versions/[1-9][0-9]{0,5}\.bundle$'
      or key ~ '^orgs/org_[0-9a-f]{32}/apps/app_[0-9a-f]{32}/builds/[1-9][0-9]{0,5}/screens/[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)*$'
      or key ~ '^listings/lst_[0-9a-f]{32}/[1-9][0-9]{0,5}\.bundle$')),
  -- A key under orgs/ names a restaurant, and it IS the row's restaurant.
  constraint objects_key_owner check (
    starts_with(key, 'listings/lst_') or starts_with(key, 'orgs/org_' || replace(org_id::text, '-', '') || '/')),
  -- What is stored is what was hashed and measured. One object is at most 5 MB.
  constraint objects_size check (size = octet_length(bytes) and size between 1 and 5000000),
  constraint objects_sha256 check (sha256 = encode(sha256(bytes), 'hex'))
);
create index objects_org_key on platform.objects (org_id, key text_pattern_ops);

alter table platform.objects enable row level security;
create policy admin_all on platform.objects for all to rms_admin using (true) with check (true);

-- Nobody updates an object: it is written once, or deleted and written again.
grant select, insert, delete on platform.objects to rms_admin;
grant select, insert, delete on platform.objects to rms_api;

-- The restaurant-facing login reads its own restaurant's objects under orgs/ (never a
-- listing's, not even its own). It writes and deletes ONLY the source of its own DRAFT
-- versions: the build flow saves source at the end of a run. Built files and listings are
-- written by the platform login, after its checks.
-- The sub-select runs as that login, so it only ever sees its own restaurant's versions.
create policy api_read_own on platform.objects for select to rms_api
  using (org_id = rms.current_org() and starts_with(key, 'orgs/'));

create policy api_write_draft_source on platform.objects for insert to rms_api
  with check (
    org_id = rms.current_org()
    and exists (
      select 1
        from platform.app_versions v
        join platform.apps a on a.id = v.app_id and a.org_id = v.org_id
       where v.org_id = objects.org_id and v.status = 'draft' and a.status <> 'deleted' and a.kind <> 'system'
         and objects.key = 'orgs/org_' || replace(v.org_id::text, '-', '') || '/apps/app_' || replace(v.app_id::text, '-', '')
                           || '/versions/' || v.number::text || '.bundle'));

create policy api_delete_draft_source on platform.objects for delete to rms_api
  using (
    org_id = rms.current_org()
    and exists (
      select 1
        from platform.app_versions v
        join platform.apps a on a.id = v.app_id and a.org_id = v.org_id
       where v.org_id = objects.org_id and v.status = 'draft' and a.status <> 'deleted' and a.kind <> 'system'
         and objects.key = 'orgs/org_' || replace(v.org_id::text, '-', '') || '/apps/app_' || replace(v.app_id::text, '-', '')
                           || '/versions/' || v.number::text || '.bundle'));

-- One built file of a PUBLISHED mini-app, found by (mini-app, version, path). This is the only
-- way the apps host reads: it never names a key, and it gets nothing unless that version is the
-- mini-app's published version right now. A paused, deleted, draft or hidden mini-app has no files.
-- Platform login only.
create or replace function platform.published_screen(p_app uuid, p_version uuid, p_path text)
returns table (bytes bytea, sha256 text, size integer)
language sql stable security definer set search_path = '' as $$
  select o.bytes, o.sha256, o.size
    from platform.apps a
    join platform.app_versions v on v.id = a.published_version_id and v.app_id = a.id and v.org_id = a.org_id
    join platform.objects o
      on o.org_id = a.org_id
     and o.key = 'orgs/org_' || replace(a.org_id::text, '-', '') || '/apps/app_' || replace(a.id::text, '-', '')
                 || '/builds/' || v.number::text || '/screens/' || p_path
   where a.id = p_app and v.id = p_version
     and a.status = 'published' and v.status = 'published' and a.kind <> 'system'
     and length(p_path) between 1 and 200
$$;
revoke all on function platform.published_screen(uuid, uuid, text) from public;
grant execute on function platform.published_screen(uuid, uuid, text) to rms_admin;

-- ------------------------------------------------------------------ 2. an action held for a decision
-- A T3 change (a public share) records what it is holding. When a maintainer approves, the
-- action is carried out in the same transaction as the decision. When they reject, it is
-- cancelled. The shape is HeldAction in packages/contracts/src/changes.ts.
--
-- Only the platform login can write or read these two columns: a restaurant must not be able
-- to say what an approval will do. So the restaurant-facing login's insert right becomes a list
-- of the columns it could already fill, and the new columns are not on it. (Its select right is
-- already a column list from migration 20261121120300, so it cannot read them either.)
alter table platform.change_sets
  add column held_action jsonb,
  add column held_state text not null default 'none' check (held_state in ('none', 'waiting', 'carried_out', 'cancelled'));
alter table platform.change_sets
  add constraint change_sets_held_consistent check ((held_action is null) = (held_state = 'none')),
  add constraint change_sets_held_shape check (held_action is null or jsonb_typeof(held_action) = 'object');

revoke insert on platform.change_sets from rms_api;
grant insert (id, org_id, app_id, origin, run_id, actor, signals, tier, summary, owner_summary, diff, decision,
              decided_by_staff_id, decided_at, applied_at, created_at)
  on platform.change_sets to rms_api;

-- Wave 3: where mini-app code is kept, and actions held for a decision. Lead-owned.
--
-- Everything else Wave 3 needs is already there (apps, app_versions, app_slots, deployments,
-- listings, listing_versions, installs, org_recommendations, change_sets, change_reviews).
-- Checked and NOT added:
--   * a login for the apps host. It runs on the same machine today and reads through the
--     platform login, by (mini-app, published version) only: platform.published_screen below.
--     Before the apps host is ever deployed it gets its own login that can run that one
--     function and nothing else (ADR 0009).
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

create or replace function platform.org_key_prefix(p_org uuid) returns text
language sql immutable set search_path = '' as $$
  select 'orgs/org_' || replace(p_org::text, '-', '') || '/'
$$;

create or replace function platform.source_key(p_org uuid, p_app uuid, p_number integer) returns text
language sql immutable set search_path = '' as $$
  select platform.org_key_prefix(p_org) || 'apps/app_' || replace(p_app::text, '-', '') || '/versions/' || p_number::text || '.bundle'
$$;

create or replace function platform.screens_prefix(p_org uuid, p_app uuid, p_number integer) returns text
language sql immutable set search_path = '' as $$
  select platform.org_key_prefix(p_org) || 'apps/app_' || replace(p_app::text, '-', '') || '/builds/' || p_number::text || '/screens/'
$$;

create or replace function platform.listing_key(p_listing uuid, p_number integer) returns text
language sql immutable set search_path = '' as $$
  select 'listings/lst_' || replace(p_listing::text, '-', '') || '/' || p_number::text || '.bundle'
$$;

create table platform.objects (
  key          text primary key,
  -- The restaurant the object belongs to. Null only for a Marketplace listing, which belongs to
  -- no restaurant's store.
  org_id       uuid references platform.organizations(id),
  -- Set only for a listing's object, so it goes when the listing goes.
  listing_id   uuid references platform.listings(id) on delete cascade,
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
  -- The key's restaurant IS the row's restaurant. A listing key has neither.
  constraint objects_key_owner check (
       (org_id is not null and listing_id is null and starts_with(key, platform.org_key_prefix(org_id)))
    or (org_id is null and listing_id is not null and starts_with(key, 'listings/lst_' || replace(listing_id::text, '-', '') || '/'))),
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

-- True when `p_key` is the source key of one of this restaurant's own DRAFT versions.
-- Runs as the caller, so for the restaurant-facing login it only ever sees that restaurant's rows.
create or replace function platform.is_draft_source_key(p_org uuid, p_key text) returns boolean
language sql stable set search_path = '' as $$
  select exists (
    select 1
      from platform.app_versions v
      join platform.apps a on a.id = v.app_id and a.org_id = v.org_id
     where v.org_id = p_org and v.status = 'draft' and a.status <> 'deleted' and a.kind <> 'system'
       and p_key = platform.source_key(v.org_id, v.app_id, v.number))
$$;
revoke all on function platform.org_key_prefix(uuid), platform.source_key(uuid, uuid, integer),
  platform.screens_prefix(uuid, uuid, integer), platform.listing_key(uuid, integer),
  platform.is_draft_source_key(uuid, text) from public;
grant execute on function platform.org_key_prefix(uuid), platform.source_key(uuid, uuid, integer),
  platform.screens_prefix(uuid, uuid, integer), platform.listing_key(uuid, integer),
  platform.is_draft_source_key(uuid, text) to rms_api, rms_admin;

-- The restaurant-facing login: reads its own restaurant's objects. Writes and deletes ONLY the
-- source of its own draft versions (the build flow saves source at the end of a run). Built
-- files and listings are written by the platform login, after its checks.
create policy api_read_own on platform.objects for select to rms_api
  using (org_id = rms.current_org());
create policy api_write_draft_source on platform.objects for insert to rms_api
  with check (org_id = rms.current_org() and listing_id is null and platform.is_draft_source_key(org_id, key));
create policy api_delete_draft_source on platform.objects for delete to rms_api
  using (org_id = rms.current_org() and listing_id is null and platform.is_draft_source_key(org_id, key));

-- One built file of a PUBLISHED mini-app, found by (mini-app, version, path). This is the only
-- way the apps host reads: it never names a key, and it gets nothing unless that version is the
-- mini-app's published version right now. A paused, deleted, draft or hidden mini-app has no files.
create or replace function platform.published_screen(p_app uuid, p_version uuid, p_path text)
returns table (bytes bytea, sha256 text, size integer)
language sql stable security definer set search_path = '' as $$
  select o.bytes, o.sha256, o.size
    from platform.apps a
    join platform.app_versions v on v.id = a.published_version_id and v.app_id = a.id and v.org_id = a.org_id
    join platform.objects o on o.org_id = a.org_id and o.key = platform.screens_prefix(a.org_id, a.id, v.number) || p_path
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

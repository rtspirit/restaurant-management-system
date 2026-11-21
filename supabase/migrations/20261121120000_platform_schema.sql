-- RMS platform schema. Owned by the lead. Ask the lead for changes.
--
-- Rules:
--   * Nothing of ours goes in `public`.
--   * `platform` holds platform tables. `rms` holds tiny helper functions that restaurant roles may call.
--   * Each restaurant gets `o_<id>_parent`, `o_<id>`, `o_<id>_draft` (see the provisioning migration).
--   * Roles are created WITHOUT passwords here. Passwords are set outside git.
--   * Server code connects as `rms_api` (restaurant-facing, row-level security by org) or
--     `rms_admin` (sign-up, provisioning, jobs, maintainer console). Never as `postgres`.

create extension if not exists vector with schema extensions;

create schema if not exists platform;
create schema if not exists rms;

revoke all on schema platform from public;
revoke all on schema rms from public;

-- ---------------------------------------------------------------- roles
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'rms_api') then
    create role rms_api login noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'rms_admin') then
    create role rms_admin login noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'rms_tenant_migrator') then
    create role rms_tenant_migrator nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'rms_parent_sync') then
    create role rms_parent_sync nologin;
  end if;
  -- Every restaurant role is a member of this group. It carries only what all of them need.
  if not exists (select 1 from pg_roles where rolname = 'rms_tenant') then
    create role rms_tenant nologin;
  end if;
end $$;

grant usage on schema platform to rms_api, rms_admin;
grant usage on schema rms to rms_api, rms_admin, rms_tenant, rms_tenant_migrator, rms_parent_sync;
grant usage on schema extensions to rms_api, rms_admin, rms_tenant, rms_tenant_migrator;

-- rms_admin may act as the migrator and the parent sync. rms_api may not.
grant rms_tenant_migrator to rms_admin with inherit false, set true;
grant rms_parent_sync to rms_admin with inherit false, set true;

-- ---------------------------------------------------------------- request context helpers
-- Set once per transaction by server code, with set_config(name, value, true):
--   rms.org        the org uuid (platform row-level security)
--   rms.locations  'all' or a comma-separated list of location uuids (store row-level security)
--   rms.actor      'user:<uuid>' | 'job:<name>' | 'connection:<uuid>' | 'system:<name>'

create or replace function rms.current_org() returns uuid
language sql stable set search_path = '' as $$
  select nullif(current_setting('rms.org', true), '')::uuid
$$;

create or replace function rms.location_ok(loc uuid) returns boolean
language sql stable set search_path = '' as $$
  select case
    when coalesce(current_setting('rms.locations', true), '') = '' then false
    when current_setting('rms.locations', true) = 'all' then true
    else loc = any (string_to_array(current_setting('rms.locations', true), ',')::uuid[])
  end
$$;

create or replace function rms.current_actor() returns text
language sql stable set search_path = '' as $$
  select nullif(current_setting('rms.actor', true), '')
$$;

create or replace function rms.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := date_trunc('milliseconds', clock_timestamp());
  return new;
end $$;

grant execute on all functions in schema rms to rms_api, rms_admin, rms_tenant, rms_tenant_migrator, rms_parent_sync;

-- ---------------------------------------------------------------- identity and tenancy
create table platform.organizations (
  id            uuid primary key,
  slug          text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,48}$'),
  name          text not null,
  kind          text not null default 'independent' check (kind in ('independent','franchisor','franchisee','group')),
  store_prefix  text not null unique check (store_prefix ~ '^o_[0-9a-f]{12}$'),
  region        text not null default 'us',
  status        text not null default 'active' check (status in ('active','suspended')),
  brand_colour  text check (brand_colour ~ '^#[0-9a-fA-F]{6}$'),
  logo_url      text,
  store_ready   boolean not null default false,
  created_at    timestamptz not null default now()
);

create table platform.locations (
  id          uuid primary key,
  org_id      uuid not null references platform.organizations(id),
  name        text not null,
  address     text,
  timezone    text not null default 'America/New_York',
  currency    char(3) not null default 'USD',
  day_cutoff  time not null default '04:00',
  seats       integer,
  hours       jsonb not null default '{}'::jsonb,
  status      text not null default 'open' check (status in ('open','closed')),
  created_at  timestamptz not null default now(),
  unique (org_id, name)
);
create index on platform.locations (org_id);

-- Users are Supabase Auth users (auth.users). Maintainers are separate (staff_users).
create table platform.members (
  id          uuid primary key,
  org_id      uuid not null references platform.organizations(id),
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        text not null check (role in ('owner','staff')),
  status      text not null default 'active' check (status in ('active','invited','removed')),
  created_at  timestamptz not null default now(),
  unique (org_id, user_id)
);
create index on platform.members (user_id);

-- No rows for a member means all locations.
create table platform.member_locations (
  org_id       uuid not null references platform.organizations(id),
  member_id    uuid not null references platform.members(id) on delete cascade,
  location_id  uuid not null references platform.locations(id) on delete cascade,
  primary key (member_id, location_id)
);

create table platform.staff_users (
  id          uuid primary key,
  user_id     uuid not null unique references auth.users(id) on delete cascade,
  name        text not null,
  created_at  timestamptz not null default now()
);

create table platform.org_settings (
  org_id      uuid primary key references platform.organizations(id),
  version     integer not null default 1,
  settings    jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------- parent data (source of truth)
-- Read-only copies live in each restaurant's o_<id>_parent schema, same columns minus org_id.
create table platform.restaurant_profiles (
  org_id         uuid primary key references platform.organizations(id),
  id             uuid not null unique,
  name           text not null,
  concept        text not null,
  cuisine        text not null,
  service_style  text not null check (service_style in ('full_service','counter_service','quick_service','bar','cafe','food_truck')),
  seats          integer not null default 0,
  price_band     text not null check (price_band in ('low','mid','high','premium')),
  systems_used   text[] not null default '{}',
  updated_at     timestamptz not null default now()
);

create table platform.parent_jobs (
  id uuid primary key, org_id uuid not null references platform.organizations(id),
  name text not null, house text not null check (house in ('front','back','management')),
  tipped boolean not null default false, updated_at timestamptz not null default now()
);

create table platform.parent_staff (
  id uuid primary key, org_id uuid not null references platform.organizations(id),
  location_id uuid references platform.locations(id),
  full_name text not null, job_id uuid references platform.parent_jobs(id),
  email text, phone text, hourly_rate_minor bigint, currency char(3) not null default 'USD',
  started_on date, status text not null default 'active' check (status in ('active','left')),
  updated_at timestamptz not null default now()
);

create table platform.parent_menu_categories (
  id uuid primary key, org_id uuid not null references platform.organizations(id),
  name text not null, sales_group text not null check (sales_group in ('food','beverage','alcohol','merchandise','other')),
  position integer not null default 0, updated_at timestamptz not null default now()
);

create table platform.parent_menu_items (
  id uuid primary key, org_id uuid not null references platform.organizations(id),
  category_id uuid not null references platform.parent_menu_categories(id),
  name text not null, description text, price_minor bigint not null, currency char(3) not null default 'USD',
  active boolean not null default true, updated_at timestamptz not null default now()
);

create table platform.parent_menu_modifiers (
  id uuid primary key, org_id uuid not null references platform.organizations(id),
  item_id uuid references platform.parent_menu_items(id),
  name text not null, price_minor bigint not null default 0, currency char(3) not null default 'USD',
  updated_at timestamptz not null default now()
);

create table platform.parent_tax_rates (
  id uuid primary key, org_id uuid not null references platform.organizations(id),
  location_id uuid references platform.locations(id),
  name text not null, rate_bps integer not null check (rate_bps between 0 and 10000),
  applies_to text not null default 'all', remitted_by text not null default 'restaurant' check (remitted_by in ('restaurant','platform')),
  updated_at timestamptz not null default now()
);

create table platform.parent_licences (
  id uuid primary key, org_id uuid not null references platform.organizations(id),
  location_id uuid references platform.locations(id),
  name text not null, issuer text, number text, expires_on date,
  updated_at timestamptz not null default now()
);

create table platform.parent_equipment (
  id uuid primary key, org_id uuid not null references platform.organizations(id),
  location_id uuid references platform.locations(id),
  name text not null, kind text, make text, installed_on date,
  updated_at timestamptz not null default now()
);

create table platform.parent_sync_state (
  org_id uuid not null references platform.organizations(id),
  model_key text not null,
  row_count integer not null default 0,
  synced_at timestamptz not null default now(),
  primary key (org_id, model_key)
);

-- ---------------------------------------------------------------- model library and per-restaurant models
create table platform.model_templates (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{0,47}$'),
  pack text not null, name text not null, description text not null,
  current_version integer not null default 1,
  status text not null default 'active' check (status in ('active','retired')),
  embedding extensions.vector(1536)
);

create table platform.model_template_versions (
  template_key text not null references platform.model_templates(key),
  version integer not null,
  definition jsonb not null,
  breaking boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (template_key, version)
);

create table platform.named_queries (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{0,47}$'),
  pack text not null, definition jsonb not null, updated_at timestamptz not null default now()
);

create table platform.named_actions (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{0,47}$'),
  pack text not null, definition jsonb not null, updated_at timestamptz not null default now()
);

create table platform.org_models (
  id uuid primary key,
  org_id uuid not null references platform.organizations(id),
  key text not null check (key ~ '^[a-z][a-z0-9_]{0,47}$'),
  kind text not null check (kind in ('standard','custom')),
  template_key text references platform.model_templates(key),
  template_version integer,
  definition jsonb not null,
  status text not null default 'draft' check (status in ('draft','live','archived')),
  embedding extensions.vector(1536),
  created_by_run_id uuid,
  created_at timestamptz not null default now(),
  unique (org_id, key)
);

create table platform.org_model_changes (
  id uuid primary key,
  org_id uuid not null references platform.organizations(id),
  org_model_id uuid references platform.org_models(id),
  change_set_id uuid,
  change jsonb not null,
  compiled_sql text not null,
  destructive boolean not null default false,
  applied_draft_at timestamptz,
  applied_live_at timestamptz,
  created_at timestamptz not null default now()
);
create index on platform.org_model_changes (org_id, created_at);

-- ---------------------------------------------------------------- mini-apps
create table platform.apps (
  id uuid primary key,
  org_id uuid not null references platform.organizations(id),
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,48}$'),
  -- Short number shown to owner and maintainers alike ("No. 014").
  number integer not null,
  name text not null,
  kind text not null default 'custom' check (kind in ('custom','installed','system')),
  status text not null default 'draft' check (status in ('draft','published','paused','deleted')),
  current_version_id uuid,
  published_version_id uuid,
  listing_id uuid,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (org_id, slug),
  unique (org_id, number)
);

create table platform.app_versions (
  id uuid primary key,
  app_id uuid not null references platform.apps(id),
  org_id uuid not null references platform.organizations(id),
  number integer not null,
  manifest jsonb not null,
  source_key text,
  bundle_key text,
  parent_version_id uuid references platform.app_versions(id),
  run_id uuid,
  checks jsonb not null default '{}'::jsonb,
  ui_version text,
  status text not null default 'draft' check (status in ('draft','checked','published','superseded','failed')),
  summary text,
  created_at timestamptz not null default now(),
  unique (app_id, number)
);
create index on platform.app_versions (org_id);

create table platform.app_models (
  app_id uuid not null references platform.apps(id) on delete cascade,
  org_id uuid not null references platform.organizations(id),
  model_ref text not null,
  access text not null check (access in ('read','write')),
  fields_used text[] not null default '{}',
  primary key (app_id, model_ref)
);

create table platform.app_profiles (
  app_id uuid primary key references platform.apps(id) on delete cascade,
  org_id uuid not null references platform.organizations(id),
  purpose text not null,
  capabilities text[] not null default '{}',
  embedding extensions.vector(1536),
  updated_at timestamptz not null default now()
);

create table platform.app_slots (
  id uuid primary key,
  app_id uuid not null references platform.apps(id) on delete cascade,
  org_id uuid not null references platform.organizations(id),
  slot_type text not null check (slot_type in ('nav','dashboard-widget')),
  config jsonb not null default '{}'::jsonb,
  position integer not null default 0
);

create table platform.deployments (
  id uuid primary key,
  app_id uuid not null references platform.apps(id),
  org_id uuid not null references platform.organizations(id),
  version_id uuid not null references platform.app_versions(id),
  env text not null check (env in ('live','draft')),
  screens_key text not null,
  url text,
  status text not null default 'active' check (status in ('active','rolled_back','failed')),
  created_at timestamptz not null default now()
);

create table platform.sandboxes (
  id uuid primary key,
  app_id uuid references platform.apps(id),
  org_id uuid not null references platform.organizations(id),
  provider text not null default 'vercel',
  external_id text,
  snapshot_ref text,
  preview_url text,
  status text not null default 'starting' check (status in ('starting','running','stopped','failed')),
  last_active_at timestamptz not null default now(),
  cpu_seconds integer not null default 0,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- agent and memory
create table platform.agent_sessions (
  id uuid primary key,
  org_id uuid not null references platform.organizations(id),
  user_id uuid not null,
  app_id uuid references platform.apps(id),
  mode text not null check (mode in ('build','ask')),
  provider text not null default 'openai',
  model text not null,
  thread_id text,
  title text,
  state jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open','closed')),
  created_at timestamptz not null default now()
);
create index on platform.agent_sessions (org_id, created_at desc);

create table platform.agent_runs (
  id uuid primary key,
  session_id uuid not null references platform.agent_sessions(id),
  org_id uuid not null references platform.organizations(id),
  status text not null default 'running' check (status in ('running','paused','waiting','done','failed','cancelled')),
  sandbox_id uuid references platform.sandboxes(id),
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cost_micros bigint not null default 0,
  change_set_id uuid,
  error text,
  created_at timestamptz not null default now(),
  ended_at timestamptz
);
create index on platform.agent_runs (session_id);

create table platform.agent_events (
  run_id uuid not null references platform.agent_runs(id) on delete cascade,
  seq integer not null,
  session_id uuid not null,
  org_id uuid not null references platform.organizations(id),
  type text not null,
  payload jsonb not null,
  at timestamptz not null default now(),
  primary key (run_id, seq)
);

create table platform.org_memory (
  id uuid primary key,
  org_id uuid not null references platform.organizations(id),
  kind text not null check (kind in ('fact','preference','decision','session_summary')),
  text text not null,
  source_session_id uuid references platform.agent_sessions(id),
  embedding extensions.vector(1536),
  superseded_by uuid references platform.org_memory(id),
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);
create index on platform.org_memory (org_id, created_at desc);

create table platform.usage_events (
  id uuid primary key,
  org_id uuid not null references platform.organizations(id),
  kind text not null,
  quantity bigint not null,
  unit text not null,
  cost_micros bigint not null default 0,
  provider text, model text, run_id uuid, app_id uuid,
  at timestamptz not null default now()
);
create index on platform.usage_events (org_id, at);

-- ---------------------------------------------------------------- connections and secrets
create table platform.secrets (
  id uuid primary key,
  org_id uuid not null references platform.organizations(id),
  purpose text not null,
  ciphertext text not null,
  key_version integer not null default 1,
  created_at timestamptz not null default now()
);

create table platform.mcp_catalog (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{0,47}$'),
  name text not null, vendor text not null, category text not null,
  url text not null, auth text not null default 'bearer',
  description text not null default '',
  status text not null default 'listed' check (status in ('listed','hidden'))
);

create table platform.mcp_connections (
  id uuid primary key,
  org_id uuid not null references platform.organizations(id),
  name text not null,
  catalog_key text references platform.mcp_catalog(key),
  url text not null,
  auth_type text not null default 'bearer' check (auth_type in ('bearer','none')),
  secret_id uuid references platform.secrets(id),
  status text not null default 'connected' check (status in ('connected','needs_approval','error','disconnected')),
  tools jsonb not null default '[]'::jsonb,
  tools_hash text,
  last_synced_at timestamptz,
  checked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (org_id, name)
);

create table platform.mcp_tool_grants (
  org_id uuid not null references platform.organizations(id),
  connection_id uuid not null references platform.mcp_connections(id) on delete cascade,
  consumer_type text not null check (consumer_type in ('app','ask','import')),
  consumer_id text not null,
  tool_name text not null,
  access text not null check (access in ('read','write')),
  confirm boolean not null default false,
  primary key (connection_id, consumer_type, consumer_id, tool_name)
);

create table platform.mcp_calls (
  id uuid primary key,
  org_id uuid not null references platform.organizations(id),
  connection_id uuid not null references platform.mcp_connections(id) on delete cascade,
  consumer text not null,
  tool_name text not null,
  args_summary jsonb not null default '{}'::jsonb,
  status text not null check (status in ('ok','error','denied')),
  duration_ms integer,
  run_id uuid,
  at timestamptz not null default now()
);
create index on platform.mcp_calls (org_id, at);

-- ---------------------------------------------------------------- governance
create table platform.change_sets (
  id uuid primary key,
  org_id uuid not null references platform.organizations(id),
  app_id uuid references platform.apps(id),
  origin text not null check (origin in ('build','publish','settings','connection','share','install','system')),
  run_id uuid,
  actor text not null,
  signals text[] not null default '{}',
  tier text not null check (tier in ('T0','T1','T2','T3')),
  summary text not null,
  owner_summary text not null default '',
  diff jsonb not null default '{}'::jsonb,
  decision text not null check (decision in ('applied','pending_owner','pending_maintainer','approved','rejected')),
  decided_by_staff_id uuid references platform.staff_users(id),
  decided_at timestamptz,
  applied_at timestamptz,
  created_at timestamptz not null default now()
);
create index on platform.change_sets (created_at desc);
create index on platform.change_sets (org_id, created_at desc);

create table platform.change_reviews (
  id uuid primary key,
  change_set_id uuid not null references platform.change_sets(id),
  staff_id uuid not null references platform.staff_users(id),
  decision text not null check (decision in ('approved','rejected')),
  note text,
  at timestamptz not null default now()
);

-- ---------------------------------------------------------------- marketplace
create table platform.listings (
  id uuid primary key,
  source_app_id uuid not null references platform.apps(id),
  -- For our records only. Never selected by anything that serves another restaurant.
  publisher_org_id uuid not null references platform.organizations(id),
  visibility text not null default 'public' check (visibility in ('public','franchise')),
  status text not null default 'draft' check (status in ('draft','in_review','listed','delisted','rejected')),
  title text not null,
  summary text not null,
  category text not null,
  required_models text[] not null default '{}',
  required_connections text[] not null default '{}',
  current_version_id uuid,
  embedding extensions.vector(1536),
  install_count integer not null default 0,
  created_at timestamptz not null default now()
);

create table platform.listing_versions (
  id uuid primary key,
  listing_id uuid not null references platform.listings(id),
  number integer not null,
  bundle_key text not null,
  manifest jsonb not null,
  model_definitions jsonb not null default '[]'::jsonb,
  scan_report jsonb not null default '{}'::jsonb,
  review_status text not null default 'pending' check (review_status in ('pending','approved','rejected')),
  created_at timestamptz not null default now(),
  unique (listing_id, number)
);

create table platform.installs (
  id uuid primary key,
  listing_id uuid not null references platform.listings(id),
  listing_version_id uuid not null references platform.listing_versions(id),
  org_id uuid not null references platform.organizations(id),
  app_id uuid not null references platform.apps(id),
  model_mapping jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (listing_id, org_id)
);

create table platform.org_recommendations (
  org_id uuid not null references platform.organizations(id),
  listing_id uuid not null references platform.listings(id),
  score real not null,
  reasons text[] not null,
  computed_at timestamptz not null default now(),
  primary key (org_id, listing_id)
);

-- What other restaurants may see of a listing. No publisher column, by construction.
create view platform.public_listings as
  select l.id, l.title, l.summary, l.category, l.required_models, l.required_connections,
         l.install_count, l.current_version_id, l.embedding
  from platform.listings l
  where l.status = 'listed' and l.visibility = 'public';

-- ---------------------------------------------------------------- operations
create table platform.audit_log (
  id uuid primary key,
  org_id uuid not null references platform.organizations(id),
  actor text not null,
  action text not null check (action ~ '^[a-z_]+\.[a-z_]+$'),
  target_type text not null,
  target_id text,
  meta jsonb not null default '{}'::jsonb,
  request_id text,
  at timestamptz not null default now()
);
create index on platform.audit_log (org_id, at desc);
create index on platform.audit_log (at desc);

create table platform.outbox (
  id bigint generated always as identity primary key,
  topic text not null,
  org_id uuid not null references platform.organizations(id),
  change_set_id uuid,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending','sent','failed')),
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index on platform.outbox (status, id);

create table platform.notifications (
  id uuid primary key,
  audience text not null check (audience in ('owner','maintainer')),
  org_id uuid not null references platform.organizations(id),
  change_set_id uuid references platform.change_sets(id),
  kind text not null,
  title text not null,
  body text not null default '',
  severity text not null default 'info' check (severity in ('info','attention','urgent')),
  read_at timestamptz,
  created_at timestamptz not null default now()
);

-- Batch idempotency. Scoped to the caller, never global.
create table platform.idempotency_keys (
  org_id uuid not null references platform.organizations(id),
  app_id uuid not null,
  env text not null check (env in ('live','draft')),
  user_id uuid not null,
  key text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (org_id, app_id, env, user_id, key)
);

-- ---------------------------------------------------------------- grants and row-level security
-- rms_admin: everything in platform. rms_api: only its own org's rows, enforced by the database.
grant select, insert, update, delete on all tables in schema platform to rms_admin;
grant usage on all sequences in schema platform to rms_admin, rms_api;

do $$
declare
  t record;
  shared_read text[] := array['model_templates','model_template_versions','named_queries','named_actions','mcp_catalog'];
  append_only text[] := array['audit_log','agent_events','outbox','usage_events','mcp_calls'];
  admin_only  text[] := array['staff_users','change_reviews','listing_versions','secrets'];
begin
  for t in select c.relname as name,
                  exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped) as has_org
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'platform' and c.relkind = 'r'
  loop
    execute format('alter table platform.%I enable row level security', t.name);
    execute format('create policy admin_all on platform.%I for all to rms_admin using (true) with check (true)', t.name);

    if t.name = any (admin_only) then
      continue;
    elsif t.name = any (shared_read) then
      execute format('grant select on platform.%I to rms_api', t.name);
      execute format('create policy api_read on platform.%I for select to rms_api using (true)', t.name);
    elsif t.name = 'organizations' then
      execute 'grant select, update on platform.organizations to rms_api';
      execute 'create policy api_own on platform.organizations for all to rms_api using (id = rms.current_org()) with check (id = rms.current_org())';
    elsif t.name = 'listings' then
      execute 'grant select, insert, update on platform.listings to rms_api';
      execute 'create policy api_own on platform.listings for all to rms_api using (publisher_org_id = rms.current_org()) with check (publisher_org_id = rms.current_org())';
    elsif t.has_org then
      if t.name = any (append_only) then
        execute format('grant select, insert on platform.%I to rms_api', t.name);
      else
        execute format('grant select, insert, update, delete on platform.%I to rms_api', t.name);
      end if;
      execute format('create policy api_own on platform.%I for all to rms_api using (org_id = rms.current_org()) with check (org_id = rms.current_org())', t.name);
    end if;
  end loop;
end $$;

-- Parent data source of truth: rms_api may read its own org's rows, never write them.
revoke insert, update, delete on
  platform.restaurant_profiles, platform.parent_jobs, platform.parent_staff, platform.parent_menu_categories,
  platform.parent_menu_items, platform.parent_menu_modifiers, platform.parent_tax_rates, platform.parent_licences,
  platform.parent_equipment, platform.parent_sync_state, platform.locations, platform.members, platform.member_locations
from rms_api;

-- Governance decisions and recommendations are made by maintainers and jobs, not by a restaurant.
revoke update, delete on platform.change_sets from rms_api;
revoke insert, update, delete on platform.org_recommendations, platform.org_models, platform.org_model_changes from rms_api;

-- Listed public listings, without the publisher. The view runs as its owner, so it is the only
-- way a restaurant can see a listing it did not make.
grant select on platform.public_listings to rms_api, rms_admin;

-- Lets a signed-in user find their own membership before an org context exists.
create or replace function platform.memberships_for(p_user uuid)
returns table (org_id uuid, member_id uuid, role text, store_prefix text, org_name text, store_ready boolean)
language sql stable security definer set search_path = '' as $$
  select m.org_id, m.id, m.role, o.store_prefix, o.name, o.store_ready
  from platform.members m join platform.organizations o on o.id = m.org_id
  where m.user_id = p_user and m.status = 'active' and o.status = 'active'
$$;
revoke all on function platform.memberships_for(uuid) from public;
grant execute on function platform.memberships_for(uuid) to rms_api, rms_admin;

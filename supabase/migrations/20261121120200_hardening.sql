-- Hardening after the security review of the database layer (2026-11-21). Lead-owned.
-- See docs/adr/0004-database-hardening.md for what each part closes and what stays open.

-- ------------------------------------------------------------------ 1. no temp tables for restaurant roles
do $$
begin
  execute format('revoke temporary on database %I from public', current_database());
  execute format('grant temporary on database %I to postgres, rms_admin', current_database());
end $$;

-- ------------------------------------------------------------------ 2. rows can only point at rows of the same restaurant
-- A plain foreign key on `id` lets org A point at org B's row (and tells A the id exists).
-- Every such link is now also checked on (org_id, id).
do $$
declare
  p text;
  l record;
begin
  foreach p in array array['locations','members','apps','app_versions','sandboxes','agent_sessions','agent_runs',
                           'secrets','mcp_connections','change_sets','org_models','parent_jobs',
                           'parent_menu_categories','parent_menu_items']
  loop
    execute format('alter table platform.%I add constraint %I unique (org_id, id)', p, p || '_org_id_id_key');
  end loop;

  for l in
    select * from (values
      ('member_locations',       'member_id',         'members',                'org_id'),
      ('member_locations',       'location_id',       'locations',              'org_id'),
      ('app_versions',           'app_id',            'apps',                   'org_id'),
      ('app_models',             'app_id',            'apps',                   'org_id'),
      ('app_profiles',           'app_id',            'apps',                   'org_id'),
      ('app_slots',              'app_id',            'apps',                   'org_id'),
      ('deployments',            'app_id',            'apps',                   'org_id'),
      ('deployments',            'version_id',        'app_versions',           'org_id'),
      ('sandboxes',              'app_id',            'apps',                   'org_id'),
      ('agent_sessions',         'app_id',            'apps',                   'org_id'),
      ('agent_runs',             'session_id',        'agent_sessions',         'org_id'),
      ('agent_runs',             'sandbox_id',        'sandboxes',              'org_id'),
      ('agent_events',           'run_id',            'agent_runs',             'org_id'),
      ('agent_events',           'session_id',        'agent_sessions',         'org_id'),
      ('org_memory',             'source_session_id', 'agent_sessions',         'org_id'),
      ('mcp_connections',        'secret_id',         'secrets',                'org_id'),
      ('mcp_tool_grants',        'connection_id',     'mcp_connections',        'org_id'),
      ('mcp_calls',              'connection_id',     'mcp_connections',        'org_id'),
      ('change_sets',            'app_id',            'apps',                   'org_id'),
      ('notifications',          'change_set_id',     'change_sets',            'org_id'),
      ('org_model_changes',      'org_model_id',      'org_models',             'org_id'),
      ('installs',               'app_id',            'apps',                   'org_id'),
      ('listings',               'source_app_id',     'apps',                   'publisher_org_id'),
      ('parent_staff',           'location_id',       'locations',              'org_id'),
      ('parent_staff',           'job_id',            'parent_jobs',            'org_id'),
      ('parent_menu_items',      'category_id',       'parent_menu_categories', 'org_id'),
      ('parent_menu_modifiers',  'item_id',           'parent_menu_items',      'org_id'),
      ('parent_tax_rates',       'location_id',       'locations',              'org_id'),
      ('parent_licences',        'location_id',       'locations',              'org_id'),
      ('parent_equipment',       'location_id',       'locations',              'org_id')
    ) as t(child, col, parent, org_col)
  loop
    execute format(
      'alter table platform.%I add constraint %I foreign key (%I, %I) references platform.%I (org_id, id) on delete cascade',
      l.child, l.child || '_' || l.col || '_same_org_fkey', l.org_col, l.col, l.parent);
  end loop;
end $$;

-- ------------------------------------------------------------------ 3. a restaurant cannot write its own governance fields
-- rms_api keeps row access to its own org, but only the columns a restaurant may change.
revoke update on platform.organizations from rms_api;
grant update (name, brand_colour, logo_url) on platform.organizations to rms_api;

revoke insert, update, delete on platform.listings from rms_api;
grant insert (id, source_app_id, publisher_org_id, visibility, title, summary, category, required_models, required_connections)
  on platform.listings to rms_api;
grant update (title, summary, category) on platform.listings to rms_api;

revoke update, delete on platform.apps from rms_api;
grant update (name, current_version_id) on platform.apps to rms_api;

revoke update, delete on platform.app_versions from rms_api;
grant update (manifest, source_key, bundle_key, checks, ui_version, summary, run_id) on platform.app_versions to rms_api;

-- Publishing, installing, deploying and deciding are done by the platform (rms_admin) after its checks.
revoke insert, update, delete on platform.deployments, platform.installs, platform.notifications from rms_api;
grant update (read_at) on platform.notifications to rms_api;

create policy api_new_app_is_draft on platform.apps as restrictive for insert to rms_api
  with check (status = 'draft' and published_version_id is null and listing_id is null);

create policy api_new_version_is_draft on platform.app_versions as restrictive for insert to rms_api
  with check (status = 'draft');

create policy api_new_listing_is_draft on platform.listings as restrictive for insert to rms_api
  with check (status = 'draft' and install_count = 0 and current_version_id is null);

-- A restaurant can record a change, but only with the decision its tier allows, and never decided.
create policy api_new_change_is_undecided on platform.change_sets as restrictive for insert to rms_api
  with check (
    decided_by_staff_id is null and decided_at is null
    and ((tier in ('T0','T1') and decision = 'applied')
      or (tier = 'T2' and decision = 'pending_owner')
      or (tier = 'T3' and decision = 'pending_maintainer'))
  );

-- ------------------------------------------------------------------ 4. public listings: no leak through a cheap function
drop view platform.public_listings;
create view platform.public_listings with (security_barrier = true) as
  select l.id, l.title, l.summary, l.category, l.required_models, l.required_connections,
         l.install_count, l.current_version_id
  from platform.listings l
  where l.status = 'listed' and l.visibility = 'public';
grant select on platform.public_listings to rms_api, rms_admin;

-- ------------------------------------------------------------------ 5. store provisioning: draft role cannot read real pay or contact details
create or replace function platform.provision_store(p_org uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_prefix text;
  v_parent text;
  v_live   text;
  v_draft  text;
  v_rw     text;
  v_drw    text;
  v_ask    text;
  m record;
begin
  select store_prefix into v_prefix from platform.organizations where id = p_org;
  if v_prefix is null then
    raise exception 'Unknown organization';
  end if;
  if v_prefix !~ '^o_[0-9a-f]{12}$' then
    raise exception 'Bad store prefix';
  end if;

  v_parent := v_prefix || '_parent';
  v_live   := v_prefix;
  v_draft  := v_prefix || '_draft';
  v_rw     := v_prefix || '_rw';
  v_drw    := v_prefix || '_draft_rw';
  v_ask    := v_prefix || '_ask';

  if not exists (select 1 from pg_catalog.pg_roles where rolname = v_rw) then
    execute format('create role %I nologin', v_rw);
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = v_drw) then
    execute format('create role %I nologin', v_drw);
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = v_ask) then
    execute format('create role %I nologin connection limit 5', v_ask);
  end if;
  execute format('grant rms_tenant to %I, %I, %I', v_rw, v_drw, v_ask);
  execute format('grant %I, %I to rms_api with inherit false, set true', v_rw, v_drw);
  execute format('grant %I, %I to rms_admin with inherit false, set true', v_rw, v_drw);

  execute format('create schema if not exists %I', v_parent);
  execute format('create schema if not exists %I', v_live);
  execute format('create schema if not exists %I', v_draft);
  execute format('revoke all on schema %I, %I, %I from public', v_parent, v_live, v_draft);

  execute format('grant usage on schema %I to %I, %I, %I, rms_parent_sync, rms_tenant_migrator', v_parent, v_rw, v_drw, v_ask);
  execute format('grant usage on schema %I to %I, %I', v_live, v_rw, v_ask);
  execute format('grant usage on schema %I to %I', v_draft, v_drw);
  execute format('grant usage, create on schema %I, %I to rms_tenant_migrator', v_live, v_draft);

  for m in
    select * from (values
      ('profile',         'restaurant_profiles'),
      ('locations',       'locations'),
      ('jobs',            'parent_jobs'),
      ('staff',           'parent_staff'),
      ('menu_categories', 'parent_menu_categories'),
      ('menu_items',      'parent_menu_items'),
      ('menu_modifiers',  'parent_menu_modifiers'),
      ('tax_rates',       'parent_tax_rates'),
      ('licences',        'parent_licences'),
      ('equipment',       'parent_equipment')
    ) as t(parent_table, source_table)
  loop
    if to_regclass(format('%I.%I', v_parent, m.parent_table)) is null then
      execute format('create table %I.%I (like platform.%I including defaults)', v_parent, m.parent_table, m.source_table);
      execute format('alter table %I.%I drop column org_id', v_parent, m.parent_table);
      execute format('alter table %I.%I add primary key (id)', v_parent, m.parent_table);
    end if;
    execute format('revoke all on %I.%I from public', v_parent, m.parent_table);
    execute format('revoke all on %I.%I from %I, %I, %I', v_parent, m.parent_table, v_rw, v_drw, v_ask);
    execute format('grant select on %I.%I to %I, %I', v_parent, m.parent_table, v_rw, v_ask);
    if m.parent_table = 'staff' then
      -- Builds and previews run in draft. They see who works here and in which job,
      -- never real pay or contact details.
      execute format('grant select (id, location_id, full_name, job_id, currency, started_on, status, updated_at) on %I.%I to %I',
                     v_parent, m.parent_table, v_drw);
    else
      execute format('grant select on %I.%I to %I', v_parent, m.parent_table, v_drw);
    end if;
    execute format('grant select, insert, update, delete, truncate on %I.%I to rms_parent_sync', v_parent, m.parent_table);
  end loop;

  update platform.organizations set store_ready = true where id = p_org;
  return v_prefix;
end $$;

-- ------------------------------------------------------------------ 6. the Ask login: short-lived, and the password never reaches the database in the clear
-- The server makes a random password per Ask session, computes the SCRAM verifier itself and
-- passes only the verifier. The login stops working after 15 minutes. The role cannot extend
-- that itself. The limits set here are defaults a session could undo, so the Ask tool ALSO
-- wraps every query (see askQuery in @rms/db): read-only transaction, reset all, local timeout,
-- one statement, rollback.
drop function platform.set_ask_login(uuid, text);
create function platform.set_ask_login(p_org uuid, p_verifier text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_prefix text;
  v_role   text;
begin
  select store_prefix into v_prefix from platform.organizations where id = p_org and store_ready and status = 'active';
  if v_prefix is null or v_prefix !~ '^o_[0-9a-f]{12}$' then
    raise exception 'Store is not ready';
  end if;
  if p_verifier !~ '^SCRAM-SHA-256\$[0-9]{4,6}:[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*$' then
    raise exception 'Not a SCRAM verifier';
  end if;
  v_role := v_prefix || '_ask';
  execute format('alter role %I login password %L valid until %L', v_role, p_verifier, (now() + interval '15 minutes')::text);
  execute format('alter role %I set default_transaction_read_only = on', v_role);
  execute format('alter role %I set statement_timeout = %L', v_role, '5s');
  execute format('alter role %I set idle_in_transaction_session_timeout = %L', v_role, '10s');
  execute format('alter role %I set search_path = %I, %I', v_role, v_prefix, v_prefix || '_parent');
  return v_role;
end $$;
revoke all on function platform.set_ask_login(uuid, text) from public;
grant execute on function platform.set_ask_login(uuid, text) to rms_admin;

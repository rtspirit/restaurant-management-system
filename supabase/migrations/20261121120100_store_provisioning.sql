-- Store provisioning: the ONE place that creates a restaurant's schemas, roles and grants.
-- Owned by the lead. Parent data (task B) and the model compiler (task C) both build on it.
--
-- For a restaurant with store prefix o_<id> this creates:
--
--   schema o_<id>_parent   read-only copy of parent data. Written only by rms_parent_sync.
--   schema o_<id>          live child data. Tables are created only by rms_tenant_migrator.
--   schema o_<id>_draft    same tables, sample data, for builds and previews.
--
--   role o_<id>_rw         NOLOGIN. Data API, published mini-apps. Reads parent.
--   role o_<id>_draft_rw   NOLOGIN. Data API, previews. Reads parent. No access to live.
--   role o_<id>_ask        Ask agent's query login. Reads live and parent. Nothing else, anywhere.
--                          NOLOGIN until platform.set_ask_login() gives it a password.
--
-- Contract for the model compiler (it runs its SQL as rms_tenant_migrator, which owns the tables it creates):
--   * live table:   grant select to o_<id>_ask; grant select, insert, update, delete to o_<id>_rw
--                   (append-only models: select, insert only. No update, delete or truncate, ever.)
--   * draft table:  grant select, insert, update, delete to o_<id>_draft_rw (append-only: select, insert)
--   * never grant anything to PUBLIC, rms_tenant, or any other restaurant's role
--   * location-scoped tables: enable row level security, with a policy using rms.location_ok(location_id)
--     for both USING and WITH CHECK
--   * no restaurant role ever gets CREATE on a schema. Structure changes only through org_model_changes.

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

  -- Roles. NOINHERIT is not needed on these: they are members of rms_tenant only.
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

  -- Server logins may switch INTO the two Data API roles. They never inherit them.
  -- Nobody may switch into the ask role: it is only ever used by logging in as it.
  execute format('grant %I, %I to rms_api with inherit false, set true', v_rw, v_drw);
  execute format('grant %I, %I to rms_admin with inherit false, set true', v_rw, v_drw);

  -- Schemas.
  execute format('create schema if not exists %I', v_parent);
  execute format('create schema if not exists %I', v_live);
  execute format('create schema if not exists %I', v_draft);
  execute format('revoke all on schema %I, %I, %I from public', v_parent, v_live, v_draft);

  execute format('grant usage on schema %I to %I, %I, %I, rms_parent_sync, rms_tenant_migrator', v_parent, v_rw, v_drw, v_ask);
  execute format('grant usage on schema %I to %I, %I', v_live, v_rw, v_ask);
  execute format('grant usage on schema %I to %I', v_draft, v_drw);
  execute format('grant usage, create on schema %I, %I to rms_tenant_migrator', v_live, v_draft);

  -- Parent tables: same columns as the platform source of truth, minus org_id.
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
    -- Read for the restaurant. Write for the sync job only.
    execute format('revoke all on %I.%I from public', v_parent, m.parent_table);
    execute format('grant select on %I.%I to %I, %I, %I', v_parent, m.parent_table, v_rw, v_drw, v_ask);
    execute format('grant select, insert, update, delete, truncate on %I.%I to rms_parent_sync', v_parent, m.parent_table);
  end loop;

  update platform.organizations set store_ready = true where id = p_org;
  return v_prefix;
end $$;

-- Gives the Ask login a password so the query tool can connect as it. The password is made by
-- server code, stored encrypted in platform.secrets, and never written to git or logs.
create or replace function platform.set_ask_login(p_org uuid, p_password text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_prefix text;
begin
  select store_prefix into v_prefix from platform.organizations where id = p_org and store_ready;
  if v_prefix is null or v_prefix !~ '^o_[0-9a-f]{12}$' then
    raise exception 'Store is not ready';
  end if;
  if length(p_password) < 32 then
    raise exception 'Password too short';
  end if;
  execute format('alter role %I login password %L', v_prefix || '_ask', p_password);
  -- Read-only by default, short statements, no way to wander.
  execute format('alter role %I set default_transaction_read_only = on', v_prefix || '_ask');
  execute format('alter role %I set statement_timeout = %L', v_prefix || '_ask', '5s');
  execute format('alter role %I set idle_in_transaction_session_timeout = %L', v_prefix || '_ask', '10s');
  execute format('alter role %I set search_path = %I, %I', v_prefix || '_ask', v_prefix, v_prefix || '_parent');
end $$;

-- Removes a restaurant's store completely. Used by the demo reset script only.
create or replace function platform.drop_store(p_org uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_prefix text;
  r text;
begin
  select store_prefix into v_prefix from platform.organizations where id = p_org;
  if v_prefix is null or v_prefix !~ '^o_[0-9a-f]{12}$' then
    raise exception 'Unknown organization';
  end if;
  execute format('drop schema if exists %I cascade', v_prefix || '_parent');
  execute format('drop schema if exists %I cascade', v_prefix || '_draft');
  execute format('drop schema if exists %I cascade', v_prefix);
  foreach r in array array[v_prefix || '_rw', v_prefix || '_draft_rw', v_prefix || '_ask'] loop
    -- The schemas are gone, so the role holds no privileges. Dropping it also drops its memberships.
    if exists (select 1 from pg_catalog.pg_roles where rolname = r) then
      execute format('drop role %I', r);
    end if;
  end loop;
  update platform.organizations set store_ready = false where id = p_org;
end $$;

revoke all on function platform.provision_store(uuid) from public;
revoke all on function platform.set_ask_login(uuid, text) from public;
revoke all on function platform.drop_store(uuid) from public;
grant execute on function platform.provision_store(uuid) to rms_admin;
grant execute on function platform.set_ask_login(uuid, text) to rms_admin;
grant execute on function platform.drop_store(uuid) to rms_admin;

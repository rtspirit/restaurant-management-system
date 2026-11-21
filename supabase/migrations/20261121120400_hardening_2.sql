-- Hardening after the Wave 1 attack suite (task G). Lead-owned.

-- 1. A restaurant's login may change a version or a listing only while it is a draft.
--    (It could rewrite a published version's manifest and bundle, and reword a listed listing.)
create policy api_update_draft_versions_only on platform.app_versions as restrictive for update to rms_api
  using (status = 'draft') with check (status = 'draft');
create policy api_update_draft_listings_only on platform.listings as restrictive for update to rms_api
  using (status = 'draft') with check (status = 'draft');

-- 2. Two more links that must stay inside one restaurant.
alter table platform.org_memory add constraint org_memory_org_id_id_key unique (org_id, id);
alter table platform.app_versions add constraint app_versions_parent_version_id_same_org_fkey
  foreign key (org_id, parent_version_id) references platform.app_versions (org_id, id);
alter table platform.org_memory add constraint org_memory_superseded_by_same_org_fkey
  foreign key (org_id, superseded_by) references platform.org_memory (org_id, id);

-- 3. Removing a store must work even if one of its roles left objects behind (a store role
--    could create a large object, and the role then could not be dropped, which would have
--    stopped the demo reset). The function's owner joins the role just long enough to remove
--    whatever it owns.
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
    if exists (select 1 from pg_catalog.pg_roles where rolname = r) then
      execute format('grant %I to %I', r, current_user);
      execute format('drop owned by %I', r);
      execute format('drop role %I', r);
    end if;
  end loop;
  update platform.organizations set store_ready = false where id = p_org;
end $$;
revoke all on function platform.drop_store(uuid) from public;
grant execute on function platform.drop_store(uuid) to rms_admin;

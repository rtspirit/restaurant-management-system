-- Governance checks in the database. Lead-owned.
-- Found in review of task F: the policy tied tier to decision but not to signals, so a row could
-- claim any tier. Now the database derives the tier from the signals itself.
-- The mapping below MUST match SIGNAL_TIER in packages/contracts/src/governance.ts.
-- packages/db has a test that compares the two.

create or replace function platform.tier_for_signals(p_signals text[]) returns text
language plpgsql immutable set search_path = '' as $$
declare
  s text;
  t text;
  top text := 'T0';
begin
  foreach s in array coalesce(p_signals, '{}') loop
    t := case s
      when 'theme_change' then 'T0'
      when 'screen_change' then 'T1'
      when 'new_model' then 'T1'
      when 'new_optional_field' then 'T1'
      when 'new_index' then 'T1'
      when 'new_required_field' then 'T2'
      when 'new_unique_rule' then 'T2'
      when 'new_connection' then 'T2'
      when 'new_write_access' then 'T2'
      when 'new_action' then 'T2'
      when 'new_job' then 'T2'
      when 'role_change' then 'T2'
      when 'first_publish' then 'T2'
      when 'touches_payroll_or_financial' then 'T2'
      when 'public_share' then 'T3'
      when 'new_dependency' then 'T3'
      when 'security_check_blocked' then 'T3'
      else null
    end;
    if t is null then
      raise exception 'Unknown change signal' using errcode = '23514';
    end if;
    if t > top then
      top := t;
    end if;
  end loop;
  return top;
end $$;

revoke all on function platform.tier_for_signals(text[]) from public;
grant execute on function platform.tier_for_signals(text[]) to rms_api, rms_admin;

-- Remove rows that could not be valid (only test fixtures can exist at this point).
delete from platform.change_reviews r using platform.change_sets c
  where r.change_set_id = c.id and c.tier is distinct from platform.tier_for_signals(c.signals);
delete from platform.notifications n using platform.change_sets c
  where n.change_set_id = c.id and c.tier is distinct from platform.tier_for_signals(c.signals);
delete from platform.change_sets c where c.tier is distinct from platform.tier_for_signals(c.signals);

alter table platform.change_sets
  add constraint change_sets_tier_matches_signals check (tier = platform.tier_for_signals(signals));

-- Demo: one person belongs to one restaurant. A second active membership cannot be created,
-- whatever the application does.
create unique index members_one_active_per_user on platform.members (user_id) where status = 'active';

-- ------------------------------------------------------------------ what a restaurant's login may read back
-- Found in the security review of task F: maintainer words (tier codes, signal names, which
-- maintainer decided) were readable by the restaurant-facing login for its own org.

-- Maintainer notifications are for maintainers.
create policy api_owner_notifications_only on platform.notifications as restrictive for select to rms_api
  using (audience = 'owner');

-- The outbox is write-only for a restaurant.
revoke select on platform.outbox from rms_api;

-- A restaurant sees its changes in owner words only: no tier, signals, maintainer summary or staff id.
revoke select on platform.change_sets from rms_api;
grant select (id, org_id, app_id, origin, run_id, owner_summary, decision, created_at, decided_at, applied_at)
  on platform.change_sets to rms_api;

-- ------------------------------------------------------------------ onboarding without holding a connection
-- Found in the security review of task A: holding a pooled connection for a per-user lock let
-- ten sign-ups at once freeze the platform login. A claim row needs no held connection.
create table platform.onboarding_claims (
  user_id     uuid primary key,
  claimed_at  timestamptz not null default now()
);
alter table platform.onboarding_claims enable row level security;
create policy admin_all on platform.onboarding_claims for all to rms_admin using (true) with check (true);
grant select, insert, update, delete on platform.onboarding_claims to rms_admin;

-- Takes the claim for a user. Returns true when this caller now holds it. A claim older than
-- two minutes is treated as abandoned and taken over.
create or replace function platform.claim_onboarding(p_user uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  got uuid;
begin
  insert into platform.onboarding_claims as c (user_id) values (p_user)
  on conflict (user_id) do update set claimed_at = now()
    where c.claimed_at < now() - interval '2 minutes'
  returning c.user_id into got;
  return got is not null;
end $$;

create or replace function platform.release_onboarding(p_user uuid) returns void
language sql security definer set search_path = '' as $$
  delete from platform.onboarding_claims where user_id = p_user
$$;

-- True when the sign-in user still exists (a deleted user's token can stay valid for a while).
create or replace function platform.user_exists(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from auth.users u where u.id = p_user and u.deleted_at is null)
$$;

-- How many restaurants exist (for a simple cap on open sign-up).
create or replace function platform.restaurant_count() returns integer
language sql stable security definer set search_path = '' as $$
  select count(*)::int from platform.organizations
$$;

revoke all on function platform.claim_onboarding(uuid), platform.release_onboarding(uuid),
  platform.user_exists(uuid), platform.restaurant_count() from public;
grant execute on function platform.claim_onboarding(uuid), platform.release_onboarding(uuid),
  platform.user_exists(uuid), platform.restaurant_count() to rms_admin;

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

-- Wave 2: the few things the agent, build and memory tasks cannot work without. Lead-owned.
--
-- Everything else Wave 2 needs is already there (agent_sessions, agent_runs, agent_events,
-- sandboxes, mcp_*, secrets, app_profiles, org_memory, usage_events, apps, app_versions).
-- Checked and NOT added:
--   * a vector index on app_profiles. A duplicate check only ever compares a request with one
--     restaurant's own handful of mini-apps (row-level security by org), so an exact scan is
--     right, and rms_api can already use the distance operator: operator(extensions.<=>).
--   * the Demo POS catalog row. That is seed data: task L upserts it from code.
--
-- No new table, so nothing new to fence. The tables changed here already have row-level
-- security with the admin_all and api_own policies from the first migration, the same-org
-- composite foreign keys from hardening, and table-level grants that cover a new column.
-- None of the new columns is a governance field: they hold run bookkeeping and the owner's
-- own words.

-- ------------------------------------------------------------------ 1. events are numbered across a whole session
-- The browser resumes a conversation of many runs with ONE number (?after=<seq>). (run_id, seq)
-- is already the primary key. This makes (session_id, seq) unique too, so two requests moving
-- the same session along can never both store event number N, and it serves the replay query.
create unique index agent_events_session_seq_key on platform.agent_events (session_id, seq);
alter table platform.agent_events add constraint agent_events_seq_positive check (seq >= 1);

-- ------------------------------------------------------------------ 2. moving a run along from short requests
-- (One run at a time in a session is kept by the runner, which locks the session row before it
-- starts a run. A unique index for it was tried and taken out: the isolation suite inserts
-- several running runs into one session to test the same-restaurant links.)
-- A Vercel function stops after 300 seconds, so a run is moved along by whichever request is
-- reading its event stream. Only one may do so at a time:
--   lease_owner, lease_until   who is moving the run along, and until when. Taken and renewed
--                              with one conditional UPDATE. An expired lease can be taken over.
--   driver_cursor              how many lines of the agent's event file (inside the sandbox)
--                              have been turned into stored events. Advanced in the SAME
--                              transaction as the event inserts, so a request that dies
--                              half-way never stores an event twice.
--   driver_state               what is needed to find the turn again from another request
--                              (the command id, the event file, token totals so far). Never a
--                              key, a token or a password.
alter table platform.agent_runs
  add column lease_owner text,
  add column lease_until timestamptz,
  add column driver_cursor integer not null default 0 check (driver_cursor >= 0),
  add column driver_state jsonb not null default '{}'::jsonb;

-- ------------------------------------------------------------------ 3. what the owner asked for, kept with the mini-app's profile
-- "You already have this" must hold when the owner types the very same request again, whatever
-- an embedding model makes of it. The requests are kept in the owner's own words, newest last,
-- and compared word for word (after tidying) before the embedding is compared.
alter table platform.app_profiles add column requests text[] not null default '{}';
alter table platform.app_profiles add constraint app_profiles_requests_bounded check (coalesce(array_length(requests, 1), 0) <= 10);

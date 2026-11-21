#!/usr/bin/env bash
set -u
# Settings come from ./.env.local, or from RMS_ENV_FILE (a git worktree has no .env.local of its own).
set -a; . "${RMS_ENV_FILE:-./.env.local}"; set +a
A=0193a3c0-0000-7000-8000-00000000000a; B=0193a3c0-0000-7000-8000-00000000000b
ASKPW="$(openssl rand -hex 24)"
ASKVER="$(node -e 'const c=require("node:crypto");const pw=process.argv[1];const salt=c.randomBytes(16);const s=c.pbkdf2Sync(pw,salt,4096,32,"sha256");const ck=c.createHmac("sha256",s).update("Client Key").digest();const sk=c.createHash("sha256").update(ck).digest();const sv=c.createHmac("sha256",s).update("Server Key").digest();process.stdout.write("SCRAM-SHA-256$4096:"+salt.toString("base64")+"$"+sk.toString("base64")+":"+sv.toString("base64"))' "$ASKPW")"
q() { psql -X -q -t -A "$1" -c "$2" 2>&1 | tr '\n' ' ' | cut -c1-100; }
last() { psql -X -q -t -A "$1" -c "$2" 2>&1 | grep -v -E "^(BEGIN|COMMIT|SET)?$" | tail -1 | tr -d ' '; }
fails=0
run() { local label="$1" want="$2" url="$3" sql="$4" out got
  out="$(q "$url" "$sql")"
  if echo "$out" | grep -q -i -E "error|fatal"; then got=blocked; else got=allowed; fi
  [ "$got" = "$want" ] && s=PASS || { s=FAIL; fails=$((fails+1)); }
  printf '%s  %-52s [%s] %s\n' "$s" "$label" "$got" "$out"; }
expect() { local label="$1" want="$2" url="$3" sql="$4" out
  out="$(last "$url" "$sql")"
  [ "$out" = "$want" ] && s=PASS || { s=FAIL; fails=$((fails+1)); }
  printf '%s  %-52s got "%s" want "%s"\n' "$s" "$label" "$out" "$want"; }
echo "setup: $(q "$DATABASE_ADMIN_URL" "insert into platform.organizations (id, slug, name, store_prefix) values ('$A','smoke-a','Smoke A','o_aaaaaaaaaaaa'), ('$B','smoke-b','Smoke B','o_bbbbbbbbbbbb') on conflict do nothing; select platform.provision_store('$A'); select platform.provision_store('$B'); select platform.set_ask_login('$A', '$ASKVER'); insert into platform.parent_jobs (id, org_id, name, house) values (gen_random_uuid(), '$A', 'Server', 'front'); set role rms_tenant_migrator; create table o_aaaaaaaaaaaa.notes (id int); grant select on o_aaaaaaaaaaaa.notes to o_aaaaaaaaaaaa_ask; grant select, insert on o_aaaaaaaaaaaa.notes to o_aaaaaaaaaaaa_rw; reset role; set role rms_parent_sync; insert into o_aaaaaaaaaaaa_parent.jobs (id, name, house) values (gen_random_uuid(), 'Server', 'front'); insert into o_bbbbbbbbbbbb_parent.jobs (id, name, house) values (gen_random_uuid(), 'Cook', 'back');")"
ASK="postgresql://o_aaaaaaaaaaaa_ask:$ASKPW@127.0.0.1:54322/postgres"
RW="begin; set local role o_aaaaaaaaaaaa_rw;"
echo "--- rms_api: platform rows are fenced by org"
expect "no org set: sees 0 organizations" "0" "$DATABASE_URL" "select count(*) from platform.organizations"
expect "org A set: sees only A" "smoke-a" "$DATABASE_URL" "begin; select set_config('rms.org','$A',true);
select string_agg(slug,',') from platform.organizations; commit"
expect "org A set: update of B touches 0 rows" "0" "$DATABASE_URL" "begin; select set_config('rms.org','$A',true);
with u as (update platform.organizations set name='x' where id='$B' returning 1) select count(*) from u; commit"
expect "org A set: sees its own parent source rows" "1" "$DATABASE_URL" "begin; select set_config('rms.org','$A',true);
select count(*) from platform.parent_jobs; commit"
expect "org B set: sees none of A's parent source rows" "0" "$DATABASE_URL" "begin; select set_config('rms.org','$B',true);
select count(*) from platform.parent_jobs; commit"
run "cannot insert a member" blocked "$DATABASE_URL" "begin; select set_config('rms.org','$A',true); insert into platform.members (id,org_id,user_id,role) values (gen_random_uuid(),'$A',gen_random_uuid(),'owner'); commit"
run "cannot write parent source of truth" blocked "$DATABASE_URL" "begin; select set_config('rms.org','$A',true); insert into platform.parent_jobs (id,org_id,name,house) values (gen_random_uuid(),'$A','x','front'); commit"
run "cannot insert an org-B row while org A is set" blocked "$DATABASE_URL" "begin; select set_config('rms.org','$A',true); insert into platform.org_settings (org_id) values ('$B'); commit"
run "cannot read secrets" blocked "$DATABASE_URL" "select count(*) from platform.secrets"
run "cannot provision a store" blocked "$DATABASE_URL" "select platform.provision_store('$A')"
run "cannot drop a store" blocked "$DATABASE_URL" "select platform.drop_store('$B')"
run "cannot become the migrator" blocked "$DATABASE_URL" "set role rms_tenant_migrator"
run "cannot become the parent sync" blocked "$DATABASE_URL" "set role rms_parent_sync"
run "cannot become the ask role" blocked "$DATABASE_URL" "set role o_aaaaaaaaaaaa_ask"
run "cannot create a table in a live schema" blocked "$DATABASE_URL" "create table o_aaaaaaaaaaaa.x (id int)"
run "cannot read a store without switching role" blocked "$DATABASE_URL" "select count(*) from o_aaaaaaaaaaaa_parent.jobs"
echo "--- rms_api: cannot point at another restaurant's rows or approve itself"
q "$DATABASE_ADMIN_URL" "insert into platform.secrets (id, org_id, purpose, ciphertext) values ('0193a3c0-0000-7000-8000-0000000000b5', '$B', 'smoke', 'x'); insert into platform.apps (id, org_id, slug, number, name) values ('0193a3c0-0000-7000-8000-0000000000b6', '$B', 'smoke-app', 1, 'Smoke app')" >/dev/null
ORGA="begin; select set_config('rms.org','$A',true);"
run "cannot link A's connection to B's secret" blocked "$DATABASE_URL" "$ORGA insert into platform.mcp_connections (id, org_id, name, url, secret_id) values (gen_random_uuid(), '$A', 'x', 'https://example.test', '0193a3c0-0000-7000-8000-0000000000b5'); commit"
run "cannot attach a profile to B's app" blocked "$DATABASE_URL" "$ORGA insert into platform.app_profiles (app_id, org_id, purpose) values ('0193a3c0-0000-7000-8000-0000000000b6', '$A', 'x'); commit"
run "cannot list B's app as its own" blocked "$DATABASE_URL" "$ORGA insert into platform.listings (id, source_app_id, publisher_org_id, title, summary, category) values (gen_random_uuid(), '0193a3c0-0000-7000-8000-0000000000b6', '$A', 't', 's', 'c'); commit"
run "cannot change its own store prefix" blocked "$DATABASE_URL" "$ORGA update platform.organizations set store_prefix = 'o_bbbbbbbbbbbb' where id = '$A'; commit"
run "cannot change its own status or kind" blocked "$DATABASE_URL" "$ORGA update platform.organizations set kind = 'franchisor' where id = '$A'; commit"
run "can change its own brand colour" allowed "$DATABASE_URL" "$ORGA update platform.organizations set brand_colour = '#112233' where id = '$A'; commit"
run "cannot record an already-approved change" blocked "$DATABASE_URL" "$ORGA insert into platform.change_sets (id, org_id, origin, actor, signals, tier, summary, decision) values (gen_random_uuid(), '$A', 'share', 'user:x', '{public_share}', 'T3', 's', 'approved'); commit"
run "cannot record a T3 change as applied" blocked "$DATABASE_URL" "$ORGA insert into platform.change_sets (id, org_id, origin, actor, signals, tier, summary, decision) values (gen_random_uuid(), '$A', 'share', 'user:x', '{public_share}', 'T3', 's', 'applied'); commit"
run "can record a T3 change as waiting" allowed "$DATABASE_URL" "$ORGA insert into platform.change_sets (id, org_id, origin, actor, signals, tier, summary, decision) values (gen_random_uuid(), '$A', 'share', 'user:x', '{public_share}', 'T3', 's', 'pending_maintainer'); rollback"
run "cannot record a public share as a low tier" blocked "$DATABASE_URL" "$ORGA insert into platform.change_sets (id, org_id, origin, actor, signals, tier, summary, decision) values (gen_random_uuid(), '$A', 'share', 'user:x', '{public_share}', 'T0', 's', 'applied'); commit"
run "cannot read back tier or staff id of its changes" blocked "$DATABASE_URL" "$ORGA select tier, signals, decided_by_staff_id from platform.change_sets; commit"
run "can read back its changes in owner words" allowed "$DATABASE_URL" "$ORGA select id, owner_summary, decision from platform.change_sets; commit"
run "cannot read the outbox" blocked "$DATABASE_URL" "$ORGA select count(*) from platform.outbox; commit"
run "cannot insert a maintainer notification" blocked "$DATABASE_URL" "$ORGA insert into platform.notifications (id, audience, org_id, kind, title) values (gen_random_uuid(), 'maintainer', '$A', 'k', 't'); commit"
run "cannot create an app that is already published" blocked "$DATABASE_URL" "$ORGA insert into platform.apps (id, org_id, slug, number, name, status) values (gen_random_uuid(), '$A', 'x', 9, 'x', 'published'); commit"
expect "public listings view has no publisher or embedding" "0" "$DATABASE_ADMIN_URL" "select count(*) from information_schema.columns where table_schema='platform' and table_name='public_listings' and column_name in ('publisher_org_id','embedding')"
expect "nothing of ours in public" "0" "$DATABASE_ADMIN_URL" "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','v','m','S','f')"
echo "--- as restaurant A's Data API role"
expect "reads its own parent data" "1" "$DATABASE_URL" "$RW select count(*) from o_aaaaaaaaaaaa_parent.jobs; commit"
run "cannot insert parent data" blocked "$DATABASE_URL" "$RW insert into o_aaaaaaaaaaaa_parent.jobs (id,name,house) values (gen_random_uuid(),'x','front'); commit"
run "cannot update parent data" blocked "$DATABASE_URL" "$RW update o_aaaaaaaaaaaa_parent.jobs set name='x'; commit"
run "cannot delete parent data" blocked "$DATABASE_URL" "$RW delete from o_aaaaaaaaaaaa_parent.jobs; commit"
run "cannot truncate parent data" blocked "$DATABASE_URL" "$RW truncate o_aaaaaaaaaaaa_parent.jobs; commit"
run "cannot alter a parent table" blocked "$DATABASE_URL" "$RW alter table o_aaaaaaaaaaaa_parent.jobs add column x int; commit"
run "cannot read B's parent data" blocked "$DATABASE_URL" "$RW select count(*) from o_bbbbbbbbbbbb_parent.jobs; commit"
run "cannot read the platform schema" blocked "$DATABASE_URL" "$RW select count(*) from platform.organizations; commit"
run "cannot call platform functions" blocked "$DATABASE_URL" "$RW select * from platform.memberships_for(gen_random_uuid()); commit"
run "cannot read auth users" blocked "$DATABASE_URL" "$RW select count(*) from auth.users; commit"
run "cannot create a table in its own schema" blocked "$DATABASE_URL" "$RW create table o_aaaaaaaaaaaa.x (id int); commit"
run "cannot create a table in public" blocked "$DATABASE_URL" "$RW create table public.x (id int); commit"
run "KNOWN LIMIT (ADR 0003): server login can switch to B's role" allowed "$DATABASE_URL" "$RW set local role o_bbbbbbbbbbbb_rw; commit"
run "cannot switch to the migrator" blocked "$DATABASE_URL" "$RW set local role rms_tenant_migrator; commit"
run "draft role cannot read a live table" blocked "$DATABASE_URL" "begin; set local role o_aaaaaaaaaaaa_draft_rw; select count(*) from o_aaaaaaaaaaaa.notes; commit"
run "draft role cannot read real staff pay" blocked "$DATABASE_URL" "begin; set local role o_aaaaaaaaaaaa_draft_rw; select hourly_rate_minor from o_aaaaaaaaaaaa_parent.staff; commit"
expect "draft role can read staff names" "0" "$DATABASE_URL" "begin; set local role o_aaaaaaaaaaaa_draft_rw; select count(full_name) from o_aaaaaaaaaaaa_parent.staff; commit"
echo "--- logged in as restaurant A's ask role"
expect "reads its own parent data" "1" "$ASK" "select count(*) from jobs"
run "cannot read B's parent data" blocked "$ASK" "select count(*) from o_bbbbbbbbbbbb_parent.jobs"
run "cannot read the platform schema" blocked "$ASK" "select count(*) from platform.organizations"
run "cannot read auth users" blocked "$ASK" "select count(*) from auth.users"
run "cannot write with read-only on" blocked "$ASK" "insert into o_aaaaaaaaaaaa_parent.jobs (id,name,house) values (gen_random_uuid(),'x','front')"
run "cannot write in a read-write transaction" blocked "$ASK" "begin read write; insert into o_aaaaaaaaaaaa_parent.jobs (id,name,house) values (gen_random_uuid(),'x','front')"
run "cannot switch to A's write role" blocked "$ASK" "set role o_aaaaaaaaaaaa_rw"
run "cannot switch to rms_admin" blocked "$ASK" "set role rms_admin"
run "cannot switch to postgres" blocked "$ASK" "set role postgres"
run "cannot call provisioning" blocked "$ASK" "select platform.drop_store('$B')"
run "cannot create a temp table, even read-write" blocked "$ASK" "begin read write; create temp table x (id int)"
expect "reads its own live table" "0" "$ASK" "select count(*) from notes"
run "B's ask role cannot log in" blocked "postgresql://o_bbbbbbbbbbbb_ask:$ASKPW@127.0.0.1:54322/postgres" "select 1"
echo "--- cleanup: $(q "$DATABASE_ADMIN_URL" "select platform.drop_store('$A'); select platform.drop_store('$B'); delete from platform.parent_jobs where org_id in ('$A','$B'); delete from platform.change_sets where org_id in ('$A','$B'); delete from platform.apps where org_id in ('$A','$B'); delete from platform.secrets where org_id in ('$A','$B'); delete from platform.organizations where id in ('$A','$B'); select 'roles left: ' || count(*) from pg_roles where rolname like 'o\_%'")"
echo "FAILS=$fails"

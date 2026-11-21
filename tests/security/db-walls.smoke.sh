#!/usr/bin/env bash
set -u
set -a; . ./.env.local; set +a
A=0193a3c0-0000-7000-8000-00000000000a; B=0193a3c0-0000-7000-8000-00000000000b
ASKPW="$(openssl rand -hex 24)"
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
echo "setup: $(q "$DATABASE_ADMIN_URL" "insert into platform.organizations (id, slug, name, store_prefix) values ('$A','smoke-a','Smoke A','o_aaaaaaaaaaaa'), ('$B','smoke-b','Smoke B','o_bbbbbbbbbbbb') on conflict do nothing; select platform.provision_store('$A'); select platform.provision_store('$B'); select platform.set_ask_login('$A', '$ASKPW'); insert into platform.parent_jobs (id, org_id, name, house) values (gen_random_uuid(), '$A', 'Server', 'front'); set role rms_parent_sync; insert into o_aaaaaaaaaaaa_parent.jobs (id, name, house) values (gen_random_uuid(), 'Server', 'front'); insert into o_bbbbbbbbbbbb_parent.jobs (id, name, house) values (gen_random_uuid(), 'Cook', 'back');")"
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
run "draft role cannot read the live schema" blocked "$DATABASE_URL" "begin; set local role o_aaaaaaaaaaaa_draft_rw; create table o_aaaaaaaaaaaa.x (id int); commit"
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
run "cannot create a temp table" blocked "$ASK" "create temp table x (id int)"
run "B's ask role cannot log in" blocked "postgresql://o_bbbbbbbbbbbb_ask:$ASKPW@127.0.0.1:54322/postgres" "select 1"
echo "--- cleanup: $(q "$DATABASE_ADMIN_URL" "select platform.drop_store('$A'); select platform.drop_store('$B'); delete from platform.parent_jobs where org_id in ('$A','$B'); delete from platform.organizations where id in ('$A','$B'); select 'roles left: ' || count(*) from pg_roles where rolname like 'o\_%'")"
echo "FAILS=$fails"

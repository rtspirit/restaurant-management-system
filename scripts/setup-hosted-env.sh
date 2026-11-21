#!/usr/bin/env bash
# Sets up the HOSTED Supabase project's server logins and writes .env.hosted (git-ignored).
# Runs the Supabase guard first. Never prints a secret. Safe to run again: it rotates the two
# server logins' passwords and rewrites .env.hosted.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
scripts/preflight-supabase.sh >/dev/null
REF="$(sed -n '1p' .rms/supabase-project | tr -d '[:space:]')"
DBPW="$(sed -n 's/^SUPABASE_DB_PASSWORD=//p' .env.local)"
[ -n "$DBPW" ] || { echo "SUPABASE_DB_PASSWORD is not set in .env.local" >&2; exit 1; }
POOLER="$(tr -d '[:space:]' < supabase/.temp/pooler-url)"
# Must be this project's pooler and nothing else.
printf '%s' "$POOLER" | grep -Eq "^postgresql://postgres\.${REF}@aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com:5432/postgres$" \
  || { echo "Unexpected pooler address" >&2; exit 1; }
HOST="$(printf '%s' "$POOLER" | sed -E 's#^postgresql://[^@]+@([^:/]+):.*#\1#')"

scram() { node -e 'const c=require("node:crypto");const pw=process.argv[1];const salt=c.randomBytes(16);const s=c.pbkdf2Sync(pw.normalize("NFKC"),salt,4096,32,"sha256");const ck=c.createHmac("sha256",s).update("Client Key").digest();const sk=c.createHash("sha256").update(ck).digest();const sv=c.createHmac("sha256",s).update("Server Key").digest();process.stdout.write("SCRAM-SHA-256$4096:"+salt.toString("base64")+"$"+sk.toString("base64")+":"+sv.toString("base64"))' "$1"; }
API_PW="$(openssl rand -hex 24)"; ADMIN_PW="$(openssl rand -hex 24)"
# Session-mode pooler (5432) as the project owner, for the two ALTER ROLE statements only.
PGPASSWORD="$DBPW" psql "postgresql://postgres.${REF}@${HOST}:5432/postgres?sslmode=require" -X -q -v ON_ERROR_STOP=1 \
  -c "alter role rms_api login password '$(scram "$API_PW")'" -c "alter role rms_admin login password '$(scram "$ADMIN_PW")'" >/dev/null

KEYS="$(scripts/preflight-supabase.sh projects api-keys -o json 2>/dev/null)"
key() { printf '%s' "$KEYS" | python3 -c 'import sys,json; d=json.load(sys.stdin); ks=d.get("keys",d) if isinstance(d,dict) else d; print(next(k["api_key"] for k in ks if k.get("type")==sys.argv[1]))' "$1"; }
PUB="$(key publishable)"; SEC="$(key secret)"
get() { sed -n "s/^$1=//p" .env.local | head -1; }

umask 077
cat > .env.hosted <<ENV
# Hosted settings for the rms-demo Supabase project. Git-ignored. Written by scripts/setup-hosted-env.sh
SUPABASE_PROJECT_REF=$REF
SUPABASE_URL=https://$REF.supabase.co
SUPABASE_PUBLISHABLE_KEY=$PUB
SUPABASE_SECRET_KEY=$SEC
NEXT_PUBLIC_SUPABASE_URL=https://$REF.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$PUB
# Transaction-mode pooler (6543) for the server logins. Custom logins use <role>.<project ref>.
DATABASE_URL=postgresql://rms_api.$REF:$API_PW@$HOST:6543/postgres
DATABASE_ADMIN_URL=postgresql://rms_admin.$REF:$ADMIN_PW@$HOST:6543/postgres
ASK_DATABASE_HOST=$HOST:5432
ASK_DATABASE_USER_SUFFIX=.$REF
SUPABASE_DB_PASSWORD=$DBPW
OPENAI_API_KEY=$(get OPENAI_API_KEY)
RMS_BUILD_MODEL=$(get RMS_BUILD_MODEL)
RMS_ASK_MODEL=$(get RMS_ASK_MODEL)
RMS_EMBED_MODEL=$(get RMS_EMBED_MODEL)
RMS_TOKEN_SECRET=$(openssl rand -base64 48 | tr -d '\n')
DEMO_PASSWORD=$(get DEMO_PASSWORD)
ENV
chmod 600 .env.hosted
echo "Hosted logins set. Settings written to .env.hosted." >&2

#!/usr/bin/env bash
# Local development only. Gives the two server logins (rms_api, rms_admin) random passwords on the
# LOCAL Supabase stack and writes their connection strings into .env.local (git-ignored).
# Never run against a hosted project: it refuses any host but 127.0.0.1 / localhost.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_URL="${LOCAL_DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
# Strict host check: the part after the LAST "@" before the first "/" must be a local host and port.
if ! printf '%s' "$LOCAL_URL" | grep -Eq '^postgres(ql)?://[^@/?#]+@(127\.0\.0\.1|localhost):[0-9]+/[A-Za-z0-9_]+$'; then
  echo "Refusing: not a local database" >&2; exit 1
fi
# The database only ever receives a SCRAM verifier, so no password appears in its logs.
scram() { node -e 'const c=require("node:crypto");const pw=process.argv[1];const salt=c.randomBytes(16);const s=c.pbkdf2Sync(pw.normalize("NFKC"),salt,4096,32,"sha256");const ck=c.createHmac("sha256",s).update("Client Key").digest();const sk=c.createHash("sha256").update(ck).digest();const sv=c.createHmac("sha256",s).update("Server Key").digest();process.stdout.write("SCRAM-SHA-256$4096:"+salt.toString("base64")+"$"+sk.toString("base64")+":"+sv.toString("base64"))' "$1"; }
ENV_FILE="$ROOT/.env.local"
[ -f "$ENV_FILE" ] || cp "$ROOT/.env.example" "$ENV_FILE"
set_kv() { local k="$1" v="$2"; if grep -q "^$k=" "$ENV_FILE"; then sed -i.bak "s|^$k=.*|$k=$v|" "$ENV_FILE" && rm -f "$ENV_FILE.bak"; else printf '%s=%s\n' "$k" "$v" >> "$ENV_FILE"; fi; }
# Keep working logins as they are, so other running tasks are not cut off. Rotate only when needed.
CUR_API="$(sed -n 's/^DATABASE_URL=//p' "$ENV_FILE")"; CUR_ADMIN="$(sed -n 's/^DATABASE_ADMIN_URL=//p' "$ENV_FILE")"
if [ -n "$CUR_API" ] && [ -n "$CUR_ADMIN" ] && psql "$CUR_API" -q -c "select 1" >/dev/null 2>&1 && psql "$CUR_ADMIN" -q -c "select 1" >/dev/null 2>&1; then
  echo "Local logins already work. Left unchanged." >&2
else
  API_PW="$(openssl rand -hex 24)"; ADMIN_PW="$(openssl rand -hex 24)"
  psql "$LOCAL_URL" -v ON_ERROR_STOP=1 -q -c "alter role rms_api login password '$(scram "$API_PW")'" -c "alter role rms_admin login password '$(scram "$ADMIN_PW")'" >/dev/null
  set_kv DATABASE_URL "postgresql://rms_api:$API_PW@127.0.0.1:54322/postgres"
  set_kv DATABASE_ADMIN_URL "postgresql://rms_admin:$ADMIN_PW@127.0.0.1:54322/postgres"
  fi
set_kv ASK_DATABASE_HOST "127.0.0.1:54322"
# Local Supabase URL and keys (well-known local development values, never a hosted project's).
STATUS="$(cd "$ROOT" && pnpm exec supabase status -o env 2>/dev/null || true)"
val() { printf '%s\n' "$STATUS" | sed -n "s/^$1=\"\{0,1\}\([^\"]*\)\"\{0,1\}$/\1/p" | head -1; }
API_URL="$(val API_URL)"
case "$API_URL" in http://127.0.0.1:*|http://localhost:*)
  set_kv SUPABASE_URL "$API_URL"
  set_kv SUPABASE_PUBLISHABLE_KEY "$(val PUBLISHABLE_KEY)"
  set_kv SUPABASE_SECRET_KEY "$(val SECRET_KEY)"
  set_kv NEXT_PUBLIC_SUPABASE_URL "$API_URL"
  set_kv NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY "$(val PUBLISHABLE_KEY)"
  set_kv NEXT_PUBLIC_API_URL "http://127.0.0.1:8787"
  set_kv API_URL "http://127.0.0.1:8787"
  set_kv WEB_URL "http://127.0.0.1:3000"
  set_kv ADMIN_URL "http://127.0.0.1:3001"
  ;;
esac
# A signing key for RMS tokens, if there is none yet.
if [ -z "$(sed -n 's/^RMS_TOKEN_SECRET=//p' "$ENV_FILE")" ]; then
  set_kv RMS_TOKEN_SECRET "$(openssl rand -base64 48 | tr -d '\n')"
fi
# Next.js only reads .env files from the app's own folder, so point each app at the root file.
for app in web admin apps-host; do
  [ -d "$ROOT/apps/$app" ] && ln -sf ../../.env.local "$ROOT/apps/$app/.env.local"
done
chmod 600 "$ENV_FILE"
echo "Local settings are in .env.local." >&2

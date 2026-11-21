#!/usr/bin/env bash
# Local development only. Gives the two server logins (rms_api, rms_admin) random passwords on the
# LOCAL Supabase stack and writes their connection strings into .env.local (git-ignored).
# Never run against a hosted project: it refuses any host but 127.0.0.1 / localhost.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_URL="${LOCAL_DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
case "$LOCAL_URL" in *@127.0.0.1:*|*@localhost:*) ;; *) echo "Refusing: not a local database" >&2; exit 1;; esac
ENV_FILE="$ROOT/.env.local"
[ -f "$ENV_FILE" ] || cp "$ROOT/.env.example" "$ENV_FILE"
set_kv() { local k="$1" v="$2"; if grep -q "^$k=" "$ENV_FILE"; then sed -i.bak "s|^$k=.*|$k=$v|" "$ENV_FILE" && rm -f "$ENV_FILE.bak"; else printf '%s=%s\n' "$k" "$v" >> "$ENV_FILE"; fi; }
# Keep working logins as they are, so other running tasks are not cut off. Rotate only when needed.
CUR_API="$(sed -n 's/^DATABASE_URL=//p' "$ENV_FILE")"; CUR_ADMIN="$(sed -n 's/^DATABASE_ADMIN_URL=//p' "$ENV_FILE")"
if [ -n "$CUR_API" ] && [ -n "$CUR_ADMIN" ] && psql "$CUR_API" -q -c "select 1" >/dev/null 2>&1 && psql "$CUR_ADMIN" -q -c "select 1" >/dev/null 2>&1; then
  echo "Local logins already work. Left unchanged." >&2
else
  API_PW="$(openssl rand -hex 24)"; ADMIN_PW="$(openssl rand -hex 24)"
  psql "$LOCAL_URL" -v ON_ERROR_STOP=1 -q -c "alter role rms_api login password '$API_PW'" -c "alter role rms_admin login password '$ADMIN_PW'" >/dev/null
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
chmod 600 "$ENV_FILE"
echo "Local settings are in .env.local." >&2

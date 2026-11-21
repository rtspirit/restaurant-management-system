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
API_PW="$(openssl rand -hex 24)"; ADMIN_PW="$(openssl rand -hex 24)"
psql "$LOCAL_URL" -v ON_ERROR_STOP=1 -q -c "alter role rms_api login password '$API_PW'" -c "alter role rms_admin login password '$ADMIN_PW'" >/dev/null
set_kv() { local k="$1" v="$2"; if grep -q "^$k=" "$ENV_FILE"; then sed -i.bak "s|^$k=.*|$k=$v|" "$ENV_FILE" && rm -f "$ENV_FILE.bak"; else printf '%s=%s\n' "$k" "$v" >> "$ENV_FILE"; fi; }
set_kv DATABASE_URL "postgresql://rms_api:$API_PW@127.0.0.1:54322/postgres"
set_kv DATABASE_ADMIN_URL "postgresql://rms_admin:$ADMIN_PW@127.0.0.1:54322/postgres"
set_kv ASK_DATABASE_HOST "127.0.0.1:54322"
chmod 600 "$ENV_FILE"
echo "Local logins set for rms_api and rms_admin. Connection strings written to .env.local." >&2

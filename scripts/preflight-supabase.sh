#!/usr/bin/env bash
# Guard for every Supabase command that touches the HOSTED project.
#
#   scripts/preflight-supabase.sh            check only
#   scripts/preflight-supabase.sh <args...>  check, then run `supabase <args...>`
#
# Local commands (start, stop, status, migration up, db reset) do not need this guard.
# Stops unless:
#   - .rms/supabase-project holds the personal project (ref, name, organisation id)
#   - the project the CLI is linked to is that ref, and nothing else
#   - no argument names another project, or contains "tradeengage" or "te-team"
#   - the project still exists under that name in that organisation
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXPECTED_REF="madxltljtpanwcmgsfgm"
EXPECTED_NAME="rms-demo"
EXPECTED_ORG="ncrrwaimorqkbpohzgkk"
BANNED='tradeengage|te-team'

stop() { echo "PREFLIGHT STOP: $*" >&2; exit 1; }
banned() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | grep -Eq "$BANNED"; }
supa() { (cd "$ROOT" && pnpm exec supabase "$@"); }

F="$ROOT/.rms/supabase-project"
[ -f "$F" ] || stop ".rms/supabase-project is missing"
[ "$(sed -n '1p' "$F" | tr -d '[:space:]')" = "$EXPECTED_REF" ] || stop ".rms/supabase-project ref is not $EXPECTED_REF"
[ "$(sed -n '2p' "$F" | tr -d '[:space:]')" = "$EXPECTED_NAME" ] || stop ".rms/supabase-project name is not $EXPECTED_NAME"
[ "$(sed -n '3p' "$F" | tr -d '[:space:]')" = "$EXPECTED_ORG" ] || stop ".rms/supabase-project organisation is not $EXPECTED_ORG"

[ -z "${SUPABASE_ACCESS_TOKEN:-}" ] || stop "SUPABASE_ACCESS_TOKEN is set. Use the personal 'supabase login' session"
if [ -n "${SUPABASE_PROJECT_ID:-}" ] && [ "$SUPABASE_PROJECT_ID" != "$EXPECTED_REF" ]; then stop "SUPABASE_PROJECT_ID points at another project"; fi

prev=""
for a in "$@"; do
  banned "$a" && stop "argument '$a' contains a banned name"
  case "$a" in
    --project-ref=*|--project-id=*|--ref=*) [ "${a#*=}" = "$EXPECTED_REF" ] || stop "argument '$a' targets another project" ;;
    --db-url|--db-url=*) stop "do not pass a database address. Use the linked project" ;;
  esac
  case "$prev" in
    --project-ref|--project-id|--ref) [ "$a" = "$EXPECTED_REF" ] || stop "'$prev $a' targets another project" ;;
  esac
  case "$a" in
    projects) case "${2:-}" in create|delete|pause|restore) stop "creating, deleting or pausing projects needs Rahul's yes and is not done through this guard" ;; esac ;;
  esac
  prev="$a"
done

LINKED="$ROOT/supabase/.temp/project-ref"
if [ -f "$LINKED" ]; then
  [ "$(tr -d '[:space:]' < "$LINKED")" = "$EXPECTED_REF" ] || stop "the CLI is linked to another project"
else
  case "${1:-}" in ""|link) ;; *) stop "the CLI is not linked yet. Run: scripts/preflight-supabase.sh link --project-ref $EXPECTED_REF" ;; esac
fi

# The project must exist under the expected name and organisation. Only this one project is inspected.
INFO="$(supa projects list -o json 2>/dev/null)" || stop "not signed in. Run: pnpm exec supabase login"
printf '%s' "$INFO" | REF="$EXPECTED_REF" NAME="$EXPECTED_NAME" ORG="$EXPECTED_ORG" python3 -c '
import json, os, sys
d = json.load(sys.stdin)
ps = d.get("projects", d) if isinstance(d, dict) else d
m = [p for p in ps if (p.get("ref") or p.get("id")) == os.environ["REF"]]
ok = len(m) == 1 and m[0].get("name") == os.environ["NAME"] and (m[0].get("organization_id") or m[0].get("organization_slug")) == os.environ["ORG"]
sys.exit(0 if ok else 1)
' || stop "project $EXPECTED_REF was not found as '$EXPECTED_NAME' in the personal organisation"

echo "preflight ok: supabase project=$EXPECTED_NAME ($EXPECTED_REF)" >&2
[ "$#" -gt 0 ] || exit 0
exec env SUPABASE_PROJECT_ID="$EXPECTED_REF" bash -c 'cd "$0" && shift 0 && exec pnpm exec supabase "$@"' "$ROOT" "$@"

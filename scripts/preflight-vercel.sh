#!/usr/bin/env bash
# Guard for every Vercel command in this repo.
#
#   scripts/preflight-vercel.sh            check only, exit 0 if safe
#   scripts/preflight-vercel.sh <args...>  check, then run `vercel <args...>` on the personal team
#
# Stops unless:
#   - .rms/vercel-team holds the personal team id and slug
#   - the Vercel CLI is logged in and that team is reachable
#   - no team name, project name, linked project or argument contains "tradeengage" or "te-team"
#   - no argument or environment variable points the command at another team
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXPECTED_ID="team_RM4toarAtl8vljERLdxRvfeh"
EXPECTED_SLUG="rtspirits-projects"
ALLOWED_PROJECTS="rms-web rms-admin rms-apps"
BANNED='tradeengage|te-team'

stop() { echo "PREFLIGHT STOP: $*" >&2; exit 1; }
banned() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | grep -Eq "$BANNED"; }

# 1. The stored team must be the personal team, exactly.
TEAM_FILE="$ROOT/.rms/vercel-team"
[ -f "$TEAM_FILE" ] || stop ".rms/vercel-team is missing"
FILE_ID="$(sed -n '1p' "$TEAM_FILE" | tr -d '[:space:]')"
FILE_SLUG="$(sed -n '2p' "$TEAM_FILE" | tr -d '[:space:]')"
[ "$FILE_ID" = "$EXPECTED_ID" ] || stop ".rms/vercel-team id is '$FILE_ID', expected $EXPECTED_ID"
[ "$FILE_SLUG" = "$EXPECTED_SLUG" ] || stop ".rms/vercel-team slug is '$FILE_SLUG', expected $EXPECTED_SLUG"

# 2. Nothing in the environment may redirect the command.
for v in VERCEL_ORG_ID VERCEL_TEAM_ID; do
  val="${!v:-}"
  [ -z "$val" ] || [ "$val" = "$EXPECTED_ID" ] || stop "$v is set to another team ($val)"
done
if [ -n "${VERCEL_PROJECT_ID:-}" ]; then banned "$VERCEL_PROJECT_ID" && stop "VERCEL_PROJECT_ID looks like TradeEngage"; fi
[ -z "${VERCEL_TOKEN:-}" ] || stop "VERCEL_TOKEN is set. Use the personal 'vercel login' session, not a token"

# 3. Arguments may not name another team or anything banned.
prev=""
for a in "$@"; do
  banned "$a" && stop "argument '$a' contains a banned name"
  case "$a" in
    --scope=*|--team=*|-S=*|-T=*)
      v="${a#*=}"
      [ "$v" = "$EXPECTED_ID" ] || [ "$v" = "$EXPECTED_SLUG" ] || stop "argument '$a' targets another team" ;;
    --token|--token=*|-t) stop "do not pass a token. Use the personal 'vercel login' session" ;;
  esac
  case "$prev" in
    --scope|--team|-S|-T)
      [ "$a" = "$EXPECTED_ID" ] || [ "$a" = "$EXPECTED_SLUG" ] || stop "'$prev $a' targets another team" ;;
  esac
  prev="$a"
done

# 4. Any linked project in the repo must belong to the personal team and be one of ours.
while IFS= read -r pj; do
  [ -n "$pj" ] || continue
  org="$(sed -n 's/.*"orgId"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$pj" | head -1)"
  name="$(sed -n 's/.*"projectName"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$pj" | head -1)"
  [ -z "$org" ] || [ "$org" = "$EXPECTED_ID" ] || stop "$pj is linked to another team ($org)"
  if [ -n "$name" ]; then
    banned "$name" && stop "$pj is linked to a banned project ($name)"
    case " $ALLOWED_PROJECTS " in *" $name "*) ;; *) stop "$pj is linked to '$name', which is not an RMS project" ;; esac
  fi
done < <(find "$ROOT" -path '*/node_modules' -prune -o -path '*/.vercel/project.json' -print 2>/dev/null)

# 5. The CLI must be installed, logged in, and able to see the personal team.
command -v vercel >/dev/null 2>&1 || stop "the Vercel CLI is not installed"
WHO="$(vercel whoami 2>/dev/null | tail -1 | tr -d '[:space:]')" || stop "not logged in. Run: vercel login"
[ -n "$WHO" ] || stop "not logged in. Run: vercel login"
banned "$WHO" && stop "logged in as '$WHO', which looks like a TradeEngage account"

TEAMS="$(vercel teams ls 2>&1)" || stop "could not list teams"
printf '%s\n' "$TEAMS" | grep -Eq "(^|[[:space:]])$EXPECTED_SLUG([[:space:]]|$)" \
  || stop "team $EXPECTED_SLUG is not visible to '$WHO'. Wrong account?"
if printf '%s' "$TEAMS" | tr '[:upper:]' '[:lower:]' | grep -Eq "$BANNED"; then
  stop "this login can see a TradeEngage team. Log in with the personal account only"
fi

echo "preflight ok: user=$WHO team=$EXPECTED_SLUG ($EXPECTED_ID)" >&2

# 6. Run the command pinned to the personal team.
[ "$#" -gt 0 ] || exit 0
exec env VERCEL_ORG_ID="$EXPECTED_ID" vercel "$@" --scope "$EXPECTED_SLUG"

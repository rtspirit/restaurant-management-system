#!/usr/bin/env bash
# Phone mode (ADR 0010). Runs RMS on this laptop so a phone on the same Wi-Fi can open it.
#
#   scripts/demo-phone.sh          start phone mode (builds the web app, starts the servers)
#   scripts/demo-phone.sh stop     stop phone mode and rebuild the normal laptop-only web app
#   scripts/demo-phone.sh status   say what is running
#
# Settings (environment, all optional):
#   PHONE_ADDRESS=name|ip   how the phone reaches the laptop. Default "name" (this Mac's .local
#                           name, which an iPhone resolves; it survives the address changing).
#                           Use "ip" for a phone that cannot open .local names (some Android).
#   API_PORT=8787 WEB_PORT=3000 CONSOLE_PORT=3001 APPS_PORT=3002   CONSOLE_PORT=off skips the console.
#   NO_REBUILD=1            with "stop": do not rebuild the normal web app and console.
#
# It never edits .env.local and never prints a secret. Its own settings go to .env.phone
# (git-ignored, nothing secret in it). Logs and process ids go to .phone-mode/ (git-ignored).
# Supabase is not touched: it must already be running (pnpm exec supabase start ...).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_LOCAL="$ROOT/.env.local"
ENV_PHONE="$ROOT/.env.phone"
STATE="$ROOT/.phone-mode"
API_PORT="${API_PORT:-8787}"; WEB_PORT="${WEB_PORT:-3000}"; CONSOLE_PORT="${CONSOLE_PORT:-3001}"; APPS_PORT="${APPS_PORT:-3002}"
PHONE_ADDRESS="${PHONE_ADDRESS:-name}"
APPS_DIR="$ROOT/apps/apps-host"

say() { printf '%s\n' "$*"; }
die() { printf 'Phone mode: %s\n' "$*" >&2; exit 1; }
# After start has written its state: keep the logs and state, and say how to put things back.
fail() { printf 'Phone mode: %s\nNothing was cleaned up. Run: scripts/demo-phone.sh stop\n' "$*" >&2; exit 1; }
# Every setting phone mode exports. "stop" rebuilds with all of them removed.
PHONE_VARS="RMS_LOCAL_DEMO WEB_URL APPS_URL RMS_LOCAL_DEMO_ORIGINS WEB_EXTRA_ORIGINS NEXT_PUBLIC_API_URL NEXT_PUBLIC_SUPABASE_URL API_HOST ADMIN_URL PORT HOSTNAME"
# Reads one NON-secret setting from .env.local. Never used for keys or passwords.
local_setting() { [ -f "$ENV_LOCAL" ] && sed -n "s/^$1=//p" "$ENV_LOCAL" | tail -1 || true; }
host_of() { printf '%s' "$1" | sed -E 's#^https?://\[?([^]/:]+)\]?.*#\1#'; }
port_of() { printf '%s' "$1" | sed -nE 's#^https?://[^/]*:([0-9]+).*#\1#p'; }
listener() { lsof -nP -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -1 || true; }
folder_of() { lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1; }

is_private_ipv4() {
  local ip="$1" a b
  [[ "$ip" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.[0-9]{1,3}\.[0-9]{1,3}$ ]] || return 1
  a="${BASH_REMATCH[1]}"; b="${BASH_REMATCH[2]}"
  [ "$a" = 10 ] && return 0
  [ "$a" = 192 ] && [ "$b" = 168 ] && return 0
  [ "$a" = 172 ] && [ "$b" -ge 16 ] && [ "$b" -le 31 ] && return 0
  return 1
}

detect_ip() {
  local iface ip=""
  iface="$(route -n get default 2>/dev/null | awk '/interface:/{print $2}' || true)"
  [ -n "$iface" ] && ip="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"
  [ -z "$ip" ] && ip="$(ipconfig getifaddr en0 2>/dev/null || true)"
  printf '%s' "$ip"
}

detect_name() {
  local n
  n="$(scutil --get LocalHostName 2>/dev/null || true)"
  [ -n "$n" ] || return 0
  n="$(printf '%s.local' "$n" | tr '[:upper:]' '[:lower:]')"
  # Only if this Mac answers to it on the network (multicast DNS).
  if dscacheutil -q host -a name "$n" 2>/dev/null | grep -q '^ip_address'; then printf '%s' "$n"; fi
}

wait_for() { # url, seconds
  local i
  for ((i = 0; i < $2; i++)); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$1" || true)" != "000" ] && return 0
    sleep 1
  done
  return 1
}

kill_tree() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do kill_tree "$child"; done
  kill "$pid" 2>/dev/null || true
}

started_at() { ps -o lstart= -p "$1" 2>/dev/null | sed 's/  */ /g; s/^ //; s/ $//' || true; }

# True only for a process this script started: the recorded pid still has the recorded start
# time (so it is not a recycled pid) and runs from a folder inside this checkout.
is_ours() { # pidfile
  local f="$1" pid want got dir
  pid="$(cat "$f" 2>/dev/null || true)"; want="$(cat "${f%.pid}.started" 2>/dev/null || true)"
  [ -n "$pid" ] && [ -n "$want" ] || return 1
  got="$(started_at "$pid")"
  [ -n "$got" ] && [ "$got" = "$want" ] || return 1
  dir="$(folder_of "$pid")"
  case "$dir" in "$ROOT"|"$ROOT"/*) return 0 ;; esac
  return 1
}

stop_all() {
  if [ ! -d "$STATE" ] && [ ! -f "$ENV_PHONE" ]; then say "Phone mode is not running."; return 0; fi
  local f name
  for f in "$STATE"/*.pid; do
    [ -f "$f" ] || continue
    name="$(basename "${f%.pid}")"
    # Never by port: only a process this script started, checked by pid, start time and folder.
    if is_ours "$f"; then kill_tree "$(cat "$f")"; else say "  $name: already gone (or not ours), left alone."; fi
  done
  rm -rf "$STATE" "$ENV_PHONE"
  say "Phone mode stopped. The phone can no longer reach RMS (Supabase is left as it was)."
  if [ "${NO_REBUILD:-}" != 1 ]; then
    say "Rebuilding the normal (laptop-only) web app and console, about a minute..."
    local unset_args="" v
    for v in $PHONE_VARS; do unset_args="$unset_args -u $v"; done
    # shellcheck disable=SC2086
    (cd "$ROOT" && env $unset_args pnpm --filter @rms/web build >/dev/null 2>&1 && env $unset_args pnpm --filter @rms/admin build >/dev/null 2>&1) || die "the normal rebuild failed: run pnpm build"
    say "Done. Start the normal servers again as usual."
  fi
}

status() {
  if [ ! -f "$ENV_PHONE" ]; then say "Phone mode is not running."; return 0; fi
  say "Phone mode settings:"; sed -nE 's/^(WEB_URL|APPS_URL)=/  \1=/p' "$ENV_PHONE"
  local f
  for f in "$STATE"/*.port; do [ -f "$f" ] || continue; local p; p="$(cat "$f")"; say "  $(basename "${f%.port}"): port $p $([ -n "$(listener "$p")" ] && echo up || echo DOWN)"; done
}

start_bg() { # name port dir cmd... (environment comes from the caller)
  local name="$1" port="$2" dir="$3"; shift 3
  # Separate statements, so the server itself (not a waiting shell) is the background job and
  # nothing keeps this script's output open.
  (
    cd "$dir" || exit 1
    nohup "$@" >"$STATE/$name.log" 2>&1 </dev/null &
    echo $! >"$STATE/$name.pid"
  )
  echo "$port" >"$STATE/$name.port"
  started_at "$(cat "$STATE/$name.pid")" >"$STATE/$name.started"
}

start() {
  [ -f "$ENV_LOCAL" ] || die "no .env.local. Run scripts/dev-db-roles.sh first."
  [ -f "$ENV_PHONE" ] && die "already running. Use: scripts/demo-phone.sh stop"
  command -v lsof >/dev/null || die "lsof is missing."

  # 1. Where the phone finds the laptop.
  local ip name web_host apps_host=""
  ip="$(detect_ip)"
  [ -n "$ip" ] || die "this laptop has no network address. Join the Wi-Fi (or the phone's hotspot) first."
  is_private_ipv4 "$ip" || die "refusing: the network address $ip is not a private home or office address. Phone mode only runs on a private network."
  name="$(detect_name)"
  if [ "$PHONE_ADDRESS" = ip ] || [ -z "$name" ]; then
    web_host="$ip"; apps_host="$name"
  else
    web_host="$name"; apps_host="$ip"
  fi

  # 2. Ports: free, and the normal servers from THIS folder must be stopped (the build replaces theirs).
  local p pid
  for p in "$API_PORT" "$WEB_PORT" $([ "$CONSOLE_PORT" != off ] && echo "$CONSOLE_PORT") $([ -d "$APPS_DIR" ] && echo "$APPS_PORT"); do
    pid="$(listener "$p")"; [ -z "$pid" ] || die "port $p is in use (by $(folder_of "$pid")). Stop that server first."
  done
  for p in 3000 3001; do
    pid="$(listener "$p")"
    case "$(folder_of "${pid:-0}")" in "$ROOT/apps/web"|"$ROOT/apps/admin") die "the normal server from this folder is running on port $p. Stop it first: phone mode rebuilds it.";; esac
  done

  # 3. The sign-in service (local Supabase) must answer on the network address too.
  local sb_local sb_port
  sb_local="$(local_setting NEXT_PUBLIC_SUPABASE_URL)"; sb_port="$(port_of "$sb_local")"; sb_port="${sb_port:-54321}"
  case "$(host_of "$sb_local")" in 127.0.0.1|localhost) ;; *) die "refusing: .env.local does not point at the local sign-in service.";; esac
  wait_for "http://$web_host:$sb_port/auth/v1/health" 3 || die "the local sign-in service does not answer on http://$web_host:$sb_port. Is Supabase running?"

  local laptop_host console_host web_origin api_url
  laptop_host="$(host_of "$(local_setting WEB_URL)")"; laptop_host="${laptop_host:-127.0.0.1}"
  console_host="$(host_of "$(local_setting ADMIN_URL)")"; console_host="${console_host:-127.0.0.1}"
  web_origin="http://$web_host:$WEB_PORT"
  api_url="http://$web_host:$API_PORT"

  # 4. The overlay. Addresses only: nothing secret. Two different hosts for the laptop: the web
  # app (shell) on one, the mini-app host on the other, because cookies ignore the port.
  local apps_origin=""
  [ -n "$apps_host" ] && apps_origin="http://$apps_host:$APPS_PORT"
  umask 077
  {
    echo "# Phone mode, written by scripts/demo-phone.sh at $(date -u +%Y-%m-%dT%H:%M:%SZ). Removed by 'stop'. Not secret."
    echo "RMS_LOCAL_DEMO=1"
    echo "WEB_URL=$web_origin"
    [ -n "$apps_origin" ] && echo "APPS_URL=$apps_origin"
    echo "RMS_LOCAL_DEMO_ORIGINS=$web_origin${apps_origin:+,$apps_origin}"
    echo "NEXT_PUBLIC_API_URL=$api_url"
    echo "NEXT_PUBLIC_SUPABASE_URL=http://$web_host:$sb_port"
  } >"$ENV_PHONE"
  mkdir -p "$STATE"
  set -a; # shellcheck disable=SC1090
  . "$ENV_PHONE"; set +a

  say "Phone mode: anyone on this Wi-Fi can reach the demo while it runs. Use a trusted network or the phone's own hotspot."

  # 5. Build. The web app bakes the phone addresses in; the console stays laptop-only.
  say "Building the web app for the phone (about a minute)..."
  (cd "$ROOT" && pnpm turbo run build --filter='@rms/web^...' --filter='@rms/admin^...' --output-logs=errors-only >"$STATE/build.log" 2>&1) || fail "building the packages failed. See .phone-mode/build.log"
  (cd "$ROOT" && pnpm --filter @rms/web build >>"$STATE/build.log" 2>&1) || fail "building the web app failed. See .phone-mode/build.log"
  if [ "$CONSOLE_PORT" != off ]; then
    (cd "$ROOT" && NEXT_PUBLIC_API_URL="http://127.0.0.1:$API_PORT" NEXT_PUBLIC_SUPABASE_URL="$sb_local" pnpm --filter @rms/admin build >>"$STATE/build.log" 2>&1) || fail "building the console failed. See .phone-mode/build.log"
  fi

  # 6. Start. API and web listen on every address; the console on this laptop only.
  # The API keeps WEB_URL on the laptop address: the build preview (ADR 0008) takes its shell
  # origin from it and stays on this laptop. The phone address reaches the API as an extra origin.
  WEB_URL="http://$laptop_host:$WEB_PORT" WEB_EXTRA_ORIGINS="$web_origin" ADMIN_URL="http://$console_host:$CONSOLE_PORT" API_PORT="$API_PORT" API_HOST=0.0.0.0 \
    start_bg api "$API_PORT" "$ROOT/apps/api" "$ROOT/apps/api/node_modules/.bin/tsx" --env-file=../../.env.local src/dev.ts
  start_bg web "$WEB_PORT" "$ROOT/apps/web" "$ROOT/apps/web/node_modules/.bin/next" start --port "$WEB_PORT" --hostname 0.0.0.0
  if [ "$CONSOLE_PORT" != off ]; then
    NEXT_PUBLIC_API_URL="http://127.0.0.1:$API_PORT" NEXT_PUBLIC_SUPABASE_URL="$sb_local" \
      start_bg console "$CONSOLE_PORT" "$ROOT/apps/admin" "$ROOT/apps/admin/node_modules/.bin/next" start --port "$CONSOLE_PORT" --hostname "$console_host"
  fi
  if [ -z "$apps_host" ]; then
    say "This laptop has only one name on the network, so published mini-apps cannot open on the phone (they need a host of their own). RMS itself works."
  elif [ -f "$APPS_DIR/package.json" ]; then
    PORT="$APPS_PORT" HOSTNAME=0.0.0.0 start_bg apps "$APPS_PORT" "$APPS_DIR" pnpm start
  fi

  wait_for "$api_url/health" "${START_WAIT:-60}" || fail "the API did not start. See .phone-mode/api.log"
  wait_for "$web_origin/sign-in" "${START_WAIT:-60}" || fail "the web app did not start. See .phone-mode/web.log"

  say ""
  say "On the phone (same Wi-Fi), open:  $web_origin"
  [ "$web_host" != "$ip" ] && say "If the phone cannot open that, stop and run again with PHONE_ADDRESS=ip  (http://$ip:$WEB_PORT)."
  if command -v qrencode >/dev/null; then qrencode -t ANSIUTF8 "$web_origin"; fi
  say "On this laptop, RMS is at http://$laptop_host:$WEB_PORT$([ "$CONSOLE_PORT" != off ] && echo " and the console at http://$console_host:$CONSOLE_PORT (laptop only)")."
  say "To stop: scripts/demo-phone.sh stop"
}

case "${1:-start}" in
  start) start ;;
  stop) stop_all ;;
  status) status ;;
  *) die "unknown command '$1'. Use start, stop or status." ;;
esac

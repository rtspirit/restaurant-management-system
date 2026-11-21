#!/usr/bin/env bash
# One-command rehearsal check for the demo. Run from the repo root (or a worktree of it):
#   scripts/rehearse.sh
#
# 1. Checks the API, the web app and the console answer.
# 2. Checks the two seeded restaurants exist (read only, on the admin login).
# 3. Says whether Marigold's week of 2026-11-09 can be checked through an owner's API route yet.
# 4. Runs the browser suite (pnpm test:e2e) and prints one PASS/FAIL line per demo beat.
# Exits non-zero on any failure.
#
# It never resets, never writes to a seeded restaurant, never calls a model, never prints a secret:
# settings are read by node from .env.local and only counts and words are printed.
# Needs: the local stack and the three servers running, and `pnpm build` done (the suite loads
# @rms/db and @rms/seed from their built output).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

API="http://127.0.0.1:8787"
WEB="http://127.0.0.1:3000"
CONSOLE="http://127.0.0.1:3001"
FAILED=0

line() { printf '  %-58s %s\n' "$1" "$2"; }

echo "RMS rehearsal check"
echo
echo "Servers"
answer() { # name url
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$2" || true)"
  if [[ "$code" =~ ^[23] ]]; then line "$1 ($2)" "OK"; else line "$1 ($2)" "NOT ANSWERING (${code:-no reply})"; FAILED=1; fi
}
answer "API health" "$API/health"
answer "Web app sign-in page" "$WEB/sign-in"
answer "Console sign-in page" "$CONSOLE/sign-in"
if [[ $FAILED -ne 0 ]]; then
  echo
  echo "RESULT: FAIL. Start the servers (docs/runbook.md section 2) and run this again."
  exit 1
fi

echo
echo "Seeded restaurants"
# Read only. Prints counts and names, nothing else.
SEEDED="$(node --input-type=module -e '
  import { loadTestEnv } from "@rms/db/testing";
  import { adminDb, closeAll } from "@rms/db";
  loadTestEnv();
  try {
    // The seeded owners, found through the local sign-in service (the admin login cannot read its tables).
    const key = process.env.SUPABASE_SECRET_KEY;
    const res = await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users?page=1&per_page=1000`, { headers: { apikey: key, authorization: `Bearer ${key}` } });
    if (!res.ok) throw new Error("sign-in service");
    const users = ((await res.json()).users ?? []).filter((u) => ["owner@marigold.test", "owner@sliceyard.test"].includes(u.email)).map((u) => u.id);
    const rows = await adminDb()`
      select o.name, (select count(*)::int from platform.locations l where l.org_id = o.id) as locations
      from platform.organizations o
      join platform.members m on m.org_id = o.id and m.role = ${"owner"} and m.status = ${"active"}
      where o.status = ${"active"} and m.user_id = any(${users}::uuid[])
      order by o.name`;
    for (const r of rows) console.log(`${r.name}|${r.locations}`);
  } catch {
    console.log("ERROR");
  } finally {
    await closeAll();
  }
' 2>/dev/null)"
check_seeded() { # name locations
  if grep -qx "$1|$2" <<<"$SEEDED"; then line "$1 ($2 location(s), owned by its seeded owner)" "OK"
  elif grep -qx "ERROR" <<<"$SEEDED"; then line "$1" "NOT CHECKED (could not read the database)"; FAILED=1
  else line "$1 ($2 location(s))" "MISSING: run pnpm reset-demo when nobody else is testing"; FAILED=1; fi
}
check_seeded "Marigold Kitchen" 2
check_seeded "Slice Yard" 1

echo
echo "Demo numbers"
# The only routes that return Marigold's sales are the Data API's, which need a mini-app token.
# No owner-session route (Ask, a published mini-app) exists yet. The suite still checks the seed
# itself against the run-book (specs/seed-numbers.spec.ts).
if curl -s -o /dev/null -w '%{http_code}' --max-time 5 -X POST "$API/ask/v1/ask" | grep -q '^404$'; then
  line "Marigold, week of 2026-11-09, net sales \$84,310.00" "NOT CHECKED (no owner route reads it yet)"
  line "Marigold, week of 2026-11-09, prime cost 61.3%" "NOT CHECKED (no owner route reads it yet)"
else
  line "Marigold, week of 2026-11-09" "NOT CHECKED (an Ask route answers now: switch on beat 5)"
fi

echo
echo "Browser suite (pnpm test:e2e)"
OUT="$ROOT/tests/e2e/results/outcomes.jsonl"
rm -f "$OUT"
# One retry, only so a server restarted mid-run (after a merge) does not fail the rehearsal.
# A test that passes only on the retry is shown as "PASS (flaky)".
E2E_RETRIES=1 pnpm --silent test:e2e
SUITE=$?
if [[ "${E2E_KEEP_SESSIONS:-0}" != "1" ]]; then rm -rf "$ROOT/tests/e2e/.auth"; fi

if [[ ! -s "$OUT" ]]; then
  echo
  echo "RESULT: FAIL. The browser suite did not run (exit $SUITE). See the output above."
  exit 1
fi

echo
echo "Per beat"
node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const rows = readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const NAMES = {
    1: "Sign up and onboarding", 2: "Build the accounts mini-app", 3: "Connect Demo POS", 4: "Publish, and on a phone",
    5: "Ask: prime cost last week", 6: "You already have this", 7: "Share, and the maintainer approves",
    8: "Recommended, installed, own numbers only", 9: "The change feed",
  };
  const groups = new Map();
  for (const r of rows) {
    const m = /beat-(\d)-/.exec(r.file);
    const key = m ? `Beat ${m[1]}  ${NAMES[m[1]]}` : "Screens  sign-in, owners, staff, Mini-apps, console";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  let bad = 0;
  const keys = [...groups.keys()].sort((a, b) => (a.startsWith("Screens") ? -1 : b.startsWith("Screens") ? 1 : a.localeCompare(b)));
  for (const k of keys) {
    const g = groups.get(k);
    const failed = g.filter((r) => r.outcome === "unexpected").length;
    const flaky = g.filter((r) => r.outcome === "flaky").length;
    const passed = g.filter((r) => r.outcome === "expected" && r.status === "passed").length + flaky;
    const waiting = g.filter((r) => r.outcome === "skipped" && r.expected === "skipped").length;
    if (failed) bad++;
    const verdict = failed ? `FAIL (${failed} failed)` : passed === 0 ? "NOT BUILT (nothing to run yet)" : flaky ? `PASS (flaky: ${flaky})` : "PASS";
    console.log(`  ${k.padEnd(58)} ${verdict.padEnd(26)} ran ${passed + failed}, waiting or skipped ${waiting}`);
  }
  process.exit(bad ? 1 : 0);
' "$OUT"
TABLE=$?

echo
if [[ $FAILED -ne 0 || $SUITE -ne 0 || $TABLE -ne 0 ]]; then
  echo "RESULT: FAIL"
  exit 1
fi
echo "RESULT: PASS (the beats marked NOT BUILT have their steps written down as fixme tests)"

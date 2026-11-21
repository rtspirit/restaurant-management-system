#!/usr/bin/env bash
# Pulls a short-lived Vercel OIDC token for the linked project into .env.local (git-ignored).
# Run after: scripts/preflight-vercel.sh link --yes --project rms-api   (from this folder)
#
# The guard pins VERCEL_ORG_ID. The Vercel CLI then insists on VERCEL_PROJECT_ID too,
# so we read it from the link file and check team and project name first.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

EXPECTED_TEAM="team_RM4toarAtl8vljERLdxRvfeh"
EXPECTED_PROJECT="rms-api"

ORG="$(node -e 'process.stdout.write(require("./.vercel/project.json").orgId)')"
NAME="$(node -e 'process.stdout.write(require("./.vercel/project.json").projectName)')"
PID="$(node -e 'process.stdout.write(require("./.vercel/project.json").projectId)')"
[ "$ORG" = "$EXPECTED_TEAM" ] || { echo "STOP: linked to another team" >&2; exit 1; }
[ "$NAME" = "$EXPECTED_PROJECT" ] || { echo "STOP: linked to another project ($NAME)" >&2; exit 1; }

VERCEL_PROJECT_ID="$PID" ../../scripts/preflight-vercel.sh env pull .env.local --yes
echo "variables written (names only):"
grep -o '^[A-Z_]*=' .env.local || true

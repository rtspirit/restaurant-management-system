#!/usr/bin/env bash
# Runs INSIDE the sandbox. Starts Codex with the setup in codex-args.sh.
# Event lines go to stdout AND to a file in the sandbox, so a later function call can read on from a line number.
#   run-codex.sh <model> <context tokens> <app folder> <task> [thread id to resume]
set -o pipefail
MODEL="$1" CONTEXT="$2" APP="$3" TASK="$4" RESUME="${5:-}"
BASE_URL="https://openrouter.ai/api/v1"
. /tmp/codex-args.sh
cd "$APP" || exit 9
if [ -n "$RESUME" ]; then
  codex "${CODEX_RESUME_ARGS[@]}" "$TASK" </dev/null | tee -a /vercel/codex-events.jsonl
else
  codex "${CODEX_ARGS[@]}" "$TASK" </dev/null | tee /vercel/codex-events.jsonl
fi

#!/usr/bin/env bash
# Sourced INSIDE the sandbox by probe.sh and run-codex.sh. The one Codex setup under test.
# Needs: MODEL (an OpenRouter model id), BASE_URL, APP (folder to work in), CONTEXT (tokens).
# The key is not here. RMS_LLM_DUMMY_KEY holds dummy text; the firewall replaces the header.
CODEX_CONFIG=(
  --config 'approval_policy="never"'
  --config 'sandbox_mode="danger-full-access"'   # the Vercel sandbox is the boundary, so Codex must not build its own
  --config analytics.enabled=false
  --config check_for_update_on_startup=false
  --config 'web_search="disabled"'               # hosted tool, runs at the provider, our firewall cannot stop it
  --config features.image_generation=false
  --config "model_context_window=$CONTEXT"
  --config 'model_provider="rmsllm"'
  --config 'model_providers.rmsllm.name="OpenRouter through the firewall"'
  --config "model_providers.rmsllm.base_url=\"$BASE_URL\""
  --config 'model_providers.rmsllm.env_key="RMS_LLM_DUMMY_KEY"'
  --config 'model_providers.rmsllm.wire_api="responses"'
  --config model_providers.rmsllm.supports_websockets=false
)
# First turn of a thread.
CODEX_ARGS=(exec --json --skip-git-repo-check --cd "$APP" --model "$MODEL" "${CODEX_CONFIG[@]}")
# Follow-up turn on an existing thread ("exec resume" has no --cd: run it from the app folder).
CODEX_RESUME_ARGS=(exec resume "${RESUME:-}" --json --skip-git-repo-check --model "$MODEL" "${CODEX_CONFIG[@]}")

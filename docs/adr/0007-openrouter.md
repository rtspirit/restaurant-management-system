# 0007: In-product agents call models through OpenRouter

Date: 2026-11-21. Status: decided by Rahul.

## Context

The plan said OpenAI only, with one OpenAI key. The sandbox test then found the OpenAI account had no credit. Rahul chose OpenRouter instead: one key with enough credit, and a choice of models without topping up separate accounts.

## Decision

- All in-product model calls (build agent, Ask agent, embeddings) go through OpenRouter with `OPENROUTER_API_KEY`.
- The address is a setting, `RMS_LLM_BASE_URL`. Model names stay in `RMS_BUILD_MODEL`, `RMS_ASK_MODEL` and `RMS_EMBED_MODEL`, written the way OpenRouter lists them.
- The `AgentDriver` interface is unchanged. The first driver still runs the Codex agent inside the sandbox, pointed at OpenRouter. The sandbox firewall allows only that address and adds the key to outgoing calls, so the key never enters the sandbox.
- The OpenAI key in `.env.local` is no longer used. It can be removed.

## To prove before Wave 2 relies on it

1. The Codex agent works against OpenRouter (which request style it needs, and whether OpenRouter offers it).
2. The sandbox firewall adds the key for OpenRouter's address the same way it did for OpenAI's.
3. OpenRouter offers an embeddings model, or embeddings need another route.
4. Which models to name in the three settings, and what they cost.
5. Whether OpenRouter can be told not to let providers keep or train on prompts, since owners' questions will contain their restaurant's numbers.

## Fallback

If the Codex agent cannot be made to work through OpenRouter in the time-boxed test, the build agent uses the plan's section 6 fallback: a simple tool loop that calls the model through OpenRouter and drives the sandbox by commands.

## Proven and decided on 2026-11-21

- **Proven:** the Codex agent works through OpenRouter inside a Vercel Sandbox with the key kept outside (three real runs, two labs' models, a resumed conversation, embeddings). See `docs/spikes/s1b-codex-via-openrouter.md`. No fallback is needed.
- **Settings:** `RMS_BUILD_MODEL` and `RMS_ASK_MODEL` are `openai/gpt-6.2-sol`. `RMS_EMBED_MODEL` is `openai/text-embedding-3-small`.
- **Privacy option: not used for now** (Rahul: "Let the agent tool keep the prompts. It's fine for now. We can scope it out if needed in the future."). Demo data is fictional. Before real restaurant data goes through it, turn off prompt retention and training on the OpenRouter account or key.
- **Budget:** the key carries a $50 limit, which Rahul considers enough for the demo's scope. The key expires on 2026-11-22 at 18:26 UTC. The demo is on 2026-11-21, so that is accepted.

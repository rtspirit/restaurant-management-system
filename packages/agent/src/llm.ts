// The ONE place server code makes a model client. Lead-owned. Used by the planner (task I), the
// Ask agent (task K) and embeddings (task M).
//
// Rules (CLAUDE.md, ADR 0007):
//   - every in-product model call goes through OpenRouter, with OPENROUTER_API_KEY and RMS_LLM_BASE_URL
//   - model names come from RMS_BUILD_MODEL, RMS_ASK_MODEL and RMS_EMBED_MODEL. Never hard-code one.
//   - this module runs on the server only. The key never enters a sandbox, a mini-app or a browser,
//     and is never logged. (The build agent inside the sandbox does not use this module: the
//     sandbox firewall adds the key to its calls from outside.)
// Nothing here makes a call when the module is loaded.
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { EmbeddingModel, LanguageModel } from "ai";

const need = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
};

let provider: ReturnType<typeof createOpenRouter> | undefined;

/** The OpenRouter provider for the Vercel AI SDK. It speaks the chat API (see docs/reference/verified-apis.md, section 10). */
export const llm = (): ReturnType<typeof createOpenRouter> =>
  (provider ??= createOpenRouter({ apiKey: need("OPENROUTER_API_KEY"), baseURL: need("RMS_LLM_BASE_URL") }));

export type LlmUse = "build" | "ask";
const MODEL_ENV: Record<LlmUse, string> = { build: "RMS_BUILD_MODEL", ask: "RMS_ASK_MODEL" };

/** The model id for a use, as OpenRouter lists it. Recorded on sessions and usage rows. */
export const modelId = (use: LlmUse | "embed"): string => need(use === "embed" ? "RMS_EMBED_MODEL" : MODEL_ENV[use]);

/** A chat model for `generateText` / `streamText`. Usage and cost come back in `providerMetadata.openrouter.usage`. */
export const chatModel = (use: LlmUse): LanguageModel => llm()(modelId(use), { usage: { include: true } });

/** The embedding model for `embed` / `embedMany`. Vectors have EMBEDDING_DIMENSIONS numbers. */
export const embeddingModel = (): EmbeddingModel => llm().textEmbeddingModel(modelId("embed"));

/** For tests: forget the cached provider after changing the environment. */
export const resetLlm = (): void => {
  provider = undefined;
};

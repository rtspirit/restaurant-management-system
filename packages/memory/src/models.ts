// The two model calls memory makes, behind one seam so unit tests can put a stand-in in place
// (no network in unit tests). Real calls go through @rms/agent: OpenRouter, the key from the
// environment, the model names from RMS_EMBED_MODEL and RMS_BUILD_MODEL. Nothing here logs a
// key, a prompt or a vector.
import { chatModel, embeddingModel, modelId } from "@rms/agent";
import { Output, embedMany, generateText } from "ai";
import { z } from "zod";
import { checkedEmbedding } from "./text.js";

export type EmbedResult = { embeddings: number[][]; tokens: number; costMicros: number; model: string };
export type Embedder = (values: string[]) => Promise<EmbedResult>;

/** What the model writes for a session. Same limits as `SessionSummary` in the contract. */
export const SummaryDraft = z.object({
  text: z.string().min(1).max(600),
  facts: z.array(z.string().min(1).max(200)).max(5),
});
export type SummaryDraft = z.infer<typeof SummaryDraft>;

export type SummariseResult = { output: SummaryDraft; inputTokens: number; outputTokens: number; costMicros: number; model: string };
export type Summariser = (input: { instructions: string; prompt: string }) => Promise<SummariseResult>;

/** OpenRouter reports the cost of a call in USD here when it can. Zero when it does not. */
const costMicrosOf = (meta: unknown): number => {
  const cost = (meta as { openrouter?: { usage?: { cost?: unknown } } } | undefined)?.openrouter?.usage?.cost;
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? Math.round(cost * 1_000_000) : 0;
};

const realEmbedder: Embedder = async (values) => {
  const r = await embedMany({ model: embeddingModel(), values, maxRetries: 1 });
  return { embeddings: r.embeddings.map((e) => [...e]), tokens: r.usage.tokens, costMicros: costMicrosOf(r.providerMetadata), model: modelId("embed") };
};

const realSummariser: Summariser = async ({ instructions, prompt }) => {
  const r = await generateText({ model: chatModel("build"), instructions, prompt, output: Output.object({ schema: SummaryDraft }), maxRetries: 1 });
  return {
    output: SummaryDraft.parse(r.output),
    inputTokens: r.totalUsage.inputTokens ?? 0,
    outputTokens: r.totalUsage.outputTokens ?? 0,
    costMicros: costMicrosOf(r.providerMetadata),
    model: modelId("build"),
  };
};

let embedder: Embedder = realEmbedder;
let summariser: Summariser = realSummariser;

export const embedTexts: Embedder = (values) => embedder(values);
export const summarise: Summariser = (input) => summariser(input);

// Vectors of profile lines, kept in this process so a duplicate check embeds only the request
// and lines it has not seen. Keyed by the exact text: a vector depends on the text and the model
// only, so a cached one tells nobody anything about whose line it was. Cleared when the model
// changes, when it grows past the cap, and when tests swap the embedder.
const LINE_CACHE_MAX = 2000;
const lineCache = new Map<string, number[]>();
let lineCacheModel = "";

/**
 * Embeds `request` (always, never cached) plus any of `lines` not cached yet, in one call.
 * Every vector is checked for length. Returns the call's result (for the usage row) and a map
 * from text to vector covering the request and every line. Throws if the call fails.
 */
export const embedWithCache = async (request: string, lines: readonly string[]): Promise<{ result: EmbedResult; vectors: Map<string, number[]> }> => {
  const missing = lines.filter((l) => l !== request && !lineCache.has(l));
  const result = await embedTexts([request, ...missing]);
  if (result.embeddings.length !== missing.length + 1) throw new Error("Embedding count does not match");
  const checked = result.embeddings.map((v) => checkedEmbedding(v));
  if (result.model !== lineCacheModel || lineCache.size + missing.length > LINE_CACHE_MAX) {
    lineCache.clear();
    lineCacheModel = result.model;
  }
  const vectors = new Map<string, number[]>();
  vectors.set(request, checked[0] as number[]);
  missing.forEach((l, i) => lineCache.set(l, checked[i + 1] as number[]));
  for (const l of lines) {
    const v = lineCache.get(l) ?? vectors.get(l);
    if (v) vectors.set(l, v);
    else {
      // Cleared above because the model changed: embed what is left in a second call.
      const again = await embedTexts([l]);
      vectors.set(l, checkedEmbedding(again.embeddings[0]));
    }
  }
  return { result, vectors };
};

/**
 * For tests only: replace the embedder and/or the summariser. Returns a function that puts the
 * real ones back. Production code never calls this.
 */
export const useMemoryModels = (models: { embed?: Embedder; summarise?: Summariser }): (() => void) => {
  if (models.embed) embedder = models.embed;
  if (models.summarise) summariser = models.summarise;
  lineCache.clear();
  return () => {
    lineCache.clear();
    embedder = realEmbedder;
    summariser = realSummariser;
  };
};

import { afterEach, describe, expect, it } from "vitest";
import { chatModel, embeddingModel, modelId, resetLlm } from "./llm.js";

const KEYS = ["OPENROUTER_API_KEY", "RMS_LLM_BASE_URL", "RMS_BUILD_MODEL", "RMS_ASK_MODEL", "RMS_EMBED_MODEL"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetLlm();
});

// No test here makes a model call.
describe("the model client", () => {
  it("takes every model name from the environment", () => {
    process.env.RMS_BUILD_MODEL = "lab/build-model";
    process.env.RMS_ASK_MODEL = "lab/ask-model";
    process.env.RMS_EMBED_MODEL = "lab/embed-model";
    expect(modelId("build")).toBe("lab/build-model");
    expect(modelId("ask")).toBe("lab/ask-model");
    expect(modelId("embed")).toBe("lab/embed-model");
  });

  it("refuses to work without a key, an address or a model name, and never falls back to a default", () => {
    for (const k of KEYS) delete process.env[k];
    resetLlm();
    expect(() => chatModel("ask")).toThrow(/RMS_ASK_MODEL|OPENROUTER_API_KEY|RMS_LLM_BASE_URL/);
    expect(() => embeddingModel()).toThrow(/RMS_EMBED_MODEL|OPENROUTER_API_KEY|RMS_LLM_BASE_URL/);
    process.env.RMS_ASK_MODEL = "lab/ask-model";
    expect(() => chatModel("ask")).toThrow(/OPENROUTER_API_KEY/);
    process.env.OPENROUTER_API_KEY = "not-a-real-key";
    expect(() => chatModel("ask")).toThrow(/RMS_LLM_BASE_URL/);
  });

  it("builds a model for the named id once everything is set", () => {
    process.env.OPENROUTER_API_KEY = "not-a-real-key";
    process.env.RMS_LLM_BASE_URL = "https://llm.invalid/api/v1";
    process.env.RMS_ASK_MODEL = "lab/ask-model";
    process.env.RMS_EMBED_MODEL = "lab/embed-model";
    resetLlm();
    expect((chatModel("ask") as { modelId: string }).modelId).toBe("lab/ask-model");
    expect((embeddingModel() as { modelId: string }).modelId).toBe("lab/embed-model");
  });
});

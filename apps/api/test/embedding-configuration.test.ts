import { describe, expect, it } from "vitest";
import {
  validateEmbeddingConfigurationDraft,
  type EmbeddingConfigurationDraft
} from "../src/semantic/embedding/configuration.js";

describe("embedding configuration contract", () => {
  it("accepts every supported authenticated field", () => {
    expect(validateEmbeddingConfigurationDraft(draft())).toEqual([]);
  });

  it("accepts an explicitly unauthenticated local endpoint", () => {
    expect(validateEmbeddingConfigurationDraft({
      ...draft(),
      authenticationMode: "none",
      apiKey: null,
      baseUrl: "http://127.0.0.1:11434/v1"
    })).toEqual([]);
  });

  it.each([
    ["displayName", ""],
    ["authenticationMode", "invalid"],
    ["baseUrl", "file:///private/model"],
    ["modelName", ""],
    ["requestedDimension", 0],
    ["maximumInputTokens", 0],
    ["batchSize", 0],
    ["timeoutMs", 99],
    ["retryCount", 11],
    ["minimumIntervalMs", -1],
    ["concurrency", 0],
    ["maximumResponseBytes", 100],
    ["minimumVectorRelevance", -0.01],
    ["minimumVectorRelevance", 1.01],
    ["minimumVectorRelevance", Number.NaN]
  ] as const)("rejects invalid %s", (field, value) => {
    const input = { ...draft(), [field]: value } as EmbeddingConfigurationDraft;
    expect(validateEmbeddingConfigurationDraft(input))
      .toContainEqual(expect.objectContaining({ field }));
  });

  it("requires a key for authenticated creation and forbids one for none mode", () => {
    expect(validateEmbeddingConfigurationDraft({ ...draft(), apiKey: null }))
      .toContainEqual(expect.objectContaining({ field: "apiKey" }));
    expect(validateEmbeddingConfigurationDraft({
      ...draft(), authenticationMode: "none", apiKey: "must-not-persist"
    })).toContainEqual(expect.objectContaining({ field: "apiKey" }));
  });
});

function draft(): EmbeddingConfigurationDraft {
  return {
    displayName: "Primary embedding",
    authenticationMode: "api_key",
    baseUrl: "https://embedding.example/v1",
    apiKey: "embedding-secret",
    modelName: "text-embedding-model",
    requestedDimension: 1_536,
    normalization: "l2",
    maximumInputTokens: 8_192,
    batchSize: 32,
    timeoutMs: 10_000,
    retryCount: 2,
    minimumIntervalMs: 20,
    concurrency: 4,
    maximumResponseBytes: 8_388_608,
    minimumVectorRelevance: 0.7
  };
}

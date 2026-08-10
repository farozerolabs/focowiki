import { describe, expect, it } from "vitest";

import {
  validateRerankerConfigurationDraft,
  type RerankerConfigurationDraft
} from "../src/semantic/reranker/configuration.js";

describe("reranker model-only configuration contract", () => {
  it("accepts every supported authenticated model field", () => {
    expect(validateRerankerConfigurationDraft(draft())).toEqual([]);
    expect(Object.keys(draft()).sort()).toEqual([
      "apiKey",
      "authenticationMode",
      "baseUrl",
      "concurrency",
      "displayName",
      "minimumIntervalMs",
      "modelName",
      "retryCount",
      "timeoutMs"
    ]);
  });

  it("accepts explicitly unauthenticated local endpoints only", () => {
    expect(validateRerankerConfigurationDraft({
      ...draft(),
      authenticationMode: "none",
      apiKey: null,
      baseUrl: "http://127.0.0.1:11434/v1"
    })).toEqual([]);
    expect(validateRerankerConfigurationDraft({
      ...draft(),
      authenticationMode: "none",
      apiKey: null,
      baseUrl: "https://reranker.example/v1"
    })).toContainEqual(expect.objectContaining({ field: "baseUrl" }));
  });

  it.each([
    ["displayName", ""],
    ["authenticationMode", "invalid"],
    ["baseUrl", "file:///private/model"],
    ["modelName", ""],
    ["timeoutMs", 99],
    ["retryCount", 11],
    ["minimumIntervalMs", -1],
    ["concurrency", 0]
  ] as const)("rejects invalid %s", (field, value) => {
    expect(validateRerankerConfigurationDraft({
      ...draft(), [field]: value
    } as RerankerConfigurationDraft)).toContainEqual(
      expect.objectContaining({ field })
    );
  });

  it.each([
    "https://reranker.example/v1/rerank",
    "https://reranker.example/v1/chat/completions"
  ])("rejects an operation endpoint instead of a base URL: %s", (baseUrl) => {
    expect(validateRerankerConfigurationDraft({
      ...draft(), baseUrl
    })).toContainEqual(expect.objectContaining({ field: "baseUrl" }));
  });

  it("requires authenticated credentials and contains no request-ranking fields", () => {
    expect(validateRerankerConfigurationDraft({ ...draft(), apiKey: null }))
      .toContainEqual(expect.objectContaining({ field: "apiKey" }));
    const serialized = JSON.stringify(draft());
    for (const forbidden of [
      "limit", "rerankTopK", "rerankScoreThreshold", "sourceExcerpt"
    ]) expect(serialized).not.toContain(forbidden);
  });
});

function draft(): RerankerConfigurationDraft {
  return {
    displayName: "Primary reranker",
    authenticationMode: "api_key",
    baseUrl: "https://reranker.example/v1",
    apiKey: "reranker-secret",
    modelName: "rerank-model",
    timeoutMs: 1_500,
    retryCount: 1,
    minimumIntervalMs: 20,
    concurrency: 4
  };
}

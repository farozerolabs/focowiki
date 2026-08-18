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

  it("rejects unknown configuration fields instead of silently dropping them", () => {
    expect(validateRerankerConfigurationDraft({
      ...draft(), unknownField: true
    } as unknown as RerankerConfigurationDraft)).toContainEqual({
      field: "unknownField",
      code: "unknown_field"
    });
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

  it.each([
    ["timeoutMs", 100, 300_000, 99, 300_001],
    ["retryCount", 0, 10, -1, 11],
    ["minimumIntervalMs", 0, 60_000, -1, 60_001],
    ["concurrency", 1, 64, 0, 65]
  ] as const)(
    "accepts %s boundaries and rejects values immediately outside them",
    (field, minimum, maximum, below, above) => {
      expect(validateRerankerConfigurationDraft({
        ...draft(), [field]: minimum
      })).toEqual([]);
      expect(validateRerankerConfigurationDraft({
        ...draft(), [field]: maximum
      })).toEqual([]);
      for (const value of [below, above, 1.5, "1", null]) {
        expect(validateRerankerConfigurationDraft({
          ...draft(), [field]: value
        } as unknown as RerankerConfigurationDraft)).toContainEqual(
          expect.objectContaining({ field })
        );
      }
    }
  );

  it("validates text, URL, and credential byte bounds", () => {
    expect(validateRerankerConfigurationDraft({
      ...draft(), displayName: "a".repeat(255), modelName: "b".repeat(255),
      apiKey: "k".repeat(16_384)
    })).toEqual([]);
    for (const [field, value] of [
      ["displayName", "a".repeat(256)],
      ["modelName", "b".repeat(256)],
      ["apiKey", "k".repeat(16_385)],
      ["baseUrl", `https://reranker.example/${"p".repeat(2_100)}`]
    ] as const) {
      expect(validateRerankerConfigurationDraft({
        ...draft(), [field]: value
      } as unknown as RerankerConfigurationDraft)).toContainEqual(
        expect.objectContaining({ field })
      );
    }
  });

  it("returns field issues instead of throwing for omitted, null, or wrong JSON types", () => {
    for (const field of Object.keys(draft()) as Array<keyof RerankerConfigurationDraft>) {
      for (const value of [undefined, null, {}, []]) {
        expect(() => validateRerankerConfigurationDraft({
          ...draft(), [field]: value
        } as unknown as RerankerConfigurationDraft)).not.toThrow();
        expect(validateRerankerConfigurationDraft({
          ...draft(), [field]: value
        } as unknown as RerankerConfigurationDraft)).toContainEqual(
          expect.objectContaining({ field })
        );
      }
    }
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

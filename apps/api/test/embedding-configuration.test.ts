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

  it("rejects unknown configuration fields instead of silently dropping them", () => {
    expect(validateEmbeddingConfigurationDraft({
      ...draft(), unknownField: true
    } as unknown as EmbeddingConfigurationDraft)).toContainEqual({
      field: "unknownField",
      code: "unknown_field"
    });
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
    ["maximumResponseBytes", 100]
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

  it.each([
    ["requestedDimension", 1, 65_536, 0, 65_537],
    ["maximumInputTokens", 1, 1_048_576, 0, 1_048_577],
    ["batchSize", 1, 2_048, 0, 2_049],
    ["timeoutMs", 100, 300_000, 99, 300_001],
    ["retryCount", 0, 10, -1, 11],
    ["minimumIntervalMs", 0, 60_000, -1, 60_001],
    ["concurrency", 1, 64, 0, 65],
    ["maximumResponseBytes", 1_024, 67_108_864, 1_023, 67_108_865]
  ] as const)(
    "accepts %s boundaries and rejects values immediately outside them",
    (field, minimum, maximum, below, above) => {
      expect(validateEmbeddingConfigurationDraft({
        ...draft(), [field]: minimum
      })).toEqual([]);
      expect(validateEmbeddingConfigurationDraft({
        ...draft(), [field]: maximum
      })).toEqual([]);
      for (const value of [below, above, 1.5, "1", null]) {
        if (field === "requestedDimension" && value === null) continue;
        expect(validateEmbeddingConfigurationDraft({
          ...draft(), [field]: value
        } as unknown as EmbeddingConfigurationDraft)).toContainEqual(
          expect.objectContaining({ field })
        );
      }
    }
  );

  it("validates nullable dimension, normalization, text, URL, and credential bounds", () => {
    expect(validateEmbeddingConfigurationDraft({
      ...draft(), requestedDimension: null, normalization: "none"
    })).toEqual([]);
    expect(validateEmbeddingConfigurationDraft({
      ...draft(), displayName: "a".repeat(255), modelName: "b".repeat(255),
      apiKey: "k".repeat(16_384)
    })).toEqual([]);
    for (const [field, value] of [
      ["displayName", "a".repeat(256)],
      ["modelName", "b".repeat(256)],
      ["apiKey", "k".repeat(16_385)],
      ["normalization", "unit"],
      ["baseUrl", `https://embedding.example/${"p".repeat(2_100)}`]
    ] as const) {
      expect(validateEmbeddingConfigurationDraft({
        ...draft(), [field]: value
      } as unknown as EmbeddingConfigurationDraft)).toContainEqual(
        expect.objectContaining({ field })
      );
    }
  });

  it("returns field issues instead of throwing for omitted, null, or wrong JSON types", () => {
    for (const field of Object.keys(draft()) as Array<keyof EmbeddingConfigurationDraft>) {
      for (const value of [undefined, null, {}, []]) {
        if (field === "requestedDimension" && value === null) continue;
        expect(() => validateEmbeddingConfigurationDraft({
          ...draft(), [field]: value
        } as unknown as EmbeddingConfigurationDraft)).not.toThrow();
        expect(validateEmbeddingConfigurationDraft({
          ...draft(), [field]: value
        } as unknown as EmbeddingConfigurationDraft)).toContainEqual(
          expect.objectContaining({ field })
        );
      }
    }
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
    maximumResponseBytes: 8_388_608
  };
}

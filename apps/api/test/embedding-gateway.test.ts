import { describe, expect, it, vi } from "vitest";
import { encryptRuntimeSecret } from "../src/runtime-settings/encryption.js";
import type { EmbeddingConfigurationPrivate } from
  "../src/semantic/embedding/configuration.js";
import { createEmbeddingGateway } from
  "../src/semantic/embedding/gateway.js";
import { EmbeddingTransportError } from
  "../src/semantic/embedding/openai-compatible-transport.js";

describe("process-level embedding gateway", () => {
  it("batches, bounds concurrency, decrypts credentials, and normalizes vectors", async () => {
    let active = 0;
    let maximumActive = 0;
    const transport = { embed: vi.fn(async (request) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      expect(request.apiKey).toBe("embedding-secret");
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return {
        modelName: request.modelName,
        dimension: 2,
        vectors: request.inputs.map(() => [3, 4]),
        inputTokens: null,
        totalTokens: null
      };
    }) };
    const gateway = createEmbeddingGateway({
      transport,
      deploymentSecret: "deployment-secret"
    });
    const vectors = await gateway.embed({
      configuration: { ...configuration(), minimumIntervalMs: 0 },
      inputs: ["a", "b", "c", "d", "e"],
      signal: null
    });
    expect(transport.embed).toHaveBeenCalledTimes(3);
    expect(maximumActive).toBe(2);
    expect(vectors).toEqual([[0.6, 0.8], [0.6, 0.8], [0.6, 0.8], [0.6, 0.8], [0.6, 0.8]]);
  });

  it("retries only retryable failures within the configured bound", async () => {
    const transport = { embed: vi.fn()
      .mockRejectedValueOnce(new EmbeddingTransportError("rate_limited", true))
      .mockResolvedValueOnce({
        modelName: "embedding-model",
        dimension: 2,
        vectors: [[1, 0]],
        inputTokens: null,
        totalTokens: null
      }) };
    const delay = vi.fn(async () => undefined);
    const gateway = createEmbeddingGateway({
      transport,
      deploymentSecret: "deployment-secret",
      delay
    });
    await expect(gateway.embed({
      configuration: configuration(),
      inputs: ["a"],
      signal: null
    })).resolves.toEqual([[1, 0]]);
    expect(transport.embed).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledWith(1, null);
  });

  it("sends a dimension only when the configuration explicitly requests one", async () => {
    const transport = { embed: vi.fn(async (request) => ({
      modelName: request.modelName,
      dimension: 2,
      vectors: request.inputs.map(() => [1, 0]),
      inputTokens: null,
      totalTokens: null
    })) };
    const gateway = createEmbeddingGateway({
      transport,
      deploymentSecret: "deployment-secret"
    });

    await expect(gateway.embed({
      configuration: { ...configuration(), requestedDimension: null },
      inputs: ["a"],
      signal: null
    })).resolves.toEqual([[1, 0]]);

    expect(transport.embed).toHaveBeenCalledWith(expect.objectContaining({
      requestedDimension: null
    }));
  });

  it("rejects unvalidated, oversized, cancelled, and dimension-drifted work", async () => {
    const gateway = createEmbeddingGateway({
      transport: {
        embed: vi.fn(async () => ({
          modelName: "embedding-model",
          dimension: 3,
          vectors: [[1, 0, 0]],
          inputTokens: null,
          totalTokens: null
        }))
      },
      deploymentSecret: "deployment-secret"
    });
    await expect(gateway.embed({
      configuration: { ...configuration(), validationStatus: "not_tested" },
      inputs: ["a"], signal: null
    })).rejects.toThrow("not validated");
    await expect(gateway.embed({
      configuration: { ...configuration(), maximumInputTokens: 1 },
      inputs: ["12345"], signal: null
    })).rejects.toThrow("exceeds");
    await expect(gateway.embed({
      configuration: configuration(), inputs: ["a"], signal: null
    })).rejects.toMatchObject({ code: "dimension_mismatch" });
  });
});

function configuration(): EmbeddingConfigurationPrivate {
  return {
    publicId: "embedding-config",
    revisionPublicId: "embedding-revision",
    revision: 1,
    displayName: "Embedding",
    authenticationMode: "api_key",
    baseUrl: "https://embedding.example/v1",
    encryptedApiKey: encryptRuntimeSecret({
      value: "embedding-secret",
      secret: "deployment-secret"
    }),
    apiKeyConfigured: true,
    modelName: "embedding-model",
    requestedDimension: 2,
    resolvedDimension: 2,
    normalization: "l2",
    maximumInputTokens: 8_192,
    batchSize: 2,
    timeoutMs: 1_000,
    retryCount: 1,
    minimumIntervalMs: 1,
    concurrency: 2,
    maximumResponseBytes: 1_000_000,
    minimumVectorRelevance: 0.7,
    vectorProducingRevisionPublicId: "embedding-revision-a",
    queryPolicyRevisionPublicId: "embedding-revision-a",
    validationStatus: "valid",
    validationFingerprintSha256: "a".repeat(64),
    safeValidationErrorCode: null,
    lifecycleStatus: "active",
    createdAt: "2026-08-08T00:00:00.000Z"
  };
}

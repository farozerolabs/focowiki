import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmbeddingBatchCoordinator } from
  "../src/semantic/embedding/batch-coordinator.js";

describe("embedding batch coordinator", () => {
  afterEach(() => vi.useRealTimers());

  it("flushes a partial provider micro-batch on its bounded window", async () => {
    vi.useFakeTimers();
    const embed = vi.fn(async ({ inputs }: { inputs: readonly string[] }) =>
      inputs.map(() => [1, 0, 0]));
    const coordinator = createEmbeddingBatchCoordinator({
      gateway: { embed },
      batchWindowMs: 50
    });

    const pending = coordinator.embed({
      configuration: configuration(),
      inputs: ["one input"],
      signal: null
    });
    expect(coordinator.stats()).toMatchObject({
      providerRequestCount: 0,
      pendingInputs: 1
    });
    await vi.advanceTimersByTimeAsync(49);
    expect(embed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual([[1, 0, 0]]);
    expect(embed).toHaveBeenCalledOnce();
    expect(coordinator.stats()).toMatchObject({
      providerRequestCount: 1,
      inputCount: 1,
      maximumBatchSize: 1,
      batchCapacity: 16,
      pendingInputs: 0,
      activeFlushes: 0
    });
  });
});

function configuration() {
  return {
    publicId: "embedding-1",
    revisionPublicId: "embedding-revision-1",
    revision: 1,
    displayName: "Embedding",
    authenticationMode: "none" as const,
    baseUrl: "http://embedding.local/v1",
    encryptedApiKey: null,
    apiKeyConfigured: false,
    modelName: "embedding-model",
    requestedDimension: 3,
    resolvedDimension: 3,
    normalization: "l2" as const,
    maximumInputTokens: 8_192,
    batchSize: 16,
    timeoutMs: 10_000,
    retryCount: 2,
    minimumIntervalMs: 20,
    concurrency: 2,
    maximumResponseBytes: 1_000_000,
    vectorProducingRevisionPublicId: "embedding-revision-1",
    validationStatus: "valid" as const,
    validationFingerprintSha256: "a".repeat(64),
    safeValidationErrorCode: null,
    lifecycleStatus: "active" as const,
    createdAt: "2026-08-08T00:00:00.000Z"
  };
}

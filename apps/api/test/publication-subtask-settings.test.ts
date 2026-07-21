import { describe, expect, it } from "vitest";
import { resolvePublicationSubtaskWorkerSettings } from "../src/worker/publication-subtask-settings.js";

describe("publication subtask worker settings", () => {
  it("fills projection slots independently from the outer generation claim size", () => {
    expect(resolvePublicationSubtaskWorkerSettings({
      generationClaimBatchSize: 1,
      projectionPartitionConcurrency: 8,
      pollIntervalMs: 250,
      lockTtlSeconds: 300,
      heartbeatIntervalMs: 30_000,
      retryDelayMs: 5_000
    })).toEqual({
      claimBatchSize: 32,
      concurrency: 8,
      pollIntervalMs: 250,
      lockTtlSeconds: 300,
      heartbeatIntervalMs: 30_000,
      retryDelayMs: 5_000
    });
  });

  it("preserves a larger explicitly configured claim batch", () => {
    expect(resolvePublicationSubtaskWorkerSettings({
      generationClaimBatchSize: 64,
      projectionPartitionConcurrency: 8,
      pollIntervalMs: 250,
      lockTtlSeconds: 300,
      heartbeatIntervalMs: 30_000,
      retryDelayMs: 5_000
    }).claimBatchSize).toBe(64);
  });
});

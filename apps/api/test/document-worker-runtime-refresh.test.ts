import { describe, expect, it, vi } from "vitest";
import { watchDocumentWorkerRuntime } from
  "../src/document-indexing/infrastructure/production-runtime.js";

describe("document worker runtime refresh", () => {
  it("applies a changed durable capacity once without restarting the worker", async () => {
    const controller = new AbortController();
    const initial = runtimeState(2);
    const changed = runtimeState(18);
    const reads = [initial, changed, changed];
    const apply = vi.fn(async () => undefined);

    await watchDocumentWorkerRuntime({
      initial,
      read: async () => reads.shift() ?? changed,
      apply,
      wait: async () => {
        if (reads.length === 0) controller.abort();
      },
      signal: controller.signal,
      pollIntervalMs: 1
    });

    expect(apply).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith(changed);
  });
});

function runtimeState(sourceFileConcurrency: number) {
  return {
    workerConfig: {
      sourceFileConcurrency,
      claimBatchSize: sourceFileConcurrency * 2,
      pollIntervalMs: 100,
      lockTtlSeconds: 30,
      heartbeatIntervalMs: 10_000,
      jobMaxAttempts: 3,
      jobRetryDelayMs: 1_000,
      sourceQueueHardDepth: 10_000,
      sourceQueueResumeDepth: 8_000,
      sourceQueueHardAgeSeconds: 300,
      sourceQueueResumeAgeSeconds: 120,
      shutdownGraceMs: 30_000,
      completedJobRetentionDays: 7,
      failedJobRetentionDays: 30,
      deadLetterJobRetentionDays: 90,
      retentionCleanupBatchSize: 100,
      hardDeleteConcurrency: 1,
      hardDeleteDatabaseBatchSize: 500,
      hardDeleteObjectBatchSize: 500,
      hardDeleteMaxAttempts: 3,
      hardDeleteRetryDelayMs: 30_000,
      hardDeleteFailedRetentionDays: 30
    },
    resourceCapacity: {
      documentConcurrency: sourceFileConcurrency,
      sourceObjectReadConcurrency: sourceFileConcurrency,
      generationModelConcurrency: 40,
      graphRagConcurrency: sourceFileConcurrency >= 17 ? 3 : 2,
      embeddingConcurrency: 40,
      databaseConnectionLimit: 16,
      searchConcurrency: 8
    }
  };
}

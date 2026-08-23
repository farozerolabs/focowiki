import { describe, expect, it } from "vitest";
import { deriveDocumentWorkerRuntimeSettings } from
  "../src/document-indexing/application/document-worker-settings.js";
import type { WorkerRuntimeConfig } from "../src/config.js";

describe("document worker settings", () => {
  it("derives hidden scheduler values from deployment defaults", () => {
    const result = deriveDocumentWorkerRuntimeSettings({
      deployment: {
        sourceFileConcurrency: 8,
        claimBatchSize: 32,
        pollIntervalMs: 2_000,
        lockTtlSeconds: 900,
        heartbeatIntervalMs: 30_000,
        jobMaxAttempts: 3,
        jobRetryDelayMs: 10_000,
        completedJobRetentionDays: 30,
        retentionCleanupBatchSize: 100
      } as Required<WorkerRuntimeConfig>,
      stored: {
        sourceFileConcurrency: 12,
        s3Concurrency: 20,
        jobMaxAttempts: 5,
        jobRetryDelayMs: 20_000,
        completedJobRetentionDays: 45
      }
    });

    expect(result).toMatchObject({
      sourceFileConcurrency: 12,
      sourceObjectReadConcurrency: 20,
      claimBatchSize: 24,
      pollIntervalMs: 2_000,
      lockTtlSeconds: 900,
      heartbeatIntervalMs: 30_000,
      jobMaxAttempts: 5,
      jobRetryDelayMs: 20_000,
      completedJobRetentionDays: 45
    });
  });

  it("uses the independent S3 default when no worker settings are stored", () => {
    const result = deriveDocumentWorkerRuntimeSettings({
      deployment: {
        sourceFileConcurrency: 8,
        claimBatchSize: 32,
        pollIntervalMs: 2_000,
        lockTtlSeconds: 900,
        heartbeatIntervalMs: 30_000,
        jobMaxAttempts: 3,
        jobRetryDelayMs: 10_000,
        completedJobRetentionDays: 30,
        retentionCleanupBatchSize: 100
      } as Required<WorkerRuntimeConfig>,
      stored: null
    });

    expect(result.sourceObjectReadConcurrency).toBe(40);
  });
});

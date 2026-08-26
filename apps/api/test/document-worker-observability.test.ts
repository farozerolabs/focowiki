import { describe, expect, it } from "vitest";
import { createDocumentWorkerObservability } from
  "../src/document-indexing/application/document-worker-observability.js";

describe("document worker observability", () => {
  it("records one bounded single-job publication event", () => {
    const events: unknown[] = [];
    const observer = createDocumentWorkerObservability({
      write: (event) => events.push(event)
    });
    observer.publication({
      event: "activated",
      knowledgeBaseId: "kb-one",
      jobPublicId: "publication-job-one",
      itemCount: 5,
      attemptCount: 1,
      durationMs: 17,
      objectPutCount: 2,
      objectReuseCount: 5,
      objectRequestCount: 4,
      objectAttemptedBytes: 1024,
      peakActiveScopeCount: 2,
      outputCount: 8,
      navigationMutationCount: 1,
      navigationLeafCount: 3,
      navigationEntryCount: 400,
      maximumNavigationMutationBytes: 90_000,
      heapUsedBytes: 100,
      heapLimitBytes: 512,
      rssBytes: 200,
      errorCode: null
    });
    expect(events).toEqual([{
      level: "info",
      event: "worker.publication_job_activated",
      fields: {
        event: "activated",
        knowledgeBaseId: "kb-one",
        jobPublicId: "publication-job-one",
        itemCount: 5,
        attemptCount: 1,
        durationMs: 17,
        objectPutCount: 2,
        objectReuseCount: 5,
        objectRequestCount: 4,
        objectAttemptedBytes: 1024,
        peakActiveScopeCount: 2,
        outputCount: 8,
        navigationMutationCount: 1,
        navigationLeafCount: 3,
        navigationEntryCount: 400,
        maximumNavigationMutationBytes: 90_000,
        heapUsedBytes: 100,
        heapLimitBytes: 512,
        rssBytes: 200,
        errorCode: null
      }
    }]);
  });

  it("deduplicates queue depth and rejects unsafe publication values", () => {
    const events: unknown[] = [];
    const observer = createDocumentWorkerObservability({
      write: (event) => events.push(event)
    });
    observer.queue({ waiting: 7, oldestAgeMs: 1_250 });
    observer.queue({ waiting: 7, oldestAgeMs: 2_250 });
    expect(events).toHaveLength(1);
    expect(() => observer.publication({
      event: "failed",
      knowledgeBaseId: "kb-one",
      jobPublicId: "publication-job-one",
      itemCount: 1,
      attemptCount: 1,
      durationMs: 1,
      objectPutCount: 0,
      objectReuseCount: 0,
      objectRequestCount: 0,
      objectAttemptedBytes: 0,
      peakActiveScopeCount: 0,
      outputCount: 0,
      navigationMutationCount: 0,
      navigationLeafCount: 0,
      navigationEntryCount: 0,
      maximumNavigationMutationBytes: 0,
      heapUsedBytes: 100,
      heapLimitBytes: 512,
      rssBytes: 200,
      errorCode: "unsafe error"
    })).toThrow("error code is invalid");
  });

  it("records bounded S3 retry and status diagnostics", () => {
    const events: unknown[] = [];
    const observer = createDocumentWorkerObservability({
      write: (event) => events.push(event)
    });

    observer.storageRequest({
      operation: "put",
      safeObjectKeyHash: "a".repeat(64),
      durationMs: 1250,
      outcome: "failed",
      errorCode: "InternalError",
      attemptCount: 3,
      httpStatusCode: 500
    });

    expect(events).toEqual([{
      level: "info",
      event: "worker.storage_request",
      fields: {
        operation: "put",
        safeObjectKeyHash: "a".repeat(64),
        durationMs: 1250,
        outcome: "failed",
        errorCode: "InternalError",
        attemptCount: 3,
        httpStatusCode: 500
      }
    }]);
  });

  it("records bounded publication runtime failure and recovery diagnostics", () => {
    const events: unknown[] = [];
    const observer = createDocumentWorkerObservability({
      write: (event) => events.push(event)
    });

    observer.publicationRuntime({
      event: "failed",
      errorCode: "database_unavailable",
      failureCount: 3,
      suppressedFailureCount: 2,
      durationMs: 30_000
    });
    observer.publicationRuntime({
      event: "recovered",
      errorCode: "database_unavailable",
      failureCount: 3,
      suppressedFailureCount: 0,
      durationMs: 31_000
    });

    expect(events).toEqual([
      {
        level: "error",
        event: "worker.publication_runtime_failed",
        fields: {
          event: "failed",
          errorCode: "database_unavailable",
          failureCount: 3,
          suppressedFailureCount: 2,
          durationMs: 30_000
        }
      },
      {
        level: "info",
        event: "worker.publication_runtime_recovered",
        fields: {
          event: "recovered",
          errorCode: "database_unavailable",
          failureCount: 3,
          suppressedFailureCount: 0,
          durationMs: 31_000
        }
      }
    ]);
  });
});

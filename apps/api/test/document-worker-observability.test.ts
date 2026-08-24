import { describe, expect, it } from "vitest";
import { createDocumentWorkerObservability } from
  "../src/document-indexing/application/document-worker-observability.js";

describe("document worker observability", () => {
  it("records safe bounded publication amplification counters", () => {
    const events: unknown[] = [];
    const observer = createDocumentWorkerObservability({
      write: (event) => events.push(event)
    });

    observer.publicationProjection({
      knowledgeBaseId: "kb-one",
      generationPublicId: "projection-generation-one",
      planningMode: "delta",
      rendererContractVersion: "portable-okf-v3",
      affectedSourceCount: 18,
      basePageCount: 100,
      recordsRendered: 118,
      objectPutCount: 36,
      objectReuseCount: 82,
      putByteCount: 4_096,
      renewalCount: 2,
      maximumHeartbeatAgeMs: 9_500,
      heapUsedBytes: 128,
      heapLimitBytes: 512,
      rssBytes: 256,
      changedRecordCount: 80,
      chunkCount: 4,
      peakBufferedRecordCount: 20,
      touchedShardCount: 3
    });

    expect(events).toEqual([log("worker.publication_projection", {
      knowledgeBaseId: "kb-one",
      generationPublicId: "projection-generation-one",
      planningMode: "delta",
      rendererContractVersion: "portable-okf-v3",
      affectedSourceCount: 18,
      basePageCount: 100,
      recordsRendered: 118,
      objectPutCount: 36,
      objectReuseCount: 82,
      putByteCount: 4_096,
      renewalCount: 2,
      maximumHeartbeatAgeMs: 9_500,
      heapUsedBytes: 128,
      heapLimitBytes: 512,
      rssBytes: 256,
      changedRecordCount: 80,
      chunkCount: 4,
      peakBufferedRecordCount: 20,
      touchedShardCount: 3
    })]);
  });

  it("records bounded queue, lifecycle, provider, activation, and cleanup facts", () => {
    const events: unknown[] = [];
    const observer = createDocumentWorkerObservability({
      write: (event) => events.push(event)
    });

    observer.queue({ waiting: 7, oldestAgeMs: 1_250 });
    observer.queue({ waiting: 7, oldestAgeMs: 2_250 });
    observer.job({
      event: "started",
      jobPublicId: "document-job-one",
      state: "processing",
      blockingWorkKind: "prepare",
      attemptCount: 2,
      queueAgeMs: 900,
      serviceTimeMs: null,
      errorCode: null
    });
    observer.provider({
      resource: "embedding",
      waitTimeMs: 12,
      serviceTimeMs: 45,
      outcome: "success"
    });
    observer.ingestionFailure({
      stage: "knowledge_projection",
      errorCode: "portable_endpoint_unreadable",
      errorClass: "Error",
      errorMessage: "Generated endpoint is unreadable",
      httpStatusCode: null,
      requestId: null,
      retryable: false,
      attemptCount: 1,
      knowledgeBaseId: "kb-one",
      documentJobPublicId: "document-job-one",
      workPublicId: "document-work-one",
      scopePublicId: null,
      uploadSessionId: null
    });
    observer.work({
      event: "failed",
      workPublicId: "document-work-one",
      documentJobPublicId: "document-job-one",
      workKind: "knowledge_projection",
      resourceLane: "activation",
      attemptCount: 1,
      errorCode: "portable_endpoint_unreadable",
      errorConstraint: null,
      errorResource: "_graph/by-directory/guides/guides-relationships.json",
      errorTarget: "pages/guides/missing.md"
    });
    observer.activation({ attempt: 2, outcome: "conflict" });
    observer.publication({
      event: "activated",
      knowledgeBaseId: "kb-one",
      generationPublicId: "projection-generation-one",
      scopeKind: null,
      waitingCount: 0,
      durationMs: 17,
      contentionCount: 1,
      objectPutCount: 2,
      objectReuseCount: 5,
      errorCode: null
    });
    observer.publicationBacklog({
      knowledgeBaseId: "kb-one",
      waitingScopeCount: 4,
      runningScopeCount: 2,
      dirtyFactCount: 3,
      oldestAgeMs: 1_500,
      statusRegressionCount: 0
    });
    observer.publicationRecovery({
      generationCount: 2,
      releasedFactCount: 8,
      supersededScopeCount: 11
    });
    observer.publicationScope({
      event: "completed",
      knowledgeBaseId: "kb-one",
      generationPublicId: "projection-generation-one",
      scopeKind: "root",
      safeScopeKeyHash: "a".repeat(64),
      targetFactEpoch: 9,
      activeFactEpoch: 7,
      scopeGeneration: 4,
      leaseGeneration: 3,
      durationMs: 21,
      errorCode: null
    });
    observer.publicationStorage({
      knowledgeBaseId: "kb-one",
      generationPublicId: "projection-generation-one",
      objectPutCount: 2,
      objectReuseCount: 5,
      putByteCount: 1_024
    });
    observer.cleanup({
      claimed: 3, completed: 2, retried: 1, failed: 0,
      backlogDepth: 4, oldestAgeMs: 2_000, verifiedReservationDebt: 1
    });

    expect(events).toEqual([
      log("worker.queue_metrics", { waiting: 7, oldestAgeMs: 1_250 }),
      log("worker.document_started", {
        jobPublicId: "document-job-one",
        state: "processing",
        blockingWorkKind: "prepare",
        attemptCount: 2,
        queueAgeMs: 900,
        serviceTimeMs: null,
        errorCode: null
      }),
      log("worker.provider_metrics", {
        resource: "embedding",
        waitTimeMs: 12,
        serviceTimeMs: 45,
        outcome: "success"
      }),
      {
        level: "error",
        event: "ingestion.stage_failed",
        fields: {
          stage: "knowledge_projection",
          errorCode: "portable_endpoint_unreadable",
          errorClass: "Error",
          errorMessage: "Generated endpoint is unreadable",
          httpStatusCode: null,
          requestId: null,
          retryable: false,
          attemptCount: 1,
          knowledgeBaseId: "kb-one",
          documentJobPublicId: "document-job-one",
          workPublicId: "document-work-one",
          scopePublicId: null,
          uploadSessionId: null
        }
      },
      log("worker.document_work_failed", {
        workPublicId: "document-work-one",
        documentJobPublicId: "document-job-one",
        workKind: "knowledge_projection",
        resourceLane: "activation",
        attemptCount: 1,
        errorCode: "portable_endpoint_unreadable",
        errorConstraint: null,
        errorResource: "_graph/by-directory/guides/guides-relationships.json",
        errorTarget: "pages/guides/missing.md"
      }),
      log("worker.activation_attempt", { attempt: 2, outcome: "conflict" }),
      log("worker.publication_activated", {
        knowledgeBaseId: "kb-one",
        generationPublicId: "projection-generation-one",
        scopeKind: null,
        waitingCount: 0,
        durationMs: 17,
        contentionCount: 1,
        objectPutCount: 2,
        objectReuseCount: 5,
        errorCode: null
      }),
      log("worker.publication_backlog", {
        knowledgeBaseId: "kb-one",
        waitingScopeCount: 4,
        runningScopeCount: 2,
        dirtyFactCount: 3,
        oldestAgeMs: 1_500,
        statusRegressionCount: 0
      }),
      log("worker.publication_recovery", {
        generationCount: 2,
        releasedFactCount: 8,
        supersededScopeCount: 11
      }),
      log("worker.publication_scope_completed", {
        knowledgeBaseId: "kb-one",
        generationPublicId: "projection-generation-one",
        scopeKind: "root",
        safeScopeKeyHash: "a".repeat(64),
        targetFactEpoch: 9,
        activeFactEpoch: 7,
        scopeLag: 2,
        scopeGeneration: 4,
        leaseGeneration: 3,
        leaseLossCount: 0,
        durationMs: 21,
        errorCode: null
      }),
      log("worker.publication_storage", {
        knowledgeBaseId: "kb-one",
        generationPublicId: "projection-generation-one",
        objectPutCount: 2,
        objectReuseCount: 5,
        putByteCount: 1_024
      }),
      log("worker.cleanup_metrics", {
        claimed: 3,
        completed: 2,
        retried: 1,
        failed: 0,
        backlogDepth: 4,
        oldestAgeMs: 2_000,
        verifiedReservationDebt: 1
      })
    ]);
    expect(JSON.stringify(events)).not.toMatch(/body|prompt|secret|token/u);
  });

  it("does not emit an unchanged queue depth on every poll", () => {
    const events: unknown[] = [];
    const observer = createDocumentWorkerObservability({
      write: (event) => events.push(event)
    });

    observer.queue({ waiting: 0, oldestAgeMs: 0 });
    observer.queue({ waiting: 0, oldestAgeMs: 0 });
    observer.queue({ waiting: 2, oldestAgeMs: 100 });
    observer.queue({ waiting: 2, oldestAgeMs: 1_100 });
    observer.queue({ waiting: 0, oldestAgeMs: 0 });

    expect(events).toEqual([
      log("worker.queue_metrics", { waiting: 0, oldestAgeMs: 0 }),
      log("worker.queue_metrics", { waiting: 2, oldestAgeMs: 100 }),
      log("worker.queue_metrics", { waiting: 0, oldestAgeMs: 0 })
    ]);
  });

  it("rejects unbounded or unsafe metric fields", () => {
    const observer = createDocumentWorkerObservability({ write: () => {} });
    expect(() => observer.queue({ waiting: -1, oldestAgeMs: 0 })).toThrow(
      /metric value/u
    );
    expect(() => observer.job({
      event: "failed",
      jobPublicId: "document-job-one",
      state: "error",
      blockingWorkKind: "graphrag",
      attemptCount: 1,
      queueAgeMs: 0,
      serviceTimeMs: 1,
      errorCode: "provider secret"
    })).toThrow(/error code/u);
  });
});

function log(event: string, fields: Record<string, unknown>) {
  return { level: "info", event, fields };
}

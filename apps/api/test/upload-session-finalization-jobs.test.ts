import { describe, expect, it, vi } from "vitest";
import type { WorkerRuntimeConfig } from "../src/config.js";
import type { AdminRepositories } from "../src/db/admin-repositories.js";
import type { WorkerJobRecord } from "../src/db/worker-job-repository.js";
import { processUploadSessionFinalizationJob } from "../src/worker/upload-session-finalization-jobs.js";

describe("upload session finalization worker", () => {
  it("uses remaining queue capacity as a bounded database batch", async () => {
    const finalizeEntryBatch = vi.fn(async () => ({
      session: session("finalizing", 1),
      processedCount: 1,
      completed: true,
      cancelled: false
    }));
    const completeSession = vi.fn(async () => session("completed", 1));
    const repositories = createRepositories({
      globalActive: 5,
      knowledgeBaseActive: 2,
      finalizeEntryBatch,
      completeSession
    });

    const result = await processUploadSessionFinalizationJob({
      job: finalizationJob(),
      repositories,
      worker: workerConfig({
        queueBackpressureLimit: 10,
        queueBackpressureKnowledgeBaseLimit: 3
      }),
      upload: uploadConfig()
    });

    expect(result).toMatchObject({ completed: true, processedCount: 1, retryAfter: null });
    expect(finalizeEntryBatch).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "upload-session-1", limit: 1 })
    );
    expect(completeSession).toHaveBeenCalledOnce();
  });

  it("defers without creating source rows when the source queue is full", async () => {
    const finalizeEntryBatch = vi.fn();
    const repositories = createRepositories({
      globalActive: 10,
      knowledgeBaseActive: 1,
      finalizeEntryBatch,
      completeSession: vi.fn()
    });

    const result = await processUploadSessionFinalizationJob({
      job: finalizationJob(),
      repositories,
      worker: workerConfig({ queueBackpressureLimit: 10 }),
      upload: uploadConfig()
    });

    expect(result.completed).toBe(false);
    expect(result.processedCount).toBe(0);
    expect(result.retryAfter).not.toBeNull();
    expect(finalizeEntryBatch).not.toHaveBeenCalled();
  });
});

function createRepositories(input: {
  globalActive: number;
  knowledgeBaseActive: number;
  finalizeEntryBatch: ReturnType<typeof vi.fn>;
  completeSession: ReturnType<typeof vi.fn>;
}): AdminRepositories {
  return {
    uploadSessions: {
      finalizeEntryBatch: input.finalizeEntryBatch,
      completeSession: input.completeSession
    },
    workerJobs: {
      countActiveWorkerJobs: async (query: { knowledgeBaseId?: string | null }) =>
        query.knowledgeBaseId ? input.knowledgeBaseActive : input.globalActive,
      getWorkerQueueSummary: async () => ({
        queuedCount: input.globalActive,
        runningCount: 0,
        completedCount: 0,
        failedCount: 0,
        deadLetterCount: 0,
        oldestQueuedAt: null,
        oldestQueuedAgeSeconds: null
      })
    }
  } as unknown as AdminRepositories;
}

function finalizationJob(): WorkerJobRecord {
  return {
    id: "worker-job-finalize-1",
    kind: "upload_session_finalization",
    status: "running",
    knowledgeBaseId: "kb-1",
    sourceFileId: null,
    payload: { sessionId: "upload-session-1" },
    runAfter: "2026-07-10T00:00:00.000Z",
    attemptCount: 1,
    maxAttempts: 3,
    lockedBy: "worker-1",
    lockedAt: "2026-07-10T00:00:00.000Z",
    heartbeatAt: "2026-07-10T00:00:00.000Z",
    startedAt: "2026-07-10T00:00:00.000Z",
    completedAt: null,
    failedAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z"
  };
}

function workerConfig(overrides: Partial<WorkerRuntimeConfig> = {}): WorkerRuntimeConfig {
  return {
    sourceFileConcurrency: 2,
    claimBatchSize: 10,
    pollIntervalMs: 1_000,
    lockTtlSeconds: 900,
    jobMaxAttempts: 3,
    jobRetryDelayMs: 30_000,
    queueBackpressureLimit: 100,
    shutdownGraceMs: 30_000,
    ...overrides
  };
}

function uploadConfig() {
  return {
    maxBytes: 1_048_576,
    generationBatchSize: 50,
    fileProcessingConcurrency: 1,
    sessionTtlSeconds: 3_600,
    manifestPageSize: 500,
    contentBatchMaxFiles: 24,
    contentBatchMaxBytes: 25_165_824
  };
}

function session(state: "finalizing" | "completed", finalized: number) {
  return {
    id: "upload-session-1",
    knowledgeBaseId: "kb-1",
    state,
    idempotencyKey: "key-1",
    manifestFingerprint: "0".repeat(64),
    declaredFileCount: 1,
    declaredByteCount: 1,
    counts: {
      selected: 1,
      uploadRequired: 1,
      skippedExisting: 0,
      waitingReservation: 0,
      rejectedDeleting: 0,
      uploaded: 1,
      failed: 0,
      finalized
    },
    errorCode: null,
    expiresAt: "2026-07-11T00:00:00.000Z",
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    completedAt: state === "completed" ? "2026-07-10T00:00:01.000Z" : null
  } as const;
}

import { describe, expect, it } from "vitest";
import type { AdminRepositories } from "../src/db/admin-repositories.js";
import type {
  WorkerJobDraft,
  WorkerJobRecord,
  WorkerJobRepository
} from "../src/db/worker-job-repository.js";
import {
  enqueueSourceFileProcessingJobs,
  WorkerQueueBackpressureError
} from "../src/worker/source-file-jobs.js";

function createWorkerJob(input: WorkerJobDraft): WorkerJobRecord {
  return {
    id: "worker-job-001",
    kind: input.kind,
    status: "queued",
    knowledgeBaseId: input.knowledgeBaseId,
    sourceFileId: input.sourceFileId ?? null,
    payload: input.payload,
    runAfter: input.runAfter,
    attemptCount: 0,
    maxAttempts: input.maxAttempts,
    lockedBy: null,
    lockedAt: null,
    heartbeatAt: null,
    startedAt: null,
    completedAt: null,
    failedAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    createdAt: input.runAfter,
    updatedAt: input.runAfter
  };
}

describe("source-file worker jobs", () => {
  it("enqueues source-file identifiers without file content payloads", async () => {
    const enqueued: WorkerJobRecord[] = [];
    const repositories = createRepositories({
      activeJobCount: 0,
      onEnqueue: (job) => enqueued.push(job)
    });

    await enqueueSourceFileProcessingJobs({
      repositories,
      sourceFileIds: ["source-file-001", "source-file-002"],
      knowledgeBaseId: "kb-001",
      reason: "upload",
      config: {
        worker: {
          sourceFileConcurrency: 2,
          claimBatchSize: 10,
          pollIntervalMs: 1_000,
          lockTtlSeconds: 900,
          jobMaxAttempts: 3,
          jobRetryDelayMs: 30_000,
          queueBackpressureLimit: 100,
          shutdownGraceMs: 30_000
        }
      }
    });

    expect(enqueued).toHaveLength(2);
    expect(enqueued.map((job) => job.sourceFileId)).toEqual([
      "source-file-001",
      "source-file-002"
    ]);
    expect(enqueued.every((job) => job.payload.reason === "upload")).toBe(true);
    expect(JSON.stringify(enqueued)).not.toContain("markdown");
  });

  it("rejects enqueue when the active source-file queue is over capacity", async () => {
    const repositories = createRepositories({
      activeJobCount: 100,
      onEnqueue: () => undefined
    });

    await expect(
      enqueueSourceFileProcessingJobs({
        repositories,
        sourceFileIds: ["source-file-001"],
        knowledgeBaseId: "kb-001",
        reason: "upload",
        config: {
          worker: {
            sourceFileConcurrency: 2,
            claimBatchSize: 10,
            pollIntervalMs: 1_000,
            lockTtlSeconds: 900,
            jobMaxAttempts: 3,
            jobRetryDelayMs: 30_000,
            queueBackpressureLimit: 100,
            shutdownGraceMs: 30_000
          }
        }
      })
    ).rejects.toBeInstanceOf(WorkerQueueBackpressureError);
  });

  it("rejects enqueue when the knowledge-base queue is over capacity", async () => {
    const repositories = createRepositories({
      activeJobCount: 10,
      knowledgeBaseActiveJobCount: 20,
      onEnqueue: () => undefined
    });

    await expect(
      enqueueSourceFileProcessingJobs({
        repositories,
        sourceFileIds: ["source-file-001"],
        knowledgeBaseId: "kb-001",
        reason: "upload",
        config: {
          worker: {
            sourceFileConcurrency: 2,
            claimBatchSize: 10,
            pollIntervalMs: 1_000,
            lockTtlSeconds: 900,
            jobMaxAttempts: 3,
            jobRetryDelayMs: 30_000,
            queueBackpressureLimit: 100,
            queueBackpressureKnowledgeBaseLimit: 20,
            shutdownGraceMs: 30_000
          }
        }
      })
    ).rejects.toMatchObject({
      code: "QUEUE_BACKPRESSURE",
      knowledgeBaseActiveJobCount: 20,
      knowledgeBaseLimit: 20
    });
  });

  it("rejects enqueue when queued work is too old", async () => {
    const repositories = createRepositories({
      activeJobCount: 10,
      oldestQueuedAgeSeconds: 600,
      onEnqueue: () => undefined
    });

    await expect(
      enqueueSourceFileProcessingJobs({
        repositories,
        sourceFileIds: ["source-file-001"],
        knowledgeBaseId: "kb-001",
        reason: "upload",
        config: {
          worker: {
            sourceFileConcurrency: 2,
            claimBatchSize: 10,
            pollIntervalMs: 1_000,
            lockTtlSeconds: 900,
            jobMaxAttempts: 3,
            jobRetryDelayMs: 30_000,
            queueBackpressureLimit: 100,
            queueBackpressureMaxAgeSeconds: 600,
            queueBackpressureRetryAfterSeconds: 90,
            shutdownGraceMs: 30_000
          }
        }
      })
    ).rejects.toMatchObject({
      code: "QUEUE_BACKPRESSURE",
      oldestQueuedAgeSeconds: 600,
      maxQueuedAgeSeconds: 600,
      retryAfterSeconds: 90
    });
  });
});

function createRepositories(input: {
  activeJobCount: number;
  knowledgeBaseActiveJobCount?: number;
  oldestQueuedAgeSeconds?: number | null;
  onEnqueue: (job: WorkerJobRecord) => void;
}): AdminRepositories {
  const workerJobs: WorkerJobRepository = {
    async enqueueWorkerJob(job) {
      const record = createWorkerJob(job);
      input.onEnqueue(record);
      return record;
    },
    async enqueueSourceFileJob(job) {
      const record = createWorkerJob({
        kind: "source_file_processing",
        knowledgeBaseId: job.knowledgeBaseId,
        sourceFileId: job.sourceFileId,
        payload: { reason: job.reason },
        runAfter: job.runAfter,
        maxAttempts: job.maxAttempts
      });
      input.onEnqueue(record);
      return record;
    },
    async enqueuePublicationJob(job) {
      const record = createWorkerJob({
        kind: "publication",
        knowledgeBaseId: job.knowledgeBaseId,
        sourceFileId: null,
        payload: { reason: job.reason },
        runAfter: job.runAfter,
        maxAttempts: job.maxAttempts
      });
      input.onEnqueue(record);
      return record;
    },
    async claimWorkerJobs() {
      return [];
    },
    async releaseWorkerJob() {
      return null;
    },
    async completeWorkerJob() {
      return null;
    },
    async failWorkerJob() {
      return null;
    },
    async deadLetterWorkerJob() {
      return null;
    },
    async heartbeatWorkerJob() {
      return null;
    },
    async recordWorkerHeartbeat() {
      throw new Error("Not used");
    },
    async listWorkerHeartbeats() {
      return [];
    },
    async getWorkerQueueSummary() {
      return {
        queuedCount: input.activeJobCount,
        runningCount: 0,
        completedCount: 0,
        failedCount: 0,
        deadLetterCount: 0,
        oldestQueuedAt: input.oldestQueuedAgeSeconds ? "2026-06-18T00:00:00.000Z" : null,
        oldestQueuedAgeSeconds: input.oldestQueuedAgeSeconds ?? null
      };
    },
    async cleanupWorkerJobs() {
      return 0;
    },
    async countActiveWorkerJobs(query) {
      if (query.knowledgeBaseId) {
        return input.knowledgeBaseActiveJobCount ?? input.activeJobCount;
      }

      return input.activeJobCount;
    }
  };

  return {
    knowledgeBases: {
      async listKnowledgeBases() {
        return { items: [], nextCursor: null };
      },
      async createKnowledgeBase() {
        throw new Error("Not used");
      },
      async getKnowledgeBase() {
        return null;
      }
    },
    workerJobs
  };
}

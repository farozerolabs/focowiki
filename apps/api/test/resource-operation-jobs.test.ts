import { describe, expect, it, vi } from "vitest";
import type { AdminRepositories } from "../src/db/admin-repositories.js";
import type {
  WorkerJobRecord,
  WorkerJobRepository
} from "../src/db/worker-job-repository.js";
import type { ResourceOperationRecord } from "../src/domain/source-resource.js";
import { SourceResourceError } from "../src/domain/source-resource.js";
import { processResourceOperationJob } from "../src/worker/resource-operation-jobs.js";

describe("resource operation worker jobs", () => {
  it("publishes directory deletions with the deletion reason before hard cleanup", async () => {
    const enqueuePublicationJob = vi.fn(async () => createWorkerJob("publication"));
    const enqueueHardDeleteJob = vi.fn(async () => createWorkerJob("hard_delete"));
    const cancelQueuedSourceDirectoryJobs = vi.fn(async () => []);
    const workerJobs = {
      enqueuePublicationJob,
      enqueueHardDeleteJob,
      cancelQueuedSourceDirectoryJobs
    } as unknown as WorkerJobRepository;
    const operation = createOperation("source_directory_delete", "publishing");
    const repositories = {
      sourceResources: {
        prepareOperation: vi.fn(async () => ({
          operation,
          sourceFileId: null,
          requiresSourceProcessing: false,
          requiresPublication: true,
          requiresContinuation: false,
          directoryDeletion: {
            deletionIntentId: "deletion-intent-test",
            directoryId: "source-directory-test"
          }
        }))
      }
    } as unknown as AdminRepositories;

    await expect(
      processResourceOperationJob({
        job: createResourceOperationJob(),
        repositories,
        workerJobs,
        sourceJobMaxAttempts: 3,
        publicationJobMaxAttempts: 3,
        databaseBatchSize: 50
      })
    ).resolves.toEqual({ retryAfter: null, cleanupObjectKeys: [] });

    expect(enqueuePublicationJob).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-test",
      reason: "deletion",
      runAfter: expect.any(String),
      maxAttempts: 3
    });
    expect(cancelQueuedSourceDirectoryJobs).toHaveBeenCalledOnce();
    expect(enqueueHardDeleteJob).toHaveBeenCalledOnce();
  });

  it("contains terminal resource conflicts without terminating the worker runtime", async () => {
    const failOperation = vi.fn(async () => ({
      operation: createOperation("source_file_move", "failed"),
      objectKeys: ["sources/candidate.md"]
    }));
    const repositories = {
      sourceResources: {
        prepareOperation: vi.fn(async () => {
          throw new SourceResourceError("RESOURCE_PATH_CONFLICT");
        }),
        failOperation
      }
    } as unknown as AdminRepositories;

    await expect(
      processResourceOperationJob({
        job: createResourceOperationJob(),
        repositories,
        workerJobs: {} as WorkerJobRepository,
        sourceJobMaxAttempts: 3,
        publicationJobMaxAttempts: 3,
        databaseBatchSize: 50
      })
    ).resolves.toEqual({
      retryAfter: null,
      cleanupObjectKeys: ["sources/candidate.md"]
    });

    expect(failOperation).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-test",
      operationId: "resource-operation-test",
      errorCode: "RESOURCE_PATH_CONFLICT",
      failedAt: expect.any(String)
    });
  });
});

function createOperation(
  kind: ResourceOperationRecord["kind"],
  state: ResourceOperationRecord["state"]
): ResourceOperationRecord {
  return {
    id: "resource-operation-test",
    knowledgeBaseId: "kb-test",
    kind,
    state,
    expectedResourceRevision: 1,
    candidateCatalogGeneration: 1,
    result: null,
    errorCode: null,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    completedAt: null
  };
}

function createResourceOperationJob(): WorkerJobRecord {
  return createWorkerJob("resource_operation", {
    operationId: "resource-operation-test"
  });
}

function createWorkerJob(
  kind: WorkerJobRecord["kind"],
  payload: Record<string, unknown> = {}
): WorkerJobRecord {
  return {
    id: `worker-job-${kind}`,
    kind,
    status: "queued",
    knowledgeBaseId: "kb-test",
    sourceFileId: null,
    payload,
    runAfter: "2026-07-10T00:00:00.000Z",
    attemptCount: 0,
    maxAttempts: 3,
    lockedBy: null,
    lockedAt: null,
    heartbeatAt: null,
    startedAt: null,
    completedAt: null,
    failedAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z"
  };
}

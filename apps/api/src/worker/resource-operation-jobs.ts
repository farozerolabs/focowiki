import type { AdminRepositories } from "../db/admin-repositories.js";
import type { WorkerJobRecord, WorkerJobRepository } from "../db/worker-job-repository.js";
import { SourceResourceError } from "../domain/source-resource.js";

export async function processResourceOperationJob(input: {
  job: WorkerJobRecord;
  repositories: AdminRepositories;
  workerJobs: WorkerJobRepository;
  sourceJobMaxAttempts: number;
  publicationJobMaxAttempts: number;
  databaseBatchSize: number;
}): Promise<{ retryAfter: string | null; cleanupObjectKeys: string[] }> {
  const repository = input.repositories.sourceResources;
  if (!repository) throw new Error("Source resource repository is unavailable");
  const operationId = readOperationId(input.job.payload);
  try {
    const prepared = await repository.prepareOperation({
      knowledgeBaseId: input.job.knowledgeBaseId,
      operationId,
      now: new Date().toISOString(),
      batchSize: input.databaseBatchSize
    });
    if (prepared.requiresContinuation) {
      return {
        retryAfter: new Date(Date.now() + 100).toISOString(),
        cleanupObjectKeys: []
      };
    }
    if (prepared.requiresSourceProcessing && prepared.sourceFileId) {
      await input.workerJobs.enqueueSourceFileJob({
        knowledgeBaseId: input.job.knowledgeBaseId,
        sourceFileId: prepared.sourceFileId,
        reason: "resource_operation",
        runAfter: new Date().toISOString(),
        maxAttempts: input.sourceJobMaxAttempts
      });
    }
    if (prepared.requiresPublication) {
      await input.workerJobs.enqueuePublicationJob({
        knowledgeBaseId: input.job.knowledgeBaseId,
        reason: prepared.operation.kind === "source_directory_delete" ? "deletion" : "manual",
        targetCatalogGeneration: prepared.operation.candidateCatalogGeneration,
        runAfter: new Date().toISOString(),
        maxAttempts: input.publicationJobMaxAttempts,
        forceSuccessor: true
      });
    }
    if (prepared.directoryDeletion) {
      const now = new Date().toISOString();
      await input.workerJobs.cancelQueuedSourceDirectoryJobs?.({
        knowledgeBaseId: input.job.knowledgeBaseId,
        deletionIntentId: prepared.directoryDeletion.deletionIntentId,
        cancelledAt: now,
        errorCode: "SOURCE_DIRECTORY_DELETED",
        errorMessage: "Source directory was deleted before queued processing started."
      });
      await input.workerJobs.enqueueHardDeleteJob?.({
        knowledgeBaseId: input.job.knowledgeBaseId,
        targetKind: "source_directory",
        sourceDirectoryId: prepared.directoryDeletion.directoryId,
        deletionIntentId: prepared.directoryDeletion.deletionIntentId,
        reason: "source_directory_deleted",
        runAfter: now,
        maxAttempts: input.publicationJobMaxAttempts
      });
    }
    return { retryAfter: null, cleanupObjectKeys: [] };
  } catch (error) {
    if (error instanceof SourceResourceError) {
      const failed = await repository.failOperation({
        knowledgeBaseId: input.job.knowledgeBaseId,
        operationId,
        errorCode: error.code,
        failedAt: new Date().toISOString()
      });
      return { retryAfter: null, cleanupObjectKeys: failed.objectKeys };
    }
    throw error;
  }
}

function readOperationId(payload: Record<string, unknown>): string {
  const value = payload.operationId;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Resource operation worker payload is invalid");
  }
  return value;
}

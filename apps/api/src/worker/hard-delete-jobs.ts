import type { AdminRepositories } from "../db/admin-repositories.js";
import type { WorkerJobRecord } from "../db/worker-job-repository.js";
import type { RedisCoordinator } from "../redis/coordination.js";
import type { StorageAdapter } from "../storage/s3.js";
import { invalidateKnowledgeBaseCaches } from "../admin/cache-invalidation.js";
import { deleteStorageObjectBatch } from "./storage-object-deletion.js";

export type HardDeleteJobResult = {
  workerJobDeleted: boolean;
  retryAfter?: string;
};

export type HardDeleteJobSettings = {
  databaseBatchSize: number;
  objectBatchSize: number;
  versionPurgeEnabled: boolean;
};

export async function processHardDeleteJob(input: {
  job: WorkerJobRecord;
  repositories: AdminRepositories;
  storage: StorageAdapter;
  redis: RedisCoordinator;
  cursorTtlSeconds: number;
  settings: HardDeleteJobSettings;
}): Promise<HardDeleteJobResult> {
  const hardDelete = input.repositories.hardDelete;

  if (!hardDelete) {
    throw new Error("Hard delete repository is unavailable.");
  }

  const target = readHardDeleteTarget(input.job);

  if (target.targetKind === "knowledge_base") {
    await hardDelete.cancelQueuedKnowledgeBaseWork({
      knowledgeBaseId: input.job.knowledgeBaseId,
      excludeJobId: input.job.id,
      cancelledAt: new Date().toISOString()
    });
    const activeWork = await input.repositories.workerJobs?.countActiveWorkerJobs({
      kinds: [
        "upload_session_finalization",
        "source_file_processing",
        "resource_operation",
        "publication",
        "generated_output_reset"
      ],
      knowledgeBaseId: input.job.knowledgeBaseId
    });
    if (activeWork && activeWork > 0) {
      return { workerJobDeleted: false, retryAfter: retryAfterShortDelay() };
    }
    await clearKnowledgeBaseSourceFileRuntimeKeys({
      repositories: input.repositories,
      redis: input.redis,
      knowledgeBaseId: input.job.knowledgeBaseId,
      batchSize: input.settings.databaseBatchSize
    });
    await hardDelete.prepareKnowledgeBaseObjectDeletions({
      jobId: input.job.id,
      knowledgeBaseId: input.job.knowledgeBaseId
    });
    await prepareKnowledgeBaseStoragePrefixObjectDeletions({
      hardDelete,
      storage: input.storage,
      jobId: input.job.id,
      knowledgeBaseId: input.job.knowledgeBaseId,
      objectBatchSize: input.settings.objectBatchSize
    });
    await deleteTrackedObjects({
      repositories: input.repositories,
      storage: input.storage,
      jobId: input.job.id,
      settings: input.settings
    });
    await input.redis.clearKnowledgeBaseRuntimeKeys({
      knowledgeBaseId: input.job.knowledgeBaseId
    });
    await hardDelete.purgeKnowledgeBaseData({
      jobId: input.job.id,
      knowledgeBaseId: input.job.knowledgeBaseId,
      batchSize: input.settings.databaseBatchSize
    });
    return { workerJobDeleted: true };
  }

  if (target.targetKind === "source_directory") {
    const runnable = await hardDelete.isDeletionIntentRunnable({
      knowledgeBaseId: input.job.knowledgeBaseId,
      deletionIntentId: target.deletionIntentId
    });
    if (!runnable) {
      return { workerJobDeleted: false };
    }
    const activePublications = await input.repositories.workerJobs?.countActiveWorkerJobs({
      kinds: ["publication"],
      knowledgeBaseId: input.job.knowledgeBaseId
    });
    if (activePublications && activePublications > 0) {
      return { workerJobDeleted: false, retryAfter: retryAfterShortDelay() };
    }
    const excluded = await hardDelete.isSourceDirectoryExcludedFromActiveRelease({
      knowledgeBaseId: input.job.knowledgeBaseId,
      deletionIntentId: target.deletionIntentId
    });
    if (!excluded) {
      return { workerJobDeleted: false, retryAfter: retryAfterShortDelay() };
    }
    await hardDelete.prepareSourceDirectoryObjectDeletions({
      jobId: input.job.id,
      knowledgeBaseId: input.job.knowledgeBaseId,
      deletionIntentId: target.deletionIntentId
    });
    await deleteTrackedObjects({
      repositories: input.repositories,
      storage: input.storage,
      jobId: input.job.id,
      settings: input.settings
    });
    await hardDelete.purgeSourceDirectoryReleaseData({
      jobId: input.job.id,
      knowledgeBaseId: input.job.knowledgeBaseId,
      deletionIntentId: target.deletionIntentId,
      batchSize: input.settings.databaseBatchSize
    });
    await invalidateKnowledgeBaseCaches({
      redis: input.redis,
      knowledgeBaseId: input.job.knowledgeBaseId,
      releaseId: null,
      ttlSeconds: input.cursorTtlSeconds
    });
    let cursor: string | null = null;
    do {
      const page = await hardDelete.listSourceDirectorySourceFileIds({
        knowledgeBaseId: input.job.knowledgeBaseId,
        deletionIntentId: target.deletionIntentId,
        cursor,
        limit: input.settings.databaseBatchSize
      });
      for (const sourceFileId of page.items) {
        await input.redis.clearSourceFileRuntimeKeys({
          knowledgeBaseId: input.job.knowledgeBaseId,
          sourceFileId
        });
        await hardDelete.purgeSourceFileData({
          jobId: input.job.id,
          knowledgeBaseId: input.job.knowledgeBaseId,
          sourceFileId,
          batchSize: input.settings.databaseBatchSize
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
    await hardDelete.clearObjectDeletionTracking({
      jobId: input.job.id,
      batchSize: input.settings.databaseBatchSize
    });
    await hardDelete.completeSourceDirectoryDeletion({
      knowledgeBaseId: input.job.knowledgeBaseId,
      deletionIntentId: target.deletionIntentId,
      completedAt: new Date().toISOString()
    });
    return { workerJobDeleted: false };
  }

  const sourceFileId = target.sourceFileId;
  if (target.deletionIntentId) {
    const runnable = await hardDelete.isDeletionIntentRunnable({
      knowledgeBaseId: input.job.knowledgeBaseId,
      deletionIntentId: target.deletionIntentId
    });
    if (!runnable) {
      return { workerJobDeleted: false };
    }
  }
  const activePublications = await input.repositories.workerJobs?.countActiveWorkerJobs({
    kinds: ["publication"],
    knowledgeBaseId: input.job.knowledgeBaseId
  });

  if (activePublications && activePublications > 0) {
    return {
      workerJobDeleted: false,
      retryAfter: new Date(Date.now() + 5_000).toISOString()
    };
  }

  const knowledgeBase = await input.repositories.knowledgeBases.getKnowledgeBase(
    input.job.knowledgeBaseId
  );

  if (!knowledgeBase) {
    return { workerJobDeleted: false };
  }

  const excluded = await hardDelete.isSourceFileExcludedFromActiveRelease({
    knowledgeBaseId: knowledgeBase.id,
    sourceFileId
  });
  if (!excluded) {
    return { workerJobDeleted: false, retryAfter: retryAfterShortDelay() };
  }

  await hardDelete.prepareSourceFileObjectDeletions({
    jobId: input.job.id,
    knowledgeBaseId: knowledgeBase.id,
    sourceFileId
  });
  await deleteTrackedObjects({
    repositories: input.repositories,
    storage: input.storage,
    jobId: input.job.id,
    settings: input.settings
  });
  await invalidateKnowledgeBaseCaches({
    redis: input.redis,
    knowledgeBaseId: knowledgeBase.id,
    releaseId: knowledgeBase.activeReleaseId,
    sourceFileId,
    ttlSeconds: input.cursorTtlSeconds
  });
  await input.redis.clearSourceFileRuntimeKeys({
    knowledgeBaseId: knowledgeBase.id,
    sourceFileId
  });
  await hardDelete.purgeSourceFileData({
    jobId: input.job.id,
    knowledgeBaseId: knowledgeBase.id,
    sourceFileId,
    batchSize: input.settings.databaseBatchSize
  });
  if (target.deletionIntentId) {
    await hardDelete.completeSourceFileDeletion({
      knowledgeBaseId: knowledgeBase.id,
      sourceFileId,
      deletionIntentId: target.deletionIntentId,
      completedAt: new Date().toISOString()
    });
  }

  return { workerJobDeleted: false };
}

async function clearKnowledgeBaseSourceFileRuntimeKeys(input: {
  repositories: AdminRepositories;
  redis: RedisCoordinator;
  knowledgeBaseId: string;
  batchSize: number;
}): Promise<void> {
  const hardDelete = input.repositories.hardDelete;

  if (!hardDelete) {
    return;
  }

  let cursor: string | null = null;

  do {
    const page = await hardDelete.listKnowledgeBaseSourceFileIds({
      knowledgeBaseId: input.knowledgeBaseId,
      cursor,
      limit: input.batchSize
    });
    for (const sourceFileId of page.items) {
      await input.redis.clearSourceFileRuntimeKeys({
        knowledgeBaseId: input.knowledgeBaseId,
        sourceFileId
      });
    }
    cursor = page.nextCursor;
  } while (cursor);
}

async function deleteTrackedObjects(input: {
  repositories: AdminRepositories;
  storage: StorageAdapter;
  jobId: string;
  settings: HardDeleteJobSettings;
}): Promise<void> {
  const hardDelete = input.repositories.hardDelete;

  if (!hardDelete) {
    throw new Error("Hard delete repository is unavailable.");
  }

  const objectBatchSize = Math.min(Math.max(input.settings.objectBatchSize, 1), 1_000);

  while (await hardDelete.hasPendingObjectKeys({ jobId: input.jobId })) {
    const objectKeys = await hardDelete.listPendingObjectKeys({
      jobId: input.jobId,
      limit: objectBatchSize
    });

    if (objectKeys.length === 0) {
      return;
    }

    await deleteStorageObjectBatch({
      storage: input.storage,
      objectKeys,
      versionPurgeEnabled: input.settings.versionPurgeEnabled
    });
    await hardDelete.markObjectKeysDeleted({
      jobId: input.jobId,
      objectKeys,
      deletedAt: new Date().toISOString()
    });
    await hardDelete.recordHardDeleteProgress({
      jobId: input.jobId,
      stageKey: "object_cleanup",
      cursor: {
        lastObjectKey: objectKeys[objectKeys.length - 1] ?? null,
        batchSize: objectKeys.length
      },
      updatedAt: new Date().toISOString()
    });
  }
}

async function prepareKnowledgeBaseStoragePrefixObjectDeletions(input: {
  hardDelete: NonNullable<AdminRepositories["hardDelete"]>;
  storage: StorageAdapter;
  jobId: string;
  knowledgeBaseId: string;
  objectBatchSize: number;
}): Promise<void> {
  if (!input.storage.listObjectKeys) {
    return;
  }

  const prefix = `${input.storage.keyspace.knowledgeBaseRootKey(input.knowledgeBaseId)}/`;
  const limit = Math.min(Math.max(input.objectBatchSize, 1), 1_000);
  let continuationToken: string | null = null;

  do {
    const page = await input.storage.listObjectKeys({
      prefix,
      continuationToken,
      limit
    });

    await input.hardDelete.trackObjectDeletions({
      jobId: input.jobId,
      knowledgeBaseId: input.knowledgeBaseId,
      objectKeys: page.keys
    });

    continuationToken = page.nextContinuationToken;
  } while (continuationToken);
}

function readHardDeleteTarget(job: WorkerJobRecord):
  | { targetKind: "knowledge_base" }
  | { targetKind: "source_directory"; sourceDirectoryId: string; deletionIntentId: string }
  | { targetKind: "source_file"; sourceFileId: string; deletionIntentId: string | null } {
  const targetKind = job.payload.targetKind;

  if (targetKind === "knowledge_base") {
    return { targetKind };
  }

  if (targetKind === "source_directory") {
    const sourceDirectoryId = job.payload.sourceDirectoryId;
    const deletionIntentId = job.payload.deletionIntentId;
    if (typeof sourceDirectoryId !== "string" || typeof deletionIntentId !== "string") {
      throw new Error("Hard delete source-directory job is missing stable target IDs.");
    }
    return { targetKind, sourceDirectoryId, deletionIntentId };
  }

  if (targetKind !== "source_file") {
    throw new Error("Hard delete job is missing a valid targetKind.");
  }

  const sourceFileId = job.payload.sourceFileId;
  const deletionIntentId = typeof job.payload.deletionIntentId === "string"
    ? job.payload.deletionIntentId
    : null;

  if (typeof sourceFileId !== "string" || sourceFileId.length === 0) {
    throw new Error("Hard delete source-file job is missing sourceFileId.");
  }

  return {
    targetKind,
    sourceFileId,
    deletionIntentId
  };
}

function retryAfterShortDelay(): string {
  return new Date(Date.now() + 5_000).toISOString();
}

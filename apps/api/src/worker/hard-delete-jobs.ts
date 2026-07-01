import type { AdminRepositories } from "../db/admin-repositories.js";
import type { WorkerJobRecord } from "../db/worker-job-repository.js";
import type { RedisCoordinator } from "../redis/coordination.js";
import type { StorageAdapter } from "../storage/s3.js";
import { invalidateKnowledgeBaseCaches } from "../admin/cache-invalidation.js";

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
    const sourceFileIds = await collectKnowledgeBaseSourceFileIds({
      repositories: input.repositories,
      knowledgeBaseId: input.job.knowledgeBaseId,
      batchSize: input.settings.databaseBatchSize
    });
    await hardDelete.cancelQueuedKnowledgeBaseWork({
      knowledgeBaseId: input.job.knowledgeBaseId,
      excludeJobId: input.job.id,
      cancelledAt: new Date().toISOString()
    });
    await hardDelete.prepareKnowledgeBaseObjectDeletions({
      jobId: input.job.id,
      knowledgeBaseId: input.job.knowledgeBaseId
    });
    await deleteTrackedObjects({
      repositories: input.repositories,
      storage: input.storage,
      jobId: input.job.id,
      settings: input.settings
    });
    await hardDelete.purgeKnowledgeBaseData({
      jobId: input.job.id,
      knowledgeBaseId: input.job.knowledgeBaseId,
      batchSize: input.settings.databaseBatchSize
    });
    await input.redis.clearKnowledgeBaseRuntimeKeys({
      knowledgeBaseId: input.job.knowledgeBaseId,
      sourceFileIds
    });
    return { workerJobDeleted: true };
  }

  const sourceFileId = target.sourceFileId;
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
  await hardDelete.purgeSourceFileData({
    jobId: input.job.id,
    knowledgeBaseId: knowledgeBase.id,
    sourceFileId,
    batchSize: input.settings.databaseBatchSize
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

  return { workerJobDeleted: false };
}

async function collectKnowledgeBaseSourceFileIds(input: {
  repositories: AdminRepositories;
  knowledgeBaseId: string;
  batchSize: number;
}): Promise<string[]> {
  const hardDelete = input.repositories.hardDelete;

  if (!hardDelete) {
    return [];
  }

  const sourceFileIds: string[] = [];
  let cursor: string | null = null;

  do {
    const page = await hardDelete.listKnowledgeBaseSourceFileIds({
      knowledgeBaseId: input.knowledgeBaseId,
      cursor,
      limit: input.batchSize
    });
    sourceFileIds.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);

  return sourceFileIds;
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

    await deleteStorageObjects({
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

async function deleteStorageObjects(input: {
  storage: StorageAdapter;
  objectKeys: string[];
  versionPurgeEnabled: boolean;
}): Promise<void> {
  if (input.objectKeys.length === 0) {
    return;
  }

  if (input.versionPurgeEnabled) {
    if (!input.storage.deleteObjectVersions) {
      throw new Error("Versioned object purge is not supported by the active storage adapter.");
    }

    await input.storage.deleteObjectVersions(input.objectKeys);
    return;
  }

  if (input.storage.deleteObjects) {
    await input.storage.deleteObjects(input.objectKeys);
    return;
  }

  if (!input.storage.deleteObject) {
    return;
  }

  for (const objectKey of input.objectKeys) {
    await input.storage.deleteObject(objectKey);
  }
}

function readHardDeleteTarget(job: WorkerJobRecord):
  | { targetKind: "knowledge_base" }
  | { targetKind: "source_file"; sourceFileId: string } {
  const targetKind = job.payload.targetKind;

  if (targetKind === "knowledge_base") {
    return { targetKind };
  }

  if (targetKind !== "source_file") {
    throw new Error("Hard delete job is missing a valid targetKind.");
  }

  const sourceFileId = job.payload.sourceFileId;

  if (typeof sourceFileId !== "string" || sourceFileId.length === 0) {
    throw new Error("Hard delete source-file job is missing sourceFileId.");
  }

  return {
    targetKind,
    sourceFileId
  };
}

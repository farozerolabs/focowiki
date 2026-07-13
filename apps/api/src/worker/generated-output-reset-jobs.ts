import type { GeneratedOutputResetRepository } from "../application/ports/generated-output-reset-repository.js";
import type { RedisCoordinator } from "../redis/coordination.js";
import type { StorageAdapter } from "../storage/s3.js";
import { deleteStorageObjectBatch } from "./storage-object-deletion.js";

const PREFIX_PAGE_SIZE = 25;

export async function processGeneratedOutputResetJob(input: {
  jobId: string;
  knowledgeBaseId: string;
  repository: GeneratedOutputResetRepository;
  storage: StorageAdapter;
  redis: RedisCoordinator;
  lockTtlSeconds: number;
  objectBatchSize: number;
  versionPurgeEnabled: boolean;
  publicationJobMaxAttempts: number;
  now?: () => string;
}): Promise<{ completed: boolean; retryAfter: string | null }> {
  const now = input.now ?? (() => new Date().toISOString());
  const state = await input.repository.beginReset({
    knowledgeBaseId: input.knowledgeBaseId,
    startedAt: now()
  });
  if (state === null || state === "completed") {
    return { completed: true, retryAfter: null };
  }

  await input.redis.clearKnowledgeBaseRuntimeKeys({
    knowledgeBaseId: input.knowledgeBaseId
  });

  const ownerId = `generated-output-reset:${input.jobId}`;
  const lockAcquired = await input.redis.acquireKnowledgeBasePublicationLock(
    input.knowledgeBaseId,
    ownerId,
    input.lockTtlSeconds
  );
  if (!lockAcquired) {
    return {
      completed: false,
      retryAfter: new Date(Date.now() + 1_000).toISOString()
    };
  }

  try {
    await deletePendingPrefixes({
      knowledgeBaseId: input.knowledgeBaseId,
      repository: input.repository,
      storage: input.storage,
      objectBatchSize: Math.min(Math.max(input.objectBatchSize, 1), 1_000),
      versionPurgeEnabled: input.versionPurgeEnabled,
      now
    });
    await input.repository.completeResetAndEnqueueRebuild({
      knowledgeBaseId: input.knowledgeBaseId,
      completedAt: now(),
      publicationJobMaxAttempts: input.publicationJobMaxAttempts
    });
    return { completed: true, retryAfter: null };
  } finally {
    await input.redis.releaseKnowledgeBasePublicationLock(input.knowledgeBaseId, ownerId);
  }
}

async function deletePendingPrefixes(input: {
  knowledgeBaseId: string;
  repository: GeneratedOutputResetRepository;
  storage: StorageAdapter;
  objectBatchSize: number;
  versionPurgeEnabled: boolean;
  now: () => string;
}): Promise<void> {
  if (!input.storage.listObjectKeys) {
    throw new Error("Generated output reset requires storage prefix listing support.");
  }

  while (true) {
    const prefixes = await input.repository.listPendingPrefixes({
      knowledgeBaseId: input.knowledgeBaseId,
      limit: PREFIX_PAGE_SIZE
    });
    if (prefixes.length === 0) {
      return;
    }

    for (const prefix of prefixes) {
      await emptyStoragePrefix({
        storage: input.storage,
        prefix,
        objectBatchSize: input.objectBatchSize,
        versionPurgeEnabled: input.versionPurgeEnabled
      });
      await input.repository.markPrefixDeleted({
        knowledgeBaseId: input.knowledgeBaseId,
        prefix,
        deletedAt: input.now()
      });
    }
  }
}

async function emptyStoragePrefix(input: {
  storage: StorageAdapter;
  prefix: string;
  objectBatchSize: number;
  versionPurgeEnabled: boolean;
}): Promise<void> {
  while (true) {
    const page = await input.storage.listObjectKeys!({
      prefix: input.prefix,
      continuationToken: null,
      limit: input.objectBatchSize
    });
    if (page.keys.length === 0) {
      return;
    }
    await deleteStorageObjectBatch({
      storage: input.storage,
      objectKeys: page.keys,
      versionPurgeEnabled: input.versionPurgeEnabled
    });
  }
}

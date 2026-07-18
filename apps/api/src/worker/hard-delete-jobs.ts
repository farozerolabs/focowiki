import type {
  CleanupCheckpoint,
  CleanupTarget,
  GenerationCleanupRepository
} from "../application/ports/generation-cleanup-repository.js";
import { RoleJobFailure, RoleJobReschedule, type RoleJobRecord } from "../domain/role-job.js";
import type { RedisCoordinator } from "../redis/coordination.js";
import type { StorageAdapter } from "../storage/s3.js";
import { deleteStorageObjectBatch } from "./storage-object-deletion.js";

export type HardDeleteJobSettings = {
  databaseBatchSize: number;
  objectBatchSize: number;
  versionPurgeEnabled: boolean;
  continuationDelayMs: number;
};

export function createHardDeleteJobProcessor(input: {
  cleanup: GenerationCleanupRepository;
  storage: StorageAdapter;
  redis: Pick<RedisCoordinator, "clearKnowledgeBaseRuntimeKeys" | "clearSourceFileRuntimeKeys">;
  settings: HardDeleteJobSettings;
  now?: () => Date;
}) {
  const now = input.now ?? (() => new Date());

  return async (job: RoleJobRecord): Promise<void> => {
    const target = parseCleanupTarget(job);
    const ready = await input.cleanup.isReady({ jobId: job.id, target });
    if (!ready) {
      throw continuation(now(), input.settings.continuationDelayMs);
    }

    let checkpoint = await input.cleanup.getCheckpoint(job.id) ?? initialCheckpoint();
    if (!checkpoint.discoveryCompleted) {
      checkpoint = await discoverObjects({
        job,
        target,
        checkpoint,
        cleanup: input.cleanup,
        storage: input.storage,
        objectBatchSize: input.settings.objectBatchSize,
        now: now()
      });
      await input.cleanup.saveCheckpoint({
        jobId: job.id,
        target,
        checkpoint,
        updatedAt: now().toISOString()
      });
      if (!checkpoint.discoveryCompleted) {
        throw continuation(now(), input.settings.continuationDelayMs);
      }
    }

    const objectKeys = await input.cleanup.listPendingObjectKeys({
      jobId: job.id,
      limit: input.settings.objectBatchSize
    });
    if (objectKeys.length > 0) {
      await deleteStorageObjectBatch({
        storage: input.storage,
        objectKeys,
        versionPurgeEnabled: input.settings.versionPurgeEnabled
      });
      await input.cleanup.markObjectKeysDeleted({
        jobId: job.id,
        objectKeys,
        deletedAt: now().toISOString()
      });
      await input.cleanup.saveCheckpoint({
        jobId: job.id,
        target,
        checkpoint: { ...checkpoint, phase: "object_deletion" },
        updatedAt: now().toISOString()
      });
      const remainingObjectKeys = await input.cleanup.listPendingObjectKeys({
        jobId: job.id,
        limit: 1
      });
      if (remainingObjectKeys.length > 0) {
        throw continuation(now(), input.settings.continuationDelayMs);
      }
    }

    const purge = await input.cleanup.purgeTargetBatch({
      jobId: job.id,
      target,
      limit: input.settings.databaseBatchSize,
      purgedAt: now().toISOString()
    });
    await input.cleanup.saveCheckpoint({
      jobId: job.id,
      target,
      checkpoint: { ...checkpoint, phase: "database_cleanup" },
      updatedAt: now().toISOString()
    });
    if (purge.hasMore) {
      throw continuation(now(), input.settings.continuationDelayMs);
    }

    if (target.kind === "source_file") {
      await input.redis.clearSourceFileRuntimeKeys({
        knowledgeBaseId: target.knowledgeBaseId,
        sourceFileId: target.sourceFileId
      });
    } else {
      await input.redis.clearKnowledgeBaseRuntimeKeys({
        knowledgeBaseId: target.knowledgeBaseId
      });
    }
    await input.cleanup.complete({
      jobId: job.id,
      target,
      completedAt: now().toISOString()
    });
  };
}

async function discoverObjects(input: {
  job: RoleJobRecord;
  target: CleanupTarget;
  checkpoint: CleanupCheckpoint;
  cleanup: GenerationCleanupRepository;
  storage: StorageAdapter;
  objectBatchSize: number;
  now: Date;
}): Promise<CleanupCheckpoint> {
  if (input.target.kind === "knowledge_base") {
    if (!input.storage.listObjectKeys) {
      throw new RoleJobFailure({
        code: "STORAGE_LIST_UNAVAILABLE",
        message: "Storage object listing is unavailable",
        retryable: false
      });
    }
    const page = await input.storage.listObjectKeys({
      prefix: `${input.storage.keyspace.knowledgeBaseRootKey(input.target.knowledgeBaseId)}/`,
      continuationToken: input.checkpoint.discoveryCursor,
      limit: input.objectBatchSize
    });
    await input.cleanup.trackObjectKeys({
      jobId: input.job.id,
      knowledgeBaseId: input.target.knowledgeBaseId,
      objectKeys: page.keys,
      createdAt: input.now.toISOString()
    });
    return {
      phase: page.nextContinuationToken ? "object_discovery" : "object_deletion",
      discoveryCursor: page.nextContinuationToken,
      discoveryCompleted: page.nextContinuationToken === null
    };
  }

  const page = await input.cleanup.discoverSourceObjectKeys({
    target: input.target,
    cursor: input.checkpoint.discoveryCursor,
    limit: input.objectBatchSize
  });
  await input.cleanup.trackObjectKeys({
    jobId: input.job.id,
    knowledgeBaseId: input.target.knowledgeBaseId,
    objectKeys: page.objectKeys,
    createdAt: input.now.toISOString()
  });
  return {
    phase: page.nextCursor ? "object_discovery" : "object_deletion",
    discoveryCursor: page.nextCursor,
    discoveryCompleted: page.nextCursor === null
  };
}

function parseCleanupTarget(job: RoleJobRecord): CleanupTarget {
  const payload = readPayload(job);
  const targetKind = payload.targetKind;
  const deletionIntentId = payload.deletionIntentId;
  if (typeof deletionIntentId !== "string" || deletionIntentId.length === 0) {
    throw invalidTarget();
  }
  if (targetKind === "knowledge_base") {
    return { kind: targetKind, knowledgeBaseId: job.knowledgeBaseId, deletionIntentId };
  }
  if (targetKind === "source_file") {
    const sourceFileId = payload.sourceFileId;
    if (typeof sourceFileId !== "string" || sourceFileId.length === 0) throw invalidTarget();
    return {
      kind: targetKind,
      knowledgeBaseId: job.knowledgeBaseId,
      sourceFileId,
      deletionIntentId
    };
  }
  if (targetKind === "source_directory") {
    const sourceDirectoryId = payload.sourceDirectoryId;
    if (typeof sourceDirectoryId !== "string" || sourceDirectoryId.length === 0) {
      throw invalidTarget();
    }
    return {
      kind: targetKind,
      knowledgeBaseId: job.knowledgeBaseId,
      sourceDirectoryId,
      deletionIntentId
    };
  }
  throw invalidTarget();
}

function readPayload(job: RoleJobRecord): Readonly<Record<string, unknown>> {
  const payload = job.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload instanceof Date) {
    throw invalidTarget();
  }
  return payload as Readonly<Record<string, unknown>>;
}

function initialCheckpoint(): CleanupCheckpoint {
  return {
    phase: "object_discovery",
    discoveryCursor: null,
    discoveryCompleted: false
  };
}

function continuation(date: Date, delayMs: number): RoleJobReschedule {
  return new RoleJobReschedule(new Date(date.getTime() + delayMs).toISOString());
}

function invalidTarget(): RoleJobFailure {
  return new RoleJobFailure({
    code: "INVALID_HARD_DELETE_TARGET",
    message: "Hard delete target is invalid",
    retryable: false
  });
}

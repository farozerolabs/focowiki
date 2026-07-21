import type { GenerationCleanupRepository } from "../application/ports/generation-cleanup-repository.js";
import { RoleJobReschedule, type RoleJobRecord } from "../domain/role-job.js";
import type { StorageAdapter } from "../storage/s3.js";
import { deleteStorageObjectBatch } from "./storage-object-deletion.js";

export function createGarbageCollectionJobProcessor(input: {
  cleanup: GenerationCleanupRepository;
  storage: StorageAdapter;
  batchSize: number;
  retentionDays: number;
  versionPurgeEnabled: boolean;
  continuationDelayMs: number;
  now?: () => Date;
}) {
  const now = input.now ?? (() => new Date());
  return async (job: RoleJobRecord): Promise<void> => {
    const current = now();
    const result = await runGarbageCollectionSlice({
      cleanup: input.cleanup,
      storage: input.storage,
      jobId: job.id,
      batchSize: input.batchSize,
      retentionDays: input.retentionDays,
      versionPurgeEnabled: input.versionPurgeEnabled,
      now: current
    });
    if (result.hasMore) throw continuation(current, input.continuationDelayMs);
  };
}

export async function runGarbageCollectionSlice(input: {
  cleanup: GenerationCleanupRepository;
  storage: StorageAdapter;
  jobId: string;
  batchSize: number;
  retentionDays: number;
  versionPurgeEnabled: boolean;
  now: Date;
}): Promise<{
  expiredGenerations: number;
  deletedObjects: number;
  hasMore: boolean;
}> {
  const olderThan = new Date(
    input.now.getTime() - input.retentionDays * 24 * 60 * 60 * 1_000
  ).toISOString();
  const expiredGenerations = await input.cleanup.deleteExpiredGenerations({
    olderThan,
    limit: input.batchSize
  });
  if (expiredGenerations >= input.batchSize) {
    return { expiredGenerations, deletedObjects: 0, hasMore: true };
  }

  let objects = await input.cleanup.listClaimedImmutableObjects({
    jobId: input.jobId,
    limit: input.batchSize
  });
  if (objects.length === 0) {
    const claimed = await input.cleanup.claimUnreferencedImmutableObjects({
      jobId: input.jobId,
      cursor: null,
      olderThan,
      limit: input.batchSize
    });
    objects = claimed.objects;
  }
  if (objects.length === 0) {
    return { expiredGenerations, deletedObjects: 0, hasMore: false };
  }

  await deleteStorageObjectBatch({
    storage: input.storage,
    objectKeys: objects.map((object) => object.objectKey),
    versionPurgeEnabled: input.versionPurgeEnabled
  });
  const deletedObjects = await input.cleanup.completeImmutableObjectDeletions({
    jobId: input.jobId,
    objects: objects.map((object) => ({
      checksumSha256: object.checksumSha256,
      formatVersion: object.formatVersion
    }))
  });
  return {
    expiredGenerations,
    deletedObjects,
    hasMore: objects.length >= input.batchSize
  };
}

function continuation(now: Date, delayMs: number): RoleJobReschedule {
  return new RoleJobReschedule(new Date(now.getTime() + delayMs).toISOString());
}

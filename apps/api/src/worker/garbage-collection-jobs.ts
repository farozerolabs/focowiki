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
    const olderThan = new Date(
      current.getTime() - input.retentionDays * 24 * 60 * 60 * 1_000
    ).toISOString();
    const expired = await input.cleanup.deleteExpiredGenerations({
      olderThan,
      limit: input.batchSize
    });
    if (expired >= input.batchSize) {
      throw continuation(current, input.continuationDelayMs);
    }

    let objects = await input.cleanup.listClaimedImmutableObjects({
      jobId: job.id,
      limit: input.batchSize
    });
    if (objects.length === 0) {
      const claimed = await input.cleanup.claimUnreferencedImmutableObjects({
        jobId: job.id,
        cursor: null,
        olderThan,
        limit: input.batchSize
      });
      objects = claimed.objects;
    }
    if (objects.length === 0) return;

    await deleteStorageObjectBatch({
      storage: input.storage,
      objectKeys: objects.map((object) => object.objectKey),
      versionPurgeEnabled: input.versionPurgeEnabled
    });
    await input.cleanup.completeImmutableObjectDeletions({
      jobId: job.id,
      objects: objects.map((object) => ({
        checksumSha256: object.checksumSha256,
        formatVersion: object.formatVersion
      }))
    });
    if (objects.length >= input.batchSize) {
      throw continuation(current, input.continuationDelayMs);
    }
  };
}

function continuation(now: Date, delayMs: number): RoleJobReschedule {
  return new RoleJobReschedule(new Date(now.getTime() + delayMs).toISOString());
}

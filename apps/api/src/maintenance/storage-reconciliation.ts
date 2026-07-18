import { randomUUID } from "node:crypto";
import type { StorageReconciliationRepository } from "../application/ports/storage-reconciliation-repository.js";
import { createImmutableObjectKey } from "../domain/generation.js";
import type { RuntimeMaintenanceSettings } from "../runtime-settings/types.js";
import { deleteStorageObjectBatch } from "../worker/storage-object-deletion.js";
import type { StorageAdapter, StorageObjectMetadata } from "../storage/s3.js";

type ReconciliationStorage = StorageAdapter & {
  listObjectMetadata: NonNullable<StorageAdapter["listObjectMetadata"]>;
  headObjectMetadata: NonNullable<StorageAdapter["headObjectMetadata"]>;
};

export type StorageReconciliationSliceResult = {
  claimed: boolean;
  phase: "idle" | "scanning" | "deleting" | "verifying" | "completed" | "failed";
  scanned: number;
  deleted: number;
  verified: number;
  failed: number;
};

export function parseManagedImmutableObjectKey(
  prefix: string,
  objectKey: string
): { checksumSha256: string; formatVersion: number } | null {
  const normalizedPrefix = prefix.replace(/^\/+|\/+$/g, "");
  const managedPrefix = `${normalizedPrefix}/generated/`;
  if (!normalizedPrefix || !objectKey.startsWith(managedPrefix)) return null;

  const match = /^v([1-9]\d*)\/objects\/([a-f0-9]{2})\/([a-f0-9]{64})$/.exec(
    objectKey.slice(managedPrefix.length)
  );
  if (!match) return null;
  const formatVersion = Number(match[1]);
  const checksumSha256 = match[3]!;
  if (!Number.isSafeInteger(formatVersion) || match[2] !== checksumSha256.slice(0, 2)) {
    return null;
  }
  if (createImmutableObjectKey({ prefix: normalizedPrefix, checksumSha256, formatVersion }) !== objectKey) {
    return null;
  }
  return { checksumSha256, formatVersion };
}

export async function runStorageReconciliationSlice(input: {
  repository: StorageReconciliationRepository;
  storage: ReconciliationStorage;
  settings: RuntimeMaintenanceSettings;
  versionPurgeEnabled: boolean;
  now?: () => Date;
  leaseToken?: string;
  cycleId?: string;
}): Promise<StorageReconciliationSliceResult> {
  if (!input.settings.reconciliationEnabled) return emptyResult("idle", false);

  const now = input.now ?? (() => new Date());
  const startedAt = now();
  const leaseToken = input.leaseToken ?? randomUUID();
  const prefix = `${input.storage.keyspace.prefix}/generated/`;
  const cycle = await input.repository.claimCycle({
    prefix,
    cycleId: input.cycleId ?? randomUUID(),
    leaseToken,
    now: startedAt.toISOString(),
    leaseExpiresAt: new Date(startedAt.getTime() + 5 * 60_000).toISOString()
  });
  if (!cycle) return emptyResult("idle", false);

  try {
    if (cycle.state === "scanning") {
      const page = await input.storage.listObjectMetadata({
        prefix: cycle.prefix,
        continuationToken: cycle.continuationToken,
        limit: input.settings.scanBatchSize
      });
      const objects = page.objects.flatMap((object) => {
        const identity = parseManagedImmutableObjectKey(input.storage.keyspace.prefix, object.key);
        return identity ? [{ ...object, ...identity }] : [];
      });
      await input.repository.recordScanPage({
        cycle,
        leaseToken,
        objects,
        nextContinuationToken: page.nextContinuationToken,
        recordedAt: now().toISOString()
      });
      return { ...emptyResult("scanning", true), scanned: page.objects.length };
    }

    const current = now();
    const candidates = await input.repository.claimDeletionCandidates({
      cycle,
      leaseToken,
      now: current.toISOString(),
      graceBefore: new Date(
        current.getTime() - input.settings.quarantineGracePeriodSeconds * 1_000
      ).toISOString(),
      confirmationPasses: input.settings.confirmationPasses,
      maxAttempts: input.settings.maxAttempts,
      limit: input.settings.deletionBatchSize
    });
    if (candidates.length > 0) {
      const result = emptyResult("deleting", true);
      for (const candidate of candidates) {
        try {
          const metadata = await input.storage.headObjectMetadata(candidate.key);
          if (metadata && observationChanged(candidate, metadata)) {
            await input.repository.refreshCandidateObservation({
              prefix: cycle.prefix,
              object: {
                key: candidate.key,
                checksumSha256: candidate.checksumSha256,
                formatVersion: candidate.formatVersion,
                sizeBytes: metadata.sizeBytes,
                etag: metadata.etag,
                lastModified: metadata.lastModified
              },
              observedAt: now().toISOString()
            });
            continue;
          }

          const authorizedAt = now().toISOString();
          const authorized = await input.repository.authorizeCandidateDeletion({
            cycle,
            leaseToken,
            objectKey: candidate.key,
            checksumSha256: candidate.checksumSha256,
            formatVersion: candidate.formatVersion,
            authorizedAt
          });
          if (!authorized) continue;

          const finalMetadata = await input.storage.headObjectMetadata(candidate.key);
          if (finalMetadata && observationChanged(candidate, finalMetadata)) {
            await input.repository.refreshCandidateObservation({
              prefix: cycle.prefix,
              object: {
                key: candidate.key,
                checksumSha256: candidate.checksumSha256,
                formatVersion: candidate.formatVersion,
                sizeBytes: finalMetadata.sizeBytes,
                etag: finalMetadata.etag,
                lastModified: finalMetadata.lastModified
              },
              observedAt: now().toISOString()
            });
            continue;
          }

          if (finalMetadata) {
            await deleteStorageObjectBatch({
              storage: input.storage,
              objectKeys: [candidate.key],
              versionPurgeEnabled: input.versionPurgeEnabled
            });
          }
          await input.repository.completeCandidateDeletion({
            prefix: cycle.prefix,
            objectKey: candidate.key,
            completedAt: now().toISOString()
          });
          result.deleted += 1;
        } catch {
          await input.repository.failCandidateDeletion({
            prefix: cycle.prefix,
            objectKey: candidate.key,
            errorCode: "STORAGE_DELETE_FAILED",
            retryAt: new Date(now().getTime() + input.settings.retryDelayMs).toISOString(),
            failedAt: now().toISOString()
          });
          result.failed += 1;
        }
      }
      return result;
    }

    const registered = await input.repository.listRegisteredObjectsForVerification({
      cycle,
      leaseToken,
      limit: input.settings.scanBatchSize
    });
    if (registered.length > 0) {
      for (const object of registered) {
        const metadata = await input.storage.headObjectMetadata(object.objectKey);
        await input.repository.recordRegisteredObjectCheck({
          cycle,
          leaseToken,
          object,
          exists: metadata !== null,
          checkedAt: now().toISOString()
        });
      }
      return { ...emptyResult("verifying", true), verified: registered.length };
    }

    const completedAt = now();
    await input.repository.finishCycle({
      cycle,
      leaseToken,
      nextScanAt: new Date(
        completedAt.getTime() + input.settings.scanIntervalSeconds * 1_000
      ).toISOString(),
      completedAt: completedAt.toISOString()
    });
    return emptyResult("completed", true);
  } catch {
    const failedAt = now();
    await input.repository.failCycle({
      cycle,
      leaseToken,
      errorCode: "STORAGE_RECONCILIATION_FAILED",
      retryAt: new Date(failedAt.getTime() + input.settings.retryDelayMs).toISOString(),
      failedAt: failedAt.toISOString()
    });
    return { ...emptyResult("failed", true), failed: 1 };
  }
}

function observationChanged(
  candidate: { sizeBytes: number; etag: string | null },
  metadata: StorageObjectMetadata
): boolean {
  return candidate.sizeBytes !== metadata.sizeBytes || candidate.etag !== metadata.etag;
}

function emptyResult(
  phase: StorageReconciliationSliceResult["phase"],
  claimed: boolean
): StorageReconciliationSliceResult {
  return { claimed, phase, scanned: 0, deleted: 0, verified: 0, failed: 0 };
}

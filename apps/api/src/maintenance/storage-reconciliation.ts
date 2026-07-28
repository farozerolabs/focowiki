import { randomUUID } from "node:crypto";
import type { StorageReconciliationRepository } from "../application/ports/storage-reconciliation-repository.js";
import { createImmutableObjectKey } from "../domain/generation.js";
import type { RuntimeMaintenanceSettings } from "../runtime-settings/types.js";
import { deleteStorageObjectBatch } from "../worker/storage-object-deletion.js";
import type { StorageAdapter, StorageObjectMetadata } from "../storage/s3.js";
import {
  createStoragePageCheckpointId,
  planStoragePageChunks,
  reduceStorageDatabaseChunkSize
} from "./storage-reconciliation-chunks.js";

type ReconciliationStorage = StorageAdapter & {
  listObjectMetadata: NonNullable<StorageAdapter["listObjectMetadata"]>;
  headObjectMetadata: NonNullable<StorageAdapter["headObjectMetadata"]>;
};

type StorageReconciliationSettings = Pick<
  RuntimeMaintenanceSettings,
  | "reconciliationEnabled"
  | "scanIntervalSeconds"
  | "scanBatchSize"
  | "deletionBatchSize"
  | "quarantineGracePeriodSeconds"
  | "confirmationPasses"
  | "maxAttempts"
  | "retryDelayMs"
>;

const RECONCILIATION_LEASE_MS = 5 * 60_000;
const RECONCILIATION_LEASE_RENEWAL_WINDOW_MS = 60_000;
const RECONCILIATION_DELETION_STALE_MS = 10 * 60_000;
const RECONCILIATION_HEARTBEAT_MS = 30_000;
const DEFAULT_DATABASE_CHUNK_SIZE = 250;

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
  settings: StorageReconciliationSettings;
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
  let leaseExpiresAt = new Date(startedAt.getTime() + RECONCILIATION_LEASE_MS);
  const cycle = await input.repository.claimCycle({
    prefix,
    cycleId: input.cycleId ?? randomUUID(),
    leaseToken,
    now: startedAt.toISOString(),
    leaseExpiresAt: leaseExpiresAt.toISOString()
  });
  if (!cycle) return emptyResult("idle", false);
  let activePageId: string | null = null;
  let activeDatabaseChunkSize = cycle.databaseChunkSize
    ?? Math.max(25, Math.min(DEFAULT_DATABASE_CHUNK_SIZE, input.settings.scanBatchSize));

  try {
    if (cycle.state === "scanning") {
      await renewLease();
      const pageStartedAt = Date.now();
      const page = await withLeaseHeartbeat(() =>
        input.storage.listObjectMetadata({
          prefix: cycle.prefix,
          continuationToken: cycle.continuationToken,
          limit: input.settings.scanBatchSize
        })
      );
      const objects = page.objects.flatMap((object) => {
        const identity = parseManagedImmutableObjectKey(input.storage.keyspace.prefix, object.key);
        return identity ? [{ ...object, ...identity }] : [];
      });
      const readiness = await input.repository.getProtectionReadiness();
      activePageId = createStoragePageCheckpointId({
        cycleId: cycle.cycleId,
        continuationToken: cycle.continuationToken,
        nextContinuationToken: page.nextContinuationToken
      });
      const progress = await input.repository.prepareScanPage({
        cycle,
        leaseToken,
        pageId: activePageId,
        nextContinuationToken: page.nextContinuationToken,
        listedCount: objects.length,
        databaseChunkSize: activeDatabaseChunkSize,
        preparedAt: now().toISOString()
      });
      if (!progress) throw ownershipError();
      activeDatabaseChunkSize = progress.databaseChunkSize;
      if (!progress.committed) {
        const remainingObjects = objects.slice(progress.completedObjectCount);
        const chunks = planStoragePageChunks(
          remainingObjects,
          activeDatabaseChunkSize
        );
        for (const chunk of chunks) {
          await renewLease();
          const objectOffset = progress.completedObjectCount + chunk.offset;
          const committed = await withLeaseHeartbeat(() =>
            input.repository.recordScanChunk({
              cycle,
              leaseToken,
              pageId: activePageId!,
              objectOffset,
              objects: chunk.objects,
              allowQuarantine: readiness === "ready",
              recordedAt: now().toISOString()
            })
          );
          if (!committed) throw ownershipError();
          await renewLease();
        }
        const completed = await input.repository.completeScanPage({
          cycle,
          leaseToken,
          pageId: activePageId,
          completedAt: now().toISOString(),
          batchLatencyMs: Math.max(0, Date.now() - pageStartedAt)
        });
        if (!completed) throw ownershipError();
      }
      return { ...emptyResult("scanning", true), scanned: page.objects.length };
    }

    const current = now();
    const candidates = await input.repository.claimDeletionCandidates({
      cycle,
      leaseToken,
      now: current.toISOString(),
      staleDeletingBefore: new Date(
        current.getTime() - RECONCILIATION_DELETION_STALE_MS
      ).toISOString(),
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
          await renewLeaseWhenNeeded();
          const metadata = await input.storage.headObjectMetadata(candidate.key);
          if (metadata && observationChanged(candidate, metadata)) {
            await input.repository.refreshCandidateObservation({
              cycle,
              leaseToken,
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
              cycle,
              leaseToken,
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
            cycle,
            leaseToken,
            objectKey: candidate.key,
            completedAt: now().toISOString()
          });
          result.deleted += 1;
        } catch {
          await input.repository.failCandidateDeletion({
            cycle,
            leaseToken,
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
        await renewLeaseWhenNeeded();
        const metadata = await input.storage.headObjectMetadata(object.objectKey);
        const recorded = await input.repository.recordRegisteredObjectCheck({
          cycle,
          leaseToken,
          object,
          exists: metadata !== null,
          checkedAt: now().toISOString()
        });
        if (!recorded) throw ownershipError();
      }
      return { ...emptyResult("verifying", true), verified: registered.length };
    }

    const completedAt = now();
    const completed = await input.repository.finishCycle({
      cycle,
      leaseToken,
      nextScanAt: new Date(
        completedAt.getTime() + input.settings.scanIntervalSeconds * 1_000
      ).toISOString(),
      completedAt: completedAt.toISOString()
    });
    if (!completed) throw ownershipError();
    return emptyResult("completed", true);
  } catch (error) {
    const failedAt = now();
    const retryable = isRetryableReconciliationError(error);
    const reducedChunkSize = retryable && activePageId
      ? reduceStorageDatabaseChunkSize(activeDatabaseChunkSize)
      : activeDatabaseChunkSize;
    if (retryable && activePageId && reducedChunkSize < activeDatabaseChunkSize) {
      await input.repository.reduceScanPageChunkSize({
        cycle,
        leaseToken,
        pageId: activePageId,
        databaseChunkSize: reducedChunkSize,
        reducedAt: failedAt.toISOString()
      }).catch(() => false);
    }
    await input.repository.failCycle({
      cycle,
      leaseToken,
      errorCode: retryable
        ? "STORAGE_RECONCILIATION_RETRYABLE_TIMEOUT"
        : readSafeErrorCode(error),
      retryAt: new Date(failedAt.getTime() + input.settings.retryDelayMs).toISOString(),
      failedAt: failedAt.toISOString(),
      databaseChunkSize: reducedChunkSize
    });
    return { ...emptyResult("failed", true), failed: 1 };
  }

  async function renewLeaseWhenNeeded(): Promise<void> {
    const renewedAt = now();
    if (
      leaseExpiresAt.getTime() - renewedAt.getTime()
      > RECONCILIATION_LEASE_RENEWAL_WINDOW_MS
    ) {
      return;
    }
    const nextLeaseExpiresAt = new Date(renewedAt.getTime() + RECONCILIATION_LEASE_MS);
    const renewed = await input.repository.renewCycleLease({
      cycle: cycle!,
      leaseToken,
      renewedAt: renewedAt.toISOString(),
      leaseExpiresAt: nextLeaseExpiresAt.toISOString()
    });
    if (!renewed) throw new Error("Storage reconciliation lease renewal failed");
    leaseExpiresAt = nextLeaseExpiresAt;
  }

  async function renewLease(): Promise<void> {
    const renewedAt = now();
    const nextLeaseExpiresAt = new Date(renewedAt.getTime() + RECONCILIATION_LEASE_MS);
    const renewed = await input.repository.renewCycleLease({
      cycle: cycle!,
      leaseToken,
      renewedAt: renewedAt.toISOString(),
      leaseExpiresAt: nextLeaseExpiresAt.toISOString()
    });
    if (!renewed) throw ownershipError();
    leaseExpiresAt = nextLeaseExpiresAt;
  }

  async function withLeaseHeartbeat<T>(operation: () => Promise<T>): Promise<T> {
    let heartbeatError: unknown = null;
    let heartbeatPromise: Promise<void> | null = null;
    const timer = setInterval(() => {
      if (heartbeatPromise || heartbeatError) return;
      heartbeatPromise = renewLease()
        .catch((error) => {
          heartbeatError = error;
        })
        .finally(() => {
          heartbeatPromise = null;
        });
    }, RECONCILIATION_HEARTBEAT_MS);
    timer.unref();
    const outcome = await operation().then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    );
    clearInterval(timer);
    if (heartbeatPromise) await heartbeatPromise;
    if (heartbeatError) throw heartbeatError;
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
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

function isRetryableReconciliationError(error: unknown): boolean {
  const code = readErrorCode(error);
  return new Set(["57014", "55P03", "40001", "40P01", "53300"]).has(code);
}

function readSafeErrorCode(error: unknown): string {
  const code = readErrorCode(error);
  return /^[A-Z0-9_]{3,80}$/u.test(code)
    ? code
    : "STORAGE_RECONCILIATION_FAILED";
}

function readErrorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    && typeof error.code === "string"
    ? error.code
    : "";
}

function ownershipError(): Error {
  const error = new Error("Storage reconciliation ownership expired");
  Object.assign(error, { code: "STORAGE_RECONCILIATION_OWNERSHIP_EXPIRED" });
  return error;
}

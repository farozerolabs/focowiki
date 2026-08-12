import type {
  SearchProviderOperationReceipt,
  SearchProviderRuntime
} from "../../application/ports/search-provider-runtime.js";
import type {
  StorageVnextSearchCleanupLease,
  StorageVnextSearchCleanupRepository
} from "./cleanup-repository.js";

const MAXIMUM_POLL_ATTEMPTS = 36_000;

export type StorageVnextSearchCleanupErrorCode =
  | "invalid_configuration"
  | "invalid_input"
  | "provider_contract_unavailable"
  | "provider_index_not_deleted"
  | "provider_task_failed"
  | "provider_task_timeout";

export class StorageVnextSearchCleanupError extends Error {
  public constructor(public readonly code: StorageVnextSearchCleanupErrorCode) {
    super(`Storage vNext search cleanup error: ${code}`);
    this.name = "StorageVnextSearchCleanupError";
  }
}

type CleanupConfig = {
  repository: StorageVnextSearchCleanupRepository;
  provider: SearchProviderRuntime;
  indexUidPrefix: string;
  indexPageSize: number;
  taskPageSize: number;
  maxDeletesPerRun: number;
  maxPollAttempts: number;
  pollIntervalMs: number;
  highWaterRatio: number;
  minimumReclaimableBytes: number;
  sleep?: (milliseconds: number) => Promise<void>;
};

export function createStorageVnextSearchCleanup(config: CleanupConfig) {
  assertConfig(config);
  const sleep = config.sleep ?? wait;
  const ownedPrefix = `${config.indexUidPrefix}_`;

  return {
    async cleanupFailedCandidate(input: {
      failedBefore: string;
      correlationPublicId: string;
      candidatePublicId?: string;
    }) {
      assertTimestamp(input.failedBefore);
      assertId(input.correlationPublicId);
      if (input.candidatePublicId !== undefined) assertId(input.candidatePublicId);
      const lease = await config.repository.claimFailedCandidate({
        ...input,
        providerKind: config.provider.kind
      });
      if (!lease) return { outcome: "none" as const, candidatePublicId: null };
      await deleteLeasedIndex(lease);
      await config.repository.completeFailedCandidateCleanup({
        candidatePublicId: lease.publicId,
        correlationPublicId: lease.correlationPublicId
      });
      return { outcome: "deleted" as const, candidatePublicId: lease.publicId };
    },

    async cleanupOrphanIndexes(input: {
      updatedBefore: string;
      continuation: string | null;
    }) {
      assertTimestamp(input.updatedBefore);
      const listIndexes = config.provider.maintenance?.listOwnedIndexes;
      if (!listIndexes) return { deleted: 0, continuation: null };
      const page = await listIndexes({
        indexUidPrefix: ownedPrefix,
        continuation: input.continuation,
        limit: config.indexPageSize
      });
      const owned = page.indexes;
      const retained = new Set(await config.repository.listRetainedProviderIndexUids({
        providerKind: config.provider.kind,
        providerIndexUids: owned.map((item) => item.indexUid)
      }));
      const eligible = owned.filter((item) =>
        !retained.has(item.indexUid)
        && timestampAtOrBefore(item.updatedAt, input.updatedBefore)
      ).slice(0, config.maxDeletesPerRun);
      for (const item of eligible) await deleteUnleasedIndex(item.indexUid);
      return {
        deleted: eligible.length,
        continuation: eligible.length > 0
          ? page.restartContinuation
          : page.continuation
      };
    },

    async cleanupFinishedTasks(input: {
      finishedBefore: string;
      continuation: string | null;
    }) {
      assertTimestamp(input.finishedBefore);
      const deleteFinished = config.provider.maintenance
        ?.deleteOwnedFinishedOperations;
      if (!deleteFinished) return { deleted: 0, continuation: null };
      const result = await deleteFinished({
        indexUidPrefixes: [
          ownedPrefix,
          `${config.indexUidPrefix}-semantic-`
        ],
        beforeFinishedAt: input.finishedBefore,
        continuation: input.continuation,
        limit: Math.min(config.taskPageSize, config.maxDeletesPerRun)
      });
      await pollOperation(result.operation);
      return {
        deleted: Math.min(result.deleted, config.maxDeletesPerRun),
        continuation: result.continuation
      };
    },

    async compactHighWater(input: {
      compactedBefore: string;
      correlationPublicId: string;
      availableDiskBytes: number;
    }) {
      assertTimestamp(input.compactedBefore);
      assertId(input.correlationPublicId);
      assertOrdinal(input.availableDiskBytes);
      const getDatabaseStats = config.provider.maintenance?.getStorageStats;
      const compactIndex = config.provider.maintenance?.compactIndex;
      if (!getDatabaseStats || !compactIndex) {
        return { outcome: "not_supported" as const };
      }
      const before = await getDatabaseStats();
      assertStats(before);
      const reclaimableBytes = before.databaseSizeBytes - before.usedDatabaseSizeBytes;
      const fragmentationRatio = before.databaseSizeBytes === 0
        ? 0
        : reclaimableBytes / before.databaseSizeBytes;
      if (
        fragmentationRatio <= config.highWaterRatio
        || reclaimableBytes < config.minimumReclaimableBytes
      ) return { outcome: "not_needed" as const, before };
      if (input.availableDiskBytes < before.databaseSizeBytes) {
        return { outcome: "rebuild_required" as const, before };
      }
      const lease = await config.repository.claimActiveCompaction({
        compactedBefore: input.compactedBefore,
        correlationPublicId: input.correlationPublicId
      });
      if (!lease) return { outcome: "deferred" as const, before };
      if (lease.providerKind !== config.provider.kind) {
        throw cleanupError("invalid_input");
      }
      let receipt: SearchProviderOperationReceipt;
      if (lease.providerOperationRef) {
        receipt = {
          state: "pending",
          operationRef: lease.providerOperationRef
        };
      } else {
        receipt = await compactIndex({ indexUid: lease.providerIndexUid });
        if (receipt.state === "pending") {
        await config.repository.recordCleanupOperation({
          projectionPublicId: lease.publicId,
          correlationPublicId: lease.correlationPublicId,
            providerOperationRef: receipt.operationRef
        });
        }
      }
      await pollCleanupOperation(lease, receipt);
      const after = await getDatabaseStats();
      assertStats(after);
      await config.repository.completeCompaction({
        projectionPublicId: lease.publicId,
        correlationPublicId: lease.correlationPublicId,
        databaseSizeBytes: after.databaseSizeBytes,
        usedDatabaseSizeBytes: after.usedDatabaseSizeBytes
      });
      return {
        outcome: "compacted" as const,
        providerIndexUid: lease.providerIndexUid,
        before,
        after
      };
    }
  };

  async function deleteLeasedIndex(lease: StorageVnextSearchCleanupLease) {
    if (lease.providerKind !== config.provider.kind) {
      throw cleanupError("invalid_input");
    }
    let receipt: SearchProviderOperationReceipt;
    if (lease.providerOperationRef) {
      receipt = {
        state: "pending",
        operationRef: lease.providerOperationRef
      };
    } else {
      const current = await config.provider.admin.getIndex({
        indexUid: lease.providerIndexUid
      });
      if (!current) return;
      receipt = await config.provider.admin.deleteIndex({
        indexUid: lease.providerIndexUid
      });
      if (receipt.state === "pending") {
      await config.repository.recordCleanupOperation({
        projectionPublicId: lease.publicId,
        correlationPublicId: lease.correlationPublicId,
          providerOperationRef: receipt.operationRef
      });
      }
    }
    await pollCleanupOperation(lease, receipt);
    if (await config.provider.admin.getIndex({ indexUid: lease.providerIndexUid })) {
      throw cleanupError("provider_index_not_deleted");
    }
  }

  async function deleteUnleasedIndex(indexUid: string) {
    const current = await config.provider.admin.getIndex({ indexUid });
    if (!current) return;
    const receipt = await config.provider.admin.deleteIndex({ indexUid });
    await pollOperation(receipt);
    if (await config.provider.admin.getIndex({ indexUid })) {
      throw cleanupError("provider_index_not_deleted");
    }
  }

  async function pollCleanupOperation(
    lease: StorageVnextSearchCleanupLease,
    receipt: SearchProviderOperationReceipt
  ) {
    try {
      await pollOperation(receipt);
    } catch (error) {
      if (error instanceof StorageVnextSearchCleanupError
        && error.code === "provider_task_failed") {
        await config.repository.clearCleanupOperation({
          projectionPublicId: lease.publicId,
          correlationPublicId: lease.correlationPublicId,
          providerOperationRef: receipt.state === "pending"
            ? receipt.operationRef
            : ""
        });
      }
      throw error;
    }
  }

  async function pollOperation(receipt: SearchProviderOperationReceipt) {
    if (receipt.state === "completed") return;
    for (let attempt = 1; attempt <= config.maxPollAttempts; attempt += 1) {
      const operation = await config.provider.operations.getOperation({
        operationRef: receipt.operationRef
      });
      if (operation.state === "completed") return;
      if (operation.state === "failed") throw cleanupError("provider_task_failed");
      if (attempt < config.maxPollAttempts) await sleep(config.pollIntervalMs);
    }
    throw cleanupError("provider_task_timeout");
  }
}

function assertConfig(config: CleanupConfig) {
  if (!/^[A-Za-z0-9_-]+$/u.test(config.indexUidPrefix)) {
    throw cleanupError("invalid_configuration");
  }
  for (const value of [
    config.indexPageSize,
    config.taskPageSize,
    config.maxDeletesPerRun
  ]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
      throw cleanupError("invalid_configuration");
    }
  }
  if (
    !Number.isSafeInteger(config.maxPollAttempts)
    || config.maxPollAttempts < 1
    || config.maxPollAttempts > MAXIMUM_POLL_ATTEMPTS
    ||
    !Number.isFinite(config.highWaterRatio)
    || config.highWaterRatio <= 0
    || config.highWaterRatio >= 1
    || !Number.isSafeInteger(config.minimumReclaimableBytes)
    || config.minimumReclaimableBytes < 0
    || !Number.isSafeInteger(config.pollIntervalMs)
    || config.pollIntervalMs < 0
  ) throw cleanupError("invalid_configuration");
}

function assertStats(stats: {
  databaseSizeBytes: number;
  usedDatabaseSizeBytes: number;
}) {
  assertOrdinal(stats.databaseSizeBytes);
  assertOrdinal(stats.usedDatabaseSizeBytes);
  if (stats.usedDatabaseSizeBytes > stats.databaseSizeBytes) {
    throw cleanupError("invalid_input");
  }
}

function timestampAtOrBefore(value: string, boundary: string) {
  return Date.parse(value) <= Date.parse(boundary);
}

function assertTimestamp(value: string) {
  if (!value || !Number.isFinite(Date.parse(value))) throw cleanupError("invalid_input");
}

function assertOrdinal(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw cleanupError("invalid_input");
}

function assertId(value: string) {
  if (!value || Buffer.byteLength(value) > 255) throw cleanupError("invalid_input");
}

function cleanupError(code: StorageVnextSearchCleanupErrorCode) {
  return new StorageVnextSearchCleanupError(code);
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

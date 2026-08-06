import type {
  SearchEngineDatabaseStats,
  SearchEngineTask,
  SearchEngineTransport
} from "../../application/ports/search-engine-transport.js";
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
  transport: SearchEngineTransport;
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
    }) {
      assertTimestamp(input.failedBefore);
      assertId(input.correlationPublicId);
      const lease = await config.repository.claimFailedCandidate(input);
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
      offset: number;
    }) {
      assertTimestamp(input.updatedBefore);
      assertOffset(input.offset);
      const listIndexes = requireProvider(config.transport.listIndexes);
      const page = await listIndexes({
        offset: input.offset,
        limit: config.indexPageSize
      });
      assertIndexPage(page, input.offset);
      const owned = page.indexes.filter((item) => item.uid.startsWith(ownedPrefix));
      const retained = new Set(await config.repository.listRetainedProviderIndexUids(
        owned.map((item) => item.uid)
      ));
      const eligible = owned.filter((item) =>
        !retained.has(item.uid)
        && timestampAtOrBefore(item.updatedAt, input.updatedBefore)
      ).slice(0, config.maxDeletesPerRun);
      for (const item of eligible) await deleteUnleasedIndex(item.uid);
      return {
        deleted: eligible.length,
        nextOffset: eligible.length > 0
          ? 0
          : nextIndexOffset(page.offset, page.indexes.length, page.total)
      };
    },

    async cleanupFinishedTasks(input: {
      finishedBefore: string;
      from: number | null;
    }) {
      assertTimestamp(input.finishedBefore);
      if (input.from !== null) assertOrdinal(input.from);
      const listFinishedTasks = requireProvider(config.transport.listFinishedTasks);
      const deleteFinishedTasks = requireProvider(config.transport.deleteFinishedTasks);
      const page = await listFinishedTasks({
        statuses: ["succeeded", "failed", "canceled"],
        beforeFinishedAt: input.finishedBefore,
        from: input.from,
        limit: config.taskPageSize
      });
      assertFinishedTaskPage(page, input.finishedBefore);
      const taskUids = page.tasks
        .filter((task) => task.indexUid?.startsWith(ownedPrefix))
        .slice(0, config.maxDeletesPerRun)
        .map((task) => task.taskUid);
      if (taskUids.length > 0) {
        const deletion = await deleteFinishedTasks({ taskUids });
        await pollTask(deletion.taskUid);
      }
      return { deleted: taskUids.length, next: page.next };
    },

    async compactHighWater(input: {
      compactedBefore: string;
      correlationPublicId: string;
      availableDiskBytes: number;
    }) {
      assertTimestamp(input.compactedBefore);
      assertId(input.correlationPublicId);
      assertOrdinal(input.availableDiskBytes);
      const getDatabaseStats = requireProvider(config.transport.getDatabaseStats);
      const compactIndex = requireProvider(config.transport.compactIndex);
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
      let taskUid = lease.providerTaskUid;
      if (taskUid === null) {
        taskUid = (await compactIndex(lease.providerIndexUid)).taskUid;
        await config.repository.recordCleanupTask({
          projectionPublicId: lease.publicId,
          correlationPublicId: lease.correlationPublicId,
          providerTaskUid: taskUid
        });
      }
      await pollCleanupTask(lease, taskUid);
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
    let taskUid = lease.providerTaskUid;
    if (taskUid === null) {
      const current = await config.transport.getIndex({
        indexUid: lease.providerIndexUid
      });
      if (!current) return;
      taskUid = (await config.transport.deleteIndex(lease.providerIndexUid)).taskUid;
      await config.repository.recordCleanupTask({
        projectionPublicId: lease.publicId,
        correlationPublicId: lease.correlationPublicId,
        providerTaskUid: taskUid
      });
    }
    await pollCleanupTask(lease, taskUid);
    if (await config.transport.getIndex({ indexUid: lease.providerIndexUid })) {
      throw cleanupError("provider_index_not_deleted");
    }
  }

  async function deleteUnleasedIndex(indexUid: string) {
    const current = await config.transport.getIndex({ indexUid });
    if (!current) return;
    const task = await config.transport.deleteIndex(indexUid);
    await pollTask(task.taskUid);
    if (await config.transport.getIndex({ indexUid })) {
      throw cleanupError("provider_index_not_deleted");
    }
  }

  async function pollCleanupTask(
    lease: StorageVnextSearchCleanupLease,
    taskUid: number
  ) {
    try {
      await pollTask(taskUid);
    } catch (error) {
      if (error instanceof StorageVnextSearchCleanupError
        && error.code === "provider_task_failed") {
        await config.repository.clearCleanupTask({
          projectionPublicId: lease.publicId,
          correlationPublicId: lease.correlationPublicId,
          providerTaskUid: taskUid
        });
      }
      throw error;
    }
  }

  async function pollTask(taskUid: number) {
    assertOrdinal(taskUid);
    for (let attempt = 1; attempt <= config.maxPollAttempts; attempt += 1) {
      const task = await config.transport.getTask(taskUid);
      if (task.status === "succeeded") return;
      if (isTerminalFailure(task)) throw cleanupError("provider_task_failed");
      if (attempt < config.maxPollAttempts) await sleep(config.pollIntervalMs);
    }
    throw cleanupError("provider_task_timeout");
  }
}

function requireProvider<T>(value: T | undefined): T {
  if (!value) throw cleanupError("provider_contract_unavailable");
  return value;
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

function assertIndexPage(
  page: { indexes: Array<{ uid: string; updatedAt: string }>; total: number; offset: number },
  expectedOffset: number
) {
  assertOffset(page.offset);
  assertOrdinal(page.total);
  if (page.offset !== expectedOffset || page.indexes.length > page.total) {
    throw cleanupError("invalid_input");
  }
  if (
    page.offset + page.indexes.length > page.total
    || (page.indexes.length === 0 && page.offset < page.total)
  ) throw cleanupError("invalid_input");
  for (const item of page.indexes) {
    assertId(item.uid);
    assertTimestamp(item.updatedAt);
  }
}

function assertFinishedTaskPage(
  page: {
    tasks: Array<{
      taskUid: number;
      status: string;
      finishedAt: string;
    }>;
    next: number | null;
  },
  finishedBefore: string
) {
  if (page.next !== null) assertOrdinal(page.next);
  for (const task of page.tasks) {
    assertOrdinal(task.taskUid);
    assertTimestamp(task.finishedAt);
    if (
      !["succeeded", "failed", "canceled"].includes(task.status)
      || !timestampAtOrBefore(task.finishedAt, finishedBefore)
    ) throw cleanupError("invalid_input");
  }
}

function assertStats(stats: SearchEngineDatabaseStats) {
  assertOrdinal(stats.databaseSizeBytes);
  assertOrdinal(stats.usedDatabaseSizeBytes);
  if (stats.usedDatabaseSizeBytes > stats.databaseSizeBytes) {
    throw cleanupError("invalid_input");
  }
}

function nextIndexOffset(offset: number, count: number, total: number) {
  return offset + count < total ? offset + count : null;
}

function timestampAtOrBefore(value: string, boundary: string) {
  return Date.parse(value) <= Date.parse(boundary);
}

function assertTimestamp(value: string) {
  if (!value || !Number.isFinite(Date.parse(value))) throw cleanupError("invalid_input");
}

function assertOffset(value: number) {
  assertOrdinal(value);
}

function assertOrdinal(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw cleanupError("invalid_input");
}

function assertId(value: string) {
  if (!value || Buffer.byteLength(value) > 255) throw cleanupError("invalid_input");
}

function isTerminalFailure(task: SearchEngineTask) {
  return task.status === "failed" || task.status === "canceled";
}

function cleanupError(code: StorageVnextSearchCleanupErrorCode) {
  return new StorageVnextSearchCleanupError(code);
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

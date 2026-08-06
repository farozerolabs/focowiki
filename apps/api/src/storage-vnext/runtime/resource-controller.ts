export type StorageVnextRuntimeWorkClass =
  | "foreground"
  | "background"
  | "maintenance"
  | "cleanup";

export type StorageVnextRuntimeBatchReservation = {
  itemCount: number;
  uncompressedBytes: number;
  compressedBytes: number;
  databaseConnections: number;
  searchTasks: number;
  objectRequests: number;
  memoryBytes: number;
};

export type StorageVnextRuntimeResourceConfig = {
  database: {
    connectionLimit: number;
    reservedConnections: number;
    pools: {
      api: number;
      source: number;
      publication: number;
      projectionRepair: number;
      searchRebuild: number;
      maintenance: number;
    };
  };
  workerConcurrency: Record<StorageVnextRuntimeWorkClass, number>;
  batchLimits: {
    maximumItems: number;
    maximumUncompressedBytes: number;
    maximumCompressedBytes: number;
  };
  resources: {
    databaseConnections: number;
    reservedForegroundDatabaseConnections: number;
    searchTasks: number;
    reservedForegroundSearchTasks: number;
    objectRequests: number;
    reservedForegroundObjectRequests: number;
    memoryBytes: number;
    reservedForegroundMemoryBytes: number;
  };
};

type SliceInput = {
  workClass: StorageVnextRuntimeWorkClass;
  batch: StorageVnextRuntimeBatchReservation;
  timeoutMs: number;
  claim(signal: AbortSignal): Promise<unknown>;
  run(claim: unknown, signal: AbortSignal): Promise<unknown>;
  releaseLease?(claim: unknown): Promise<void>;
};

type ResourceCounters = {
  activeByClass: Record<StorageVnextRuntimeWorkClass, number>;
  databaseConnections: number;
  searchTasks: number;
  objectRequests: number;
  memoryBytes: number;
};

export function createStorageVnextRuntimeResourceController(
  config: StorageVnextRuntimeResourceConfig
) {
  validateConfig(config);
  const counters: ResourceCounters = {
    activeByClass: {
      foreground: 0,
      background: 0,
      maintenance: 0,
      cleanup: 0
    },
    databaseConnections: 0,
    searchTasks: 0,
    objectRequests: 0,
    memoryBytes: 0
  };
  const drainWaiters = new Set<() => void>();
  let shuttingDown = false;

  return {
    async runSlice(input: SliceInput): Promise<Record<string, unknown>> {
      validateSlice(input);
      if (shuttingDown) return { outcome: "shutting_down" };
      const batchPressure = batchPressureCode(config, input.batch);
      if (batchPressure) {
        return { outcome: "backpressured", reasonCode: batchPressure };
      }
      const pressure = resourcePressureCode(config, counters, input);
      if (pressure) return { outcome: "backpressured", reasonCode: pressure };
      reserve(counters, input);

      const abortController = new AbortController();
      const timer = setTimeout(() => {
        abortController.abort(runtimeError("slice_timeout"));
      }, input.timeoutMs);
      timer.unref();
      let claim: unknown = null;
      try {
        claim = await input.claim(abortController.signal);
        if (claim === null || claim === undefined) return { outcome: "idle" };
        const result = await input.run(claim, abortController.signal);
        return { outcome: "completed", result };
      } catch (error) {
        const timedOut = abortController.signal.aborted;
        if (claim !== null && claim !== undefined && input.releaseLease) {
          await input.releaseLease(claim);
        }
        if (timedOut) return { outcome: "timed_out" };
        return { outcome: "failed", reasonCode: "slice_failed" };
      } finally {
        clearTimeout(timer);
        release(counters, input);
        notifyDrainWaiters(counters, drainWaiters);
      }
    },

    beginShutdown(): void {
      shuttingDown = true;
      notifyDrainWaiters(counters, drainWaiters);
    },

    async drain(): Promise<void> {
      if (totalActive(counters) === 0) return;
      await new Promise<void>((resolve) => drainWaiters.add(resolve));
    },

    snapshot() {
      return {
        acceptingClaims: !shuttingDown,
        foregroundActive: counters.activeByClass.foreground,
        backgroundActive: counters.activeByClass.background,
        maintenanceActive: counters.activeByClass.maintenance,
        cleanupActive: counters.activeByClass.cleanup,
        databaseConnectionsInUse: counters.databaseConnections,
        searchTasksInFlight: counters.searchTasks,
        objectRequestsInFlight: counters.objectRequests,
        memoryBytesReserved: counters.memoryBytes
      };
    }
  };
}

function validateConfig(config: StorageVnextRuntimeResourceConfig): void {
  for (const value of Object.values(config.database.pools)) positive(value);
  positive(config.database.connectionLimit);
  nonnegative(config.database.reservedConnections);
  const aggregatePools = Object.values(config.database.pools)
    .reduce((total, value) => total + value, 0);
  if (
    aggregatePools + config.database.reservedConnections
    > config.database.connectionLimit
  ) throw runtimeError("aggregate_database_pool_exceeded");

  for (const value of Object.values(config.workerConcurrency)) positive(value);
  if (
    config.workerConcurrency.foreground > config.database.pools.api
    || config.workerConcurrency.background > Math.min(
      config.database.pools.source,
      config.database.pools.publication,
      config.database.pools.projectionRepair,
      config.database.pools.searchRebuild
    )
    || config.workerConcurrency.maintenance > config.database.pools.maintenance
    || config.workerConcurrency.cleanup > config.database.pools.maintenance
  ) throw runtimeError("worker_database_capacity_exceeded");

  for (const value of Object.values(config.batchLimits)) positive(value);
  const resourcePairs = [
    [config.resources.databaseConnections,
      config.resources.reservedForegroundDatabaseConnections],
    [config.resources.searchTasks,
      config.resources.reservedForegroundSearchTasks],
    [config.resources.objectRequests,
      config.resources.reservedForegroundObjectRequests],
    [config.resources.memoryBytes,
      config.resources.reservedForegroundMemoryBytes]
  ] as const;
  for (const [limit, reserved] of resourcePairs) {
    positive(limit);
    nonnegative(reserved);
    if (reserved > limit) throw runtimeError("invalid_configuration");
  }
}

function validateSlice(input: SliceInput): void {
  if (![
    "foreground", "background", "maintenance", "cleanup"
  ].includes(input.workClass)) throw runtimeError("invalid_input");
  for (const value of Object.values(input.batch)) nonnegative(value, "invalid_input");
  positive(input.timeoutMs, "invalid_input");
  if (typeof input.claim !== "function" || typeof input.run !== "function") {
    throw runtimeError("invalid_input");
  }
}

function batchPressureCode(
  config: StorageVnextRuntimeResourceConfig,
  batch: StorageVnextRuntimeBatchReservation
): string | null {
  if (batch.itemCount > config.batchLimits.maximumItems) {
    return "batch_item_limit_exceeded";
  }
  if (batch.uncompressedBytes > config.batchLimits.maximumUncompressedBytes) {
    return "batch_byte_limit_exceeded";
  }
  if (batch.compressedBytes > config.batchLimits.maximumCompressedBytes) {
    return "compressed_batch_limit_exceeded";
  }
  return null;
}

function resourcePressureCode(
  config: StorageVnextRuntimeResourceConfig,
  counters: ResourceCounters,
  input: SliceInput
): string | null {
  if (
    counters.activeByClass[input.workClass]
    >= config.workerConcurrency[input.workClass]
  ) return `${input.workClass}_concurrency_pressure`;
  const foreground = input.workClass === "foreground";
  const resourceLimits = {
    databaseConnections: foreground
      ? config.resources.databaseConnections
      : config.resources.databaseConnections
        - config.resources.reservedForegroundDatabaseConnections,
    searchTasks: foreground
      ? config.resources.searchTasks
      : config.resources.searchTasks - config.resources.reservedForegroundSearchTasks,
    objectRequests: foreground
      ? config.resources.objectRequests
      : config.resources.objectRequests
        - config.resources.reservedForegroundObjectRequests,
    memoryBytes: foreground
      ? config.resources.memoryBytes
      : config.resources.memoryBytes - config.resources.reservedForegroundMemoryBytes
  };
  if (
    counters.databaseConnections + input.batch.databaseConnections
    > resourceLimits.databaseConnections
  ) return "database_pressure";
  if (counters.searchTasks + input.batch.searchTasks > resourceLimits.searchTasks) {
    return "search_pressure";
  }
  if (
    counters.objectRequests + input.batch.objectRequests
    > resourceLimits.objectRequests
  ) return "object_pressure";
  if (counters.memoryBytes + input.batch.memoryBytes > resourceLimits.memoryBytes) {
    return "memory_pressure";
  }
  return null;
}

function reserve(counters: ResourceCounters, input: SliceInput): void {
  counters.activeByClass[input.workClass] += 1;
  counters.databaseConnections += input.batch.databaseConnections;
  counters.searchTasks += input.batch.searchTasks;
  counters.objectRequests += input.batch.objectRequests;
  counters.memoryBytes += input.batch.memoryBytes;
}

function release(counters: ResourceCounters, input: SliceInput): void {
  counters.activeByClass[input.workClass] -= 1;
  counters.databaseConnections -= input.batch.databaseConnections;
  counters.searchTasks -= input.batch.searchTasks;
  counters.objectRequests -= input.batch.objectRequests;
  counters.memoryBytes -= input.batch.memoryBytes;
}

function totalActive(counters: ResourceCounters): number {
  return Object.values(counters.activeByClass)
    .reduce((total, value) => total + value, 0);
}

function notifyDrainWaiters(
  counters: ResourceCounters,
  waiters: Set<() => void>
): void {
  if (totalActive(counters) !== 0) return;
  for (const resolve of waiters) resolve();
  waiters.clear();
}

function positive(value: number, code = "invalid_configuration"): void {
  if (!Number.isSafeInteger(value) || value < 1) throw runtimeError(code);
}

function nonnegative(value: number, code = "invalid_configuration"): void {
  if (!Number.isSafeInteger(value) || value < 0) throw runtimeError(code);
}

function runtimeError(code: string): Error {
  return Object.assign(
    new Error(`Storage vNext runtime resource error: ${code}`),
    { code }
  );
}

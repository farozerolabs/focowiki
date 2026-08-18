import type { RuntimeConfig } from "../config.js";
import type {
  RuntimeSettingsDefaults,
  RuntimeSettingsSnapshot,
  RuntimeSettingsValidationIssue
} from "./types.js";

export type RuntimeSettingsResourceCapacity = {
  databaseConnections: number;
  searchTasks: number;
  objectStoreRequests: number;
  memoryBytes: number;
  cpuConcurrency: number;
};

type CapacitySnapshot = Pick<RuntimeSettingsSnapshot, "activeModel"> & {
  worker: Pick<
    RuntimeSettingsSnapshot["worker"],
    | "sourceFileConcurrency"
    | "sourceObjectReadConcurrency"
  >;
  maintenance: Pick<
    RuntimeSettingsSnapshot["maintenance"],
    "hardDeleteConcurrency"
  >;
  search: Pick<
    RuntimeSettingsSnapshot["search"],
    "maxInFlightTasks" | "indexBatchCompressedBytes"
  >;
};

export function createRuntimeSettingsResourceCapacity(input: {
  config: RuntimeConfig;
  defaults: RuntimeSettingsDefaults;
}): RuntimeSettingsResourceCapacity {
  const defaultSnapshot: CapacitySnapshot = {
    worker: input.defaults.worker,
    maintenance: input.defaults.maintenance,
    search: input.defaults.search,
    activeModel: null
  };
  const demand = calculateDemand(defaultSnapshot);
  const databaseConnections = input.config.database.workerPoolMax ?? 8;
  return {
    databaseConnections,
    searchTasks: input.defaults.search.maxInFlightTasks,
    objectStoreRequests: Math.max(
      demand.objectStoreRequests,
      databaseConnections
    ),
    memoryBytes: demand.memoryBytes,
    cpuConcurrency: Math.max(
      demand.cpuConcurrency,
      databaseConnections
    )
  };
}

export function validateRuntimeSettingsResourceCapacity(input: {
  snapshot: CapacitySnapshot;
  capacity: RuntimeSettingsResourceCapacity;
}): RuntimeSettingsValidationIssue[] {
  const invalidCapacity = Object.values(input.capacity).some((value) =>
    !Number.isSafeInteger(value) || value < 1);
  if (invalidCapacity) {
    return [issue("resourceCapacity", "Runtime resource capacity is invalid")];
  }
  let demand: RuntimeSettingsResourceCapacity;
  try {
    demand = calculateDemand(input.snapshot);
  } catch {
    return [issue("resourceCapacity", "Runtime resource demand is invalid")];
  }
  const issues: RuntimeSettingsValidationIssue[] = [];
  if (demand.databaseConnections > input.capacity.databaseConnections) {
    issues.push(issue(
      "databaseCapacity",
      "Aggregate worker database concurrency exceeds deployment capacity"
    ));
  }
  if (demand.searchTasks > input.capacity.searchTasks) {
    issues.push(issue(
      "searchCapacity",
      "Aggregate search concurrency exceeds deployment capacity"
    ));
  }
  if (demand.objectStoreRequests > input.capacity.objectStoreRequests) {
    issues.push(issue(
      "objectStoreCapacity",
      "Aggregate object-store concurrency exceeds deployment capacity"
    ));
  }
  if (demand.memoryBytes > input.capacity.memoryBytes) {
    issues.push(issue(
      "memoryCapacity",
      "Aggregate worker buffers exceed deployment memory capacity"
    ));
  }
  if (demand.cpuConcurrency > input.capacity.cpuConcurrency) {
    issues.push(issue(
      "cpuCapacity",
      "Aggregate worker concurrency exceeds deployment CPU capacity"
    ));
  }
  return issues;
}

function calculateDemand(snapshot: CapacitySnapshot): RuntimeSettingsResourceCapacity {
  const maintenanceConcurrency = 1;
  const databaseConnections = sum([
    maintenanceConcurrency,
    snapshot.maintenance.hardDeleteConcurrency
  ]);
  const searchTasks = Math.max(
    snapshot.search.maxInFlightTasks,
    maintenanceConcurrency
  );
  const objectStoreRequests = sum([
    maintenanceConcurrency,
    snapshot.maintenance.hardDeleteConcurrency
  ]);
  const memoryBytes = multiply(
    snapshot.search.maxInFlightTasks,
    snapshot.search.indexBatchCompressedBytes
  );
  const cpuConcurrency = sum([
    maintenanceConcurrency,
    snapshot.maintenance.hardDeleteConcurrency
  ]);
  return {
    databaseConnections,
    searchTasks,
    objectStoreRequests,
    memoryBytes,
    cpuConcurrency
  };
}

function sum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    assertNonnegative(value);
    total += value;
    if (!Number.isSafeInteger(total)) throw new Error("unsafe resource sum");
  }
  return total;
}

function multiply(left: number, right: number): number {
  assertNonnegative(left);
  assertNonnegative(right);
  const value = left * right;
  if (!Number.isSafeInteger(value)) throw new Error("unsafe resource product");
  return value;
}

function assertNonnegative(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("invalid resource value");
  }
}

function issue(field: string, message: string): RuntimeSettingsValidationIssue {
  return { field, message };
}

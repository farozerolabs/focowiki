import type { StorageVnextMaintenanceResourceGate } from "./ports.js";

export type StorageVnextMaintenanceResourceLimits = {
  maxMaintenanceConcurrency: number;
  databaseConnectionLimit: number;
  reservedApiConnections: number;
  reservedForegroundConnections: number;
  maintenanceDatabaseConnections: number;
  searchInFlightLimit: number;
  maintenanceSearchRequests: number;
  objectInFlightLimit: number;
  maintenanceObjectRequests: number;
  memoryByteLimit: number;
  maintenanceBatchBytes: number;
};

export type StorageVnextMaintenanceResourceUsage = {
  databaseConnectionsInUse: number;
  searchRequestsInFlight: number;
  objectRequestsInFlight: number;
  rssBytes: number;
};

export function createStorageVnextMaintenanceResourceGate(input: {
  limits: StorageVnextMaintenanceResourceLimits;
  sample(): Promise<StorageVnextMaintenanceResourceUsage>;
}): StorageVnextMaintenanceResourceGate {
  validateLimits(input.limits);
  let activeMaintenance = 0;
  return {
    async tryAcquire() {
      if (activeMaintenance >= input.limits.maxMaintenanceConcurrency) {
        return backpressured("MAINTENANCE_CONCURRENCY_PRESSURE");
      }
      const usage = await input.sample();
      validateUsage(usage);
      if (activeMaintenance >= input.limits.maxMaintenanceConcurrency) {
        return backpressured("MAINTENANCE_CONCURRENCY_PRESSURE");
      }
      if (
        usage.databaseConnectionsInUse
        + input.limits.reservedApiConnections
        + input.limits.reservedForegroundConnections
        + input.limits.maintenanceDatabaseConnections
        > input.limits.databaseConnectionLimit
      ) return backpressured("MAINTENANCE_DATABASE_PRESSURE");
      if (
        usage.searchRequestsInFlight + input.limits.maintenanceSearchRequests
        > input.limits.searchInFlightLimit
      ) return backpressured("MAINTENANCE_SEARCH_PRESSURE");
      if (
        usage.objectRequestsInFlight + input.limits.maintenanceObjectRequests
        > input.limits.objectInFlightLimit
      ) return backpressured("MAINTENANCE_OBJECT_PRESSURE");
      if (
        usage.rssBytes + input.limits.maintenanceBatchBytes
        > input.limits.memoryByteLimit
      ) return backpressured("MAINTENANCE_MEMORY_PRESSURE");

      activeMaintenance += 1;
      let released = false;
      return {
        outcome: "acquired" as const,
        release() {
          if (released) return;
          released = true;
          activeMaintenance -= 1;
        }
      };
    }
  };
}

function backpressured(reasonCode: string) {
  return { outcome: "backpressured" as const, reasonCode };
}

function validateLimits(limits: StorageVnextMaintenanceResourceLimits): void {
  for (const [key, value] of Object.entries(limits)) {
    const permitsZero = key === "reservedApiConnections"
      || key === "reservedForegroundConnections";
    if (!Number.isSafeInteger(value) || value < (permitsZero ? 0 : 1)) {
      throw resourceGateError("invalid_configuration");
    }
  }
  if (
    limits.reservedApiConnections
      + limits.reservedForegroundConnections
      + limits.maintenanceDatabaseConnections
      > limits.databaseConnectionLimit
    || limits.maintenanceSearchRequests > limits.searchInFlightLimit
    || limits.maintenanceObjectRequests > limits.objectInFlightLimit
    || limits.maintenanceBatchBytes > limits.memoryByteLimit
  ) throw resourceGateError("invalid_configuration");
}

function validateUsage(usage: StorageVnextMaintenanceResourceUsage): void {
  for (const value of Object.values(usage)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw resourceGateError("invalid_usage");
    }
  }
}

function resourceGateError(code: string): Error {
  return Object.assign(new Error(`Storage vNext maintenance resource gate error: ${code}`), {
    code
  });
}

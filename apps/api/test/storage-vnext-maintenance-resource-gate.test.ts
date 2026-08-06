import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";

type GateFactory = (input: Record<string, unknown>) => {
  tryAcquire(): Promise<Record<string, unknown>>;
};

let createGate: GateFactory | undefined;

beforeAll(async () => {
  const modulePath = resolve(
    import.meta.dirname,
    "../src/storage-vnext/maintenance/resource-gate.ts"
  );
  const loaded = await import(/* @vite-ignore */ pathToFileURL(modulePath).href)
    .catch(() => ({})) as {
      createStorageVnextMaintenanceResourceGate?: GateFactory;
    };
  createGate = loaded.createStorageVnextMaintenanceResourceGate;
});

describe("storage vNext maintenance resource gate", () => {
  it("preserves database capacity for API and foreground work before claiming", async () => {
    expect(createGate).toBeTypeOf("function");
    if (!createGate) return;
    const gate = createGate({
      limits: limits(),
      sample: vi.fn(async () => usage({ databaseConnectionsInUse: 6 }))
    });

    await expect(gate.tryAcquire()).resolves.toEqual({
      outcome: "backpressured",
      reasonCode: "MAINTENANCE_DATABASE_PRESSURE"
    });
  });

  it.each([
    [{ searchRequestsInFlight: 2 }, "MAINTENANCE_SEARCH_PRESSURE"],
    [{ objectRequestsInFlight: 2 }, "MAINTENANCE_OBJECT_PRESSURE"],
    [{ rssBytes: 950 }, "MAINTENANCE_MEMORY_PRESSURE"]
  ] as const)("backs off bounded provider or memory pressure %#", async (override, code) => {
    expect(createGate).toBeTypeOf("function");
    if (!createGate) return;
    const gate = createGate({
      limits: limits(),
      sample: vi.fn(async () => usage(override))
    });

    await expect(gate.tryAcquire()).resolves.toEqual({
      outcome: "backpressured",
      reasonCode: code
    });
  });

  it("bounds maintenance concurrency and releases its permit exactly once", async () => {
    expect(createGate).toBeTypeOf("function");
    if (!createGate) return;
    const gate = createGate({
      limits: limits(),
      sample: vi.fn(async () => usage())
    });

    const first = await gate.tryAcquire();
    expect(first.outcome).toBe("acquired");
    await expect(gate.tryAcquire()).resolves.toEqual({
      outcome: "backpressured",
      reasonCode: "MAINTENANCE_CONCURRENCY_PRESSURE"
    });
    const release = first.release as (() => void) | undefined;
    expect(release).toBeTypeOf("function");
    release?.();
    release?.();
    await expect(gate.tryAcquire()).resolves.toMatchObject({ outcome: "acquired" });
  });
});

function limits() {
  return {
    maxMaintenanceConcurrency: 1,
    databaseConnectionLimit: 10,
    reservedApiConnections: 2,
    reservedForegroundConnections: 2,
    maintenanceDatabaseConnections: 1,
    searchInFlightLimit: 2,
    maintenanceSearchRequests: 1,
    objectInFlightLimit: 2,
    maintenanceObjectRequests: 1,
    memoryByteLimit: 1_000,
    maintenanceBatchBytes: 100
  };
}

function usage(overrides: Partial<{
  databaseConnectionsInUse: number;
  searchRequestsInFlight: number;
  objectRequestsInFlight: number;
  rssBytes: number;
}> = {}) {
  return {
    databaseConnectionsInUse: 0,
    searchRequestsInFlight: 0,
    objectRequestsInFlight: 0,
    rssBytes: 0,
    ...overrides
  };
}

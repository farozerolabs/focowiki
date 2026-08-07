import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

type StatusMapper = {
  mapLive(input: Record<string, unknown>): Record<string, unknown>;
  mapTerminal(input: Record<string, unknown>): Record<string, unknown>;
  mapIdle(maintenanceRequired?: boolean): Record<string, unknown>;
};

let createMapper: (() => StatusMapper) | undefined;

beforeAll(async () => {
  const modulePath = resolve(
    import.meta.dirname,
    "../src/storage-vnext/maintenance/status.ts"
  );
  const loaded = await import(/* @vite-ignore */ pathToFileURL(modulePath).href)
    .catch(() => ({})) as { createStorageVnextMaintenanceStatusMapper?: () => StatusMapper };
  createMapper = loaded.createStorageVnextMaintenanceStatusMapper;
});

describe("storage vNext maintenance status contract", () => {
  it("maps live progress to the released aggregate maintenance fields", () => {
    expect(createMapper).toBeTypeOf("function");
    if (!createMapper) return;
    const mapper = createMapper();
    expect(mapper.mapLive({
      operationPublicId: "maintenance-status-live",
      workState: "retry",
      retryCount: 2,
      safeErrorCode: "MAINTENANCE_PHASE_TIMEOUT",
      checkpoint: checkpoint()
    })).toEqual({
      requestId: "maintenance-status-live",
      state: "running",
      trigger: "manual",
      stage: "search_rebuild",
      active: true,
      completedCount: 25,
      expectedCount: 100,
      retryCount: 2,
      lastProgressAt: "2026-08-01T10:00:00.000Z",
      lastCompletedAt: null,
      maintenanceRequired: true,
      safeErrorCode: "MAINTENANCE_PHASE_TIMEOUT",
      safeErrorMessage: null,
      throughputPerSecond: 5,
      estimatedCompletionAt: "2026-08-01T10:00:15.000Z"
    });
  });

  it("maps one bounded terminal result without exposing internal detail", () => {
    expect(createMapper).toBeTypeOf("function");
    if (!createMapper) return;
    const mapper = createMapper();
    expect(mapper.mapTerminal({
      operationPublicId: "maintenance-status-terminal",
      terminalState: "completed",
      resultCode: "MAINTENANCE_COMPLETED",
      completedAt: "2026-08-01T10:01:00.000Z",
      summary: {
        trigger: "automatic",
        phase: "cleanup",
        completedCount: 100,
        expectedCount: 100,
        retryCount: 0,
        lastProgressAt: "2026-08-01T10:01:00.000Z",
        throughputPerSecond: 10,
        estimatedCompletionAt: null,
        internalProviderHost: "must-not-leak"
      }
    })).toEqual({
      requestId: "maintenance-status-terminal",
      state: "completed",
      trigger: "automatic",
      stage: "cleanup",
      active: false,
      completedCount: 100,
      expectedCount: 100,
      retryCount: 0,
      lastProgressAt: "2026-08-01T10:01:00.000Z",
      lastCompletedAt: "2026-08-01T10:01:00.000Z",
      maintenanceRequired: false,
      safeErrorCode: null,
      safeErrorMessage: null,
      throughputPerSecond: 10,
      estimatedCompletionAt: null
    });
  });

  it("reports a legacy active navigation profile through the existing field", () => {
    expect(createMapper).toBeTypeOf("function");
    if (!createMapper) return;
    expect(createMapper().mapIdle(true)).toMatchObject({
      state: "idle",
      active: false,
      maintenanceRequired: true
    });
  });
});

function checkpoint() {
  return {
    version: 1,
    searchProviderKind: "meilisearch",
    maintenanceKind: "standard",
    trigger: "manual",
    phase: "search_rebuild",
    cursor: "source-cursor-25",
    batchOrdinal: 1,
    baseResourceRevision: 7,
    completedCount: 25,
    expectedCount: 100,
    processedBytes: 1_024,
    startedAt: "2026-08-01T09:59:55.000Z",
    lastProgressAt: "2026-08-01T10:00:00.000Z",
    elapsedActiveMs: 5_000,
    maxAttempts: 3,
    resultExpiresAt: "2026-08-02T00:00:00.000Z",
    throughputPerSecond: 5,
    estimatedCompletionAt: "2026-08-01T10:00:15.000Z"
  };
}

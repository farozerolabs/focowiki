import { describe, expect, it, vi } from "vitest";
import { createDocumentMaintenancePhaseRunner } from
  "../src/document-indexing/application/document-maintenance-phase-runner.js";

describe("document maintenance phase runner", () => {
  it("schedules bounded document pages and waits for independent jobs", async () => {
    const maintenance = fixture();
    maintenance.schedulePage.mockResolvedValueOnce({
      scheduledCount: 2,
      processedBytes: 256,
      nextCursor: "source-file-two",
      documentCount: 3
    });
    maintenance.readProgress.mockResolvedValueOnce({
      documentCount: 3,
      availableCount: 2,
      errorCount: 0,
      pendingCount: 1
    });
    const runner = createDocumentMaintenancePhaseRunner({ maintenance });

    await expect(runner.runPhase(request("search_rebuild"))).resolves.toEqual({
      outcome: "progress",
      cursor: "source-file-two",
      completedDelta: 0,
      expectedCount: 3,
      processedBytesDelta: 256
    });
    await expect(runner.runPhase(request("projection_repair"))).resolves.toEqual({
      outcome: "progress",
      cursor: "awaiting-document-jobs",
      completedDelta: 2,
      expectedCount: 3,
      processedBytesDelta: 0
    });
  });

  it("reports only newly available documents on later progress polls", async () => {
    const maintenance = fixture();
    maintenance.readProgress.mockResolvedValueOnce({
      documentCount: 3,
      availableCount: 3,
      errorCount: 0,
      pendingCount: 0
    });
    const runner = createDocumentMaintenancePhaseRunner({ maintenance });

    await expect(runner.runPhase(request("projection_repair", 2))).resolves.toEqual({
      outcome: "phase_completed",
      completedDelta: 1,
      expectedCount: 3,
      processedBytesDelta: 0
    });
  });

  it("fails maintenance truthfully when any document job fails", async () => {
    const maintenance = fixture();
    maintenance.readProgress.mockResolvedValueOnce({
      documentCount: 3,
      availableCount: 2,
      errorCount: 1,
      pendingCount: 0
    });
    const runner = createDocumentMaintenancePhaseRunner({ maintenance });

    await expect(runner.runPhase(request("projection_repair")))
      .rejects.toMatchObject({ code: "document_maintenance_source_failed" });
  });

  it("validates and activates only after all jobs are available", async () => {
    const maintenance = fixture();
    maintenance.readProgress.mockResolvedValueOnce({
      documentCount: 3,
      availableCount: 3,
      errorCount: 0,
      pendingCount: 0
    });
    const runner = createDocumentMaintenancePhaseRunner({ maintenance });

    await expect(runner.runPhase(request("projection_repair"))).resolves.toEqual({
      outcome: "phase_completed",
      completedDelta: 3,
      expectedCount: 3,
      processedBytesDelta: 0
    });
    await runner.runPhase(request("validation"));
    await runner.runPhase(request("activation"));

    expect(maintenance.validate).toHaveBeenCalledTimes(1);
    expect(maintenance.activate).toHaveBeenCalledTimes(1);
  });

  it("runs bounded storage reconciliation only when the live setting enables it", async () => {
    const maintenance = {
      ...fixture(),
      reconcile: vi.fn(async (): Promise<{
        processedCount: number;
        nextCursor: string | null;
      }> => ({
        processedCount: 10,
        nextCursor: "registration-page"
      }))
    };
    const enabled = createDocumentMaintenancePhaseRunner({
      maintenance,
      isReconciliationEnabled: vi.fn(async () => true)
    });

    await expect(enabled.runPhase(request("object_reconciliation"))).resolves.toEqual({
      outcome: "progress",
      cursor: "registration-page",
      completedDelta: 0,
      expectedCount: 3,
      processedBytesDelta: 0
    });
    expect(maintenance.reconcile).toHaveBeenCalledWith(expect.objectContaining({
      cursor: null,
      knowledgeBaseId: "knowledge-base-one"
    }));

    maintenance.reconcile.mockResolvedValueOnce({ processedCount: 10, nextCursor: null });
    await expect(enabled.runPhase(request("object_reconciliation"))).resolves.toEqual({
      outcome: "phase_completed",
      completedDelta: 0,
      expectedCount: 3,
      processedBytesDelta: 0
    });

    const disabled = createDocumentMaintenancePhaseRunner({
      maintenance,
      isReconciliationEnabled: vi.fn(async () => false)
    });
    await expect(disabled.runPhase(request("object_reconciliation"))).resolves.toMatchObject({
      outcome: "phase_completed"
    });
    expect(maintenance.reconcile).toHaveBeenCalledTimes(2);
  });
});

function fixture() {
  return {
    prepare: vi.fn(async () => ({ documentCount: 3 })),
    schedulePage: vi.fn(async () => ({
      scheduledCount: 3,
      processedBytes: 384,
      nextCursor: null as string | null,
      documentCount: 3
    })),
    readProgress: vi.fn(async () => ({
      documentCount: 3,
      availableCount: 3,
      errorCount: 0,
      pendingCount: 0
    })),
    validate: vi.fn(async () => undefined),
    activate: vi.fn(async () => undefined),
    cleanup: vi.fn(async () => undefined)
  };
}

function request(phase: string, completedCount = 0) {
  return {
    knowledgeBaseId: "knowledge-base-one",
    operationPublicId: "maintenance-one",
    checkpoint: {
      version: 1 as const,
      searchProviderKind: "opensearch" as const,
      trigger: "manual" as const,
      maintenanceKind: "standard" as const,
      phase: phase as never,
      cursor: null,
      batchOrdinal: 0,
      baseResourceRevision: 1,
      completedCount,
      expectedCount: 3,
      processedBytes: 0,
      startedAt: "2026-08-14T00:00:00.000Z",
      lastProgressAt: "2026-08-14T00:00:00.000Z",
      elapsedActiveMs: 0,
      throughputPerSecond: 0,
      estimatedCompletionAt: null,
      maxAttempts: 3,
      resultExpiresAt: "2026-08-15T00:00:00.000Z",
      semanticAdoption: null
    },
    searchProjection: {
      activeRole: "active" as const,
      candidateRole: "candidate" as const,
      documentKinds: ["content", "graph_seed"] as const
    },
    signal: new AbortController().signal
  };
}

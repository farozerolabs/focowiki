import { describe, expect, it, vi } from "vitest";
import { createStorageVnextAdminMaintenanceApplication } from
  "../src/storage-vnext/api/admin-maintenance-application.js";

describe("storage vNext admin maintenance application", () => {
  it("runs terminal cleanup after cancelling active maintenance", async () => {
    const status = statusFixture({ active: true, safeErrorCode: null });
    const semanticCancel = vi.fn(async () => undefined);
    const terminalCleanup = vi.fn(async () => undefined);
    const application = createApplication({
      status,
      semanticCancel,
      terminalCleanup
    });

    await expect(application.cancelMaintenance({ knowledgeBaseId: "kb-main" }))
      .resolves.toEqual({ available: true, outcome: "cancelled" });
    expect(status.cancel).toHaveBeenCalledOnce();
    expect(semanticCancel).toHaveBeenCalledOnce();
    expect(terminalCleanup).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-main",
      operationPublicId: "maintenance-main",
      cancelledAt: expect.any(String)
    });
  });

  it("repairs terminal cleanup idempotently for an already cancelled request", async () => {
    const status = statusFixture({
      active: false,
      safeErrorCode: "MAINTENANCE_CANCELLED"
    });
    const terminalCleanup = vi.fn(async () => undefined);
    const application = createApplication({ status, terminalCleanup });

    await expect(application.cancelMaintenance({ knowledgeBaseId: "kb-main" }))
      .resolves.toEqual({ available: true, outcome: "not_active" });
    expect(status.cancel).not.toHaveBeenCalled();
    expect(terminalCleanup).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-main",
      operationPublicId: "maintenance-main",
      cancelledAt: expect.any(String)
    });
  });
});

function createApplication(input: {
  status: ReturnType<typeof statusFixture>;
  semanticCancel?: (input: {
    knowledgeBaseId: string;
    operationPublicId: string;
    requestedAt: string;
  }) => Promise<unknown>;
  terminalCleanup: (input: {
    knowledgeBaseId: string;
    operationPublicId: string;
    cancelledAt: string;
  }) => Promise<unknown>;
}) {
  return createStorageVnextAdminMaintenanceApplication({
    catalog: null,
    requests: null,
    status: input.status,
    runtimeSettings: null,
    semanticCancellation: input.semanticCancel
      ? { cancel: input.semanticCancel }
      : null,
    cancellationCleanup: { terminate: input.terminalCleanup }
  });
}

function statusFixture(input: {
  active: boolean;
  safeErrorCode: string | null;
}) {
  return {
    getStatus: vi.fn(async () => ({
      requestId: "maintenance-main",
      state: input.active ? "running" as const : "superseded" as const,
      trigger: "manual" as const,
      stage: "planning" as const,
      active: input.active,
      completedCount: 0,
      expectedCount: 0,
      retryCount: 0,
      lastProgressAt: "2026-08-12T00:00:00.000Z",
      lastCompletedAt: input.active ? null : "2026-08-12T00:00:01.000Z",
      maintenanceRequired: true,
      safeErrorCode: input.safeErrorCode,
      safeErrorMessage: null,
      throughputPerSecond: 0,
      estimatedCompletionAt: null
    })),
    cancel: vi.fn(async () => "cancelled" as const)
  };
}

import { describe, expect, it, vi } from "vitest";
import { createStorageVnextAutomaticMaintenanceScheduler } from
  "../src/storage-vnext/maintenance/automatic-scheduler.js";

type MaintenanceRequest = {
  knowledgeBaseId: string;
  operationPublicId: string;
  trigger: "automatic";
  idempotencyKey: string;
  expectedResourceRevision: number;
  settingsRevisionPublicId: string;
  requestedAt: string;
  expiresAt: string;
  maxAttempts: number;
};

describe("storage vNext automatic maintenance scheduler", () => {
  it("schedules bounded due knowledge bases with deterministic identities", async () => {
    const current = fixture();
    const scheduler = createStorageVnextAutomaticMaintenanceScheduler(current);

    await expect(scheduler.run({
      mode: "automatic",
      settingsRevisionPublicId: "settings-revision-a",
      scanIntervalSeconds: 3_600,
      maxAttempts: 5,
      resultRetentionMilliseconds: 86_400_000,
      limit: 20
    })).resolves.toEqual({ canceled: 0, discovered: 2, scheduled: 2 });

    expect(current.due.list).toHaveBeenCalledWith({
      dueBefore: "2026-08-01T00:00:00.000Z",
      limit: 20
    });
    expect(current.requests.requestMaintenance).toHaveBeenCalledTimes(2);
    expect(current.requests.requestMaintenance).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        knowledgeBaseId: "kb-auto-a",
        trigger: "automatic",
        expectedResourceRevision: 3,
        settingsRevisionPublicId: "settings-revision-a",
        requestedAt: "2026-08-01T01:00:00.000Z"
      })
    );
    const first = current.requests.requestMaintenance.mock.calls[0]![0];
    const replay = fixture();
    await createStorageVnextAutomaticMaintenanceScheduler(replay).run({
      mode: "automatic",
      settingsRevisionPublicId: "settings-revision-a",
      scanIntervalSeconds: 3_600,
      maxAttempts: 5,
      resultRetentionMilliseconds: 86_400_000,
      limit: 20
    });
    expect(replay.requests.requestMaintenance.mock.calls[0]![0]).toMatchObject({
      operationPublicId: first.operationPublicId,
      idempotencyKey: first.idempotencyKey
    });
  });

  it("cancels only queued automatic work when mode is manual", async () => {
    const current = fixture();
    current.due.cancelQueuedAutomatic.mockResolvedValueOnce(3);
    const scheduler = createStorageVnextAutomaticMaintenanceScheduler(current);

    await expect(scheduler.run({
      mode: "manual",
      settingsRevisionPublicId: "settings-revision-a",
      scanIntervalSeconds: 3_600,
      maxAttempts: 5,
      resultRetentionMilliseconds: 86_400_000,
      limit: 20
    })).resolves.toEqual({ canceled: 3, discovered: 0, scheduled: 0 });

    expect(current.due.cancelQueuedAutomatic).toHaveBeenCalledWith({
      canceledAt: "2026-08-01T01:00:00.000Z",
      expiresAt: "2026-08-02T01:00:00.000Z",
      limit: 20
    });
    expect(current.due.list).not.toHaveBeenCalled();
  });
});

function fixture() {
  return {
    due: {
      list: vi.fn(async () => [
        { knowledgeBaseId: "kb-auto-a", revision: 3 },
        { knowledgeBaseId: "kb-auto-b", revision: 7 }
      ]),
      cancelQueuedAutomatic: vi.fn(async () => 0)
    },
    requests: {
      requestMaintenance: vi.fn(async (_request: MaintenanceRequest) => ({
        outcome: "queued" as const,
        operationPublicId: "maintenance-auto",
        state: "queued" as const,
        reasonCode: null
      }))
    },
    now: () => new Date("2026-08-01T01:00:00.000Z")
  };
}

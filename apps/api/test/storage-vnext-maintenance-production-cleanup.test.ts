import { describe, expect, it, vi } from "vitest";
import {
  createStorageVnextMaintenanceProductionCleanup
} from "../src/storage-vnext/maintenance/production-cleanup.js";
import { createStorageVnextMaintenanceCandidatePublicId } from
  "../src/storage-vnext/maintenance/identity.js";

describe("storage vNext maintenance production cleanup", () => {
  it("abandons and deletes a failed unified candidate before terminating its release root", async () => {
    const events: string[] = [];
    const candidatePublicId = candidateId();
    const cleanupFailedCandidate = vi.fn(async () => {
      events.push("failed-index");
      return { outcome: "deleted" as const, candidatePublicId };
    });
    const clock = vi.fn()
      .mockReturnValueOnce("2026-08-02T00:00:00.000Z")
      .mockReturnValue("2026-08-02T00:00:00.001Z");
    const cleanup = createStorageVnextMaintenanceProductionCleanup({
      releases: {
        terminateCandidate: vi.fn(async () => {
          events.push("release");
          return true;
        })
      },
      searchTerminal: {
        abandonCandidate: vi.fn(async () => {
          events.push("abandon");
          return true;
        })
      },
      searchCleanup: {
        cleanupFailedCandidate,
        cleanupOrphanIndexes: vi.fn(async () => {
          events.push("orphan-indexes");
          return { deleted: 0, continuation: null };
        }),
        cleanupFinishedTasks: vi.fn(async () => ({
          deleted: 0,
          continuation: null
        }))
      },
      clock,
      resultRetentionMilliseconds: 86_400_000,
      maximumCleanupPages: 4
    });

    await expect(cleanup.terminate({
      knowledgeBaseId: "kb-maintenance",
      operationPublicId: "operation-maintenance",
      outcome: "failed"
    })).resolves.toMatchObject({ candidatePublicId });

    expect(events).toEqual([
      "abandon",
      "failed-index",
      "release",
      "orphan-indexes"
    ]);
    expect(cleanupFailedCandidate).toHaveBeenCalledWith(expect.objectContaining({
      failedBefore: "2026-08-02T00:00:00.001Z"
    }));
  });

  it("keeps the promoted candidate and removes only orphan provider state after completion", async () => {
    const abandonCandidate = vi.fn();
    const terminateCandidate = vi.fn();
    const cleanupOrphanIndexes = vi.fn(async () => ({
      deleted: 1,
      continuation: null
    }));
    const cleanup = createStorageVnextMaintenanceProductionCleanup({
      releases: { terminateCandidate },
      searchTerminal: { abandonCandidate },
      searchCleanup: {
        cleanupFailedCandidate: vi.fn(),
        cleanupOrphanIndexes,
        cleanupFinishedTasks: vi.fn(async () => ({
          deleted: 2,
          continuation: null
        }))
      },
      clock: () => "2026-08-02T00:00:00.000Z",
      resultRetentionMilliseconds: 86_400_000,
      maximumCleanupPages: 4
    });

    await expect(cleanup.terminate({
      knowledgeBaseId: "kb-maintenance",
      operationPublicId: "operation-maintenance",
      outcome: "completed"
    })).resolves.toMatchObject({
      deletedOrphanIndexes: 1,
      deletedFinishedTasks: 2
    });
    expect(abandonCandidate).not.toHaveBeenCalled();
    expect(terminateCandidate).not.toHaveBeenCalled();
  });
});

function candidateId(): string {
  return createStorageVnextMaintenanceCandidatePublicId({
    knowledgeBaseId: "kb-maintenance",
    operationPublicId: "operation-maintenance"
  });
}

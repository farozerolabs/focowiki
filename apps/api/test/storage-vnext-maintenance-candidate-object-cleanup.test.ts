import { describe, expect, it, vi } from "vitest";
import {
  createStorageVnextMaintenanceCandidateObjectCleanup
} from "../src/storage-vnext/maintenance/candidate-object-cleanup.js";

describe("storage vNext maintenance candidate object cleanup", () => {
  it("deletes only operation-scoped superseded objects and resumes by bounded pages", async () => {
    const listPage = vi.fn()
      .mockResolvedValueOnce([
        { actionPublicId: "cleanup-a", objectId: "object-a" },
        { actionPublicId: "cleanup-b", objectId: "object-b" }
      ])
      .mockResolvedValueOnce([]);
    const complete = vi.fn(async (_request: {
      actionPublicId: string;
      knowledgeBaseId: string;
      operationPublicId: string;
    }) => true);
    const deleteZeroOwner = vi.fn(async (_objectId: string) => ({
      deletedVersions: 1,
      deletedMarkers: 0,
      abortedMultipartUploads: 0
    }));
    const purgeDeletedRegistrations = vi.fn(async (_request: { limit: number }) => 2);
    const cleanup = createStorageVnextMaintenanceCandidateObjectCleanup({
      actions: { listPage, complete },
      objects: { deleteZeroOwner },
      purgeDeletedRegistrations,
      pageSize: 2
    });

    await expect(cleanup.runPage({
      knowledgeBaseId: "kb-maintenance",
      operationPublicId: "operation-maintenance",
      signal: new AbortController().signal
    })).resolves.toMatchObject({
      outcome: "progress",
      completedDelta: 2,
      expectedCount: 2,
      deleted: 2,
      purgedRegistrations: 2
    });
    await expect(cleanup.runPage({
      knowledgeBaseId: "kb-maintenance",
      operationPublicId: "operation-maintenance",
      signal: new AbortController().signal
    })).resolves.toMatchObject({
      outcome: "phase_completed",
      completedDelta: 0
    });

    expect(listPage).toHaveBeenNthCalledWith(1, {
      knowledgeBaseId: "kb-maintenance",
      operationPublicId: "operation-maintenance",
      limit: 2
    });
    expect(deleteZeroOwner.mock.calls.map(([objectId]) => objectId))
      .toEqual(["object-a", "object-b"]);
    expect(complete.mock.calls.map(([request]) => request))
      .toEqual([
        {
          actionPublicId: "cleanup-a",
          knowledgeBaseId: "kb-maintenance",
          operationPublicId: "operation-maintenance"
        },
        {
          actionPublicId: "cleanup-b",
          knowledgeBaseId: "kb-maintenance",
          operationPublicId: "operation-maintenance"
        }
      ]);
  });

  it("completes a stale action when the object gained an owner", async () => {
    const complete = vi.fn(async () => true);
    const cleanup = createStorageVnextMaintenanceCandidateObjectCleanup({
      actions: {
        listPage: vi.fn(async () => [
          { actionPublicId: "cleanup-owned", objectId: "object-owned" }
        ]),
        complete
      },
      objects: {
        deleteZeroOwner: vi.fn(async () => {
          throw Object.assign(new Error("owned"), { code: "owners_present" });
        })
      },
      purgeDeletedRegistrations: vi.fn(async () => 0),
      pageSize: 10
    });

    await expect(cleanup.runPage({
      knowledgeBaseId: "kb-maintenance",
      operationPublicId: "operation-maintenance",
      signal: new AbortController().signal
    })).resolves.toMatchObject({
      outcome: "phase_completed",
      deleted: 0,
      skippedOwned: 1
    });
    expect(complete).toHaveBeenCalledOnce();
  });

  it("keeps the action queued when provider deletion fails", async () => {
    const complete = vi.fn();
    const cleanup = createStorageVnextMaintenanceCandidateObjectCleanup({
      actions: {
        listPage: vi.fn(async () => [
          { actionPublicId: "cleanup-retry", objectId: "object-retry" }
        ]),
        complete
      },
      objects: {
        deleteZeroOwner: vi.fn(async () => {
          throw Object.assign(new Error("provider unavailable"), {
            code: "provider_delete_failed"
          });
        })
      },
      purgeDeletedRegistrations: vi.fn(async () => 0),
      pageSize: 10
    });

    await expect(cleanup.runPage({
      knowledgeBaseId: "kb-maintenance",
      operationPublicId: "operation-maintenance",
      signal: new AbortController().signal
    })).rejects.toMatchObject({ code: "provider_delete_failed" });
    expect(complete).not.toHaveBeenCalled();
  });
});

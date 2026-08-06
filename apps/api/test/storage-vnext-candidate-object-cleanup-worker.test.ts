import { describe, expect, it, vi } from "vitest";
import {
  createStorageVnextCandidateObjectCleanupWorker
} from "../src/storage-vnext/maintenance/candidate-object-cleanup-worker.js";

describe("storage vNext candidate object cleanup worker", () => {
  it("claims release-scoped actions globally and deletes only zero-owner objects", async () => {
    const complete = vi.fn(async () => true);
    const actions = {
      recoverStale: vi.fn(async () => 0),
      claim: vi.fn(async () => [{
        publicId: "cleanup-action-a",
        operationPublicId: "publication-operation-a",
        knowledgeBaseId: "knowledge-base-a",
        domain: "candidate_projection",
        target: {
          publicId: "object-a",
          resourceKind: "superseded_candidate_object",
          plane: "object_storage" as const,
          required: true,
          sequence: 30
        },
        state: "running" as const,
        attempt: 1,
        leaseOwner: "candidate-cleanup-worker-a",
        leaseExpiresAt: "2026-08-05T01:00:00.000Z",
        safeErrorCode: null,
        notBefore: "2026-08-05T00:00:00.000Z",
        checkpoint: {},
        idempotency: { key: "cleanup-a", requestHash: "a".repeat(64) }
      }]),
      complete,
      releaseForRetry: vi.fn(),
      renew: vi.fn(),
      saveCheckpoint: vi.fn(),
      enqueue: vi.fn()
    };
    const deleteZeroOwner = vi.fn(async () => ({
      deletedVersions: 1,
      deletedMarkers: 0,
      abortedMultipartUploads: 0
    }));
    const worker = createStorageVnextCandidateObjectCleanupWorker({
      actions,
      objects: { deleteZeroOwner },
      purgeDeletedRegistrations: vi.fn(async () => 1)
    });

    await expect(worker.runBatch({
      owner: "candidate-cleanup-worker-a",
      limit: 100,
      leaseExpiresAt: "2026-08-05T01:00:00.000Z",
      now: "2026-08-05T00:00:00.000Z",
      retryDelayMilliseconds: 1_000,
      signal: new AbortController().signal
    })).resolves.toMatchObject({
      outcome: "progress",
      claimed: 1,
      deleted: 1,
      completed: 1,
      purgedRegistrations: 1
    });
    expect(actions.claim).toHaveBeenCalledWith(expect.objectContaining({
      selector: {
        domain: "candidate_projection",
        plane: "object_storage",
        resourceKind: "superseded_candidate_object"
      }
    }));
    expect(deleteZeroOwner).toHaveBeenCalledWith("object-a");
    expect(complete).toHaveBeenCalledWith({
      publicId: "cleanup-action-a",
      owner: "candidate-cleanup-worker-a"
    });
  });
});

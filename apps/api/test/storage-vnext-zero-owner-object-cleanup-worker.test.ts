import { describe, expect, it, vi } from "vitest";
import {
  createStorageVnextZeroOwnerObjectCleanupWorker
} from "../src/storage-vnext/maintenance/zero-owner-object-cleanup-worker.js";
import {
  createStorageVnextUploadTerminalObjectCleanupWorker
} from "../src/storage-vnext/maintenance/upload-terminal-object-cleanup-worker.js";

describe("storage vNext zero-owner object cleanup worker", () => {
  it("passes the configured 1000-item maintenance limit through every cleanup repository call", async () => {
    const actions = {
      recoverStale: vi.fn(async () => 0),
      claim: vi.fn(async () => []),
      complete: vi.fn(async () => true),
      releaseForRetry: vi.fn()
    };
    const worker = createStorageVnextZeroOwnerObjectCleanupWorker({
      actions,
      objects: { deleteZeroOwner: vi.fn() },
      purgeDeletedRegistrations: vi.fn(async () => 0)
    });

    await expect(worker.runBatch({
      owner: "candidate-cleanup-worker-a",
      limit: 1_000,
      leaseExpiresAt: "2026-08-05T01:00:00.000Z",
      now: "2026-08-05T00:00:00.000Z",
      retryDelayMilliseconds: 1_000,
      signal: new AbortController().signal
    })).resolves.toMatchObject({ outcome: "idle", claimed: 0 });
    expect(actions.recoverStale).toHaveBeenCalledWith(expect.objectContaining({ limit: 1_000 }));
    expect(actions.claim).toHaveBeenCalledWith(expect.objectContaining({ limit: 1_000 }));
  });

  it("claims release-scoped actions globally and deletes only zero-owner objects", async () => {
    const complete = vi.fn(async () => true);
    const actions = {
      recoverStale: vi.fn(async () => 0),
      claim: vi.fn(async () => [{
        publicId: "cleanup-action-a",
        operationPublicId: "publication-operation-a",
        knowledgeBaseId: "knowledge-base-a",
        domain: "zero_owner_object",
        searchProviderKind: null,
        target: {
          publicId: "object-a",
          resourceKind: "zero_owner_object",
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
    const worker = createStorageVnextZeroOwnerObjectCleanupWorker({
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
        domain: "zero_owner_object",
        plane: "object_storage",
        resourceKind: "zero_owner_object"
      }
    }));
    expect(deleteZeroOwner).toHaveBeenCalledWith("object-a");
    expect(complete).toHaveBeenCalledWith({
      publicId: "cleanup-action-a",
      owner: "candidate-cleanup-worker-a"
    });
  });
});

describe("storage vNext upload terminal object cleanup worker", () => {
  it("claims upload cleanup and completes safely when the object has a durable owner", async () => {
    const complete = vi.fn(async () => true);
    const actions = {
      recoverStale: vi.fn(async () => 0),
      claim: vi.fn(async () => [{
        publicId: "upload-cleanup-a",
        operationPublicId: "upload-operation-a",
        knowledgeBaseId: "knowledge-base-a",
        domain: "upload_terminal",
        searchProviderKind: null,
        target: {
          publicId: "object-a",
          resourceKind: "temporary_object",
          plane: "object_storage" as const,
          required: true,
          sequence: 30
        },
        state: "running" as const,
        attempt: 1,
        leaseOwner: "upload-cleanup-worker-a",
        leaseExpiresAt: "2026-08-05T01:00:00.000Z",
        safeErrorCode: null,
        notBefore: "2026-08-05T00:00:00.000Z",
        checkpoint: {},
        idempotency: { key: "upload-cleanup-a", requestHash: "a".repeat(64) }
      }]),
      complete,
      releaseForRetry: vi.fn()
    };
    const deleteZeroOwner = vi.fn(async () => {
      throw Object.assign(new Error("owned"), { code: "owners_present" });
    });
    const worker = createStorageVnextUploadTerminalObjectCleanupWorker({
      actions,
      objects: { deleteZeroOwner },
      purgeDeletedRegistrations: vi.fn(async () => 0)
    });

    await expect(worker.runBatch({
      owner: "upload-cleanup-worker-a",
      limit: 100,
      leaseExpiresAt: "2026-08-05T01:00:00.000Z",
      now: "2026-08-05T00:00:00.000Z",
      retryDelayMilliseconds: 1_000,
      signal: new AbortController().signal
    })).resolves.toMatchObject({
      claimed: 1,
      skippedOwned: 1,
      completed: 1
    });
    expect(actions.claim).toHaveBeenCalledWith(expect.objectContaining({
      selector: {
        domain: "upload_terminal",
        plane: "object_storage",
        resourceKind: "temporary_object"
      }
    }));
    expect(complete).toHaveBeenCalledWith({
      publicId: "upload-cleanup-a",
      owner: "upload-cleanup-worker-a"
    });
  });
});

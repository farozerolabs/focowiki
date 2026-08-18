import { describe, expect, it, vi } from "vitest";
import { createZeroOwnerObjectCleanup } from
  "../src/document-indexing/application/zero-owner-object-cleanup.js";
import { resolveZeroOwnerObjectCleanupConcurrency } from
  "../src/document-indexing/application/zero-owner-object-cleanup.js";

describe("zero-owner object cleanup", () => {
  it("uses the validated object-storage capacity instead of a fixed cleanup cap", () => {
    expect(resolveZeroOwnerObjectCleanupConcurrency(24)).toBe(24);
    expect(resolveZeroOwnerObjectCleanupConcurrency(64)).toBe(32);
  });

  it("deletes provider objects with bounded parallelism", async () => {
    let active = 0;
    let maximumActive = 0;
    const actions = Array.from({ length: 5 }, (_, index) => ({
      publicId: `cleanup-${index}`,
      objectId: `object-${index}`,
      attempt: 1,
      maximumAttempts: 3
    }));
    let cursor = 0;
    const claim = vi.fn(async (request: { limit: number }) => {
      const claimed = actions.slice(cursor, cursor + request.limit);
      cursor += claimed.length;
      return claimed;
    });
    const worker = createZeroOwnerObjectCleanup({
      concurrency: 2,
      actions: {
        recoverStale: vi.fn().mockResolvedValue(0),
        claim,
        complete: vi.fn().mockResolvedValue(true),
        retry: vi.fn(),
        fail: vi.fn()
      },
      objects: {
        async removeZeroOwner() {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
        }
      }
    });

    await expect(worker.run({ ...batch(), limit: 5 })).resolves.toEqual({
      claimed: 5, completed: 5, retried: 0, failed: 0
    });
    expect(maximumActive).toBe(2);
    expect(claim.mock.calls.map(([request]) => request.limit)).toEqual([
      2, 2, 1
    ]);
  });

  it("claims only work that can start within the current concurrency window", async () => {
    const claim = vi.fn().mockResolvedValue([]);
    const worker = createZeroOwnerObjectCleanup({
      concurrency: 3,
      actions: {
        recoverStale: vi.fn().mockResolvedValue(0),
        claim,
        complete: vi.fn(),
        retry: vi.fn(),
        fail: vi.fn()
      },
      objects: { removeZeroOwner: vi.fn() }
    });

    await worker.run(batch());

    expect(claim).toHaveBeenCalledWith({
      owner: "worker-1",
      limit: 3,
      leaseExpiresAt: "2026-08-14T15:01:00.000Z"
    });
  });

  it("deletes only through the zero-owner provider and completes the lease", async () => {
    const claim = vi.fn()
      .mockResolvedValueOnce([{
        publicId: "cleanup-1",
        objectId: "object-1",
        attempt: 1,
        maximumAttempts: 3
      }])
      .mockResolvedValue([]);
    const removeZeroOwner = vi.fn().mockResolvedValue(undefined);
    const complete = vi.fn().mockResolvedValue(true);
    const retry = vi.fn();
    const fail = vi.fn();
    const worker = createZeroOwnerObjectCleanup({
      actions: {
        recoverStale: vi.fn().mockResolvedValue(0),
        claim, complete, retry, fail
      },
      objects: { removeZeroOwner }
    });

    await expect(worker.run(batch())).resolves.toEqual({
      claimed: 1, completed: 1, retried: 0, failed: 0
    });
    expect(removeZeroOwner).toHaveBeenCalledWith("object-1");
    expect(complete).toHaveBeenCalledWith({
      publicId: "cleanup-1", owner: "worker-1",
      completedAt: "2026-08-14T15:00:00.000Z"
    });
  });

  it("retries a failed provider call without claiming success", async () => {
    const complete = vi.fn();
    const retry = vi.fn().mockResolvedValue(true);
    const fail = vi.fn();
    const worker = createZeroOwnerObjectCleanup({
      actions: {
        recoverStale: vi.fn().mockResolvedValue(0),
        claim: vi.fn()
          .mockResolvedValueOnce([{
            publicId: "cleanup-1", objectId: "object-1",
            attempt: 1, maximumAttempts: 3
          }])
          .mockResolvedValue([]),
        complete, retry, fail
      },
      objects: {
        removeZeroOwner: vi.fn().mockRejectedValue(
          Object.assign(new Error("temporary"), { code: "S3_TEMPORARY" })
        )
      }
    });

    await expect(worker.run(batch())).resolves.toMatchObject({ retried: 1 });
    expect(complete).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledWith(expect.objectContaining({
      safeErrorCode: "S3_TEMPORARY"
    }));
  });

  it("completes when the object regained an owner and must be retained", async () => {
    const complete = vi.fn().mockResolvedValue(true);
    const retry = vi.fn();
    const worker = createZeroOwnerObjectCleanup({
      actions: {
        recoverStale: vi.fn().mockResolvedValue(0),
        claim: vi.fn()
          .mockResolvedValueOnce([{
            publicId: "cleanup-1", objectId: "object-1",
            attempt: 1, maximumAttempts: 3
          }])
          .mockResolvedValue([]),
        complete,
        retry,
        fail: vi.fn()
      },
      objects: {
        removeZeroOwner: vi.fn().mockRejectedValue(
          Object.assign(new Error("retained"), { code: "owners_present" })
        )
      }
    });

    await expect(worker.run(batch())).resolves.toMatchObject({
      completed: 1, retried: 0, failed: 0
    });
    expect(complete).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });
});

function batch() {
  return {
    owner: "worker-1",
    limit: 10,
    now: "2026-08-14T15:00:00.000Z",
    leaseExpiresAt: "2026-08-14T15:01:00.000Z",
    retryAt: "2026-08-14T15:00:02.000Z",
    signal: new AbortController().signal
  };
}

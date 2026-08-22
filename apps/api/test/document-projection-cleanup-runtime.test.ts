import { describe, expect, it, vi } from "vitest";
import { createDocumentProjectionCleanupRuntime } from
  "../src/document-indexing/application/document-projection-cleanup-runtime.js";

describe("document projection cleanup runtime", () => {
  it("releases the exact write-attempt holder and completes its outbox item", async () => {
    const releaseVerifiedReservation = vi.fn(async () => undefined);
    const complete = vi.fn(async () => true);
    const runtime = createRuntime({ releaseVerifiedReservation, complete });

    await expect(runtime.runOnce(new AbortController().signal)).resolves.toBe(1);
    expect(releaseVerifiedReservation).toHaveBeenCalledWith({
      objectId: "object-a",
      writeAttemptPublicId: "write-a"
    });
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      publicId: "cleanup-a",
      leaseGeneration: 3
    }));
  });

  it("does not remove a newer holder and treats the stale cleanup as superseded", async () => {
    const complete = vi.fn(async () => true);
    const fail = vi.fn(async () => true);
    const runtime = createRuntime({
      complete,
      fail,
      releaseVerifiedReservation: vi.fn(async () => {
        throw Object.assign(new Error("newer holder"), {
          code: "write_attempt_conflict"
        });
      })
    });

    await runtime.runOnce(new AbortController().signal);
    expect(complete).toHaveBeenCalledOnce();
    expect(fail).not.toHaveBeenCalled();
  });

  it("records retryable cleanup debt without changing a document state", async () => {
    const fail = vi.fn(async () => true);
    const runtime = createRuntime({
      fail,
      releaseVerifiedReservation: vi.fn(async () => {
        throw Object.assign(new Error("database unavailable"), {
          code: "provider_unavailable"
        });
      })
    });

    await runtime.runOnce(new AbortController().signal);
    expect(fail).toHaveBeenCalledWith(expect.objectContaining({
      publicId: "cleanup-a",
      errorCode: "PROJECTION_CLEANUP_PROVIDER_UNAVAILABLE"
    }));
  });
});

function createRuntime(overrides: Record<string, unknown>) {
  let claimed = false;
  return createDocumentProjectionCleanupRuntime({
    workerId: "cleanup-worker",
    leaseDurationMs: 30_000,
    concurrency: 4,
    retryDelayMs: 1_000,
    outbox: {
      async claim() {
        if (claimed) return [];
        claimed = true;
        return [{
          publicId: "cleanup-a",
          objectId: "object-a",
          writeAttemptPublicId: "write-a",
          leaseGeneration: 3
        }];
      },
      async complete() { return true; },
      async fail() { return true; },
      ...overrides
    } as never,
    ownership: {
      async releaseVerifiedReservation() {},
      ...overrides
    } as never,
    now: () => "2026-08-21T10:00:00.000Z",
    wait: async () => undefined
  });
}

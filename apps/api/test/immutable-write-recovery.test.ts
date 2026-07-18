import { describe, expect, it, vi } from "vitest";
import type { ImmutableObjectRecoveryRepository } from "../src/application/ports/immutable-object-repository.js";
import { runImmutableWriteRecoverySlice } from "../src/maintenance/immutable-write-recovery.js";
import type { StorageAdapter } from "../src/storage/s3.js";

const reservation = {
  checksumSha256: "a".repeat(64),
  formatVersion: 1,
  objectKey: `tenant/test/generated/v1/objects/aa/${"a".repeat(64)}`,
  contentType: "text/markdown; charset=utf-8",
  sizeBytes: 12
};

describe("immutable write recovery", () => {
  it("activates a stale reservation when storage identity matches", async () => {
    const repository = createRepository();
    const storage = createStorage({
      headObjectMetadata: vi.fn().mockResolvedValue(stored())
    });

    const result = await runImmutableWriteRecoverySlice({ repository, storage });

    expect(result).toEqual({ claimed: 1, activated: 1, expired: 0, failed: 0 });
    expect(repository.activateRecovered).toHaveBeenCalledWith(expect.objectContaining({
      checksumSha256: reservation.checksumSha256,
      recoveryToken: expect.any(String)
    }));
  });

  it("expires a stale reservation when storage confirms the object is missing", async () => {
    const repository = createRepository();
    const storage = createStorage({ headObjectMetadata: vi.fn().mockResolvedValue(null) });

    const result = await runImmutableWriteRecoverySlice({ repository, storage });

    expect(result.expired).toBe(1);
    expect(repository.expireMissing).toHaveBeenCalledOnce();
    expect(repository.activateRecovered).not.toHaveBeenCalled();
  });

  it("records an identity failure without activating a conflicting object", async () => {
    const repository = createRepository();
    const storage = createStorage({
      headObjectMetadata: vi.fn().mockResolvedValue(stored({ sizeBytes: 13 }))
    });

    const result = await runImmutableWriteRecoverySlice({ repository, storage });

    expect(result.failed).toBe(1);
    expect(repository.markRecoveryFailure).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "IMMUTABLE_OBJECT_RECOVERY_IDENTITY_MISMATCH"
    }));
    expect(repository.activateRecovered).not.toHaveBeenCalled();
  });

  it("records a retryable failure when storage verification fails", async () => {
    const repository = createRepository();
    const storage = createStorage({
      headObjectMetadata: vi.fn().mockRejectedValue(new Error("provider unavailable"))
    });

    const result = await runImmutableWriteRecoverySlice({ repository, storage });

    expect(result.failed).toBe(1);
    expect(repository.markRecoveryFailure).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "IMMUTABLE_OBJECT_RECOVERY_STORAGE_FAILED"
    }));
  });
});

function createRepository(): ImmutableObjectRecoveryRepository {
  return {
    claimStaleWriting: vi.fn().mockResolvedValue([reservation]),
    activateRecovered: vi.fn().mockResolvedValue(true),
    expireMissing: vi.fn().mockResolvedValue(true),
    markRecoveryFailure: vi.fn()
  };
}

function createStorage(overrides: Partial<StorageAdapter> = {}) {
  return {
    headObjectMetadata: vi.fn().mockResolvedValue(null),
    ...overrides
  } as Pick<StorageAdapter, "headObjectMetadata"> & {
    headObjectMetadata: NonNullable<StorageAdapter["headObjectMetadata"]>;
  };
}

function stored(overrides: { sizeBytes?: number } = {}) {
  return {
    key: reservation.objectKey,
    contentType: reservation.contentType,
    sizeBytes: overrides.sizeBytes ?? reservation.sizeBytes,
    etag: "etag",
    lastModified: null,
    metadata: {
      "focowiki-checksum-sha256": reservation.checksumSha256,
      "focowiki-format-version": String(reservation.formatVersion)
    }
  };
}

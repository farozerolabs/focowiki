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

  it("releases an identity failure without activating a conflicting object", async () => {
    const repository = createRepository();
    const storage = createStorage({
      headObjectMetadata: vi.fn().mockResolvedValue(stored({ sizeBytes: 13 }))
    });

    const result = await runImmutableWriteRecoverySlice({ repository, storage });

    expect(result.failed).toBe(1);
    expect(repository.releaseRecoveryFailure).toHaveBeenCalledWith(expect.objectContaining({
      recoveryToken: expect.any(String)
    }));
    expect(repository.activateRecovered).not.toHaveBeenCalled();
  });

  it("releases a retryable failure when storage verification fails", async () => {
    const repository = createRepository();
    const storage = createStorage({
      headObjectMetadata: vi.fn().mockRejectedValue(new Error("provider unavailable"))
    });

    const result = await runImmutableWriteRecoverySlice({ repository, storage });

    expect(result.failed).toBe(1);
    expect(repository.releaseRecoveryFailure).toHaveBeenCalledWith(expect.objectContaining({
      recoveryToken: expect.any(String)
    }));
  });

  it("claims only objects that can be verified concurrently in the current slice", async () => {
    const repository = createRepository();
    const second = { ...reservation, checksumSha256: "b".repeat(64), objectKey: reservation.objectKey.replace(/a/g, "b") };
    vi.mocked(repository.claimStaleWriting).mockResolvedValue([reservation, second]);
    let active = 0;
    let maximumActive = 0;
    const storage = createStorage({
      headObjectMetadata: vi.fn(async (key: string) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        active -= 1;
        return key === reservation.objectKey
          ? stored()
          : { ...stored(), key, metadata: {
              "focowiki-checksum-sha256": second.checksumSha256,
              "focowiki-format-version": String(second.formatVersion)
            } };
      })
    });

    const result = await runImmutableWriteRecoverySlice({
      repository,
      storage,
      batchSize: 500,
      concurrency: 2
    });

    expect(repository.claimStaleWriting).toHaveBeenCalledWith(expect.objectContaining({ limit: 2 }));
    expect(result).toEqual({ claimed: 2, activated: 2, expired: 0, failed: 0 });
    expect(maximumActive).toBe(2);
  });
});

function createRepository(): ImmutableObjectRecoveryRepository {
  return {
    claimStaleWriting: vi.fn().mockResolvedValue([reservation]),
    activateRecovered: vi.fn().mockResolvedValue(true),
    expireMissing: vi.fn().mockResolvedValue(true),
    releaseRecoveryFailure: vi.fn(async () => true)
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

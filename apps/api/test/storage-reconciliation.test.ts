import { describe, expect, it, vi } from "vitest";
import type {
  StorageReconciliationCycle,
  StorageReconciliationRepository
} from "../src/application/ports/storage-reconciliation-repository.js";
import {
  parseManagedImmutableObjectKey,
  runStorageReconciliationSlice
} from "../src/maintenance/storage-reconciliation.js";
import { createImmutableObjectKey } from "../src/domain/generation.js";
import { createStorageKeyspace } from "../src/storage/keys.js";
import type { StorageAdapter } from "../src/storage/s3.js";

describe("storage reconciliation", () => {
  it("accepts only exact managed immutable object keys", () => {
    const checksum = "a".repeat(64);
    const managed = createImmutableObjectKey({
      prefix: "tenant/test",
      checksumSha256: checksum,
      formatVersion: 1
    });

    expect(parseManagedImmutableObjectKey("tenant/test", managed)).toEqual({
      checksumSha256: checksum,
      formatVersion: 1
    });
    expect(parseManagedImmutableObjectKey(
      "tenant/test",
      "tenant/test/knowledge-bases/kb-a/sources/source-a/content.md"
    )).toBeNull();
    expect(parseManagedImmutableObjectKey(
      "tenant/test",
      `tenant/test/generated/v1/objects/bb/${checksum}`
    )).toBeNull();
    expect(parseManagedImmutableObjectKey(
      "tenant/test",
      "tenant/test/generated/v1/objects/aa/../../source.md"
    )).toBeNull();
  });

  it("quarantines first discovery without deleting it", async () => {
    const checksum = "a".repeat(64);
    const key = createImmutableObjectKey({ prefix: "tenant/test", checksumSha256: checksum });
    const repository = createRepository({
      claimCycle: vi.fn().mockResolvedValue(cycle("scanning"))
    });
    const storage = createStorage({
      listObjectMetadata: vi.fn().mockResolvedValue({
        objects: [{ key, sizeBytes: 12, etag: "etag-a", lastModified: null }],
        nextContinuationToken: null
      })
    });

    await runStorageReconciliationSlice(createInput(repository, storage));

    expect(repository.recordScanPage).toHaveBeenCalledWith(expect.objectContaining({
      objects: [expect.objectContaining({ key, checksumSha256: checksum, formatVersion: 1 })]
    }));
    expect(storage.deleteObjects).not.toHaveBeenCalled();
  });

  it("cancels deletion when the database no longer authorizes a candidate", async () => {
    const repository = createRepository({
      claimCycle: vi.fn().mockResolvedValue(cycle("verifying")),
      claimDeletionCandidates: vi.fn().mockResolvedValue([]),
      listRegisteredObjectsForVerification: vi.fn().mockResolvedValue([])
    });
    const storage = createStorage();

    await runStorageReconciliationSlice(createInput(repository, storage));

    expect(storage.headObjectMetadata).not.toHaveBeenCalled();
    expect(storage.deleteObjects).not.toHaveBeenCalled();
    expect(repository.finishCycle).toHaveBeenCalledOnce();
  });

  it("deletes a confirmed unowned object after metadata and ownership revalidation", async () => {
    const object = candidate("b", { sizeBytes: 12, etag: "etag-b" });
    const repository = createRepository({
      claimCycle: vi.fn().mockResolvedValue(cycle("verifying")),
      claimDeletionCandidates: vi.fn().mockResolvedValue([object]),
      authorizeCandidateDeletion: vi.fn().mockResolvedValue(true)
    });
    const storage = createStorage({
      headObjectMetadata: vi.fn().mockResolvedValue({
        key: object.key,
        contentType: "text/markdown",
        sizeBytes: 12,
        etag: "etag-b",
        lastModified: null,
        metadata: {}
      })
    });

    await runStorageReconciliationSlice(createInput(repository, storage));

    expect(repository.authorizeCandidateDeletion).toHaveBeenCalledWith(expect.objectContaining({
      objectKey: object.key,
      checksumSha256: object.checksumSha256
    }));
    expect(storage.deleteObjects).toHaveBeenCalledWith([object.key]);
    expect(repository.completeCandidateDeletion).toHaveBeenCalledWith(expect.objectContaining({
      objectKey: object.key
    }));
  });

  it("uses the configured version purge policy for confirmed candidates", async () => {
    const object = candidate("9", { sizeBytes: 12, etag: "etag-versioned" });
    const repository = createRepository({
      claimCycle: vi.fn().mockResolvedValue(cycle("verifying")),
      claimDeletionCandidates: vi.fn().mockResolvedValue([object]),
      authorizeCandidateDeletion: vi.fn().mockResolvedValue(true)
    });
    const storage = createStorage({
      headObjectMetadata: vi.fn().mockResolvedValue({
        key: object.key,
        contentType: "application/json",
        sizeBytes: 12,
        etag: "etag-versioned",
        lastModified: null,
        metadata: {}
      }),
      deleteObjectVersions: vi.fn()
    });
    const input = createInput(repository, storage);
    input.versionPurgeEnabled = true;

    await runStorageReconciliationSlice(input);

    expect(storage.deleteObjectVersions).toHaveBeenCalledWith([object.key]);
    expect(storage.deleteObjects).not.toHaveBeenCalled();
    expect(repository.completeCandidateDeletion).toHaveBeenCalledWith(expect.objectContaining({
      objectKey: object.key
    }));
  });

  it("refreshes quarantine when object metadata changed after discovery", async () => {
    const object = candidate("c", { sizeBytes: 12, etag: "etag-old" });
    const repository = createRepository({
      claimCycle: vi.fn().mockResolvedValue(cycle("verifying")),
      claimDeletionCandidates: vi.fn().mockResolvedValue([object])
    });
    const storage = createStorage({
      headObjectMetadata: vi.fn().mockResolvedValue({
        key: object.key,
        contentType: null,
        sizeBytes: 24,
        etag: "etag-new",
        lastModified: null,
        metadata: {}
      })
    });

    await runStorageReconciliationSlice(createInput(repository, storage));

    expect(repository.refreshCandidateObservation).toHaveBeenCalledWith(expect.objectContaining({
      object: expect.objectContaining({ key: object.key, sizeBytes: 24, etag: "etag-new" })
    }));
    expect(repository.authorizeCandidateDeletion).not.toHaveBeenCalled();
    expect(storage.deleteObjects).not.toHaveBeenCalled();
  });

  it("rechecks object metadata after database authorization before deleting", async () => {
    const object = candidate("c", { sizeBytes: 12, etag: "etag-old" });
    const repository = createRepository({
      claimCycle: vi.fn().mockResolvedValue(cycle("verifying")),
      claimDeletionCandidates: vi.fn().mockResolvedValue([object]),
      authorizeCandidateDeletion: vi.fn().mockResolvedValue(true)
    });
    const storage = createStorage({
      headObjectMetadata: vi.fn()
        .mockResolvedValueOnce({
          key: object.key,
          contentType: null,
          sizeBytes: 12,
          etag: "etag-old",
          lastModified: null,
          metadata: {}
        })
        .mockResolvedValueOnce({
          key: object.key,
          contentType: null,
          sizeBytes: 18,
          etag: "etag-replaced",
          lastModified: null,
          metadata: {}
        })
    });

    await runStorageReconciliationSlice(createInput(repository, storage));

    expect(storage.headObjectMetadata).toHaveBeenCalledTimes(2);
    expect(repository.refreshCandidateObservation).toHaveBeenCalledWith(expect.objectContaining({
      object: expect.objectContaining({
        key: object.key,
        sizeBytes: 18,
        etag: "etag-replaced"
      })
    }));
    expect(storage.deleteObjects).not.toHaveBeenCalled();
    expect(repository.completeCandidateDeletion).not.toHaveBeenCalled();
  });

  it("persists a retry without blocking later deletion candidates", async () => {
    const first = candidate("d");
    const second = candidate("e");
    const repository = createRepository({
      claimCycle: vi.fn().mockResolvedValue(cycle("verifying")),
      claimDeletionCandidates: vi.fn().mockResolvedValue([first, second]),
      authorizeCandidateDeletion: vi.fn().mockResolvedValue(true)
    });
    const storage = createStorage({
      headObjectMetadata: vi.fn().mockImplementation(async (key: string) => ({
        key,
        contentType: null,
        sizeBytes: 12,
        etag: "etag",
        lastModified: null,
        metadata: {}
      })),
      deleteObjects: vi.fn()
        .mockRejectedValueOnce(new Error("provider unavailable"))
        .mockResolvedValueOnce(undefined)
    });

    await runStorageReconciliationSlice(createInput(repository, storage));

    expect(repository.failCandidateDeletion).toHaveBeenCalledWith(expect.objectContaining({
      objectKey: first.key,
      errorCode: "STORAGE_DELETE_FAILED"
    }));
    expect(repository.completeCandidateDeletion).toHaveBeenCalledWith(expect.objectContaining({
      objectKey: second.key
    }));
  });

  it("records missing registered objects without deleting catalog rows", async () => {
    const object = candidate("f");
    const repository = createRepository({
      claimCycle: vi.fn().mockResolvedValue(cycle("verifying")),
      claimDeletionCandidates: vi.fn().mockResolvedValue([]),
      listRegisteredObjectsForVerification: vi.fn().mockResolvedValue([{
        checksumSha256: object.checksumSha256,
        formatVersion: object.formatVersion,
        objectKey: object.key
      }])
    });
    const storage = createStorage({ headObjectMetadata: vi.fn().mockResolvedValue(null) });

    await runStorageReconciliationSlice(createInput(repository, storage));

    expect(repository.recordRegisteredObjectCheck).toHaveBeenCalledWith(expect.objectContaining({
      exists: false,
      object: expect.objectContaining({ objectKey: object.key })
    }));
    expect(repository.completeCandidateDeletion).not.toHaveBeenCalled();
  });

  it("ignores malformed and non-managed keys during discovery", async () => {
    const repository = createRepository({
      claimCycle: vi.fn().mockResolvedValue(cycle("scanning"))
    });
    const storage = createStorage({
      listObjectMetadata: vi.fn().mockResolvedValue({
        objects: [
          { key: "tenant/test/generated/tmp/file.md", sizeBytes: 1, etag: null, lastModified: null },
          { key: "tenant/test/knowledge-bases/kb-a/source.md", sizeBytes: 1, etag: null, lastModified: null }
        ],
        nextContinuationToken: null
      })
    });

    await runStorageReconciliationSlice(createInput(repository, storage));

    expect(repository.recordScanPage).toHaveBeenCalledWith(expect.objectContaining({ objects: [] }));
    expect(storage.deleteObjects).not.toHaveBeenCalled();
  });

  it("records one safe cycle failure when a persisted continuation is rejected", async () => {
    const repository = createRepository({
      claimCycle: vi.fn().mockResolvedValue({
        ...cycle("scanning"),
        continuationToken: "forged-provider-token"
      })
    });
    const storage = createStorage({
      listObjectMetadata: vi.fn().mockRejectedValue(new Error("provider rejected token"))
    });

    await expect(runStorageReconciliationSlice(createInput(repository, storage))).resolves.toEqual({
      claimed: true,
      phase: "failed",
      scanned: 0,
      deleted: 0,
      verified: 0,
      failed: 1
    });
    expect(repository.failCycle).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "STORAGE_RECONCILIATION_FAILED"
    }));
    expect(repository.failCycle).toHaveBeenCalledOnce();
  });
});

function createInput(repository: StorageReconciliationRepository, storage: StorageAdapter) {
  return {
    repository,
    storage: storage as StorageAdapter & {
      listObjectMetadata: NonNullable<StorageAdapter["listObjectMetadata"]>;
      headObjectMetadata: NonNullable<StorageAdapter["headObjectMetadata"]>;
    },
    settings: {
      reconciliationEnabled: true,
      scanIntervalSeconds: 21_600,
      scanBatchSize: 500,
      deletionBatchSize: 100,
      quarantineGracePeriodSeconds: 86_400,
      confirmationPasses: 2,
      maxAttempts: 5,
      retryDelayMs: 30_000
    },
    versionPurgeEnabled: false,
    now: () => new Date("2026-07-18T12:00:00.000Z"),
    leaseToken: "lease-test",
    cycleId: "cycle-test"
  };
}

function cycle(state: StorageReconciliationCycle["state"]): StorageReconciliationCycle {
  return {
    prefix: "tenant/test/generated/",
    cycleId: "cycle-test",
    state,
    continuationToken: null,
    verificationCursor: null
  };
}

function createRepository(
  overrides: Partial<StorageReconciliationRepository> = {}
): StorageReconciliationRepository {
  return {
    claimCycle: vi.fn().mockResolvedValue(null),
    recordScanPage: vi.fn().mockResolvedValue(true),
    claimDeletionCandidates: vi.fn().mockResolvedValue([]),
    authorizeCandidateDeletion: vi.fn().mockResolvedValue(true),
    refreshCandidateObservation: vi.fn(),
    completeCandidateDeletion: vi.fn(),
    failCandidateDeletion: vi.fn(),
    listRegisteredObjectsForVerification: vi.fn().mockResolvedValue([]),
    recordRegisteredObjectCheck: vi.fn().mockResolvedValue(true),
    finishCycle: vi.fn().mockResolvedValue(true),
    failCycle: vi.fn(),
    getStatus: vi.fn().mockResolvedValue(null),
    ...overrides
  };
}

function createStorage(overrides: Partial<StorageAdapter> = {}): StorageAdapter {
  return {
    keyspace: createStorageKeyspace("tenant/test"),
    putObject: vi.fn(),
    getObjectText: vi.fn(),
    listObjectMetadata: vi.fn().mockResolvedValue({ objects: [], nextContinuationToken: null }),
    headObjectMetadata: vi.fn().mockResolvedValue(null),
    deleteObjects: vi.fn(),
    ...overrides
  };
}

function candidate(
  character: string,
  metadata: { sizeBytes?: number; etag?: string | null } = {}
) {
  const checksumSha256 = character.repeat(64);
  return {
    key: createImmutableObjectKey({ prefix: "tenant/test", checksumSha256 }),
    checksumSha256,
    formatVersion: 1,
    confirmationCount: 2,
    attemptCount: 1,
    sizeBytes: metadata.sizeBytes ?? 12,
    etag: metadata.etag ?? "etag",
    lastModified: "2026-07-18T10:00:00.000Z"
  };
}

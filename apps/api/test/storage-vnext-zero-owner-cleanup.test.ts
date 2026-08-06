import { describe, expect, it, vi } from "vitest";
import type { StorageVnextObjectRegistration } from
  "../src/storage-vnext/ownership/ports.js";
import { createStorageVnextZeroOwnerCleanup } from
  "../src/storage-vnext/maintenance/zero-owner-cleanup.js";

describe("storage vNext zero-owner cleanup", () => {
  it("deletes one bounded eligible page and purges confirmed tombstones", async () => {
    const registrations = {
      listZeroOwnerObjects: vi.fn(async () => ({
        items: [registration("a"), registration("b")],
        nextCursor: "next-zero-owner-page"
      }))
    };
    const objects = {
      deleteZeroOwner: vi.fn(async (_objectId: string) => ({
        deletedVersions: 1,
        deletedMarkers: 0,
        abortedMultipartUploads: 0
      }))
    };
    const purgeDeletedRegistrations = vi.fn(async () => 2);
    const cleanup = createStorageVnextZeroOwnerCleanup({
      registrations,
      objects,
      purgeDeletedRegistrations
    });

    await expect(cleanup.runBatch({
      graceElapsedBefore: "2026-08-01T00:00:00.000Z",
      limit: 2
    })).resolves.toEqual({
      outcome: "progress",
      eligible: 2,
      deleted: 2,
      skippedOwned: 0,
      purgedRegistrations: 2,
      reasonCode: null
    });
    expect(registrations.listZeroOwnerObjects).toHaveBeenCalledWith({
      graceElapsedBefore: "2026-08-01T00:00:00.000Z",
      limit: 2,
      cursor: null
    });
    expect(objects.deleteZeroOwner.mock.calls.map(([objectId]) => objectId))
      .toEqual(["object-a", "object-b"]);
    expect(purgeDeletedRegistrations).toHaveBeenCalledWith({ limit: 2 });
  });

  it("stops a provider failure at the bounded object and keeps it retryable", async () => {
    const objects = {
      deleteZeroOwner: vi.fn()
        .mockResolvedValueOnce({
          deletedVersions: 1,
          deletedMarkers: 0,
          abortedMultipartUploads: 0
        })
        .mockRejectedValueOnce(Object.assign(new Error("provider detail"), {
          code: "provider_delete_failed"
        }))
    };
    const purgeDeletedRegistrations = vi.fn(async () => 1);
    const cleanup = createStorageVnextZeroOwnerCleanup({
      registrations: {
        listZeroOwnerObjects: vi.fn(async () => ({
          items: [registration("a"), registration("b"), registration("c")],
          nextCursor: null
        }))
      },
      objects,
      purgeDeletedRegistrations
    });

    const result = await cleanup.runBatch({
      graceElapsedBefore: "2026-08-01T00:00:00.000Z",
      limit: 3
    });
    expect(result).toEqual({
      outcome: "retry",
      eligible: 3,
      deleted: 1,
      skippedOwned: 0,
      purgedRegistrations: 1,
      reasonCode: "OBJECT_PROVIDER_DELETE_FAILED"
    });
    expect(objects.deleteZeroOwner).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain("provider detail");
  });

  it("skips an object that gained an owner after the eligible page was read", async () => {
    const cleanup = createStorageVnextZeroOwnerCleanup({
      registrations: {
        listZeroOwnerObjects: vi.fn(async () => ({
          items: [registration("a")],
          nextCursor: null
        }))
      },
      objects: {
        deleteZeroOwner: vi.fn(async () => {
          throw Object.assign(new Error("owner race"), { code: "owners_present" });
        })
      },
      purgeDeletedRegistrations: vi.fn(async () => 0)
    });

    await expect(cleanup.runBatch({
      graceElapsedBefore: "2026-08-01T00:00:00.000Z",
      limit: 1
    })).resolves.toMatchObject({
      outcome: "completed",
      deleted: 0,
      skippedOwned: 1,
      reasonCode: null
    });
  });
});

function registration(suffix: string): StorageVnextObjectRegistration {
  return {
    objectId: `object-${suffix}`,
    storageKey: `owned/generated/${suffix}.md`,
    checksum: suffix.repeat(64),
    byteCount: 10,
    contentType: "text/markdown; charset=utf-8",
    format: "okf-generated-markdown-v1",
    state: "verified",
    writeAttemptPublicId: `write-${suffix}`,
    verifiedAt: "2026-07-30T00:00:00.000Z",
    zeroOwnerSince: "2026-07-30T00:00:00.000Z",
    createdAt: "2026-07-30T00:00:00.000Z"
  };
}

import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketVersioningCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectVersionsCommand
} from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import {
  createS3StorageVnextVersionAwareDeletionProvider,
  createStorageVnextVersionAwareObjectDeletion,
  validateS3StorageVnextLifecycle
} from "../src/storage-vnext/ownership/version-aware-deletion.js";

const storageKey = "runs/svnext-delete/generated/object.md";

describe("storage vNext version-aware deletion and lifecycle", () => {
  it("purges exact-key versions, markers, and multipart uploads then confirms absence", async () => {
    let purged = false;
    let aborted = false;
    const send = vi.fn(async (command:
      | ListObjectVersionsCommand
      | ListMultipartUploadsCommand
      | DeleteObjectsCommand
      | AbortMultipartUploadCommand
      | HeadObjectCommand) => {
      if (command instanceof ListObjectVersionsCommand) {
        return purged
          ? { Versions: [], DeleteMarkers: [], IsTruncated: false }
          : {
              Versions: [
                { Key: storageKey, VersionId: "version-a", Size: 10 },
                { Key: `${storageKey}.neighbor`, VersionId: "neighbor", Size: 20 },
                { Key: storageKey, VersionId: "version-b", Size: 11 }
              ],
              DeleteMarkers: [
                { Key: storageKey, VersionId: "marker-a" },
                { Key: `${storageKey}.neighbor`, VersionId: "marker-neighbor" }
              ],
              IsTruncated: false
            };
      }
      if (command instanceof ListMultipartUploadsCommand) {
        return aborted
          ? { Uploads: [], IsTruncated: false }
          : {
              Uploads: [
                { Key: storageKey, UploadId: "upload-a" },
                { Key: `${storageKey}.neighbor`, UploadId: "upload-neighbor" }
              ],
              IsTruncated: false
            };
      }
      if (command instanceof DeleteObjectsCommand) {
        purged = true;
        return { Deleted: command.input.Delete?.Objects };
      }
      if (command instanceof AbortMultipartUploadCommand) {
        aborted = true;
        return {};
      }
      throw missingObject();
    });
    const provider = createS3StorageVnextVersionAwareDeletionProvider({
      client: { send } as never,
      bucket: "owned-bucket",
      prefix: "runs/svnext-delete"
    });

    await expect(provider.purge(storageKey)).resolves.toEqual({
      deletedVersions: 2,
      deletedMarkers: 1,
      abortedMultipartUploads: 1
    });
    const deletion = send.mock.calls
      .map(([command]) => command)
      .find((command) => command instanceof DeleteObjectsCommand) as DeleteObjectsCommand;
    expect(deletion.input.Delete?.Objects).toEqual([
      { Key: storageKey, VersionId: "version-a" },
      { Key: storageKey, VersionId: "version-b" },
      { Key: storageKey, VersionId: "marker-a" }
    ]);
    expect(send.mock.calls.map(([command]) => command).filter(
      (command) => command instanceof AbortMultipartUploadCommand
    )[0]?.input).toMatchObject({ Key: storageKey, UploadId: "upload-a" });
  });

  it("purges a current object when the provider does not expose object versions", async () => {
    let deleted = false;
    const send = vi.fn(async (command:
      | ListObjectVersionsCommand
      | ListMultipartUploadsCommand
      | DeleteObjectCommand
      | HeadObjectCommand) => {
      if (command instanceof ListObjectVersionsCommand) {
        throw Object.assign(new Error("ListObjectVersions not implemented"), {
          name: "NotImplemented",
          Code: "NotImplemented",
          $metadata: { httpStatusCode: 501 }
        });
      }
      if (command instanceof ListMultipartUploadsCommand) {
        return { Uploads: [], IsTruncated: false };
      }
      if (command instanceof DeleteObjectCommand) {
        deleted = true;
        return {};
      }
      if (!deleted) return { ContentLength: 10 };
      throw missingObject();
    });
    const provider = createS3StorageVnextVersionAwareDeletionProvider({
      client: { send } as never,
      bucket: "owned-bucket",
      prefix: "runs/svnext-delete"
    });

    await expect(provider.purge(storageKey)).resolves.toEqual({
      deletedVersions: 1,
      deletedMarkers: 0,
      abortedMultipartUploads: 0
    });
    expect(send.mock.calls.some(([command]) => command instanceof DeleteObjectCommand))
      .toBe(true);
  });

  it("refuses deletion while any active or rollback owner remains", async () => {
    const purge = vi.fn();
    const deletion = createStorageVnextVersionAwareObjectDeletion({
      registrations: {
        getRegistration: vi.fn(async () => ({
          objectId: "object-owned",
          storageKey,
          state: "verified"
        })),
        getClosure: vi.fn(async () => ({
          objectId: "object-owned",
          owners: [{ kind: "rollback_root" }],
          ownerCount: 1,
          graceExpiresAt: null
        })),
        markDeleting: vi.fn(),
        markDeleted: vi.fn()
      },
      provider: { purge }
    });

    await expect(deletion.deleteZeroOwner("object-owned"))
      .rejects.toMatchObject({ code: "owners_present" });
    expect(purge).not.toHaveBeenCalled();
  });

  it("marks an ownerless registration deleted only after provider confirmation", async () => {
    const markDeleting = vi.fn(async () => undefined);
    const markDeleted = vi.fn(async () => undefined);
    const getClosure = vi.fn(async () => ({
      objectId: "object-zero",
      owners: [],
      ownerCount: 0,
      graceExpiresAt: "2026-08-01T00:00:00.000Z"
    }));
    const purge = vi.fn(async () => ({
      deletedVersions: 1,
      deletedMarkers: 1,
      abortedMultipartUploads: 0
    }));
    const deletion = createStorageVnextVersionAwareObjectDeletion({
      registrations: {
        getRegistration: vi.fn(async () => ({
          objectId: "object-zero",
          storageKey,
          state: "verified"
        })),
        getClosure,
        markDeleting,
        markDeleted
      },
      provider: { purge }
    });

    await expect(deletion.deleteZeroOwner("object-zero")).resolves.toMatchObject({
      deletedVersions: 1,
      deletedMarkers: 1
    });
    expect(markDeleting).toHaveBeenCalledBefore(purge);
    expect(purge).toHaveBeenCalledBefore(markDeleted);
    expect(getClosure).toHaveBeenCalledTimes(2);
  });

  it("reconfirms provider absence when retrying an already deleted registration", async () => {
    const purge = vi.fn(async () => ({
      deletedVersions: 0,
      deletedMarkers: 0,
      abortedMultipartUploads: 0
    }));
    const markDeleting = vi.fn();
    const markDeleted = vi.fn(async () => undefined);
    const deletion = createStorageVnextVersionAwareObjectDeletion({
      registrations: {
        getRegistration: vi.fn(async () => ({
          objectId: "object-deleted",
          storageKey,
          state: "deleted"
        })),
        getClosure: vi.fn(async () => ({
          ownerCount: 0
        })),
        markDeleting,
        markDeleted
      },
      provider: { purge }
    });

    await expect(deletion.deleteZeroOwner("object-deleted")).resolves.toEqual({
      deletedVersions: 0,
      deletedMarkers: 0,
      abortedMultipartUploads: 0
    });
    expect(markDeleting).not.toHaveBeenCalled();
    expect(purge).toHaveBeenCalledOnce();
    expect(markDeleted).toHaveBeenCalledOnce();
  });

  it("requires enabled versioning and bounded lifecycle rules for the exact prefix", async () => {
    const validClient = {
      send: vi.fn(async (command: GetBucketVersioningCommand | GetBucketLifecycleConfigurationCommand) =>
        command instanceof GetBucketVersioningCommand
          ? { Status: "Enabled" }
          : {
              Rules: [{
                Status: "Enabled",
                Filter: { Prefix: "runs/svnext-delete/" },
                NoncurrentVersionExpiration: { NoncurrentDays: 7 },
                Expiration: { ExpiredObjectDeleteMarker: true },
                AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 }
              }]
            })
    };
    await expect(validateS3StorageVnextLifecycle({
      client: validClient as never,
      bucket: "owned-bucket",
      prefix: "runs/svnext-delete",
      maximumNoncurrentDays: 7,
      maximumMultipartDays: 1
    })).resolves.toEqual({ versioningEnabled: true, lifecycleValid: true });

    await expect(validateS3StorageVnextLifecycle({
      client: { send: vi.fn(async () => ({ Status: "Suspended" })) } as never,
      bucket: "owned-bucket",
      prefix: "runs/svnext-delete",
      maximumNoncurrentDays: 7,
      maximumMultipartDays: 1
    })).rejects.toMatchObject({ code: "versioning_unavailable" });
  });
});

function missingObject(): Error {
  return Object.assign(new Error("missing"), {
    name: "NotFound",
    $metadata: { httpStatusCode: 404 }
  });
}

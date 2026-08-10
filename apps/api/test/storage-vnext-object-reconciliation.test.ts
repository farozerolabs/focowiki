import {
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand
} from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import {
  createS3StorageVnextObjectInventory
} from "../src/storage-vnext/ownership/s3-object-inventory.js";
import {
  reconcileStorageVnextProviderInventoryPage,
  reconcileStorageVnextRegistrationPage
} from "../src/storage-vnext/ownership/object-reconciliation.js";
import type { StorageVnextObjectRegistration } from
  "../src/storage-vnext/ownership/ports.js";

describe("storage vNext provider inventory and object reconciliation", () => {
  it("pages current objects, versions, delete markers, and multipart uploads separately", async () => {
    const send = vi.fn(async (command:
      | ListObjectsV2Command
      | ListObjectVersionsCommand
      | ListMultipartUploadsCommand) => {
      if (command instanceof ListObjectsV2Command) {
        return { Contents: [{ Key: "runs/svnext-inventory/a.md", Size: 10 }], IsTruncated: false };
      }
      if (command instanceof ListObjectVersionsCommand) {
        return {
          Versions: [{
            Key: "runs/svnext-inventory/a.md",
            VersionId: "version-old",
            IsLatest: false,
            Size: 9
          }],
          DeleteMarkers: [{
            Key: "runs/svnext-inventory/deleted.md",
            VersionId: "marker-1",
            IsLatest: true
          }],
          IsTruncated: false
        };
      }
      return {
        Uploads: [{
          Key: "runs/svnext-inventory/upload.md",
          UploadId: "upload-1",
          Initiated: new Date("2026-08-01T00:00:00.000Z")
        }],
        IsTruncated: false
      };
    });
    const inventory = createS3StorageVnextObjectInventory({
      client: { send } as never,
      bucket: "owned-bucket",
      prefix: "runs/svnext-inventory"
    });

    const current = await inventory.listPage({ limit: 10, cursor: null });
    const versions = await inventory.listPage({ limit: 10, cursor: current.nextCursor });
    const multipart = await inventory.listPage({ limit: 10, cursor: versions.nextCursor });

    expect(current.items).toEqual([expect.objectContaining({ kind: "current", byteCount: 10 })]);
    expect(versions.items.map((item) => item.kind)).toEqual(["version", "delete_marker"]);
    expect(multipart.items).toEqual([expect.objectContaining({
      kind: "multipart",
      uploadId: "upload-1"
    })]);
    expect(multipart.nextCursor).toBeNull();
    expect(send.mock.calls.map(([command]) => command.constructor.name)).toEqual([
      "ListObjectsV2Command",
      "ListObjectVersionsCommand",
      "ListMultipartUploadsCommand"
    ]);
  });

  it("continues to multipart inventory when object versions are unsupported", async () => {
    const send = vi.fn(async (command:
      | ListObjectsV2Command
      | ListObjectVersionsCommand
      | ListMultipartUploadsCommand) => {
      if (command instanceof ListObjectsV2Command) {
        return {
          Contents: [{ Key: "runs/svnext-inventory/current.md", Size: 12 }],
          IsTruncated: false
        };
      }
      if (command instanceof ListObjectVersionsCommand) {
        throw Object.assign(new Error("ListObjectVersions not implemented"), {
          name: "NotImplemented",
          Code: "NotImplemented",
          $metadata: { httpStatusCode: 501 }
        });
      }
      return { Uploads: [], IsTruncated: false };
    });
    const inventory = createS3StorageVnextObjectInventory({
      client: { send } as never,
      bucket: "owned-bucket",
      prefix: "runs/svnext-inventory"
    });

    const current = await inventory.listPage({ limit: 10, cursor: null });
    const versions = await inventory.listPage({ limit: 10, cursor: current.nextCursor });
    const multipart = await inventory.listPage({ limit: 10, cursor: versions.nextCursor });

    expect(current.items).toEqual([
      expect.objectContaining({ kind: "current", storageKey: "runs/svnext-inventory/current.md" })
    ]);
    expect(versions.items).toEqual([]);
    expect(versions.nextCursor).not.toBeNull();
    expect(multipart).toEqual({ items: [], nextCursor: null });
  });

  it("classifies missing registration, inactive registration, zero owner, old versions, markers, and multipart", async () => {
    const verified = registration("verified", "runs/svnext-inventory/owned.md");
    const reserved = registration("reserved", "runs/svnext-inventory/reserved.md");
    const result = await reconcileStorageVnextProviderInventoryPage({
      provider: {
        listPage: vi.fn(async () => ({
          items: [
            { kind: "current" as const, storageKey: "runs/svnext-inventory/orphan.md", byteCount: 1 },
            { kind: "current" as const, storageKey: reserved.storageKey, byteCount: 1 },
            { kind: "current" as const, storageKey: verified.storageKey, byteCount: 1 },
            { kind: "version" as const, storageKey: verified.storageKey, versionId: "old", isLatest: false, byteCount: 1 },
            { kind: "delete_marker" as const, storageKey: verified.storageKey, versionId: "marker", isLatest: true, byteCount: 0 as const },
            { kind: "multipart" as const, storageKey: verified.storageKey, uploadId: "upload", initiatedAt: "2026-08-01T00:00:00.000Z", byteCount: 0 as const }
          ],
          nextCursor: null
        })),
        headCurrent: vi.fn()
      },
      registrations: {
        getRegistrationsByStorageKeys: vi.fn(async () => [reserved, verified]),
        getClosure: vi.fn(async (objectId: string) => ({
          objectId,
          owners: [],
          ownerCount: 0,
          referenceCount: 0,
          graceExpiresAt: "2026-08-01T00:00:00.000Z"
        }))
      },
      graceElapsedAt: "2026-08-02T00:00:00.000Z",
      limit: 10,
      cursor: null
    });

    expect(new Set(result.findings.map((finding) => finding.issue))).toEqual(new Set([
      "missing_registration",
      "inactive_registration",
      "zero_owner",
      "noncurrent_version",
      "delete_marker",
      "incomplete_multipart"
    ]));
  });

  it("finds verified registrations whose current provider bytes are missing", async () => {
    const verified = registration("verified", "runs/svnext-inventory/missing.md");
    const result = await reconcileStorageVnextRegistrationPage({
      provider: {
        listPage: vi.fn(),
        headCurrent: vi.fn(async () => false)
      },
      registrations: {
        listRegistrations: vi.fn(async () => ({ items: [verified], nextCursor: null })),
        getClosure: vi.fn(async () => ({
          objectId: verified.objectId,
          owners: [{ publicId: "owner", knowledgeBaseId: "kb", objectId: verified.objectId,
            kind: "source_revision" as const, ownerPublicId: "revision", createdAt: "2026-08-01T00:00:00.000Z" }],
          ownerCount: 1,
          referenceCount: 1,
          graceExpiresAt: null
        }))
      },
      limit: 10,
      cursor: null
    });

    expect(result.findings).toEqual([expect.objectContaining({
      issue: "missing_bytes",
      objectId: verified.objectId
    })]);
  });
});

function registration(
  state: "reserved" | "verified",
  storageKey: string
): StorageVnextObjectRegistration {
  const suffix = state === "verified" ? "b" : "c";
  return {
    objectId: `object-${suffix}`,
    storageKey,
    checksum: suffix.repeat(64),
    byteCount: 1,
    contentType: "text/markdown; charset=utf-8",
    format: "source-markdown-v1",
    state,
    writeAttemptPublicId: `write-${suffix}`,
    verifiedAt: state === "verified" ? "2026-07-30T00:00:00.000Z" : null,
    zeroOwnerSince: state === "verified" ? "2026-07-30T00:00:00.000Z" : null,
    createdAt: "2026-07-30T00:00:00.000Z"
  };
}

import { describe, expect, it, vi } from "vitest";
import { S3StorageAdapter } from "../src/storage/s3.js";
import { createStorageKeyspace } from "../src/storage/keys.js";

describe("S3 storage adapter", () => {
  it("deletes objects in unique non-empty batches no larger than 1000 keys", async () => {
    const send = vi.fn(async () => ({}));
    const storage = new S3StorageAdapter({
      bucket: "bucket-test",
      keyspace: createStorageKeyspace("tenant/test"),
      client: { send } as never
    });

    await storage.deleteObjects([
      "",
      "objects/a.md",
      "objects/a.md",
      ...Array.from({ length: 1_001 }, (_value, index) => `objects/${index}.md`)
    ]);

    expect(send).toHaveBeenCalledTimes(2);
    const calls = send.mock.calls as unknown as Array<[{ input?: unknown }]>;
    const firstCommand = calls[0]?.[0];
    const secondCommand = calls[1]?.[0];

    if (!firstCommand || !secondCommand) {
      throw new Error("Expected two S3 batch delete commands");
    }
    const firstInput = firstCommand.input as {
      Bucket: string;
      Delete: { Objects: Array<{ Key: string }>; Quiet: boolean };
    };
    const secondInput = secondCommand.input as {
      Bucket: string;
      Delete: { Objects: Array<{ Key: string }>; Quiet: boolean };
    };

    expect(firstInput.Bucket).toBe("bucket-test");
    expect(firstInput.Delete.Quiet).toBe(true);
    expect(firstInput.Delete.Objects).toHaveLength(1_000);
    expect(secondInput.Delete.Objects).toHaveLength(2);
    expect(firstInput.Delete.Objects.map((object) => object.Key)).not.toContain("");
    expect([
      ...firstInput.Delete.Objects.map((object) => object.Key),
      ...secondInput.Delete.Objects.map((object) => object.Key)
    ]).toHaveLength(1_002);
  });

  it("deletes object versions and delete markers for exact keys", async () => {
    const send = vi.fn(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === "ListObjectVersionsCommand") {
        return {
          Versions: [
            { Key: "objects/a.md", VersionId: "version-a-1" },
            { Key: "objects/other.md", VersionId: "version-other" }
          ],
          DeleteMarkers: [{ Key: "objects/a.md", VersionId: "marker-a-1" }],
          IsTruncated: false
        };
      }

      return {};
    });
    const storage = new S3StorageAdapter({
      bucket: "bucket-test",
      keyspace: createStorageKeyspace("tenant/test"),
      client: { send } as never
    });

    await storage.deleteObjectVersions(["objects/a.md"]);

    expect(send).toHaveBeenCalledTimes(2);
    const deleteCommand = (send.mock.calls as unknown as Array<[{ input?: unknown }]>)[1]?.[0];

    if (!deleteCommand) {
      throw new Error("Expected one S3 version delete command");
    }

    const deleteInput = deleteCommand.input as {
      Bucket: string;
      Delete: { Objects: Array<{ Key: string; VersionId: string }>; Quiet: boolean };
    };

    expect(deleteInput.Bucket).toBe("bucket-test");
    expect(deleteInput.Delete.Quiet).toBe(true);
    expect(deleteInput.Delete.Objects).toEqual([
      { Key: "objects/a.md", VersionId: "version-a-1" },
      { Key: "objects/a.md", VersionId: "marker-a-1" }
    ]);
  });

  it("purges versioned and current objects under a prefix before verifying emptiness", async () => {
    let versionListCount = 0;
    let objectListCount = 0;
    const send = vi.fn(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === "ListObjectVersionsCommand") {
        versionListCount += 1;
        if (versionListCount === 1) {
          return {
            Versions: [{ Key: "tenant/knowledge-bases/a/page.md", VersionId: "v1" }],
            DeleteMarkers: [{ Key: "tenant/knowledge-bases/a/old.md", VersionId: "m1" }],
            IsTruncated: true,
            NextKeyMarker: "tenant/knowledge-bases/a/page.md",
            NextVersionIdMarker: "v1"
          };
        }
        if (versionListCount === 2) {
          return {
            Versions: [{ Key: "tenant/knowledge-bases/b/page.md", VersionId: "v2" }],
            IsTruncated: false
          };
        }
        return { Versions: [], DeleteMarkers: [], IsTruncated: false };
      }
      if (command.constructor.name === "ListObjectsV2Command") {
        objectListCount += 1;
        if (objectListCount === 1) {
          return {
            Contents: [{ Key: "tenant/knowledge-bases/a/page.md" }],
            IsTruncated: true,
            NextContinuationToken: "next"
          };
        }
        if (objectListCount === 2) {
          return {
            Contents: [{ Key: "tenant/knowledge-bases/b/page.md" }],
            IsTruncated: false
          };
        }
        return { Contents: [], IsTruncated: false };
      }
      return {};
    });
    const storage = new S3StorageAdapter({
      bucket: "bucket-test",
      keyspace: createStorageKeyspace("tenant/test"),
      client: { send } as never
    });

    await expect(storage.purgePrefix("tenant/knowledge-bases/"))
      .resolves.toEqual({ deleted: 5, remaining: 0 });

    const calls = send.mock.calls as unknown as Array<[{ constructor: { name: string }; input: unknown }]>;
    const deletedObjects = calls
      .filter(([command]) => command.constructor.name === "DeleteObjectsCommand")
      .flatMap(([command]) => (command.input as {
        Delete: { Objects: Array<{ Key: string; VersionId?: string }> };
      }).Delete.Objects);
    expect(deletedObjects).toEqual([
      { Key: "tenant/knowledge-bases/a/page.md", VersionId: "v1" },
      { Key: "tenant/knowledge-bases/a/old.md", VersionId: "m1" },
      { Key: "tenant/knowledge-bases/b/page.md", VersionId: "v2" },
      { Key: "tenant/knowledge-bases/a/page.md" },
      { Key: "tenant/knowledge-bases/b/page.md" }
    ]);
  });

  it("falls back to current-object cleanup when version listing is unsupported", async () => {
    let objectListCount = 0;
    const send = vi.fn(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === "ListObjectVersionsCommand") {
        throw Object.assign(new Error("ListObjectVersions not implemented"), {
          name: "NotImplemented",
          Code: "NotImplemented",
          $metadata: { httpStatusCode: 501 }
        });
      }
      if (command.constructor.name === "ListObjectsV2Command") {
        objectListCount += 1;
        return objectListCount === 1
          ? {
              Contents: [{ Key: "tenant/knowledge-bases/a/page.md" }],
              IsTruncated: false
            }
          : { Contents: [], IsTruncated: false };
      }
      return {};
    });
    const storage = new S3StorageAdapter({
      bucket: "bucket-test",
      keyspace: createStorageKeyspace("tenant/test"),
      client: { send } as never
    });

    await expect(storage.purgePrefix("tenant/knowledge-bases/"))
      .resolves.toEqual({ deleted: 1, remaining: 0 });
    const calls = send.mock.calls as unknown as Array<[{ constructor: { name: string } }]>;
    expect(calls.some(([command]) => command.constructor.name === "DeleteObjectsCommand")).toBe(true);
  });
});

import { Readable } from "node:stream";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { describe, expect, it, vi } from "vitest";
import {
  S3_HTTP_TIMEOUTS,
  S3StorageAdapter,
  createS3ClientConfig
} from "../src/storage/s3.js";
import { createStorageKeyspace } from "../src/storage/keys.js";

describe("S3 storage adapter", () => {
  it("bounds connection, request, and idle time for every S3-compatible provider", () => {
    const config = createS3ClientConfig({
      endpoint: "https://storage.example.com",
      region: "auto",
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
      forcePathStyle: true
    } as never);

    expect(config.requestHandler).toBeInstanceOf(NodeHttpHandler);
    expect(S3_HTTP_TIMEOUTS).toEqual({
      connectionTimeout: 10_000,
      requestTimeout: 60_000,
      socketTimeout: 60_000,
      throwOnRequestTimeout: true
    });
  });

  it("sends the declared content length for streaming writes", async () => {
    const send = vi.fn(async () => ({}));
    const storage = new S3StorageAdapter({
      bucket: "bucket-test",
      keyspace: createStorageKeyspace("tenant/test"),
      client: { send } as never
    });

    await storage.putStreamObject({
      key: "objects/source.md",
      body: Readable.from([Buffer.from("# Heading\nBody")]),
      contentLength: 14,
      contentType: "text/markdown; charset=utf-8"
    });

    const command = (send.mock.calls as unknown as Array<[{ input?: unknown }]>)[0]?.[0];
    expect(command?.input).toEqual({
      Bucket: "bucket-test",
      Key: "objects/source.md",
      Body: expect.anything(),
      ContentLength: 14,
      ContentType: "text/markdown; charset=utf-8"
    });
  });

  it("checks storage health with one bounded read under the configured prefix", async () => {
    const send = vi.fn(async () => ({ Contents: [] }));
    const storage = new S3StorageAdapter({
      bucket: "bucket-test",
      keyspace: createStorageKeyspace("tenant/test"),
      client: { send } as never
    });

    await expect(storage.checkHealth()).resolves.toBeUndefined();

    expect(send).toHaveBeenCalledOnce();
    const command = (send.mock.calls as unknown as Array<[{ constructor: { name: string }; input: unknown }]>)[0]?.[0];
    expect(command?.constructor.name).toBe("ListObjectsV2Command");
    expect(command?.input).toEqual({
      Bucket: "bucket-test",
      Prefix: "tenant/test/",
      MaxKeys: 1
    });
  });

  it("reads immutable object bytes with a strict size bound", async () => {
    const send = vi.fn(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === "GetObjectCommand") {
        return { Body: Uint8Array.from([1, 2, 3, 4]) };
      }
      return {};
    });
    const storage = new S3StorageAdapter({
      bucket: "bucket-test",
      keyspace: createStorageKeyspace("tenant/test"),
      client: { send } as never
    });

    await expect(storage.getObjectBytes("objects/value.bin", { maxBytes: 4 }))
      .resolves.toEqual(Uint8Array.from([1, 2, 3, 4]));
    await expect(storage.getObjectBytes("objects/value.bin", { maxBytes: 3 }))
      .rejects.toBeInstanceOf(Error);
  });

  it("reads bounded text with one GET request", async () => {
    const send = vi.fn(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === "GetObjectCommand") {
        return {
          Body: Uint8Array.from(Buffer.from("# Heading\nBody")),
          ContentLength: 14
        };
      }
      return {};
    });
    const storage = new S3StorageAdapter({
      bucket: "bucket-test",
      keyspace: createStorageKeyspace("tenant/test"),
      client: { send } as never
    });

    await expect(storage.getObjectText("objects/value.md", { maxBytes: 14 }))
      .resolves.toBe("# Heading\nBody");

    expect(send).toHaveBeenCalledOnce();
    const command = (send.mock.calls as unknown as Array<[
      { constructor: { name: string } }
    ]>)[0]?.[0];
    expect(command?.constructor.name).toBe("GetObjectCommand");
  });

  it("stops a bounded text stream when the response exceeds its limit", async () => {
    async function* body(): AsyncGenerator<Uint8Array> {
      yield Uint8Array.from([1, 2]);
      yield Uint8Array.from([3, 4]);
    }
    const send = vi.fn(async () => ({ Body: body() }));
    const storage = new S3StorageAdapter({
      bucket: "bucket-test",
      keyspace: createStorageKeyspace("tenant/test"),
      client: { send } as never
    });

    await expect(storage.getObjectText("objects/value.md", { maxBytes: 3 }))
      .rejects.toMatchObject({
        name: "StorageObjectTooLargeError",
        key: "objects/value.md",
        maxBytes: 3
      });
    expect(send).toHaveBeenCalledOnce();
  });

  it("lists bounded object metadata pages without loading the managed prefix", async () => {
    const send = vi.fn(async () => ({
      Contents: [
        {
          Key: `tenant/test/generated/v1/objects/aa/${"a".repeat(64)}`,
          Size: 42,
          ETag: '"etag-a"',
          LastModified: new Date("2026-07-18T00:00:00.000Z")
        }
      ],
      NextContinuationToken: "next-page"
    }));
    const storage = new S3StorageAdapter({
      bucket: "bucket-test",
      keyspace: createStorageKeyspace("tenant/test"),
      client: { send } as never
    });

    await expect(storage.listObjectMetadata({
      prefix: "tenant/test/generated/",
      continuationToken: "current-page",
      limit: 5_000
    })).resolves.toEqual({
      objects: [{
        key: `tenant/test/generated/v1/objects/aa/${"a".repeat(64)}`,
        sizeBytes: 42,
        etag: '"etag-a"',
        lastModified: "2026-07-18T00:00:00.000Z"
      }],
      nextContinuationToken: "next-page"
    });

    const command = (send.mock.calls as unknown as Array<[{ input: unknown }]>)[0]![0];
    expect(command.input).toEqual({
      Bucket: "bucket-test",
      Prefix: "tenant/test/generated/",
      ContinuationToken: "current-page",
      MaxKeys: 1_000
    });
  });

  it("treats a compatible HEAD NotFound response as a missing object", async () => {
    const notFound = Object.assign(new Error("Object not found"), {
      name: "NotFound",
      $metadata: { httpStatusCode: 404 }
    });
    const storage = new S3StorageAdapter({
      bucket: "bucket-test",
      keyspace: createStorageKeyspace("tenant/test"),
      client: { send: vi.fn().mockRejectedValue(notFound) } as never
    });

    await expect(storage.headObjectMetadata("objects/missing.md")).resolves.toBeNull();
  });

  it("does not hide non-missing HEAD failures", async () => {
    const forbidden = Object.assign(new Error("Access denied"), {
      name: "AccessDenied",
      $metadata: { httpStatusCode: 403 }
    });
    const storage = new S3StorageAdapter({
      bucket: "bucket-test",
      keyspace: createStorageKeyspace("tenant/test"),
      client: { send: vi.fn().mockRejectedValue(forbidden) } as never
    });

    await expect(storage.headObjectMetadata("objects/protected.md"))
      .rejects.toBe(forbidden);
  });

  it.each([
    "tenant/other/generated/",
    "tenant/test/../other/generated/",
    "tenant/test/%2e%2e/other/generated/",
    "/tenant/test/generated/"
  ])("rejects object metadata listing outside the configured keyspace: %s", async (prefix) => {
    const send = vi.fn(async () => ({ Contents: [] }));
    const storage = new S3StorageAdapter({
      bucket: "bucket-test",
      keyspace: createStorageKeyspace("tenant/test"),
      client: { send } as never
    });

    await expect(storage.listObjectMetadata({ prefix, limit: 100 })).rejects.toThrow(
      "Storage listing prefix must stay within the configured keyspace"
    );
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    "tenant/other/",
    "tenant/test/../other/",
    "tenant/test/%2e%2e/other/",
    "/tenant/test/"
  ])("rejects prefix purges outside the configured keyspace: %s", async (prefix) => {
    const send = vi.fn(async () => ({ Contents: [] }));
    const storage = new S3StorageAdapter({
      bucket: "bucket-test",
      keyspace: createStorageKeyspace("tenant/test"),
      client: { send } as never
    });

    await expect(storage.purgePrefix(prefix)).rejects.toThrow(
      "Storage listing prefix must stay within the configured keyspace"
    );
    expect(send).not.toHaveBeenCalled();
  });

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

  it("falls back to current-object deletion when version listing is unsupported", async () => {
    const send = vi.fn(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === "ListObjectVersionsCommand") {
        throw Object.assign(new Error("ListObjectVersions not implemented"), {
          name: "NotImplemented",
          Code: "NotImplemented",
          $metadata: { httpStatusCode: 501 }
        });
      }
      return {};
    });
    const storage = new S3StorageAdapter({
      bucket: "bucket-test",
      keyspace: createStorageKeyspace("tenant/test"),
      client: { send } as never
    });

    await expect(storage.deleteObjectVersions([
      "tenant/test/objects/a.md",
      "tenant/test/objects/b.md"
    ])).resolves.toBeUndefined();

    expect(send.mock.calls.map(([command]) => command.constructor.name)).toEqual([
      "ListObjectVersionsCommand",
      "DeleteObjectsCommand"
    ]);
    const deletion = send.mock.calls[1]?.[0] as unknown as {
      input: { Delete: { Objects: Array<{ Key: string }> } };
    };
    expect(deletion.input.Delete.Objects).toEqual([
      { Key: "tenant/test/objects/a.md" },
      { Key: "tenant/test/objects/b.md" }
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
      keyspace: createStorageKeyspace("tenant"),
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
      keyspace: createStorageKeyspace("tenant"),
      client: { send } as never
    });

    await expect(storage.purgePrefix("tenant/knowledge-bases/"))
      .resolves.toEqual({ deleted: 1, remaining: 0 });
    const calls = send.mock.calls as unknown as Array<[{ constructor: { name: string } }]>;
    expect(calls.some(([command]) => command.constructor.name === "DeleteObjectsCommand")).toBe(true);
  });
});

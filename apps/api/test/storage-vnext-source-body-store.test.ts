import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createS3StorageVnextSourceBodyStore,
  StorageVnextSourceBodyStoreError
} from "../src/storage-vnext/catalog/s3-source-body-store.js";

describe("storage vNext S3 source body store", () => {
  it("stores Markdown at one provider-compatible content-addressed key", async () => {
    const bytes = new TextEncoder().encode("# Current source\n");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    let stored = false;
    const send = vi.fn(async (command: HeadObjectCommand | PutObjectCommand) => {
      if (command instanceof HeadObjectCommand) {
        if (!stored) throw missingObject();
        return {
          ContentLength: bytes.byteLength,
          ContentType: "text/markdown;charset=utf-8",
          Metadata: {
            "checksum-sha256": checksum,
            "object-format": "source-markdown-v1"
          }
        };
      }
      stored = true;
      return {};
    });
    const store = createS3StorageVnextSourceBodyStore({
      client: { send } as never,
      bucket: "owned-bucket",
      prefix: "runs/svnext-catalog01"
    });

    await expect(store.putVerified({
      bytes,
      contentType: "text/markdown; charset=utf-8"
    })).resolves.toEqual({
      outcome: "stored",
      objectId: `source-sha256:${checksum}`,
      storageKey: `runs/svnext-catalog01/source-objects/sha256/${checksum.slice(0, 2)}/${checksum}.md`,
      checksum,
      byteCount: bytes.byteLength,
      contentType: "text/markdown; charset=utf-8",
      objectFormat: "source-markdown-v1"
    });

    const put = send.mock.calls
      .map(([command]) => command)
      .find((command) => command instanceof PutObjectCommand) as PutObjectCommand;
    expect(put.input).toMatchObject({
      Bucket: "owned-bucket",
      Key: `runs/svnext-catalog01/source-objects/sha256/${checksum.slice(0, 2)}/${checksum}.md`,
      Body: bytes,
      ContentType: "text/markdown; charset=utf-8",
      Metadata: {
        "checksum-sha256": checksum,
        "object-format": "source-markdown-v1"
      }
    });
    expect(put.input.IfNoneMatch).toBeUndefined();
  });

  it("reuses verified identical bytes without issuing another object write", async () => {
    const bytes = new TextEncoder().encode("same body");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    let stored = false;
    const send = vi.fn(async (command: HeadObjectCommand | PutObjectCommand) => {
      if (command instanceof PutObjectCommand) {
        stored = true;
        return {};
      }
      if (!stored) throw missingObject();
      return {
        ContentLength: bytes.byteLength,
        ContentType: "text/markdown; charset=utf-8",
        Metadata: {
          "checksum-sha256": checksum,
          "object-format": "source-markdown-v1"
        }
      };
    });
    const store = createS3StorageVnextSourceBodyStore({
      client: { send } as never,
      bucket: "owned-bucket",
      prefix: "runs/svnext-catalog01"
    });

    const first = await store.putVerified({
      bytes,
      contentType: "text/markdown; charset=utf-8"
    });
    const second = await store.putVerified({
      bytes,
      contentType: "text/markdown; charset=utf-8"
    });

    expect(first.outcome).toBe("stored");
    expect(second.outcome).toBe("reused");
    expect(second.objectId).toBe(first.objectId);
    expect(send.mock.calls.filter(([command]) => command instanceof PutObjectCommand))
      .toHaveLength(1);
  });

  it("streams upload bytes through one provider-compatible content-addressed write", async () => {
    const bytes = new TextEncoder().encode("# Streamed upload\n中文 body");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    let stored = false;
    let uploaded = Buffer.alloc(0);
    const send = vi.fn(async (command: HeadObjectCommand | PutObjectCommand) => {
      if (command instanceof HeadObjectCommand) {
        if (!stored) throw missingObject();
        return {
          ContentLength: bytes.byteLength,
          ContentType: "text/markdown; charset=utf-8",
          Metadata: {
            "checksum-sha256": checksum,
            "object-format": "source-markdown-v1"
          }
        };
      }
      const chunks: Uint8Array[] = [];
      for await (const chunk of command.input.Body as AsyncIterable<Uint8Array>) {
        chunks.push(chunk);
      }
      uploaded = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
      stored = true;
      return {};
    });
    const store = createS3StorageVnextSourceBodyStore({
      client: { send } as never,
      bucket: "owned-bucket",
      prefix: "runs/svnext-upload01"
    });

    await expect(store.putVerifiedStream({
      body: chunks(bytes, 5),
      checksum,
      byteCount: bytes.byteLength,
      contentType: "text/markdown; charset=utf-8"
    })).resolves.toMatchObject({
      outcome: "stored",
      objectId: `source-sha256:${checksum}`,
      checksum,
      byteCount: bytes.byteLength
    });
    expect(uploaded).toEqual(Buffer.from(bytes));
    const put = send.mock.calls.map(([command]) => command)
      .find((command) => command instanceof PutObjectCommand) as PutObjectCommand;
    expect(put.input.Body).not.toBeInstanceOf(Uint8Array);
    expect(put.input.ContentLength).toBe(bytes.byteLength);
    expect(put.input.IfNoneMatch).toBeUndefined();
  });

  it("consumes and verifies a replay stream while reusing the existing object", async () => {
    const bytes = new TextEncoder().encode("identical streamed upload");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    let consumedBytes = 0;
    const send = vi.fn(async (_command: HeadObjectCommand | PutObjectCommand) => ({
      ContentLength: bytes.byteLength,
      ContentType: "text/markdown; charset=utf-8",
      Metadata: {
        "checksum-sha256": checksum,
        "object-format": "source-markdown-v1"
      }
    }));
    const store = createS3StorageVnextSourceBodyStore({
      client: { send } as never,
      bucket: "owned-bucket",
      prefix: "runs/svnext-upload01"
    });

    await expect(store.putVerifiedStream({
      body: (async function* () {
        consumedBytes += bytes.byteLength;
        yield bytes;
      })(),
      checksum,
      byteCount: bytes.byteLength,
      contentType: "text/markdown; charset=utf-8"
    })).resolves.toMatchObject({ outcome: "reused" });
    expect(consumedBytes).toBe(bytes.byteLength);
    expect(send.mock.calls.some(([command]) => command instanceof PutObjectCommand)).toBe(false);
  });

  it("rejects incompatible existing bytes and bounded reads larger than the caller limit", async () => {
    const bytes = new TextEncoder().encode("expected");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const incompatible = createS3StorageVnextSourceBodyStore({
      client: {
        send: vi.fn(async () => ({
          ContentLength: bytes.byteLength + 1,
          ContentType: "text/markdown; charset=utf-8",
          Metadata: {
            "checksum-sha256": checksum,
            "object-format": "source-markdown-v1"
          }
        }))
      } as never,
      bucket: "owned-bucket",
      prefix: "runs/svnext-catalog01"
    });
    await expect(incompatible.putVerified({
      bytes,
      contentType: "text/markdown; charset=utf-8"
    })).rejects.toMatchObject({ code: "object_verification_failed" });

    const oversized = createS3StorageVnextSourceBodyStore({
      client: {
        send: vi.fn(async (command: HeadObjectCommand | GetObjectCommand) =>
          command instanceof HeadObjectCommand
            ? {
                ContentLength: 100,
                ContentType: "text/markdown; charset=utf-8",
                Metadata: {
                  "checksum-sha256": checksum,
                  "object-format": "source-markdown-v1"
                }
              }
            : { Body: { transformToByteArray: async () => bytes } })
      } as never,
      bucket: "owned-bucket",
      prefix: "runs/svnext-catalog01"
    });
    await expect(oversized.readVerified({
      objectId: `source-sha256:${checksum}`,
      checksum,
      byteCount: 100,
      contentType: "text/markdown; charset=utf-8",
      maxBytes: 10
    })).rejects.toBeInstanceOf(StorageVnextSourceBodyStoreError);
  });

  it("streams verified source bytes without materializing the complete S3 body", async () => {
    const bytes = new TextEncoder().encode("# Streamed source\n中文 evidence");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const transformToByteArray = vi.fn();
    const destroy = vi.fn();
    const body = {
      transformToByteArray,
      destroy,
      async *[Symbol.asyncIterator]() {
        yield bytes.slice(0, 7);
        yield bytes.slice(7, 13);
        yield bytes.slice(13);
      }
    };
    const store = createS3StorageVnextSourceBodyStore({
      client: {
        send: vi.fn(async (command: HeadObjectCommand | GetObjectCommand) =>
          command instanceof HeadObjectCommand
            ? {
                ContentLength: bytes.byteLength,
                ContentType: "text/markdown; charset=utf-8",
                Metadata: {
                  "checksum-sha256": checksum,
                  "object-format": "source-markdown-v1"
                }
              }
            : { Body: body })
      } as never,
      bucket: "owned-bucket",
      prefix: "runs/svnext-catalog01"
    });

    const chunks: Uint8Array[] = [];
    const stream = await store.readVerifiedStream({
      objectId: `source-sha256:${checksum}`,
      checksum,
      byteCount: bytes.byteLength,
      contentType: "text/markdown; charset=utf-8",
      maxBytes: 1_000
    });
    for await (const chunk of stream) chunks.push(chunk);

    expect(Buffer.concat(chunks)).toEqual(Buffer.from(bytes));
    expect(transformToByteArray).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("rejects a streamed body whose bytes do not match verified metadata", async () => {
    const expected = new TextEncoder().encode("expected source");
    const actual = new TextEncoder().encode("modified source");
    const checksum = createHash("sha256").update(expected).digest("hex");
    const destroy = vi.fn();
    const body = {
      destroy,
      async *[Symbol.asyncIterator]() {
        yield actual;
      }
    };
    const store = createS3StorageVnextSourceBodyStore({
      client: {
        send: vi.fn(async (command: HeadObjectCommand | GetObjectCommand) =>
          command instanceof HeadObjectCommand
            ? {
                ContentLength: expected.byteLength,
                ContentType: "text/markdown; charset=utf-8",
                Metadata: {
                  "checksum-sha256": checksum,
                  "object-format": "source-markdown-v1"
                }
              }
            : {
                Body: body
              })
      } as never,
      bucket: "owned-bucket",
      prefix: "runs/svnext-catalog01"
    });

    const stream = await store.readVerifiedStream({
      objectId: `source-sha256:${checksum}`,
      checksum,
      byteCount: expected.byteLength,
      contentType: "text/markdown; charset=utf-8",
      maxBytes: 1_000
    });
    await expect((async () => {
      for await (const _chunk of stream) {
        // Consume the complete verified stream.
      }
    })()).rejects.toMatchObject({ code: "object_verification_failed" });
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("keeps source Markdown and repeated metadata/path facts out of PostgreSQL", () => {
    const migration = readFileSync(
      resolve(import.meta.dirname, "../migrations/001_storage_vnext.sql"),
      "utf8"
    );
    const revisions = migration.match(
      /CREATE TABLE focowiki\.source_revisions \([\s\S]*?\n\);/u
    )?.[0] ?? "";
    expect(revisions).not.toMatch(/\b(body|markdown|metadata|logical_path|normalized_path)\b/u);
    expect(revisions).toContain("checksum_sha256");
    expect(revisions).toContain("byte_count");
    expect(revisions).toContain("content_type");
    expect(revisions).toContain("object_id");
  });
});

function missingObject(): Error {
  return Object.assign(new Error("missing"), {
    name: "NotFound",
    $metadata: { httpStatusCode: 404 }
  });
}


async function* chunks(bytes: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    yield bytes.slice(offset, Math.min(offset + size, bytes.byteLength));
  }
}

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client
} from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createS3EmbeddingArtifactStore } from "../src/semantic/infrastructure/s3-embedding-artifact-store.js";
import { encodeVectorArtifact } from "../src/semantic/embedding/vector-artifact-codec.js";

describe("S3-compatible embedding artifact store", () => {
  it.each(["path-style-local", "virtual-hosted-remote"])(
    "performs immutable write, reuse, bounded read, and delete through %s transport",
    async () => {
      const client = new MemoryS3Client();
      const store = createS3EmbeddingArtifactStore({
        client: client as unknown as S3Client,
        bucket: "knowledge-artifacts",
        prefix: "focowiki"
      });
      const encoded = encodeVectorArtifact({ vector: [0.1, 0.2, 0.3], normalization: "none" });
      const descriptor = store.describe(encoded.bytes);
      expect(descriptor.storageKey).toMatch(/^focowiki\/semantic-objects\/semantic-vector-v1\/sha256\//u);
      await expect(store.putVerified({ descriptor, bytes: encoded.bytes })).resolves.toBe("stored");
      await expect(store.putVerified({ descriptor, bytes: encoded.bytes })).resolves.toBe("reused");
      await expect(store.readVerified({ descriptor, maximumBytes: descriptor.byteCount }))
        .resolves.toEqual(encoded.bytes);
      await expect(store.readVerified({ descriptor, maximumBytes: descriptor.byteCount - 1 }))
        .rejects.toThrow("bound");
      await store.deleteIfUnowned({ descriptor });
      await expect(store.readVerified({ descriptor, maximumBytes: descriptor.byteCount }))
        .rejects.toThrow("unavailable");
    }
  );

  it("rejects mismatched remote metadata and partial bodies", async () => {
    const client = new MemoryS3Client();
    const store = createS3EmbeddingArtifactStore({
      client: client as unknown as S3Client,
      bucket: "knowledge-artifacts",
      prefix: "focowiki"
    });
    const encoded = encodeVectorArtifact({ vector: [1, 2], normalization: "none" });
    const descriptor = store.describe(encoded.bytes);
    client.objects.set(descriptor.storageKey, {
      bytes: Buffer.from([1]),
      contentType: descriptor.contentType,
      metadata: { "checksum-sha256": descriptor.checksumSha256, "object-format": descriptor.objectFormat }
    });
    await expect(store.readVerified({ descriptor, maximumBytes: descriptor.byteCount }))
      .rejects.toThrow("metadata");
  });
});

class MemoryS3Client {
  readonly objects = new Map<string, {
    bytes: Buffer;
    contentType: string;
    metadata: Record<string, string>;
  }>();

  async send(command: unknown): Promise<unknown> {
    if (command instanceof HeadObjectCommand) {
      const object = this.objects.get(command.input.Key!);
      if (!object) throw missing();
      return { ContentLength: object.bytes.byteLength, ContentType: object.contentType, Metadata: object.metadata };
    }
    if (command instanceof PutObjectCommand) {
      const key = command.input.Key!;
      expect(command.input.IfNoneMatch).toBeUndefined();
      if (this.objects.has(key)) {
        const error = new Error("precondition");
        error.name = "PreconditionFailed";
        throw error;
      }
      const bytes = await consume(command.input.Body as AsyncIterable<Uint8Array>);
      this.objects.set(key, {
        bytes,
        contentType: command.input.ContentType!,
        metadata: command.input.Metadata!
      });
      return {};
    }
    if (command instanceof GetObjectCommand) {
      const object = this.objects.get(command.input.Key!);
      if (!object) throw missing();
      return {
        ContentLength: object.bytes.byteLength,
        ContentType: object.contentType,
        Metadata: object.metadata,
        Body: Readable.from([object.bytes.subarray(0, 3), object.bytes.subarray(3)])
      };
    }
    if (command instanceof DeleteObjectCommand) {
      this.objects.delete(command.input.Key!);
      return {};
    }
    throw new Error("unsupported command");
  }
}

async function consume(body: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function missing(): Error {
  const error = new Error("missing");
  error.name = "NotFound";
  return error;
}

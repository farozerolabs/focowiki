import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type {
  EmbeddingArtifactDescriptor,
  EmbeddingArtifactStorePort
} from "../embedding/artifact-ports.js";
import { EmbeddingArtifactObjectUnavailableError } from
  "../embedding/artifact-ports.js";

const CONTENT_TYPE = "application/octet-stream";
const OBJECT_FORMAT = "semantic-vector-v1";
const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/u;

export function createS3EmbeddingArtifactStore(input: {
  client: S3Client;
  bucket: string;
  prefix: string;
}): EmbeddingArtifactStorePort {
  const bucket = requireBucket(input.bucket);
  const prefix = requirePrefix(input.prefix);
  return {
    describe(bytes) {
      if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
        throw new Error("Embedding artifact bytes are invalid");
      }
      const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
      return {
        objectId: `semantic-sha256:${OBJECT_FORMAT}:${checksumSha256}`,
        storageKey: `${prefix}/semantic-objects/${OBJECT_FORMAT}/sha256/${
          checksumSha256.slice(0, 2)
        }/${checksumSha256}.bin`,
        checksumSha256,
        byteCount: bytes.byteLength,
        contentType: CONTENT_TYPE,
        objectFormat: OBJECT_FORMAT
      };
    },
    async putVerified(request) {
      assertDescriptor(request.descriptor);
      if (
        !(request.bytes instanceof Uint8Array)
        || request.bytes.byteLength !== request.descriptor.byteCount
        || createHash("sha256").update(request.bytes).digest("hex")
          !== request.descriptor.checksumSha256
      ) throw new Error("Embedding artifact write integrity validation failed");
      const existing = await head(input.client, bucket, request.descriptor.storageKey);
      if (existing) {
        assertMetadata(existing, request.descriptor);
        return "reused";
      }
      let outcome: "stored" | "reused" = "stored";
      try {
        await input.client.send(new PutObjectCommand({
          Bucket: bucket,
          Key: request.descriptor.storageKey,
          Body: Readable.from([request.bytes]),
          ContentLength: request.descriptor.byteCount,
          ContentType: CONTENT_TYPE,
          IfNoneMatch: "*",
          Metadata: {
            "checksum-sha256": request.descriptor.checksumSha256,
            "object-format": OBJECT_FORMAT
          },
          ...(request.signal ? { AbortSignal: request.signal } : {})
        }));
      } catch (error) {
        if (!isPreconditionFailure(error)) throw error;
        outcome = "reused";
      }
      const verified = await head(input.client, bucket, request.descriptor.storageKey);
      if (!verified) throw new Error("Embedding artifact object is unavailable after write");
      assertMetadata(verified, request.descriptor);
      return outcome;
    },
    async readVerified(request) {
      assertDescriptor(request.descriptor);
      if (
        !Number.isInteger(request.maximumBytes)
        || request.maximumBytes <= 0
        || request.descriptor.byteCount > request.maximumBytes
      ) throw new Error("Embedding artifact read bound is invalid");
      const metadata = await head(input.client, bucket, request.descriptor.storageKey);
      if (!metadata) throw new EmbeddingArtifactObjectUnavailableError();
      assertMetadata(metadata, request.descriptor);
      const response = await getObject(
        input.client,
        bucket,
        request.descriptor.storageKey,
        request.signal
      );
      if (!response.Body || !isAsyncIterable(response.Body)) {
        throw new Error("Embedding artifact body is unavailable");
      }
      const chunks: Buffer[] = [];
      const hash = createHash("sha256");
      let total = 0;
      try {
        for await (const value of response.Body) {
          if (request.signal?.aborted) {
            throw request.signal.reason ?? new DOMException("Embedding artifact read aborted", "AbortError");
          }
          if (!(value instanceof Uint8Array)) {
            throw new Error("Embedding artifact body chunk is invalid");
          }
          total += value.byteLength;
          if (total > request.maximumBytes || total > request.descriptor.byteCount) {
            throw new Error("Embedding artifact body exceeds its bound");
          }
          hash.update(value);
          chunks.push(Buffer.from(value));
        }
      } finally {
        destroyBody(response.Body);
      }
      if (
        total !== request.descriptor.byteCount
        || hash.digest("hex") !== request.descriptor.checksumSha256
      ) throw new Error("Embedding artifact read integrity validation failed");
      return Buffer.concat(chunks, total);
    },
    async deleteIfUnowned(request) {
      assertDescriptor(request.descriptor);
      await input.client.send(new DeleteObjectCommand({
        Bucket: bucket,
        Key: request.descriptor.storageKey,
        ...(request.signal ? { AbortSignal: request.signal } : {})
      }));
    }
  };
}

async function getObject(
  client: S3Client,
  bucket: string,
  key: string,
  signal: AbortSignal | undefined
) {
  try {
    return await client.send(new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ...(signal ? { AbortSignal: signal } : {})
    }));
  } catch (error) {
    if (isMissing(error)) throw new EmbeddingArtifactObjectUnavailableError();
    throw error;
  }
}

async function head(client: S3Client, bucket: string, key: string) {
  try {
    return await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function assertDescriptor(value: EmbeddingArtifactDescriptor): void {
  if (
    !value.objectId
    || !value.storageKey
    || !CHECKSUM_PATTERN.test(value.checksumSha256)
    || !Number.isSafeInteger(value.byteCount)
    || value.byteCount <= 0
    || value.contentType !== CONTENT_TYPE
    || value.objectFormat !== OBJECT_FORMAT
  ) throw new Error("Embedding artifact descriptor is invalid");
}

function assertMetadata(
  metadata: {
    ContentLength?: number | undefined;
    ContentType?: string | undefined;
    Metadata?: Record<string, string> | undefined;
  },
  descriptor: EmbeddingArtifactDescriptor
): void {
  if (
    Number(metadata.ContentLength ?? -1) !== descriptor.byteCount
    || metadata.ContentType !== descriptor.contentType
    || metadata.Metadata?.["checksum-sha256"] !== descriptor.checksumSha256
    || metadata.Metadata?.["object-format"] !== descriptor.objectFormat
  ) throw new Error("Embedding artifact metadata verification failed");
}

function requireBucket(value: string): string {
  if (!value || value !== value.trim() || value.length > 255) {
    throw new Error("Embedding artifact bucket is invalid");
  }
  return value;
}

function requirePrefix(value: string): string {
  if (
    !value
    || value !== value.trim()
    || value.startsWith("/")
    || value.endsWith("/")
    || value.split("/").some((segment) =>
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(segment))
  ) throw new Error("Embedding artifact prefix is invalid");
  return value;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value;
}

function destroyBody(value: unknown): void {
  if (typeof value === "object" && value !== null && "destroy" in value) {
    (value as { destroy(): void }).destroy();
  }
}

function isMissing(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = "$metadata" in error
    ? (error.$metadata as { httpStatusCode?: number }).httpStatusCode
    : undefined;
  return ["NotFound", "NoSuchKey"].includes(error.name) || status === 404;
}

function isPreconditionFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = "$metadata" in error
    ? (error.$metadata as { httpStatusCode?: number }).httpStatusCode
    : undefined;
  return error.name === "PreconditionFailed" || status === 412;
}

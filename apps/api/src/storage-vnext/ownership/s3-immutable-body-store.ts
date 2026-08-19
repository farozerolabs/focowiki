import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { areContentTypesEquivalent } from "../../storage/content-type.js";
import {
  assertStorageVnextImmutableObjectDescriptor,
  describeStorageVnextImmutableObject,
  type StorageVnextImmutableObjectDescriptor,
  type StorageVnextImmutableObjectFormat
} from "./content-address.js";

export type StorageVnextImmutableBodyWriteResult =
  & StorageVnextImmutableObjectDescriptor
  & {
    outcome: "stored" | "reused";
    requests: {
      put: number;
      head: number;
      verification: number;
      attemptedBytes: number;
      retries: number;
      latencyMilliseconds: number;
    };
  };

export type StorageVnextImmutableBodyStore = {
  describe(input: {
    bytes: Uint8Array;
    objectFormat: StorageVnextImmutableObjectFormat;
  }): StorageVnextImmutableObjectDescriptor;
  putVerified(input: {
    descriptor: StorageVnextImmutableObjectDescriptor;
    bytes: Uint8Array;
    signal?: AbortSignal;
  }): Promise<StorageVnextImmutableBodyWriteResult>;
  verify(input: {
    descriptor: StorageVnextImmutableObjectDescriptor;
    signal?: AbortSignal;
  }): Promise<void>;
  readVerified(input: {
    descriptor: StorageVnextImmutableObjectDescriptor;
    maximumBytes: number;
    signal?: AbortSignal;
  }): Promise<Uint8Array>;
};

export type StorageVnextImmutableBodyStoreErrorCode =
  | "invalid_input"
  | "object_missing"
  | "object_verification_failed";

export class StorageVnextImmutableBodyStoreError extends Error {
  public constructor(public readonly code: StorageVnextImmutableBodyStoreErrorCode) {
    super(`Storage vNext immutable body store error: ${code}`);
    this.name = "StorageVnextImmutableBodyStoreError";
  }
}

export function createS3StorageVnextImmutableBodyStore(input: {
  client: S3Client;
  bucket: string;
  prefix: string;
}): StorageVnextImmutableBodyStore {
  const bucket = requireBucket(input.bucket);
  const prefix = input.prefix;
  return {
    describe(request) {
      return describeStorageVnextImmutableObject({ prefix, ...request });
    },

    async putVerified(request) {
      assertWriteRequest(request);
      const startedAt = performance.now();
      await input.client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: request.descriptor.storageKey,
        Body: Readable.from([request.bytes]),
        ContentLength: request.descriptor.byteCount,
        ContentType: request.descriptor.contentType,
        Metadata: {
          "checksum-sha256": request.descriptor.checksum,
          "object-format": request.descriptor.objectFormat
        },
        ...(request.signal ? { AbortSignal: request.signal } : {})
      }));
      return {
        ...request.descriptor,
        outcome: "stored",
        requests: {
          put: 1,
          head: 0,
          verification: 0,
          attemptedBytes: request.descriptor.byteCount,
          retries: 0,
          latencyMilliseconds: Math.max(0, performance.now() - startedAt)
        }
      };
    },

    async verify(request) {
      assertStorageVnextImmutableObjectDescriptor(request.descriptor);
      const metadata = await readMetadata(
        input.client,
        bucket,
        request.descriptor.storageKey
      );
      if (!metadata) throw new StorageVnextImmutableBodyStoreError("object_missing");
      assertMetadata(metadata, request.descriptor);
    },

    async readVerified(request) {
      assertStorageVnextImmutableObjectDescriptor(request.descriptor);
      if (
        !Number.isSafeInteger(request.maximumBytes)
        || request.maximumBytes < 1
        || request.descriptor.byteCount > request.maximumBytes
      ) throw new StorageVnextImmutableBodyStoreError("invalid_input");
      const metadata = await readMetadata(
        input.client,
        bucket,
        request.descriptor.storageKey
      );
      if (!metadata) throw new StorageVnextImmutableBodyStoreError("object_missing");
      assertMetadata(metadata, request.descriptor);
      const response = await input.client.send(new GetObjectCommand({
        Bucket: bucket,
        Key: request.descriptor.storageKey,
        ...(request.signal ? { AbortSignal: request.signal } : {})
      }));
      if (!response.Body) throw new StorageVnextImmutableBodyStoreError("object_missing");
      const bytes = await response.Body.transformToByteArray();
      if (
        bytes.byteLength !== request.descriptor.byteCount
        || createHash("sha256").update(bytes).digest("hex") !== request.descriptor.checksum
      ) throw new StorageVnextImmutableBodyStoreError("object_verification_failed");
      return bytes;
    }
  };
}

function assertWriteRequest(input: {
  descriptor: StorageVnextImmutableObjectDescriptor;
  bytes: Uint8Array;
}): void {
  assertStorageVnextImmutableObjectDescriptor(input.descriptor);
  if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength !== input.descriptor.byteCount) {
    throw new StorageVnextImmutableBodyStoreError("invalid_input");
  }
}

async function readMetadata(client: S3Client, bucket: string, storageKey: string) {
  try {
    return await client.send(new HeadObjectCommand({ Bucket: bucket, Key: storageKey }));
  } catch (error) {
    if (isMissingObject(error)) return null;
    throw error;
  }
}

function assertMetadata(
  metadata: {
    ContentLength?: number | undefined;
    ContentType?: string | undefined;
    Metadata?: Record<string, string> | undefined;
  },
  descriptor: StorageVnextImmutableObjectDescriptor
): void {
  if (
    Number(metadata.ContentLength ?? -1) !== descriptor.byteCount
    || !areContentTypesEquivalent(metadata.ContentType, descriptor.contentType)
    || metadata.Metadata?.["checksum-sha256"] !== descriptor.checksum
    || metadata.Metadata?.["object-format"] !== descriptor.objectFormat
  ) {
    throw new StorageVnextImmutableBodyStoreError("object_verification_failed");
  }
}

function requireBucket(value: string): string {
  const bucket = value.trim();
  if (!bucket || bucket !== value || bucket.length > 255) {
    throw new StorageVnextImmutableBodyStoreError("invalid_input");
  }
  return bucket;
}

function isMissingObject(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = "$metadata" in error
    ? (error.$metadata as { httpStatusCode?: number }).httpStatusCode
    : undefined;
  return error.name === "NotFound" || error.name === "NoSuchKey" || status === 404;
}

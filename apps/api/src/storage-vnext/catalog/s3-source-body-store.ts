import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { areContentTypesEquivalent } from "../../storage/content-type.js";

const SOURCE_CONTENT_TYPE = "text/markdown; charset=utf-8";
const SOURCE_OBJECT_FORMAT = "source-markdown-v1";
const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/u;
const PREFIX_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/u;

export type StorageVnextVerifiedSourceBody = {
  outcome: "stored" | "reused";
  objectId: string;
  storageKey: string;
  checksum: string;
  byteCount: number;
  contentType: typeof SOURCE_CONTENT_TYPE;
  objectFormat: typeof SOURCE_OBJECT_FORMAT;
};

export type StorageVnextSourceBodyReadRequest = {
  objectId: string;
  checksum: string;
  byteCount: number;
  contentType: string;
  maxBytes: number;
  signal?: AbortSignal;
};

export type StorageVnextSourceBodyReadPort = {
  readVerifiedStream(
    request: StorageVnextSourceBodyReadRequest
  ): Promise<AsyncIterable<Uint8Array>>;
};

export type StorageVnextSourceBodyStreamWriteRequest = {
  body: AsyncIterable<Uint8Array>;
  checksum: string;
  byteCount: number;
  contentType: string;
  signal?: AbortSignal;
};

export type StorageVnextSourceBodyStoreErrorCode =
  | "invalid_input"
  | "object_missing"
  | "object_verification_failed"
  | "object_too_large"
  | "body_unavailable";

export class StorageVnextSourceBodyStoreError extends Error {
  public constructor(public readonly code: StorageVnextSourceBodyStoreErrorCode) {
    super(`Storage vNext source body store error: ${code}`);
    this.name = "StorageVnextSourceBodyStoreError";
  }
}

export function createS3StorageVnextSourceBodyStore(input: {
  client: S3Client;
  bucket: string;
  prefix: string;
}) {
  const bucket = requireBucket(input.bucket);
  const prefix = requirePrefix(input.prefix);

  return {
    describeExpected(request: {
      checksum: string;
      byteCount: number;
      contentType: string;
    }): Omit<StorageVnextVerifiedSourceBody, "outcome"> {
      assertExpectedWrite(request);
      const identity = sourceBodyIdentity(prefix, request.checksum);
      return {
        ...identity,
        byteCount: request.byteCount,
        contentType: SOURCE_CONTENT_TYPE,
        objectFormat: SOURCE_OBJECT_FORMAT
      };
    },

    async putVerified(request: {
      bytes: Uint8Array;
      contentType: string;
    }): Promise<StorageVnextVerifiedSourceBody> {
      if (!(request.bytes instanceof Uint8Array) || request.contentType !== SOURCE_CONTENT_TYPE) {
        throw new StorageVnextSourceBodyStoreError("invalid_input");
      }
      const checksum = checksumBytes(request.bytes);
      const identity = sourceBodyIdentity(prefix, checksum);
      const existing = await headObject(input.client, bucket, identity.storageKey);
      if (existing) {
        assertVerifiedMetadata(existing, {
          checksum,
          byteCount: request.bytes.byteLength,
          contentType: SOURCE_CONTENT_TYPE
        });
        return descriptor(identity, request.bytes.byteLength, "reused");
      }

      await input.client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: identity.storageKey,
        Body: request.bytes,
        ContentType: SOURCE_CONTENT_TYPE,
        Metadata: {
          "checksum-sha256": checksum,
          "object-format": SOURCE_OBJECT_FORMAT
        }
      }));

      const verified = await headObject(input.client, bucket, identity.storageKey);
      if (!verified) throw new StorageVnextSourceBodyStoreError("object_missing");
      assertVerifiedMetadata(verified, {
        checksum,
        byteCount: request.bytes.byteLength,
        contentType: SOURCE_CONTENT_TYPE
      });
      return descriptor(identity, request.bytes.byteLength, "stored");
    },

    async putVerifiedStream(
      request: StorageVnextSourceBodyStreamWriteRequest
    ): Promise<StorageVnextVerifiedSourceBody> {
      assertExpectedWrite(request);
      const identity = sourceBodyIdentity(prefix, request.checksum);
      const expected = {
        checksum: request.checksum,
        byteCount: request.byteCount,
        contentType: SOURCE_CONTENT_TYPE
      };
      const existing = await headObject(
        input.client, bucket, identity.storageKey, request.signal
      );
      if (existing) {
        assertVerifiedMetadata(existing, expected);
        await consumeVerifiedUploadStream(request);
        return descriptor(identity, request.byteCount, "reused");
      }

      await input.client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: identity.storageKey,
        Body: Readable.from(verifyUploadStream(request)),
        ContentLength: request.byteCount,
        ContentType: SOURCE_CONTENT_TYPE,
        Metadata: {
          "checksum-sha256": request.checksum,
          "object-format": SOURCE_OBJECT_FORMAT
        }
      }), request.signal ? { abortSignal: request.signal } : undefined);
      const verified = await headObject(
        input.client, bucket, identity.storageKey, request.signal
      );
      if (!verified) throw new StorageVnextSourceBodyStoreError("object_missing");
      assertVerifiedMetadata(verified, expected);
      return descriptor(identity, request.byteCount, "stored");
    },

    async readVerified(request: StorageVnextSourceBodyReadRequest): Promise<Uint8Array> {
      assertReadRequest(request);
      const identity = sourceBodyIdentity(prefix, request.checksum);
      if (request.objectId !== identity.objectId) {
        throw new StorageVnextSourceBodyStoreError("object_verification_failed");
      }
      if (request.byteCount > request.maxBytes) {
        throw new StorageVnextSourceBodyStoreError("object_too_large");
      }
      const response = await getObject(
        input.client, bucket, identity.storageKey, request.signal
      );
      assertVerifiedMetadata(response, request);
      if (Number(response.ContentLength ?? 0) > request.maxBytes) {
        throw new StorageVnextSourceBodyStoreError("object_too_large");
      }
      if (!response.Body) throw new StorageVnextSourceBodyStoreError("body_unavailable");
      const bytes = await response.Body.transformToByteArray();
      if (bytes.byteLength !== request.byteCount || checksumBytes(bytes) !== request.checksum) {
        throw new StorageVnextSourceBodyStoreError("object_verification_failed");
      }
      return bytes;
    },

    async readVerifiedStream(
      request: StorageVnextSourceBodyReadRequest
    ): Promise<AsyncIterable<Uint8Array>> {
      assertReadRequest(request);
      const identity = sourceBodyIdentity(prefix, request.checksum);
      if (request.objectId !== identity.objectId) {
        throw new StorageVnextSourceBodyStoreError("object_verification_failed");
      }
      if (request.byteCount > request.maxBytes) {
        throw new StorageVnextSourceBodyStoreError("object_too_large");
      }
      const response = await getObject(
        input.client, bucket, identity.storageKey, request.signal
      );
      assertVerifiedMetadata(response, request);
      if (Number(response.ContentLength ?? 0) > request.maxBytes) {
        throw new StorageVnextSourceBodyStoreError("object_too_large");
      }
      if (!response.Body || !isAsyncIterable(response.Body)) {
        throw new StorageVnextSourceBodyStoreError("body_unavailable");
      }
      return verifySourceBodyStream(response.Body, request);
    }
  };
}

async function* verifySourceBodyStream(
  body: AsyncIterable<unknown>,
  expected: StorageVnextSourceBodyReadRequest
): AsyncGenerator<Uint8Array> {
  const hash = createHash("sha256");
  let byteCount = 0;
  try {
    for await (const value of body) {
      if (expected.signal?.aborted) {
        throw expected.signal.reason ?? new StorageVnextSourceBodyStoreError("body_unavailable");
      }
      if (!(value instanceof Uint8Array)) {
        throw new StorageVnextSourceBodyStoreError("body_unavailable");
      }
      byteCount += value.byteLength;
      if (byteCount > expected.byteCount || byteCount > expected.maxBytes) {
        throw new StorageVnextSourceBodyStoreError("object_verification_failed");
      }
      hash.update(value);
      yield value;
    }
    if (byteCount !== expected.byteCount || hash.digest("hex") !== expected.checksum) {
      throw new StorageVnextSourceBodyStoreError("object_verification_failed");
    }
  } finally {
    destroyBody(body);
  }
}

function destroyBody(body: AsyncIterable<unknown>): void {
  const destroy = (body as { destroy?: () => void }).destroy;
  if (typeof destroy === "function") destroy.call(body);
}

async function consumeVerifiedUploadStream(
  request: StorageVnextSourceBodyStreamWriteRequest
): Promise<void> {
  for await (const _chunk of verifyUploadStream(request)) {
    // Consume the request stream so the caller can release its transport resources.
  }
}

async function* verifyUploadStream(
  request: StorageVnextSourceBodyStreamWriteRequest
): AsyncGenerator<Uint8Array> {
  const hash = createHash("sha256");
  let byteCount = 0;
  for await (const chunk of request.body) {
    if (request.signal?.aborted) {
      throw request.signal.reason ?? new StorageVnextSourceBodyStoreError("body_unavailable");
    }
    if (!(chunk instanceof Uint8Array)) {
      throw new StorageVnextSourceBodyStoreError("body_unavailable");
    }
    byteCount += chunk.byteLength;
    if (byteCount > request.byteCount) {
      throw new StorageVnextSourceBodyStoreError("object_verification_failed");
    }
    hash.update(chunk);
    yield chunk;
  }
  if (byteCount !== request.byteCount || hash.digest("hex") !== request.checksum) {
    throw new StorageVnextSourceBodyStoreError("object_verification_failed");
  }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === "object"
    && value !== null
    && Symbol.asyncIterator in value
    && typeof value[Symbol.asyncIterator] === "function";
}

function sourceBodyIdentity(prefix: string, checksum: string): {
  objectId: string;
  storageKey: string;
  checksum: string;
} {
  if (!CHECKSUM_PATTERN.test(checksum)) {
    throw new StorageVnextSourceBodyStoreError("invalid_input");
  }
  return {
    objectId: `source-sha256:${checksum}`,
    storageKey: `${prefix}/source-objects/sha256/${checksum.slice(0, 2)}/${checksum}.md`,
    checksum
  };
}

function assertExpectedWrite(input: {
  checksum: string;
  byteCount: number;
  contentType: string;
}): void {
  if (
    !CHECKSUM_PATTERN.test(input.checksum)
    || !Number.isSafeInteger(input.byteCount)
    || input.byteCount < 0
    || input.contentType !== SOURCE_CONTENT_TYPE
  ) throw new StorageVnextSourceBodyStoreError("invalid_input");
}

function descriptor(
  identity: ReturnType<typeof sourceBodyIdentity>,
  byteCount: number,
  outcome: StorageVnextVerifiedSourceBody["outcome"]
): StorageVnextVerifiedSourceBody {
  return {
    outcome,
    objectId: identity.objectId,
    storageKey: identity.storageKey,
    checksum: identity.checksum,
    byteCount,
    contentType: SOURCE_CONTENT_TYPE,
    objectFormat: SOURCE_OBJECT_FORMAT
  };
}

async function headObject(
  client: S3Client,
  bucket: string,
  storageKey: string,
  signal?: AbortSignal
) {
  try {
    return await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: storageKey }),
      signal ? { abortSignal: signal } : undefined
    );
  } catch (error) {
    if (isMissingObject(error)) return null;
    throw error;
  }
}

async function getObject(
  client: S3Client,
  bucket: string,
  storageKey: string,
  signal?: AbortSignal
) {
  try {
    return await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: storageKey }),
      signal ? { abortSignal: signal } : undefined
    );
  } catch (error) {
    if (isMissingObject(error)) {
      throw new StorageVnextSourceBodyStoreError("object_missing");
    }
    throw error;
  }
}

function assertVerifiedMetadata(
  metadata: {
    ContentLength?: number | undefined;
    ContentType?: string | undefined;
    Metadata?: Record<string, string> | undefined;
  },
  expected: { checksum: string; byteCount: number; contentType: string }
): void {
  if (
    Number(metadata.ContentLength ?? -1) !== expected.byteCount
    || !areContentTypesEquivalent(metadata.ContentType, expected.contentType)
    || metadata.Metadata?.["checksum-sha256"] !== expected.checksum
    || metadata.Metadata?.["object-format"] !== SOURCE_OBJECT_FORMAT
  ) {
    throw new StorageVnextSourceBodyStoreError("object_verification_failed");
  }
}

function assertReadRequest(input: {
  checksum: string;
  byteCount: number;
  contentType: string;
  maxBytes: number;
}): void {
  if (
    !CHECKSUM_PATTERN.test(input.checksum)
    || !Number.isSafeInteger(input.byteCount)
    || input.byteCount < 0
    || !Number.isSafeInteger(input.maxBytes)
    || input.maxBytes < 1
    || input.contentType !== SOURCE_CONTENT_TYPE
  ) {
    throw new StorageVnextSourceBodyStoreError("invalid_input");
  }
}

function checksumBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireBucket(value: string): string {
  const bucket = value.trim();
  if (!bucket || bucket !== value || bucket.length > 255) {
    throw new StorageVnextSourceBodyStoreError("invalid_input");
  }
  return bucket;
}

function requirePrefix(value: string): string {
  const prefix = value.trim().replace(/^\/+|\/+$/gu, "");
  const segments = prefix.split("/");
  if (
    !prefix
    || prefix !== value
    || segments.some((segment) =>
      !PREFIX_SEGMENT_PATTERN.test(segment) || segment === "." || segment === "..")
  ) {
    throw new StorageVnextSourceBodyStoreError("invalid_input");
  }
  return prefix;
}

function isMissingObject(error: unknown): boolean {
  return error instanceof Error
    && (error.name === "NotFound" || error.name === "NoSuchKey"
      || readHttpStatus(error) === 404);
}

function readHttpStatus(error: Error): number | null {
  const metadata = "$metadata" in error && error.$metadata
    && typeof error.$metadata === "object"
    ? error.$metadata as { httpStatusCode?: unknown }
    : null;
  return typeof metadata?.httpStatusCode === "number" ? metadata.httpStatusCode : null;
}

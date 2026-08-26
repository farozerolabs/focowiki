import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
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

type StorageRequestObserver = Parameters<
  typeof createS3StorageVnextImmutableBodyStore
>[0]["onRequest"];

export function createS3StorageVnextImmutableBodyStore(input: {
  client: S3Client;
  bucket: string;
  prefix: string;
  onRequest?(event: Readonly<{
    operation: "put" | "head" | "get";
    storageKey: string;
    durationMs: number;
    outcome: "completed" | "failed";
    errorCode: string | null;
    attemptCount: number;
    httpStatusCode: number | null;
  }>): void;
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
      const response = await observeRequest(
        input.onRequest, "put", request.descriptor.storageKey,
        () => input.client.send(new PutObjectCommand({
          Bucket: bucket,
          Key: request.descriptor.storageKey,
          Body: request.bytes,
          ContentLength: request.descriptor.byteCount,
          ContentType: request.descriptor.contentType,
          Metadata: {
            "checksum-sha256": request.descriptor.checksum,
            "object-format": request.descriptor.objectFormat
          }
        }), sendOptions(request.signal))
      );
      return {
        ...request.descriptor,
        outcome: "stored",
        requests: {
          put: 1,
          head: 0,
          verification: 0,
          attemptedBytes: request.descriptor.byteCount
            * requestAttemptCount(response),
          retries: Math.max(0, requestAttemptCount(response) - 1),
          latencyMilliseconds: Math.max(0, performance.now() - startedAt)
        }
      };
    },

    async verify(request) {
      assertStorageVnextImmutableObjectDescriptor(request.descriptor);
      const metadata = await readMetadata(
        input.client,
        bucket,
        request.descriptor.storageKey,
        request.signal,
        input.onRequest
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
      let response;
      try {
        response = await observeRequest(input.onRequest, "get",
          request.descriptor.storageKey,
          () => input.client.send(new GetObjectCommand({
            Bucket: bucket,
            Key: request.descriptor.storageKey
          }), sendOptions(request.signal)));
      } catch (error) {
        if (isMissingObject(error)) {
          throw new StorageVnextImmutableBodyStoreError("object_missing");
        }
        throw error;
      }
      if (!response.Body) throw new StorageVnextImmutableBodyStoreError("object_missing");
      assertMetadata(response, request.descriptor);
      let bytes: Uint8Array;
      try {
        bytes = await response.Body.transformToByteArray();
      } finally {
        destroyBody(response.Body);
      }
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

async function readMetadata(
  client: S3Client,
  bucket: string,
  storageKey: string,
  signal: AbortSignal | undefined,
  onRequest: StorageRequestObserver
) {
  try {
    return await observeRequest(onRequest, "head", storageKey,
      () => client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: storageKey }),
        sendOptions(signal)
      ));
  } catch (error) {
    if (isMissingObject(error)) return null;
    throw error;
  }
}

function sendOptions(signal: AbortSignal | undefined) {
  return signal ? { abortSignal: signal } : undefined;
}

async function observeRequest<T>(
  onRequest: StorageRequestObserver,
  operation: "put" | "head" | "get",
  storageKey: string,
  request: () => Promise<T>
): Promise<T> {
  const startedAt = performance.now();
  try {
    const result = await request();
    onRequest?.({
      operation,
      storageKey,
      durationMs: Math.max(0, performance.now() - startedAt),
      outcome: "completed",
      errorCode: null,
      attemptCount: requestAttemptCount(result),
      httpStatusCode: requestHttpStatusCode(result)
    });
    return result;
  } catch (error) {
    onRequest?.({
      operation,
      storageKey,
      durationMs: Math.max(0, performance.now() - startedAt),
      outcome: "failed",
      errorCode: requestErrorCode(error),
      attemptCount: requestAttemptCount(error),
      httpStatusCode: requestHttpStatusCode(error)
    });
    throw error;
  }
}

function requestAttemptCount(value: unknown): number {
  const metadata = requestMetadata(value);
  const attempts = metadata?.attempts;
  return Number.isSafeInteger(attempts) && Number(attempts) > 0
    ? Number(attempts) : 1;
}

function requestHttpStatusCode(value: unknown): number | null {
  const status = requestMetadata(value)?.httpStatusCode;
  return Number.isSafeInteger(status) && Number(status) >= 100
    && Number(status) <= 599 ? Number(status) : null;
}

function requestMetadata(value: unknown): Readonly<{
  attempts?: number;
  httpStatusCode?: number;
}> | null {
  if (typeof value !== "object" || value === null || !("$metadata" in value)) {
    return null;
  }
  const metadata = (value as { $metadata?: unknown }).$metadata;
  return typeof metadata === "object" && metadata !== null
    ? metadata as { attempts?: number; httpStatusCode?: number } : null;
}

function requestErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return "UNKNOWN_ERROR";
  const code = "code" in error ? error.code : null;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,128}$/u.test(code)
    ? code : error.name.replace(/[^A-Za-z0-9_]/gu, "_").slice(0, 128)
      || "UNKNOWN_ERROR";
}

function destroyBody(body: unknown): void {
  if (typeof body === "object" && body !== null && "destroy" in body
    && typeof body.destroy === "function") {
    (body as { destroy(): void }).destroy();
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

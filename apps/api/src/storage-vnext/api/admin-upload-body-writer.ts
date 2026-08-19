import {
  CopyObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client
} from "@aws-sdk/client-s3";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { UploadSessionError } from "../../domain/upload-session.js";
import { areContentTypesEquivalent } from "../../storage/content-type.js";
import type { StorageVnextVerifiedSourceBody } from "../catalog/s3-source-body-store.js";
import type { StorageVnextFailedWriteCompensation } from "../ownership/failed-write-compensation.js";
import type { StorageVnextOwnershipRepository } from "../ownership/ports.js";
import { createS3StorageVnextVersionAwareDeletionProvider } from
  "../ownership/version-aware-deletion.js";
import {
  uploadCount,
  type StorageVnextUploadEntryRow
} from "./postgres-admin-upload-session-store.js";

const MARKDOWN_CONTENT_TYPE = "text/markdown; charset=utf-8";

export type StorageVnextUploadedSourceDescriptor = {
  objectId: string;
  storageKey: string;
  checksum: string;
  byteCount: number;
  contentType: string;
  objectFormat: string;
};

export async function writeStorageVnextUploadBody(input: {
  s3: S3Client;
  bucket: string;
  prefix: string;
  registrations: StorageVnextOwnershipRepository;
  compensation: StorageVnextFailedWriteCompensation;
  describeSource(input: {
    checksum: string;
    byteCount: number;
    contentType: string;
  }): Omit<StorageVnextVerifiedSourceBody, "outcome">;
  request: {
    knowledgeBaseId: string;
    sessionId: string;
    entryId: string;
    body: ReadableStream<Uint8Array>;
  };
  entry: StorageVnextUploadEntryRow;
}): Promise<StorageVnextUploadedSourceDescriptor> {
  const temporaryKey = `${input.prefix.replace(/\/+$/gu, "")}/vnext/tmp/upload/`
    + `${input.request.sessionId}/${input.request.entryId}-${randomUUID()}`;
  let result: StorageVnextUploadedSourceDescriptor | null = null;
  let failure: unknown = null;
  try {
    result = await writeBeforeCleanup(input, temporaryKey);
  } catch (error) {
    failure = normalizeUploadWriteFailure(error);
  }

  try {
    await createS3StorageVnextVersionAwareDeletionProvider({
      client: input.s3,
      bucket: input.bucket,
      prefix: input.prefix
    }).purge(temporaryKey);
  } catch (cleanupError) {
    const cleanupFailure = normalizeUploadWriteFailure(cleanupError);
    if (failure) {
      throw new AggregateError(
        [failure, cleanupFailure],
        "Storage vNext upload and temporary-object cleanup both failed"
      );
    }
    throw cleanupFailure;
  }

  if (failure) throw failure;
  if (!result) throw new UploadSessionError("UPLOAD_ENTRY_STORAGE_FAILED");
  return result;
}

async function writeBeforeCleanup(
  input: Parameters<typeof writeStorageVnextUploadBody>[0],
  temporaryKey: string
) {
  const hash = createHash("sha256");
  let receivedBytes = 0;
  const expectedBytes = uploadCount(input.entry.byte_count);
  const source = readableStreamToAsyncIterable(input.request.body);
  const measured = async function* () {
    for await (const chunk of source) {
      receivedBytes += chunk.byteLength;
      if (receivedBytes > expectedBytes) {
        throw new UploadSessionError("UPLOAD_ENTRY_SIZE_MISMATCH");
      }
      hash.update(chunk);
      yield chunk;
    }
  };
  await input.s3.send(new PutObjectCommand({
    Bucket: input.bucket,
    Key: temporaryKey,
    Body: Readable.from(measured()),
    ContentLength: expectedBytes,
    ContentType: MARKDOWN_CONTENT_TYPE,
    Metadata: { "object-format": "upload-temporary-v1" }
  }));
  if (receivedBytes !== expectedBytes) {
    throw new UploadSessionError("UPLOAD_ENTRY_SIZE_MISMATCH");
  }
  const checksum = hash.digest("hex");
  if (input.entry.checksum_sha256 && input.entry.checksum_sha256 !== checksum) {
    throw new UploadSessionError("UPLOAD_ENTRY_CHECKSUM_MISMATCH");
  }
  const descriptor = input.describeSource({
    checksum,
    byteCount: receivedBytes,
    contentType: MARKDOWN_CONTENT_TYPE
  });
  const writeAttemptPublicId = `upload-write-${randomUUID()}`;
  const reserved = await input.registrations.reserve({
    objectId: descriptor.objectId,
    storageKey: descriptor.storageKey,
    checksum: descriptor.checksum,
    byteCount: descriptor.byteCount,
    contentType: descriptor.contentType,
    format: descriptor.objectFormat,
    writeAttemptPublicId,
    createdAt: new Date().toISOString()
  });
  if (reserved.registration.state === "verified") {
    try {
      await verifyObject(input.s3, input.bucket, descriptor);
    } catch (error) {
      if (!isMissingObject(error)) throw error;
      await copyAndVerifyObject({
        client: input.s3,
        bucket: input.bucket,
        temporaryKey,
        descriptor
      });
    }
    return descriptor;
  }
  if (reserved.registration.writeAttemptPublicId !== writeAttemptPublicId) {
    throw new UploadSessionError("UPLOAD_ENTRY_STORAGE_FAILED");
  }
  try {
    await copyAndVerifyObject({
      client: input.s3,
      bucket: input.bucket,
      temporaryKey,
      descriptor
    });
    await input.registrations.markVerified({
      objectId: descriptor.objectId,
      writeAttemptPublicId,
      checksum: descriptor.checksum,
      byteCount: descriptor.byteCount,
      contentType: descriptor.contentType,
      format: descriptor.objectFormat,
      verifiedAt: new Date().toISOString()
    });
  } catch (writeError) {
    try {
      await input.compensation.compensate({
        objectId: descriptor.objectId,
        storageKey: descriptor.storageKey,
        writeAttemptPublicId,
        reasonCode: "upload_failed",
        failedAt: new Date().toISOString()
      });
    } catch (compensationError) {
      throw new AggregateError(
        [writeError, compensationError],
        "Storage vNext upload and compensation both failed"
      );
    }
    throw writeError;
  }
  return descriptor;
}

async function copyAndVerifyObject(input: {
  client: S3Client;
  bucket: string;
  temporaryKey: string;
  descriptor: StorageVnextUploadedSourceDescriptor;
}) {
  await input.client.send(new CopyObjectCommand({
    Bucket: input.bucket,
    CopySource: `${encodeURIComponent(input.bucket)}/${input.temporaryKey
      .split("/").map(encodeURIComponent).join("/")}`,
    Key: input.descriptor.storageKey,
    MetadataDirective: "REPLACE",
    ContentType: input.descriptor.contentType,
    Metadata: {
      "checksum-sha256": input.descriptor.checksum,
      "object-format": input.descriptor.objectFormat
    }
  }));
  await verifyObject(input.client, input.bucket, input.descriptor);
}

async function verifyObject(
  client: S3Client,
  bucket: string,
  descriptor: StorageVnextUploadedSourceDescriptor
) {
  const head = await client.send(new HeadObjectCommand({
    Bucket: bucket,
    Key: descriptor.storageKey
  }));
  if (
    head.ContentLength !== descriptor.byteCount
    || !areContentTypesEquivalent(head.ContentType, descriptor.contentType)
    || head.Metadata?.["checksum-sha256"] !== descriptor.checksum
    || head.Metadata?.["object-format"] !== descriptor.objectFormat
  ) throw new Error("Storage vNext upload object verification failed");
}

async function* readableStreamToAsyncIterable(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) return;
      yield result.value;
    }
  } finally {
    reader.releaseLock();
  }
}

function isMissingObject(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const status = "$metadata" in error
    && error.$metadata
    && typeof error.$metadata === "object"
    && "httpStatusCode" in error.$metadata
    ? error.$metadata.httpStatusCode
    : null;
  return ("name" in error && ["NotFound", "NoSuchKey"].includes(String(error.name)))
    || status === 404;
}

function normalizeUploadWriteFailure(error: unknown) {
  if (error instanceof UploadSessionError || error instanceof AggregateError) return error;
  if (error && typeof error === "object" && "code" in error) return error;
  return new UploadSessionError("UPLOAD_ENTRY_STORAGE_FAILED");
}

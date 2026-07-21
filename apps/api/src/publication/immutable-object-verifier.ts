import { createHash } from "node:crypto";
import {
  IMMUTABLE_CHECKSUM_METADATA_KEY,
  IMMUTABLE_FORMAT_METADATA_KEY
} from "../domain/immutable-object-storage-identity.js";
import {
  StorageObjectTooLargeError,
  type StorageAdapter,
  type StorageObjectMetadata
} from "../storage/s3.js";

export type ImmutableObjectVerificationReason =
  | "object_missing"
  | "size_mismatch"
  | "metadata_mismatch"
  | "metadata_unavailable"
  | "content_mismatch";

export class ImmutableObjectVerificationError extends Error {
  public constructor(public readonly reason: ImmutableObjectVerificationReason) {
    super(`Immutable object upload verification failed: ${reason}`);
    this.name = "ImmutableObjectVerificationError";
  }
}

export async function verifyImmutableStorageObject(input: {
  objectKey: string;
  expected: {
    checksumSha256: string;
    formatVersion: number;
    sizeBytes: number;
  };
  storage: {
    headObjectMetadata: NonNullable<StorageAdapter["headObjectMetadata"]>;
    getObjectBytes?: NonNullable<StorageAdapter["getObjectBytes"]>;
  };
}): Promise<{ method: "metadata" | "content" }> {
  const stored = await input.storage.headObjectMetadata(input.objectKey);
  assertHeadIdentity(stored, input.expected);

  const metadata = normalizeMetadata(stored.metadata);
  const checksum = metadata[IMMUTABLE_CHECKSUM_METADATA_KEY];
  const formatVersion = metadata[IMMUTABLE_FORMAT_METADATA_KEY];
  if (checksum !== undefined && checksum.toLowerCase() !== input.expected.checksumSha256) {
    throw new ImmutableObjectVerificationError("metadata_mismatch");
  }
  if (
    formatVersion !== undefined
    && normalizeFormatVersion(formatVersion) !== String(input.expected.formatVersion)
  ) {
    throw new ImmutableObjectVerificationError("metadata_mismatch");
  }
  if (checksum !== undefined && formatVersion !== undefined) {
    return { method: "metadata" };
  }

  if (!input.storage.getObjectBytes) {
    throw new ImmutableObjectVerificationError("metadata_unavailable");
  }
  let body: Uint8Array | null;
  try {
    body = await input.storage.getObjectBytes(input.objectKey, {
      maxBytes: input.expected.sizeBytes
    });
  } catch (error) {
    if (error instanceof StorageObjectTooLargeError) {
      throw new ImmutableObjectVerificationError("content_mismatch");
    }
    throw error;
  }
  if (
    !body
    || body.byteLength !== input.expected.sizeBytes
    || createHash("sha256").update(body).digest("hex") !== input.expected.checksumSha256
  ) {
    throw new ImmutableObjectVerificationError("content_mismatch");
  }
  return { method: "content" };
}

function assertHeadIdentity(
  stored: StorageObjectMetadata | null,
  expected: { sizeBytes: number }
): asserts stored is StorageObjectMetadata {
  if (!stored) throw new ImmutableObjectVerificationError("object_missing");
  if (stored.sizeBytes !== expected.sizeBytes) {
    throw new ImmutableObjectVerificationError("size_mismatch");
  }
}

function normalizeMetadata(metadata: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [key.trim().toLowerCase(), value.trim()])
  );
}

function normalizeFormatVersion(value: string): string | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? String(parsed) : null;
}

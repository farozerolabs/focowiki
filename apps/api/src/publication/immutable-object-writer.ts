import { createHash, randomUUID } from "node:crypto";
import type {
  ActiveImmutableObjectRecord,
  ImmutableObjectRepository
} from "../application/ports/immutable-object-repository.js";
import {
  createImmutableObjectKey,
  PUBLICATION_FORMAT_VERSION
} from "../domain/generation.js";
import {
  IMMUTABLE_CHECKSUM_METADATA_KEY,
  IMMUTABLE_FORMAT_METADATA_KEY,
  matchesImmutableStorageIdentity
} from "../domain/immutable-object-storage-identity.js";
import type { StorageAdapter } from "../storage/s3.js";

export type ImmutableObjectWriteResult = Pick<
  ActiveImmutableObjectRecord,
  | "checksumSha256"
  | "formatVersion"
  | "objectKey"
  | "contentType"
  | "sizeBytes"
  | "createdAt"
  | "verifiedAt"
> & {
  reused: boolean;
};

const DEFAULT_STALE_WRITE_MS = 5 * 60_000;
const DEFAULT_PENDING_WAIT_MS = 5_000;

export function createImmutableObjectWriter(input: {
  repository: ImmutableObjectRepository;
  storage: Pick<StorageAdapter, "keyspace" | "putObject"> & {
    headObjectMetadata: NonNullable<StorageAdapter["headObjectMetadata"]>;
  };
  now?: (() => Date) | undefined;
  sleep?: ((milliseconds: number) => Promise<void>) | undefined;
  staleWriteMs?: number | undefined;
  pendingWaitMs?: number | undefined;
}) {
  const now = input.now ?? (() => new Date());
  const sleep = input.sleep ?? ((milliseconds: number) => new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  }));
  const staleWriteMs = input.staleWriteMs ?? DEFAULT_STALE_WRITE_MS;
  const pendingWaitMs = input.pendingWaitMs ?? DEFAULT_PENDING_WAIT_MS;
  return {
    async write(object: {
      body: string | Uint8Array;
      contentType: string;
      formatVersion?: number | undefined;
    }): Promise<ImmutableObjectWriteResult> {
      const body = typeof object.body === "string"
        ? Buffer.from(object.body, "utf8")
        : Buffer.from(object.body);
      const checksumSha256 = createHash("sha256").update(body).digest("hex");
      const formatVersion = object.formatVersion ?? PUBLICATION_FORMAT_VERSION;
      const objectKey = createImmutableObjectKey({
        prefix: input.storage.keyspace.prefix,
        checksumSha256,
        formatVersion
      });
      const existing = await input.repository.find({ checksumSha256, formatVersion });
      if (existing) {
        assertRegisteredObject(existing, {
          objectKey,
          contentType: object.contentType,
          sizeBytes: body.byteLength
        });
        return { ...existing, reused: true };
      }
      const writeToken = randomUUID();
      const startedAt = now();
      const expected = {
        checksumSha256,
        formatVersion,
        objectKey,
        contentType: object.contentType,
        sizeBytes: body.byteLength
      };
      const reservation = await input.repository.reserve({
        ...expected,
        writeToken,
        writeStartedAt: startedAt.toISOString(),
        staleBefore: new Date(startedAt.getTime() - staleWriteMs).toISOString()
      });
      if (reservation.status === "active") {
        const active = await input.repository.find({ checksumSha256, formatVersion });
        if (!active) throw new Error("Active immutable object reservation is unavailable");
        assertRegisteredObject(active, expected);
        return { ...active, reused: true };
      }
      if (reservation.status === "pending") {
        const active = await waitForActiveObject({
          repository: input.repository,
          identity: { checksumSha256, formatVersion },
          pendingWaitMs,
          sleep
        });
        if (!active) throw new Error("Immutable object write is already in progress");
        assertRegisteredObject(active, expected);
        return { ...active, reused: true };
      }

      try {
        await input.storage.putObject({
          key: objectKey,
          body,
          contentType: object.contentType,
          cacheControl: "public, max-age=31536000, immutable",
          metadata: {
            [IMMUTABLE_CHECKSUM_METADATA_KEY]: checksumSha256,
            [IMMUTABLE_FORMAT_METADATA_KEY]: String(formatVersion)
          }
        });
        const stored = await input.storage.headObjectMetadata(objectKey);
        assertStoredObject(stored, expected);
        const active = await input.repository.activate({
          ...expected,
          writeToken,
          verifiedAt: now().toISOString()
        });
        return { ...active, reused: false };
      } catch (error) {
        await input.repository.markWriteFailure({
          checksumSha256,
          formatVersion,
          writeToken,
          errorCode: writeErrorCode(error)
        });
        throw error;
      }
    }
  };
}

function assertRegisteredObject(
  existing: ActiveImmutableObjectRecord,
  expected: { objectKey: string; contentType: string; sizeBytes: number }
): void {
  if (
    existing.objectKey !== expected.objectKey
    || existing.contentType !== expected.contentType
    || existing.sizeBytes !== expected.sizeBytes
  ) {
    throw new Error("Immutable object identity conflicts with registered metadata");
  }
}

async function waitForActiveObject(input: {
  repository: ImmutableObjectRepository;
  identity: { checksumSha256: string; formatVersion: number };
  pendingWaitMs: number;
  sleep: (milliseconds: number) => Promise<void>;
}): Promise<ActiveImmutableObjectRecord | null> {
  const intervalMs = Math.min(100, Math.max(10, input.pendingWaitMs));
  const attempts = Math.max(1, Math.ceil(input.pendingWaitMs / intervalMs));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await input.sleep(intervalMs);
    const active = await input.repository.find(input.identity);
    if (active) return active;
  }
  return null;
}

function assertStoredObject(
  stored: Awaited<ReturnType<NonNullable<StorageAdapter["headObjectMetadata"]>>>,
  expected: {
    checksumSha256: string;
    formatVersion: number;
    contentType: string;
    sizeBytes: number;
  }
): void {
  if (!stored) throw new Error("Immutable object upload could not be verified");
  if (!matchesImmutableStorageIdentity(stored, expected)) {
    throw new Error("Immutable object upload metadata verification failed");
  }
}

function writeErrorCode(error: unknown): string {
  if (error instanceof Error && error.message.includes("verification")) {
    return "IMMUTABLE_OBJECT_VERIFICATION_FAILED";
  }
  return "IMMUTABLE_OBJECT_WRITE_FAILED";
}

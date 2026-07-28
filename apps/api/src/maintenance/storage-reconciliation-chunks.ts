import { createHash } from "node:crypto";

const MINIMUM_DATABASE_CHUNK_SIZE = 25;

export type StoragePageChunk<T> = {
  ordinal: number;
  offset: number;
  objects: T[];
};

export function planStoragePageChunks<T>(
  objects: readonly T[],
  chunkSize: number
): StoragePageChunk<T>[] {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < MINIMUM_DATABASE_CHUNK_SIZE) {
    throw new Error("Storage reconciliation database chunk size is invalid");
  }
  const chunks: StoragePageChunk<T>[] = [];
  for (let offset = 0; offset < objects.length; offset += chunkSize) {
    chunks.push({
      ordinal: chunks.length,
      offset,
      objects: objects.slice(offset, offset + chunkSize)
    });
  }
  return chunks;
}

export function createStoragePageCheckpointId(input: {
  cycleId: string;
  continuationToken: string | null;
  nextContinuationToken: string | null;
}): string {
  return createHash("sha256")
    .update(input.cycleId)
    .update("\0")
    .update(input.continuationToken ?? "")
    .update("\0")
    .update(input.nextContinuationToken ?? "")
    .digest("hex");
}

export function reduceStorageDatabaseChunkSize(currentSize: number): number {
  if (!Number.isSafeInteger(currentSize) || currentSize < MINIMUM_DATABASE_CHUNK_SIZE) {
    throw new Error("Storage reconciliation database chunk size is invalid");
  }
  return Math.max(MINIMUM_DATABASE_CHUNK_SIZE, Math.floor(currentSize / 2));
}

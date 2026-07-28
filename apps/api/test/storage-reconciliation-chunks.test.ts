import { describe, expect, it } from "vitest";
import {
  createStoragePageCheckpointId,
  planStoragePageChunks,
  reduceStorageDatabaseChunkSize
} from "../src/maintenance/storage-reconciliation-chunks.js";

describe("storage reconciliation database chunks", () => {
  it("plans stable bounded chunks without changing the storage page", () => {
    const objects = Array.from({ length: 1_000 }, (_, index) => ({
      key: `object-${index}`
    }));

    const chunks = planStoragePageChunks(objects, 100);

    expect(chunks).toHaveLength(10);
    expect(chunks[0]).toMatchObject({
      ordinal: 0,
      offset: 0,
      objects: objects.slice(0, 100)
    });
    expect(chunks.at(-1)).toMatchObject({
      ordinal: 9,
      offset: 900,
      objects: objects.slice(900)
    });
    expect(chunks.flatMap((chunk) => chunk.objects)).toEqual(objects);
  });

  it("creates a stable opaque checkpoint identity for page replay", () => {
    const first = createStoragePageCheckpointId({
      cycleId: "cycle-a",
      continuationToken: "opaque-current",
      nextContinuationToken: "opaque-next"
    });
    const replay = createStoragePageCheckpointId({
      cycleId: "cycle-a",
      continuationToken: "opaque-current",
      nextContinuationToken: "opaque-next"
    });
    const nextPage = createStoragePageCheckpointId({
      cycleId: "cycle-a",
      continuationToken: "opaque-next",
      nextContinuationToken: null
    });

    expect(first).toBe(replay);
    expect(first).not.toBe(nextPage);
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(first).not.toContain("opaque");
  });

  it("reduces retryable chunk pressure without dropping below the safe minimum", () => {
    expect(reduceStorageDatabaseChunkSize(200)).toBe(100);
    expect(reduceStorageDatabaseChunkSize(100)).toBe(50);
    expect(reduceStorageDatabaseChunkSize(50)).toBe(25);
    expect(reduceStorageDatabaseChunkSize(25)).toBe(25);
  });
});

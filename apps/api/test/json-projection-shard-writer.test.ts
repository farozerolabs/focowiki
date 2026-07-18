import { describe, expect, it, vi } from "vitest";
import { createJsonProjectionShardWriter } from "../src/publication/json-projection-shard-writer.js";

describe("JSON projection shard writer", () => {
  it("updates only one bounded shard and stages one candidate reference", async () => {
    const stageUpsert = vi.fn(async () => undefined);
    const writer = createJsonProjectionShardWriter({
      references: {
        findStagedByRef: vi.fn(async () => null),
        findActiveByRef: vi.fn(async () => ({
          knowledgeBaseId: "kb-1",
          refKind: "projection_shard",
          refKey: "search:search/v1/0001",
          fileId: "generated-file-test",
          lastChangedGenerationId: "generation-1",
          checksumSha256: "ab".repeat(32),
          formatVersion: 1,
          logicalPath: "_index/search/0001.json",
          sourceFileId: null,
          projectionShardId: "shard-old",
          objectKey: "old.json",
          contentType: "application/json",
          sizeBytes: 100
        })),
        findActiveByPath: vi.fn(async () => null),
        stageUpsert,
        stageDelete: vi.fn(async () => undefined)
      },
      shards: {
        register: vi.fn(async (record) => record)
      },
      immutableObjects: {
        write: vi.fn(async () => ({
          checksumSha256: "cd".repeat(32),
          formatVersion: 1,
          objectKey: "new.json",
          contentType: "application/json; charset=utf-8",
          sizeBytes: 200,
          createdAt: "2026-07-17T00:00:00.000Z",
          verifiedAt: "2026-07-17T00:00:00.000Z",
          reused: false
        }))
      },
      storage: {
        getObjectText: vi.fn(async () => JSON.stringify({
          records: [{ id: "a", path: "a.md" }]
        }))
      },
      maxShardBytes: 10_000
    });

    const result = await writer.apply({
      knowledgeBaseId: "kb-1",
      generationId: "generation-2",
      projectionKind: "search",
      shardKey: "search/v1/0001",
      recordId: "b",
      record: { id: "b", path: "b.md" },
      logicalPath: "_index/search/0001.json"
    });

    expect(result).toMatchObject({ deleted: false, recordCount: 2 });
    expect(stageUpsert).toHaveBeenCalledWith(expect.objectContaining({
      generationId: "generation-2",
      refKey: "search:search/v1/0001"
    }));
  });

  it("applies multiple records to one shard with one read and one immutable write", async () => {
    const getObjectText = vi.fn(async () => JSON.stringify({
      records: [{ id: "a", path: "a.md" }]
    }));
    let writtenBody = "";
    const write = vi.fn(async (input: { body: string | Uint8Array }) => {
      writtenBody = String(input.body);
      return {
      checksumSha256: "ef".repeat(32),
      formatVersion: 1,
      objectKey: "batched.json",
      contentType: "application/json; charset=utf-8",
      sizeBytes: 240,
      createdAt: "2026-07-17T00:00:00.000Z",
      verifiedAt: "2026-07-17T00:00:00.000Z",
      reused: false
      };
    });
    const writer = createJsonProjectionShardWriter({
      references: {
        findStagedByRef: vi.fn(async () => null),
        findActiveByRef: vi.fn(async () => ({
          knowledgeBaseId: "kb-1",
          refKind: "projection_shard",
          refKey: "search:search/v1/0001",
          fileId: "generated-file-test",
          lastChangedGenerationId: "generation-1",
          checksumSha256: "ab".repeat(32),
          formatVersion: 1,
          logicalPath: "_index/search/0001.json",
          sourceFileId: null,
          projectionShardId: "shard-old",
          objectKey: "old.json",
          contentType: "application/json",
          sizeBytes: 100
        })),
        findActiveByPath: vi.fn(async () => null),
        stageUpsert: vi.fn(async () => undefined),
        stageDelete: vi.fn(async () => undefined)
      },
      shards: { register: vi.fn(async (record) => record) },
      immutableObjects: { write },
      storage: { getObjectText },
      maxShardBytes: 10_000
    });

    const result = await writer.applyBatch({
      knowledgeBaseId: "kb-1",
      generationId: "generation-2",
      projectionKind: "search",
      shardKey: "search/v1/0001",
      logicalPath: "_index/search/0001.json",
      changes: [
        { recordId: "b", record: { id: "b", path: "b.md" } },
        { recordId: "c", record: { id: "c", path: "c.md" } }
      ]
    });

    expect(result.recordCount).toBe(3);
    expect(getObjectText).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(writtenBody).records.map(
      (record: { id: string }) => record.id
    )).toEqual(["a", "b", "c"]);
  });
});

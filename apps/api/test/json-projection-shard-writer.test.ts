import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createJsonProjectionShardWriter } from "../src/publication/json-projection-shard-writer.js";

describe("JSON projection shard writer", () => {
  it("updates only one bounded shard and stages one candidate reference", async () => {
    const stageUpsert = vi.fn(async () => undefined);
    const writer = createJsonProjectionShardWriter({
      references: {
        findEffectiveByRef: vi.fn(async ({ refKind }: { refKind: string }) => refKind === "projection_shard" ? ({
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
        }) : null),
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
        findEffectiveByRef: vi.fn(async ({ refKind }: { refKind: string }) => refKind === "projection_shard" ? ({
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
        }) : null),
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

  it("splits an oversized logical shard into deterministic byte-bounded parts", async () => {
    const writtenBodies: string[] = [];
    const stageUpsert = vi.fn(async (_value: Record<string, unknown>) => undefined);
    const stageDelete = vi.fn(async (_value: Record<string, unknown>) => undefined);
    const writer = createJsonProjectionShardWriter({
      references: {
        findStagedByRef: vi.fn(async () => null),
        findActiveByRef: vi.fn(async () => null),
        findActiveByPath: vi.fn(async () => null),
        stageUpsert,
        stageDelete
      },
      shards: { register: vi.fn(async (record) => record) },
      immutableObjects: {
        write: vi.fn(async ({ body }: { body: string | Uint8Array }) => {
          const serialized = String(body);
          writtenBodies.push(serialized);
          return {
            checksumSha256: Buffer.from(serialized).toString("hex").padEnd(64, "0").slice(0, 64),
            formatVersion: 1,
            objectKey: `object-${writtenBodies.length}.json`,
            contentType: "application/json; charset=utf-8",
            sizeBytes: Buffer.byteLength(serialized),
            createdAt: "2026-07-19T00:00:00.000Z",
            verifiedAt: "2026-07-19T00:00:00.000Z",
            reused: false
          };
        })
      },
      storage: { getObjectText: vi.fn(async () => null) },
      maxShardBytes: 340
    });

    const result = await writer.applyBatch({
      knowledgeBaseId: "kb-1",
      generationId: "generation-2",
      projectionKind: "search",
      shardKey: "search/v1/0001",
      logicalPath: "_index/search/0001.json",
      changes: Array.from({ length: 12 }, (_, index) => ({
        recordId: `record-${index.toString().padStart(2, "0")}`,
        record: {
          id: `record-${index.toString().padStart(2, "0")}`,
          path: `pages/document-${index}.md`,
          title: `Document ${index}`
        }
      }))
    });

    expect(result).toMatchObject({ deleted: false, recordCount: 12 });
    expect(writtenBodies.length).toBeGreaterThan(2);
    expect(writtenBodies.every((body) => Buffer.byteLength(body) <= 340)).toBe(true);
    expect(stageDelete).toHaveBeenCalledWith(expect.objectContaining({
      refKey: "search:search/v1/0001"
    }));
    expect(stageUpsert.mock.calls.some(([value]) =>
      value.refKind === "projection_partition_index"
    )).toBe(true);
    expect(stageUpsert.mock.calls.filter(([value]) =>
      value.refKind === "projection_shard"
    ).length).toBeGreaterThan(1);
  });

  it("reads and rewrites only the affected part after a shard is partitioned", async () => {
    const objects = new Map<string, string>();
    const references = new Map<string, any>();
    let objectSequence = 0;
    const getObjectText = vi.fn(async (objectKey: string) => objects.get(objectKey) ?? null);
    const write = vi.fn(async ({ body }: { body: string | Uint8Array }) => {
      const serialized = String(body);
      const checksumSha256 = createHash("sha256").update(serialized).digest("hex");
      const objectKey = `object-${++objectSequence}.json`;
      objects.set(objectKey, serialized);
      return {
        checksumSha256,
        formatVersion: 1,
        objectKey,
        contentType: "application/json; charset=utf-8",
        sizeBytes: Buffer.byteLength(serialized),
        createdAt: "2026-07-19T00:00:00.000Z",
        verifiedAt: "2026-07-19T00:00:00.000Z",
        reused: false
      };
    });
    const writer = createJsonProjectionShardWriter({
      references: {
        findStagedByRef: vi.fn(async () => null),
        findActiveByRef: vi.fn(async () => null),
        findActiveByPath: vi.fn(async () => null),
        findEffectiveByRef: vi.fn(async ({ refKind, refKey }) =>
          references.get(`${refKind}:${refKey}`) ?? null),
        stageUpsert: vi.fn(async (value) => {
          references.set(`${value.refKind}:${value.refKey}`, {
            ...value,
            lastChangedGenerationId: value.generationId,
            objectKey: [...objects.keys()].at(-1),
            contentType: "application/json; charset=utf-8",
            sizeBytes: Buffer.byteLength([...objects.values()].at(-1) ?? "")
          });
        }),
        stageDelete: vi.fn(async (value) => {
          references.delete(`${value.refKind}:${value.refKey}`);
        })
      },
      shards: { register: vi.fn(async (record) => record) },
      immutableObjects: { write },
      storage: { getObjectText },
      maxShardBytes: 340
    });
    const changes = Array.from({ length: 12 }, (_, index) => ({
      recordId: `record-${index.toString().padStart(2, "0")}`,
      record: {
        id: `record-${index.toString().padStart(2, "0")}`,
        path: `pages/document-${index}.md`,
        title: `Document ${index}`
      }
    }));
    const context = {
      knowledgeBaseId: "kb-1",
      generationId: "generation-2",
      projectionKind: "search",
      shardKey: "search/v1/0001",
      logicalPath: "_index/search/0001.json"
    };
    await writer.applyBatch({ ...context, changes });
    getObjectText.mockClear();
    write.mockClear();

    await writer.apply({
      ...context,
      recordId: "record-03",
      record: {
        id: "record-03",
        path: "pages/document-3.md",
        title: "Updated document"
      }
    });

    expect(getObjectText).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledTimes(1);
    expect([...objects.values()].every((body) => Buffer.byteLength(body) <= 340)).toBe(true);
  });

  it("expands an existing partition set when one physical part reaches the byte budget", async () => {
    const objects = new Map<string, string>();
    const references = new Map<string, any>();
    let objectSequence = 0;
    const write = vi.fn(async ({ body }: { body: string | Uint8Array }) => {
      const serialized = String(body);
      const checksumSha256 = createHash("sha256").update(serialized).digest("hex");
      const objectKey = `object-${++objectSequence}.json`;
      objects.set(objectKey, serialized);
      return {
        checksumSha256,
        formatVersion: 1,
        objectKey,
        contentType: "application/json; charset=utf-8",
        sizeBytes: Buffer.byteLength(serialized),
        createdAt: "2026-07-19T00:00:00.000Z",
        verifiedAt: "2026-07-19T00:00:00.000Z",
        reused: false
      };
    });
    const writer = createJsonProjectionShardWriter({
      references: {
        findStagedByRef: vi.fn(async () => null),
        findActiveByRef: vi.fn(async () => null),
        findActiveByPath: vi.fn(async () => null),
        findEffectiveByRef: vi.fn(async ({ refKind, refKey }) =>
          references.get(`${refKind}:${refKey}`) ?? null),
        stageUpsert: vi.fn(async (value) => {
          references.set(`${value.refKind}:${value.refKey}`, {
            ...value,
            lastChangedGenerationId: value.generationId,
            objectKey: [...objects.keys()].at(-1),
            contentType: "application/json; charset=utf-8",
            sizeBytes: Buffer.byteLength([...objects.values()].at(-1) ?? "")
          });
        }),
        stageDelete: vi.fn(async (value) => {
          references.delete(`${value.refKind}:${value.refKey}`);
        })
      },
      shards: { register: vi.fn(async (record) => record) },
      immutableObjects: { write },
      storage: {
        getObjectText: vi.fn(async (objectKey: string) => objects.get(objectKey) ?? null)
      },
      maxShardBytes: 340
    });
    const context = {
      knowledgeBaseId: "kb-1",
      generationId: "generation-2",
      projectionKind: "search",
      shardKey: "search/v1/0001",
      logicalPath: "_index/search/0001.json"
    };
    const records = (start: number, count: number) => Array.from({ length: count }, (_, offset) => {
      const index = start + offset;
      const id = `record-${index.toString().padStart(3, "0")}`;
      return {
        recordId: id,
        record: { id, path: `pages/document-${index}.md`, title: `Document ${index}` }
      };
    });

    await writer.applyBatch({ ...context, changes: records(0, 12) });
    const indexRefKey = "projection_partition_index:search:search/v1/0001";
    const firstIndexReference = references.get(indexRefKey);
    const firstPartitionCount = JSON.parse(objects.get(firstIndexReference.objectKey)!).partitionCount;

    await writer.applyBatch({ ...context, changes: records(12, 40) });

    const expandedIndexReference = references.get(indexRefKey);
    const expandedIndex = JSON.parse(objects.get(expandedIndexReference.objectKey)!);
    expect(expandedIndex.partitionCount).toBeGreaterThan(firstPartitionCount);
    expect(expandedIndex.recordCount).toBe(52);
    expect(expandedIndex.previousPartitionCounts).toEqual([]);
    for (const [key, reference] of references) {
      if (!key.startsWith("projection_shard:")) continue;
      expect(Buffer.byteLength(objects.get(reference.objectKey)!)).toBeLessThanOrEqual(340);
    }
  });
});

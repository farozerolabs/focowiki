import { describe, expect, it, vi } from "vitest";
import { createProjectionCatalogWriter } from "../src/publication/projection-catalog-writer.js";

describe("projection catalog writer", () => {
  it("publishes exact effective shard paths from durable descriptors", async () => {
    const stageUpsert = vi.fn();
    const writer = createProjectionCatalogWriter({
      catalog: {
        listEffectiveShards: vi.fn().mockResolvedValue([
          {
            projectionKind: "search",
            shardKey: "search/v1/0007",
            logicalPath: "_index/search/v1/0007.json",
            recordCount: 12
          },
          {
            projectionKind: "manifest",
            shardKey: "manifest/v1/0002",
            logicalPath: "_index/manifest/v1/0002.json",
            recordCount: 9
          }
        ])
      },
      references: {
        stageUpsert,
        stageDelete: vi.fn(),
        findActiveByPath: vi.fn(),
        findActiveByRef: vi.fn(),
        findStagedByRef: vi.fn()
      },
      immutableObjects: {
        write: vi.fn(async ({ body }) => {
          const catalog = JSON.parse(String(body));
          expect(catalog.projections.search.shards).toEqual([
            { path: "_index/search/v1/0007.json", recordCount: 12 }
          ]);
          expect(catalog.projections.manifest.shards).toEqual([
            { path: "_index/manifest/v1/0002.json", recordCount: 9 }
          ]);
          expect(catalog.projections.relatedFiles.pathTemplate)
            .toBe("_graph/by-file/{fileId}.json");
          return {
            checksumSha256: "a".repeat(64),
            formatVersion: 1,
            objectKey: "generated/catalog",
            contentType: "application/json; charset=utf-8",
            sizeBytes: 128,
            createdAt: "2026-07-17T00:00:00.000Z",
            verifiedAt: "2026-07-17T00:00:00.000Z",
            reused: false
          };
        })
      },
      maxShardDescriptors: 448
    });

    await writer.finalize({ knowledgeBaseId: "kb-1", generationId: "generation-1" });

    expect(stageUpsert).toHaveBeenCalledWith(expect.objectContaining({
      refKind: "root",
      refKey: "_index/catalog.json",
      logicalPath: "_index/catalog.json"
    }));
  });
});

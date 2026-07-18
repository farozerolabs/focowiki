import { describe, expect, it, vi } from "vitest";
import type { GenerationObjectReferenceRepository } from "../src/application/ports/generation-object-reference-repository.js";
import type { ProjectionRecordRepository } from "../src/application/ports/projection-record-repository.js";
import { createRequiredProjectionWriter } from "../src/publication/required-projection-writer.js";

describe("required projection writer", () => {
  it("writes one immutable page and keeps the direct Markdown path", async () => {
    const stageUpsert = vi.fn(async () => undefined);
    const immutableWrite = vi.fn(async () => immutableWriteResult());
    const writer = createWriter({ stageUpsert, immutableWrite });
    expect(await writer.write(impact("page"))).toEqual({
      handled: true,
      touchedShardCount: 0
    });
    expect(stageUpsert).toHaveBeenCalledWith(expect.objectContaining({
      refKind: "page",
      refKey: "source-file-1",
      logicalPath: "pages/docs/guide.md",
      sourceFileId: "source-file-1"
    }));
    expect(immutableWrite).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringContaining('description: "Deploy safely."')
    }));
  });

  it("writes a frozen source snapshot after the mutable source advances", async () => {
    const stageUpsert = vi.fn(async () => undefined);
    const immutableWrite = vi.fn(async () => immutableWriteResult());
    const writer = createWriter({ stageUpsert, immutableWrite });

    await expect(writer.write({
      ...impact("page"),
      projectionInput: sourceProjectionInput()
    })).resolves.toEqual({ handled: true, touchedShardCount: 0 });
    expect(stageUpsert).toHaveBeenCalledWith(expect.objectContaining({
      logicalPath: "pages/docs/guide.md"
    }));
  });

  it("stages searchable records with direct next-read identity", async () => {
    const recordUpsert = vi.fn(async () => undefined);
    const shardApplyBatch = vi.fn(async () => ({ deleted: false, recordCount: 1, reused: false }));
    const writer = createWriter({ recordUpsert, shardApplyBatch });
    expect(await writer.write(impact("search"))).toEqual({
      handled: true,
      touchedShardCount: 1
    });
    expect(shardApplyBatch).toHaveBeenCalledWith(expect.objectContaining({
      projectionKind: "search",
      shardKey: "search/v1/0001",
      logicalPath: "_index/search/v1/0001.json",
      changes: [expect.objectContaining({
        recordId: "source-file-1",
        record: expect.objectContaining({
          fileId: "source-file-1",
          path: "pages/docs/guide.md",
          resource: "https://docs.example.com/guide",
          timestamp: "2026-07-17T00:00:00Z",
          tags: ["operations", "current"],
          metadata: expect.objectContaining({ description: "Deploy safely." })
        })
      })]
    }));
    expect(recordUpsert).toHaveBeenCalledWith(expect.objectContaining({
      projectionKind: "search",
      recordId: "source-file-1",
      logicalPath: "pages/docs/guide.md"
    }));
  });

  it("writes accepted graph edges into the public link projection", async () => {
    const recordUpsert = vi.fn(async () => undefined);
    const shardApplyBatch = vi.fn(async () => ({ deleted: false, recordCount: 1, reused: false }));
    const writer = createWriter({ recordUpsert, shardApplyBatch });

    expect(await writer.write(graphLinkImpact())).toEqual({
      handled: true,
      touchedShardCount: 1
    });
    expect(shardApplyBatch).toHaveBeenCalledWith(expect.objectContaining({
      projectionKind: "links",
      shardKey: "links/v1/0001",
      logicalPath: "_index/links/v1/0001.json",
      changes: [{
        recordId: "edge-1",
        record: expect.objectContaining({
          path: "pages/docs/guide.md",
          from: "pages/docs/guide.md",
          to: "pages/docs/reference.md",
          label: "Reference",
          relation_type: "same_specific_subject",
          reason: "Both files explain the same deployment procedure."
        })
      }]
    }));
    expect(recordUpsert).toHaveBeenCalledWith(expect.objectContaining({
      projectionKind: "links",
      recordId: "edge-1",
      sourceFileId: "source-file-1",
      relatedSourceFileId: "source-file-2"
    }));
  });

  it("deletes graph edge records without requiring an upsert snapshot", async () => {
    const recordDelete = vi.fn(async () => undefined);
    const shardApplyBatch = vi.fn(async () => ({
      deleted: true,
      recordCount: 0,
      reused: false
    }));
    const writer = createWriter({ recordDelete, shardApplyBatch });
    const deleted = {
      ...graphLinkImpact(),
      action: "delete" as const,
      projectionInput: null
    };

    await expect(writer.write(deleted)).resolves.toEqual({
      handled: true,
      touchedShardCount: 1
    });
    expect(recordDelete).toHaveBeenCalledWith(expect.objectContaining({
      projectionKind: "links",
      recordId: "edge-1"
    }));
    expect(shardApplyBatch).toHaveBeenCalledWith(expect.objectContaining({
      changes: [{ recordId: "edge-1", record: null }]
    }));
  });

  it("batches records that share one machine projection shard", async () => {
    const shardApplyBatch = vi.fn(async () => ({
      deleted: false,
      recordCount: 2,
      reused: false
    }));
    const writer = createWriter({ shardApplyBatch });
    const second = {
      ...impact("search"),
      id: "impact-search-2",
      changeFactId: "change-2",
      sourceFileId: "source-file-2",
      sourceRevisionId: "source-revision-2",
      recordIdentity: "source-file-2"
    };

    expect(await writer.writeBatch([impact("search"), second])).toEqual({
      handled: true,
      touchedShardCount: 1
    });
    expect(shardApplyBatch).toHaveBeenCalledTimes(1);
    expect(shardApplyBatch).toHaveBeenCalledWith(expect.objectContaining({
      projectionKind: "search",
      shardKey: "search/v1/0001",
      changes: expect.arrayContaining([
        expect.objectContaining({ recordId: "source-file-1" }),
        expect.objectContaining({ recordId: "source-file-2" })
      ])
    }));
  });

  it("writes directory records into the tree projection", async () => {
    const recordUpsert = vi.fn(async () => undefined);
    const shardApplyBatch = vi.fn(async () => ({
      deleted: false,
      recordCount: 1,
      reused: false
    }));
    const writer = createWriter({ recordUpsert, shardApplyBatch });

    expect(await writer.write(directoryTreeImpact())).toEqual({
      handled: true,
      touchedShardCount: 1
    });
    expect(recordUpsert).toHaveBeenCalledWith(expect.objectContaining({
      projectionKind: "tree",
      recordId: "directory:docs",
      sourceFileId: null,
      logicalPath: "pages/docs",
      parentPath: "pages",
      payload: expect.objectContaining({
        kind: "directory",
        sourceDirectoryId: "source-directory-docs",
        directEntryCount: 2,
        directDirectoryCount: 1,
        directFileCount: 1,
        descendantFileCount: 3
      })
    }));
  });

  it("writes the synthetic pages root into the tree projection", async () => {
    const recordUpsert = vi.fn(async () => undefined);
    const shardApplyBatch = vi.fn(async () => ({
      deleted: false,
      recordCount: 1,
      reused: false
    }));
    const writer = createWriter({ recordUpsert, shardApplyBatch });

    expect(await writer.write(rootDirectoryTreeImpact())).toEqual({
      handled: true,
      touchedShardCount: 1
    });
    expect(recordUpsert).toHaveBeenCalledWith(expect.objectContaining({
      projectionKind: "tree",
      recordId: "directory:",
      sourceFileId: null,
      logicalPath: "pages",
      parentPath: "",
      payload: expect.objectContaining({
        kind: "directory",
        name: "pages",
        sourceDirectoryId: null,
        directEntryCount: 2,
        directDirectoryCount: 1,
        directFileCount: 1,
        descendantFileCount: 3
      })
    }));
  });

  it("removes a directory tree record when the frozen target state is empty", async () => {
    const recordDelete = vi.fn(async () => undefined);
    const shardApplyBatch = vi.fn(async () => ({
      deleted: false,
      recordCount: 1,
      reused: false
    }));
    const writer = createWriter({ recordDelete, shardApplyBatch });
    const removedDirectory = {
      ...directoryTreeImpact(),
      projectionInput: { kind: "empty" as const }
    };

    await expect(writer.write(removedDirectory)).resolves.toEqual({
      handled: true,
      touchedShardCount: 1
    });
    expect(recordDelete).toHaveBeenCalledWith(expect.objectContaining({
      projectionKind: "tree",
      recordId: "directory:docs"
    }));
    expect(shardApplyBatch).toHaveBeenCalledWith(expect.objectContaining({
      changes: [{ recordId: "directory:docs", record: null }]
    }));
  });
});

function createWriter(overrides: {
  stageUpsert?: GenerationObjectReferenceRepository["stageUpsert"];
  recordUpsert?: ProjectionRecordRepository["stageUpsert"];
  recordDelete?: ProjectionRecordRepository["stageDelete"];
  shardApply?: Parameters<typeof createRequiredProjectionWriter>[0]["shards"]["apply"];
  shardApplyBatch?: Parameters<typeof createRequiredProjectionWriter>[0]["shards"]["applyBatch"];
  immutableWrite?: Parameters<typeof createRequiredProjectionWriter>[0]["immutableObjects"]["write"];
}) {
  return createRequiredProjectionWriter({
    records: {
      stageUpsert: overrides.recordUpsert ?? vi.fn(async () => undefined),
      stageDelete: overrides.recordDelete ?? vi.fn(async () => undefined),
      findActive: vi.fn(async () => null),
      findStaged: vi.fn(async () => null)
    },
    references: {
      stageUpsert: overrides.stageUpsert ?? vi.fn(async () => undefined),
      stageDelete: vi.fn(async () => undefined),
      findActiveByPath: vi.fn(async () => null),
      findActiveByRef: vi.fn(async () => null),
      findStagedByRef: vi.fn(async () => null)
    },
    immutableObjects: {
      write: overrides.immutableWrite ?? vi.fn(async () => immutableWriteResult())
    },
    shards: {
      apply: overrides.shardApply ?? vi.fn(async () => ({
        deleted: false,
        recordCount: 1,
        reused: false
      })),
      applyBatch: overrides.shardApplyBatch ?? vi.fn(async () => ({
        deleted: false,
        recordCount: 1,
        reused: false
      }))
    },
    storage: {
      getObjectText: vi.fn(async () =>
        "---\ntitle: Guide\ntype: page\n---\n# Guide\n\nApproved in 2026.\n\nDeploy safely."
      )
    },
    relatedFileLimit: 20
  });
}

function immutableWriteResult() {
  return {
    checksumSha256: "cd".repeat(32),
    formatVersion: 1,
    objectKey: "generated/page",
    contentType: "text/markdown; charset=utf-8",
    sizeBytes: 128,
    createdAt: "2026-07-17T00:00:00.000Z",
    verifiedAt: "2026-07-17T00:00:00.000Z",
    reused: false
  };
}

function impact(projectionKind: "page" | "search") {
  return {
    id: `impact-${projectionKind}`,
    knowledgeBaseId: "kb-1",
    generationId: "generation-1",
    changeFactId: "change-1",
    changeKind: "source_created" as const,
    sourceFileId: "source-file-1",
    sourceRevisionId: "source-revision-1",
    previousPath: null,
    path: "docs/guide.md",
    resourceRevision: 1,
    projectionKind,
    projectionKey: projectionKind === "search" ? "search/v1/0001" : "source-file-1",
    recordIdentity: "source-file-1",
    action: "upsert" as const,
    retryCursor: {},
    attemptCount: 1,
    maxAttempts: 3,
    projectionInput: sourceProjectionInput()
  };
}

function sourceProjectionInput() {
  return {
    kind: "source" as const,
    document: {
      sourceFileId: "source-file-1",
      sourceRevisionId: "source-revision-1",
      resourceRevision: 1,
      name: "guide.md",
      relativePath: "docs/guide.md",
      generatedPath: "pages/docs/guide.md",
      objectKey: "source/guide.md",
      contentType: "text/markdown",
      sizeBytes: 24,
      checksumSha256: "ab".repeat(32),
      metadata: {
        title: "Guide",
        type: "page",
        description: "Guide",
        tags: ["operations", "current"],
        resource: "https://docs.example.com/guide",
        timestamp: "2026-07-17T00:00:00Z"
      },
      suggestions: null,
      graphNode: {
        fileId: "source-file-1",
        path: "pages/docs/guide.md",
        title: "Guide",
        summary: "Deploy safely.",
        keywords: ["deployment"]
      }
    },
    relationships: []
  };
}

function directoryTreeImpact() {
  return {
    ...impact("search"),
    id: "impact-tree-directory-docs",
    projectionKind: "tree" as const,
    projectionKey: "tree/v1/0001",
    recordIdentity: "directory:docs",
    sourceFileId: null,
    sourceRevisionId: null,
    path: "docs/guide.md",
    projectionInput: {
      kind: "directory" as const,
      directory: directorySnapshot("docs")
    }
  };
}

function graphLinkImpact() {
  return {
    ...impact("search"),
    id: "impact-links-edge-1",
    projectionKind: "links" as const,
    projectionKey: "links/v1/0001",
    recordIdentity: "edge-1",
    projectionInput: {
      kind: "graph_edge" as const,
      edge: {
        id: "edge-1",
        fromFileId: "source-file-1",
        fromPath: "pages/docs/guide.md",
        fromTitle: "Guide",
        toFileId: "source-file-2",
        toPath: "pages/docs/reference.md",
        toTitle: "Reference",
        relationType: "same_specific_subject",
        weight: 0.91,
        reason: "Both files explain the same deployment procedure.",
        source: "deterministic",
        evidence: { sharedSubjects: ["deployment"] }
      }
    }
  };
}

function rootDirectoryTreeImpact() {
  return {
    ...directoryTreeImpact(),
    id: "impact-tree-directory-root",
    recordIdentity: "directory:",
    projectionInput: {
      kind: "directory" as const,
      directory: directorySnapshot("")
    }
  };
}

function directorySnapshot(relativePath: string) {
  const name = relativePath ? relativePath.split("/").at(-1)! : "pages";
  return {
    id: relativePath ? `directory:${relativePath}` : "directory:",
    sourceDirectoryId: relativePath ? `source-directory-${name}` : null,
    name,
    relativePath,
    generatedPath: relativePath ? `pages/${relativePath}/index.md` : "pages/index.md",
    kind: "directory" as const,
    resourceRevision: relativePath ? 2 : 1,
    directEntryCount: 2,
    directDirectoryCount: 1,
    directFileCount: 1,
    descendantFileCount: 3
  };
}

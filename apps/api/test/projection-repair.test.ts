import { describe, expect, it, vi } from "vitest";
import { runProjectionRepairSlice } from "../src/maintenance/projection-repair.js";

describe("projection repair", () => {
  it("rewrites one bounded tree page and persists the checkpoint", async () => {
    const input = createInput();
    input.repair.listTreePage.mockResolvedValue([treeRecord()]);

    const result = await runProjectionRepairSlice(input);

    expect(result.phase).toBe("tree");
    expect(input.records.stageUpsert).toHaveBeenCalledWith(expect.objectContaining({
      generationId: "generation-repair",
      recordId: "directory:"
    }));
    expect(input.shards.applyBatch).toHaveBeenCalledWith(expect.objectContaining({
      projectionKind: "tree",
      changes: [expect.objectContaining({ recordId: "directory:" })]
    }));
    expect(input.repair.advanceTreeCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
      treeCursor: "directory:",
      treeComplete: false
    }));
    expect(input.generations.activateGeneration).not.toHaveBeenCalled();
  });

  it("builds and atomically activates a validated repair generation", async () => {
    const input = createInput({ treeComplete: true });

    const result = await runProjectionRepairSlice(input);

    expect(result.phase).toBe("completed");
    expect(input.catalog.finalize).toHaveBeenCalledOnce();
    expect(input.validation.validateChangedClosure).toHaveBeenCalledOnce();
    expect(input.generations.activateGeneration).toHaveBeenCalledWith(expect.objectContaining({
      generationId: "generation-repair",
      expectedPredecessorGenerationId: "generation-active"
    }));
    expect(input.repair.complete).toHaveBeenCalledOnce();
  });

  it("supersedes and retries when normal publication wins activation", async () => {
    const input = createInput({ treeComplete: true });
    input.generations.activateGeneration.mockResolvedValue(false);

    const result = await runProjectionRepairSlice(input);

    expect(result.phase).toBe("retry");
    expect(input.repair.retryFromLatest).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "PROJECTION_REPAIR_SUPERSEDED"
    }));
    expect(input.repair.complete).not.toHaveBeenCalled();
  });
});

function createInput(checkpoint = { treeComplete: false }) {
  const job = {
    knowledgeBaseId: "kb-test",
    repairVersion: 1,
    baseGenerationId: "generation-active",
    targetGenerationId: "generation-repair",
    checkpoint: { treeCursor: null, treeComplete: checkpoint.treeComplete },
    attemptCount: 1,
    descriptor: {
      id: "kb-test",
      name: "Test knowledge base",
      description: "Test description",
      sourceFileCount: 2,
      graphEdgeCount: 1,
      rootEntryCount: 2
    }
  };
  const repair = {
    bootstrap: vi.fn().mockResolvedValue(1),
    claim: vi.fn().mockResolvedValue(job),
    listTreePage: vi.fn().mockResolvedValue([]),
    advanceTreeCheckpoint: vi.fn().mockResolvedValue(true),
    complete: vi.fn().mockResolvedValue(true),
    retryFromLatest: vi.fn()
  };
  const references = {
    stageUpsert: vi.fn(),
    stageDelete: vi.fn(),
    findActiveByPath: vi.fn(),
    findActiveByRef: vi.fn().mockResolvedValue(null),
    findStagedByRef: vi.fn().mockImplementation(async ({ refKey }: { refKey: string }) => ({
      knowledgeBaseId: "kb-test",
      lastChangedGenerationId: "generation-repair",
      refKind: "root",
      refKey,
      fileId: `file-${refKey}`,
      checksumSha256: "a".repeat(64),
      formatVersion: 1,
      logicalPath: refKey,
      sourceFileId: null,
      projectionShardId: null,
      objectKey: `objects/${refKey}`,
      contentType: "text/markdown; charset=utf-8",
      sizeBytes: 12
    }))
  };
  return {
    repair,
    records: { stageUpsert: vi.fn(), stageDelete: vi.fn(), findActive: vi.fn(), findStaged: vi.fn() },
    shards: { applyBatch: vi.fn().mockResolvedValue({ deleted: false, recordCount: 1, reused: false }) },
    references,
    immutableObjects: {
      write: vi.fn().mockResolvedValue({
        checksumSha256: "a".repeat(64),
        formatVersion: 1,
        objectKey: "objects/a",
        contentType: "text/markdown; charset=utf-8",
        sizeBytes: 12,
        createdAt: "2026-07-18T12:00:00.000Z",
        verifiedAt: "2026-07-18T12:00:00.000Z",
        reused: false
      })
    },
    catalog: { finalize: vi.fn() },
    validation: { validateChangedClosure: vi.fn().mockResolvedValue([]) },
    generations: {
      markGenerationState: vi.fn().mockResolvedValue(true),
      activateGeneration: vi.fn().mockResolvedValue(true),
      failGeneration: vi.fn()
    },
    repairVersion: 1,
    treePageSize: 100,
    maxAttempts: 5,
    retryDelayMs: 30_000,
    validationIssueLimit: 50,
    now: () => new Date("2026-07-18T12:00:00.000Z"),
    leaseToken: "lease-repair",
    targetGenerationId: "generation-repair"
  };
}

function treeRecord() {
  return {
    knowledgeBaseId: "kb-test",
    projectionKind: "tree" as const,
    recordId: "directory:",
    lastChangedGenerationId: "generation-active",
    shardKey: "tree/v1/0000",
    sourceFileId: null,
    relatedSourceFileId: null,
    logicalPath: "pages",
    parentPath: "",
    sortKey: "pages",
    title: "pages",
    summary: null,
    searchableText: "pages",
    payload: {
      id: "directory:", kind: "directory", path: "pages",
      directEntryCount: 2, directDirectoryCount: 1,
      directFileCount: 1, descendantFileCount: 2
    }
  };
}

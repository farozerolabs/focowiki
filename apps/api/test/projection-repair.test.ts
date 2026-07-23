import { describe, expect, it, vi } from "vitest";
import type { ProjectionRepairCheckpoint } from "../src/application/ports/projection-repair-repository.js";
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
    const input = createInput(completedCheckpoint());

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
    const input = createInput(completedCheckpoint());
    input.generations.activateGeneration.mockResolvedValue(false);

    const result = await runProjectionRepairSlice(input);

    expect(result.phase).toBe("retry");
    expect(input.repair.retryFromLatest).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "PROJECTION_REPAIR_SUPERSEDED"
    }));
    expect(input.repair.complete).not.toHaveBeenCalled();
  });

  it("preserves the active generation and retries when candidate parity validation fails", async () => {
    const input = createInput(completedCheckpoint());
    input.validation.validateChangedClosure.mockResolvedValue([{
      code: "DIRECTORY_NAVIGATION_MISSING",
      message: "A visible directory has no navigation summary.",
      reference: "pages/guides"
    }]);

    const result = await runProjectionRepairSlice(input);

    expect(result).toEqual({ phase: "failed", records: 0 });
    expect(input.generations.failGeneration).toHaveBeenCalledWith(expect.objectContaining({
      generationId: "generation-repair",
      code: "PROJECTION_REPAIR_VALIDATION_FAILED"
    }));
    expect(input.generations.activateGeneration).not.toHaveBeenCalled();
    expect(input.repair.retryFromLatest).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "PROJECTION_REPAIR_FAILED"
    }));
    expect(input.repair.complete).not.toHaveBeenCalled();
  });

  it("logs sanitized diagnostics when a repair slice fails", async () => {
    const input = createInput();
    const failure = Object.assign(
      new Error(
        "PUT https://account.r2.cloudflarestorage.com/private/object "
        + "S3_SECRET_ACCESS_KEY=secret-value objectKey=private/object failed"
      ),
      {
        name: "ServiceUnavailable",
        code: "ServiceUnavailable",
        $metadata: {
          httpStatusCode: 503,
          requestId: "request-123"
        },
        cause: Object.assign(new Error("socket closed"), {
          name: "SocketError",
          code: "ECONNRESET"
        })
      }
    );
    input.repair.listTreePage.mockRejectedValue(failure);

    const result = await runProjectionRepairSlice(input);

    expect(result).toEqual({ phase: "failed", records: 0 });
    expect(input.logger.error).toHaveBeenCalledWith(
      "Projection repair slice failed",
      expect.objectContaining({
        knowledgeBaseId: "kb-test",
        repairVersion: 1,
        baseGenerationId: "generation-active",
        targetGenerationId: "generation-repair",
        attemptCount: 1,
        stage: "tree",
        errorClass: "ServiceUnavailable",
        errorCode: "ServiceUnavailable",
        errorMessage: "PUT <redacted-url> S3_SECRET_ACCESS_KEY=<redacted> "
          + "objectKey=<redacted> failed",
        httpStatusCode: 503,
        requestId: "request-123",
        causeClass: "SocketError",
        causeCode: "ECONNRESET",
        causeMessage: "socket closed"
      })
    );
    const logged = input.logger.error.mock.calls[0]?.[1];
    expect(JSON.stringify(logged)).not.toContain("secret-value");
    expect(JSON.stringify(logged)).not.toContain("private/object");
    expect(input.repair.retryFromLatest).toHaveBeenCalledOnce();
  });

  it("does no projection or object work when the repair version is already complete", async () => {
    const input = createInput();
    input.repair.claim.mockResolvedValue(null);

    const result = await runProjectionRepairSlice(input);

    expect(result).toEqual({ phase: "idle", records: 0 });
    expect(input.records.stageUpsert).not.toHaveBeenCalled();
    expect(input.shards.applyBatch).not.toHaveBeenCalled();
    expect(input.navigation.writeEntries).not.toHaveBeenCalled();
    expect(input.immutableObjects.write).not.toHaveBeenCalled();
    expect(input.references.stageUpsert).not.toHaveBeenCalled();
    expect(input.references.stageDelete).not.toHaveBeenCalled();
  });

  it("repairs one bounded directory-navigation page and persists its cursor", async () => {
    const input = createInput({
      treeComplete: true,
      navigationDirectoryCursor: null,
      navigationEntryCursor: null,
      navigationPhase: "entries",
      navigationComplete: false,
      graphCursor: null,
      graphNodeCount: 0,
      graphEdgeCount: 0,
      graphComplete: false
    });
    input.repair.listNextNavigationDirectory.mockResolvedValue({
      recordId: "directory:pages",
      path: "pages"
    });
    input.repair.listNavigationEntryPage.mockResolvedValue({
      entries: [{
        entryId: "source-1",
        desiredEntry: {
          id: "source-1",
          sortKey: "guide.md/source-1",
          name: "guide.md",
          targetPath: "pages/guide.md",
          kind: "file"
        }
      }],
      nextCursor: { sortKey: "guide.md/source-1", recordId: "source-1" }
    });

    const result = await runProjectionRepairSlice(input);

    expect(result).toEqual({ phase: "navigation", records: 1 });
    expect(input.navigation.writeEntries).toHaveBeenCalledWith(expect.objectContaining({
      generationId: "generation-repair",
      directoryPath: "pages"
    }));
    expect(input.repair.advanceNavigationCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
      navigationEntryCursor: { sortKey: "guide.md/source-1", recordId: "source-1" },
      navigationPhase: "entries",
      navigationComplete: false
    }));
  });

  it("persists a canonical graph summary after bounded graph counting", async () => {
    const input = createInput({
      ...completedCheckpoint(),
      graphComplete: false,
      graphCursor: { projectionKind: "graph_edge", recordId: "edge-2" },
      graphNodeCount: 2,
      graphEdgeCount: 3
    });
    input.repair.listGraphPage.mockResolvedValue({ records: [], nextCursor: null });

    const result = await runProjectionRepairSlice(input);

    expect(result).toEqual({ phase: "graph", records: 0 });
    expect(input.repair.stageGraphSummary).toHaveBeenCalledWith(expect.objectContaining({
      nodeCount: 2,
      edgeCount: 3
    }));
    expect(input.repair.advanceGraphCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
      graphComplete: true
    }));
    expect(input.generations.activateGeneration).not.toHaveBeenCalled();
  });
});

function createInput(checkpoint: Partial<ProjectionRepairCheckpoint> = emptyCheckpoint()) {
  const job = {
    knowledgeBaseId: "kb-test",
    repairVersion: 1,
    baseGenerationId: "generation-active",
    targetGenerationId: "generation-repair",
    checkpoint: { ...emptyCheckpoint(), ...checkpoint },
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
    listNextNavigationDirectory: vi.fn().mockResolvedValue(null),
    listNavigationEntryPage: vi.fn().mockResolvedValue({ entries: [], nextCursor: null }),
    listStaleNavigationEntryPage: vi.fn().mockResolvedValue({ entries: [], nextCursor: null }),
    advanceNavigationCheckpoint: vi.fn().mockResolvedValue(true),
    listGraphPage: vi.fn().mockResolvedValue({ records: [], nextCursor: null }),
    stageGraphSummary: vi.fn().mockResolvedValue(true),
    advanceGraphCheckpoint: vi.fn().mockResolvedValue(true),
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
    navigation: { writeEntries: vi.fn().mockResolvedValue({ handled: true, touchedShardCount: 1 }) },
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
    logger: { error: vi.fn() },
    now: () => new Date("2026-07-18T12:00:00.000Z"),
    leaseToken: "lease-repair",
    targetGenerationId: "generation-repair"
  };
}

function emptyCheckpoint() {
  return {
    treeCursor: null,
    treeComplete: false,
    navigationDirectoryCursor: null,
    navigationEntryCursor: null,
    navigationPhase: "entries" as const,
    navigationComplete: false,
    graphCursor: null,
    graphNodeCount: 0,
    graphEdgeCount: 0,
    graphComplete: false
  };
}

function completedCheckpoint() {
  return {
    ...emptyCheckpoint(),
    treeComplete: true,
    navigationComplete: true,
    graphComplete: true
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

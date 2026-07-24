import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  ProjectionRepairWorkItem
} from "../src/application/ports/projection-repair-work-repository.js";
import {
  createProjectionRepairTaskProcessor
} from "../src/maintenance/projection-repair-task-processor.js";

describe("projection repair task processor", () => {
  it("checkpoints bounded tree batches before writing one final partition", async () => {
    const fixture = createFixture();
    fixture.builds.stageTreeBatch
      .mockResolvedValueOnce({
        processedRecordCount: 1,
        nextCursor: "record-a",
        complete: false
      })
      .mockResolvedValueOnce({
        processedRecordCount: 1,
        nextCursor: "record-b",
        complete: true
      });
    fixture.builds.listStagedTreePartition.mockResolvedValue([
      projection("record-a"),
      projection("record-b")
    ]);
    fixture.shards.applyBatch.mockResolvedValue({
      recordCount: 2,
      objectWriteCount: 1,
      objectReuseCount: 2
    });

    const result = await fixture.process(task({ kind: "tree_partition", expectedRecordCount: 2 }));

    expect(result).toEqual({ status: "completed", processedRecordCount: 2 });
    expect(fixture.builds.stageTreeBatch).toHaveBeenCalledTimes(2);
    expect(fixture.work.checkpointTask).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        checkpoint: { cursor: "record-a" },
        processedRecordCount: 1
      })
    );
    expect(fixture.work.checkpointTask).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        checkpoint: { cursor: "record-b" },
        processedRecordCount: 2
      })
    );
    expect(fixture.shards.applyBatch).toHaveBeenCalledWith(expect.objectContaining({
      projectionKind: "tree",
      shardKey: "partition",
      changes: expect.arrayContaining([
        expect.objectContaining({ recordId: "record-a" }),
        expect.objectContaining({ recordId: "record-b" })
      ])
    }));
    expect(fixture.work.completeTask).toHaveBeenCalledWith(expect.objectContaining({
      processedRecordCount: 2,
      objectWriteCount: 1,
      objectReuseCount: 2
    }));
  });

  it("streams a directory into final leaves and writes the root once", async () => {
    const fixture = createFixture({ directoryMaxEntries: 2 });
    fixture.builds.listDirectoryEntryPage.mockResolvedValue({
      entries: [
        entry("a"),
        entry("b"),
        entry("c")
      ],
      nextCursor: null
    });

    const result = await fixture.process(task({
      kind: "directory",
      partitionKey: "pages",
      expectedRecordCount: 3
    }));

    expect(fixture.work.retryTask).not.toHaveBeenCalled();
    expect(result).toEqual({ status: "completed", processedRecordCount: 3 });
    expect(fixture.builds.resetDirectorySnapshot).toHaveBeenCalledOnce();
    expect(fixture.builds.upsertDirectoryLeaf).toHaveBeenCalledTimes(2);
    expect(fixture.builds.completeDirectorySnapshot).toHaveBeenCalledWith(expect.objectContaining({
      entryCount: 3
    }));
    expect(fixture.references.stageUpsert).toHaveBeenCalledTimes(3);
    expect(fixture.work.completeTask).toHaveBeenCalledWith(expect.objectContaining({
      objectWriteCount: 3,
      objectReuseCount: 0
    }));
  });

  it("defers finalization when bounded catch-up work is scheduled", async () => {
    const fixture = createFixture();
    fixture.work.scheduleCatchUp.mockResolvedValue("scheduled");

    const result = await fixture.process(task({ kind: "finalize" }));

    expect(result.status).toBe("deferred");
    expect(fixture.work.scheduleCatchUp).toHaveBeenCalledWith(expect.objectContaining({
      task: expect.objectContaining({
        targetGenerationId: "generation-repair",
        baseGenerationId: "generation-active"
      })
    }));
    expect(fixture.generations.activateGeneration).not.toHaveBeenCalled();
    expect(fixture.work.completeTask).not.toHaveBeenCalled();
  });

  it("removes candidate navigation when a directory disappears during catch-up", async () => {
    const fixture = createFixture();
    fixture.builds.directoryExists.mockResolvedValue(false);

    const result = await fixture.process(task({
      kind: "directory_rebase",
      partitionKey: "generation-next\u001epages/removed",
      baseGenerationId: "generation-next",
      expectedRecordCount: 0
    }));

    expect(result).toEqual({ status: "completed", processedRecordCount: 0 });
    expect(fixture.builds.resetDirectorySnapshot).toHaveBeenCalledWith({
      task: expect.objectContaining({
        partitionKey: "pages/removed",
        baseGenerationId: "generation-next"
      })
    });
    expect(fixture.builds.listDirectoryEntryPage).not.toHaveBeenCalled();
    expect(fixture.references.stageUpsert).not.toHaveBeenCalled();
  });

  it("writes graph tombstones for records deleted during catch-up", async () => {
    const fixture = createFixture();
    fixture.builds.stageGraphRebaseBatch.mockResolvedValue({
      processedRecordCount: 1,
      nextCursor: "edge-removed",
      complete: true
    });
    fixture.builds.listStagedGraphRebaseChanges.mockResolvedValue([
      { recordId: "edge-removed", record: null }
    ]);
    fixture.shards.applyBatch.mockResolvedValue({
      recordCount: 0,
      objectWriteCount: 1,
      objectReuseCount: 0
    });

    const result = await fixture.process(task({
      kind: "graph_rebase",
      partitionKey:
        "generation-next\u001egraph_edge\u001fgraph_edge/v1/0000",
      baseGenerationId: "generation-next",
      expectedRecordCount: 1
    }));

    expect(result).toEqual({ status: "completed", processedRecordCount: 1 });
    expect(fixture.shards.applyBatch).toHaveBeenCalledWith(expect.objectContaining({
      projectionKind: "graph_edge",
      shardKey: "graph_edge/v1/0000",
      changes: [{ recordId: "edge-removed", record: null }]
    }));
  });

  it("schedules another bounded catch-up after an activation conflict", async () => {
    const fixture = createFixture();
    fixture.builds.readRepairDescriptor.mockResolvedValue({
      id: "kb-one",
      name: "Knowledge",
      description: null,
      sourceFileCount: 2,
      graphEdgeCount: 1,
      rootEntryCount: 2,
      activeGenerationId: "generation-active",
      resourceRevision: 7
    });
    fixture.references.findStagedByRef.mockResolvedValue({
      checksumSha256: "a".repeat(64),
      objectKey: "objects/a",
      contentType: "text/markdown",
      sizeBytes: 1
    });
    fixture.generations.activateGeneration.mockResolvedValue(false);
    fixture.work.scheduleCatchUp
      .mockResolvedValueOnce("ready")
      .mockResolvedValueOnce("scheduled");

    const result = await fixture.process(task({ kind: "finalize" }));

    expect(result.status).toBe("deferred");
    expect(fixture.work.scheduleCatchUp).toHaveBeenCalledTimes(2);
    expect(fixture.work.retryTask).not.toHaveBeenCalled();
    expect(fixture.work.completeTask).not.toHaveBeenCalled();
  });

  it("stops safely when the knowledge base is deleted before finalization", async () => {
    const fixture = createFixture();
    fixture.work.scheduleCatchUp.mockResolvedValue("lost");

    const result = await fixture.process(task({ kind: "finalize" }));

    expect(result).toEqual({ status: "lost", processedRecordCount: 0 });
    expect(fixture.builds.readRepairDescriptor).not.toHaveBeenCalled();
    expect(fixture.work.retryTask).not.toHaveBeenCalled();
    expect(fixture.generations.activateGeneration).not.toHaveBeenCalled();
  });

  it("classifies parity failures as terminal subtask failures", async () => {
    const fixture = createFixture();
    fixture.builds.aggregateGraph.mockResolvedValue({ nodeCount: 2, edgeCount: 1 });
    fixture.work.retryTask.mockResolvedValue("failed");

    const result = await fixture.process(task({
      kind: "graph_finalize",
      expectedRecordCount: 4
    }));

    expect(result.status).toBe("failed");
    expect(fixture.work.retryTask).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "PROJECTION_REPAIR_GRAPH_PARITY_FAILED",
      retryable: false
    }));
  });

  it("inherits generation search references before validation and activation", async () => {
    const fixture = createFixture();
    fixture.builds.readRepairDescriptor.mockResolvedValue({
      id: "kb-one",
      name: "Knowledge",
      description: null,
      sourceFileCount: 2,
      graphEdgeCount: 1,
      rootEntryCount: 2,
      activeGenerationId: "generation-active",
      resourceRevision: 7
    });
    fixture.builds.inheritSearchProjectionReferences.mockResolvedValue(2);
    fixture.references.findStagedByRef.mockResolvedValue({
      checksumSha256: "a".repeat(64),
      objectKey: "objects/a",
      contentType: "text/markdown",
      sizeBytes: 1
    });
    fixture.generations.activateGeneration.mockResolvedValue(true);

    const result = await fixture.process(task({ kind: "finalize" }));

    expect(result.status).toBe("completed");
    expect(fixture.builds.inheritSearchProjectionReferences).toHaveBeenCalledWith({
      task: expect.objectContaining({
        baseGenerationId: "generation-active",
        targetGenerationId: "generation-repair"
      })
    });
    expect(fixture.builds.inheritSearchProjectionReferences.mock.invocationCallOrder[0])
      .toBeLessThan(fixture.validation.validateChangedClosure.mock.invocationCallOrder[0]!);
  });

  it("finishes durable bookkeeping when activation completed before worker restart", async () => {
    const fixture = createFixture();
    fixture.builds.readRepairDescriptor.mockResolvedValue({
      id: "kb-one",
      name: "Knowledge",
      description: null,
      sourceFileCount: 2,
      graphEdgeCount: 1,
      rootEntryCount: 2,
      activeGenerationId: "generation-repair",
      resourceRevision: 7
    });

    const result = await fixture.process(task({ kind: "finalize" }));

    expect(result).toEqual({ status: "completed", processedRecordCount: 1 });
    expect(fixture.validation.validateChangedClosure).not.toHaveBeenCalled();
    expect(fixture.generations.activateGeneration).not.toHaveBeenCalled();
    expect(fixture.work.completeRepair).toHaveBeenCalledWith(expect.objectContaining({
      activeGenerationId: "generation-repair"
    }));
  });
});

function createFixture(options: { directoryMaxEntries?: number } = {}) {
  const work = {
    heartbeat: vi.fn().mockResolvedValue(true),
    checkpointTask: vi.fn().mockResolvedValue(true),
    completeTask: vi.fn().mockResolvedValue(true),
    completeRepair: vi.fn().mockResolvedValue(true),
    scheduleCatchUp: vi.fn().mockResolvedValue("ready"),
    retryTask: vi.fn().mockResolvedValue("retry")
  };
  const builds = {
    stageTreeBatch: vi.fn(),
    listStagedTreePartition: vi.fn(),
    stageTreeRebaseBatch: vi.fn(),
    listStagedTreeRebaseChanges: vi.fn(),
    listDirectoryEntryPage: vi.fn(),
    directoryExists: vi.fn().mockResolvedValue(true),
    resetDirectorySnapshot: vi.fn(),
    upsertDirectoryLeaf: vi.fn(),
    completeDirectorySnapshot: vi.fn(),
    aggregateGraph: vi.fn(),
    stageGraphBatch: vi.fn(),
    listStagedGraphPartition: vi.fn(),
    stageGraphRebaseBatch: vi.fn(),
    listStagedGraphRebaseChanges: vi.fn(),
    inheritSearchProjectionReferences: vi.fn(),
    readRepairDescriptor: vi.fn()
  };
  const shards = { applyBatch: vi.fn() };
  const references = {
    stageUpsert: vi.fn(),
    findStagedByRef: vi.fn(),
    findActiveByRef: vi.fn()
  };
  const generations = {
    markGenerationState: vi.fn().mockResolvedValue(true),
    activateGeneration: vi.fn(),
    failGeneration: vi.fn()
  };
  const validation = { validateChangedClosure: vi.fn().mockResolvedValue([]) };
  const immutableObjects = {
    write: vi.fn(async (object: { body: string | Uint8Array; contentType: string }) => {
      const body = Buffer.from(object.body);
      const checksumSha256 = createHash("sha256").update(body).digest("hex");
      return {
        checksumSha256,
        formatVersion: 1,
        objectKey: `objects/${checksumSha256}`,
        contentType: object.contentType,
        sizeBytes: body.byteLength,
        createdAt: "2026-07-24T00:00:00.000Z",
        verifiedAt: "2026-07-24T00:00:00.000Z",
        reused: false
      };
    })
  };
  const process = createProjectionRepairTaskProcessor({
    work: work as never,
    builds: builds as never,
    shards,
    catalog: { finalize: vi.fn() },
    references: references as never,
    immutableObjects,
    validation,
    generations,
    directoryLimits: {
      maxEntries: options.directoryMaxEntries ?? 200,
      maxBytes: 65_536
    },
    validationIssueLimit: 50,
    leaseTtlMs: 60_000,
    retryDelayMs: 30_000,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    },
    now: () => new Date("2026-07-24T00:00:00.000Z")
  });
  return {
    work,
    builds,
    shards,
    references,
    generations,
    validation,
    immutableObjects,
    process
  };
}

function task(input: {
  kind: ProjectionRepairWorkItem["kind"];
  partitionKey?: string;
  baseGenerationId?: string;
  expectedRecordCount?: number;
}): ProjectionRepairWorkItem {
  return {
    id: `task-${input.kind}`,
    knowledgeBaseId: "kb-one",
    repairVersion: 4,
    targetGenerationId: "generation-repair",
    baseGenerationId: input.baseGenerationId ?? "generation-active",
    kind: input.kind,
    partitionKey: input.partitionKey ?? "partition",
    phaseOrder: 10,
    sourceWatermark: 7,
    settingsRevision: 3,
    settings: {
      concurrency: 4,
      databaseBatchSize: 2_000,
      objectWriteConcurrency: 8
    },
    expectedRecordCount: input.expectedRecordCount ?? 1,
    processedRecordCount: 0,
    attemptCount: 1,
    maxAttempts: 5,
    leaseOwner: "worker-one",
    leaseToken: "lease-one",
    checkpoint: {}
  };
}

function projection(recordId: string) {
  return {
    knowledgeBaseId: "kb-one",
    projectionKind: "tree" as const,
    recordId,
    lastChangedGenerationId: "generation-repair",
    shardKey: "partition",
    sourceFileId: recordId,
    relatedSourceFileId: null,
    logicalPath: `pages/${recordId}.md`,
    parentPath: "pages",
    sortKey: recordId,
    title: recordId,
    summary: null,
    searchableText: recordId,
    payload: { id: recordId, kind: "file" }
  };
}

function entry(id: string) {
  return {
    id,
    sortKey: id,
    name: id,
    targetPath: `pages/${id}.md`,
    kind: "file" as const
  };
}

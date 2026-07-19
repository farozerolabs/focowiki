import { describe, expect, it, vi } from "vitest";
import { createPublicationRoleProcessor } from "../src/worker/publication-role-processor.js";
import type { ClaimedPublicationImpact } from "../src/application/ports/publication-impact-repository.js";
import { RoleJobReschedule, type RoleJobRecord } from "../src/domain/role-job.js";
import { ImmutableObjectWriteInProgressError } from "../src/publication/immutable-object-writer.js";

describe("publication role processor", () => {
  it("uses the immutable publication settings snapshot attached to the claimed job", async () => {
    const claimBatch = vi.fn()
      .mockResolvedValueOnce([]);
    const processor = createPublicationRoleProcessor({
      generations: generationRepository(),
      impacts: {
        claimBatch,
        heartbeat: vi.fn(),
        release: vi.fn(),
        complete: vi.fn(),
        fail: vi.fn(),
        countIncomplete: vi.fn().mockResolvedValue({ pending: 0, running: 0, failed: 0 })
      },
      validation: { validateChangedClosure: vi.fn().mockResolvedValue([]) },
      references: referenceRepository(),
      immutableObjects: immutableWriter(),
      writers: [],
      finalizers: [],
      impactLockTtlSeconds: 60,
      retryDelayMs: 1_000,
      validationIssueLimit: 20
    });

    await processor(createJob({
      settingsSnapshot: {
        publication: {
          impactBatchSize: 3,
          impactConcurrency: 1,
          directoryIndexMaxEntries: 120,
          directoryIndexMaxBytes: 65_536
        }
      }
    }), new AbortController().signal);

    expect(claimBatch).toHaveBeenCalledWith(expect.objectContaining({ limit: 3 }));
  });

  it("builds, validates, and atomically activates one generation", async () => {
    const impact = createImpact();
    const activateGeneration = vi.fn().mockResolvedValue(true);
    const complete = vi.fn().mockResolvedValue(true);
    const generations = generationRepository({ activateGeneration });
    const references = referenceRepository();
    const claims = [[impact], []];
    const processor = createPublicationRoleProcessor({
      generations,
      impacts: {
        claimBatch: vi.fn(async () => claims.shift() ?? []),
        heartbeat: vi.fn(),
        release: vi.fn(),
        complete,
        fail: vi.fn(),
        countIncomplete: vi.fn().mockResolvedValue({ pending: 0, running: 0, failed: 0 })
      },
      validation: { validateChangedClosure: vi.fn().mockResolvedValue([]) },
      references,
      immutableObjects: immutableWriter(),
      writers: [{ write: vi.fn().mockResolvedValue({ handled: true, touchedShardCount: 1 }) }],
      finalizers: [],
      impactLockTtlSeconds: 60,
      retryDelayMs: 1_000,
      validationIssueLimit: 20,
      now: () => new Date("2026-07-17T12:00:00.000Z")
    });

    await processor(createJob(), new AbortController().signal);

    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      impactId: impact.id,
      touchedShardCount: 1
    }));
    expect(activateGeneration).toHaveBeenCalledWith(expect.objectContaining({
      generationId: "generation-1",
      expectedPredecessorGenerationId: null
    }));
    expect(references.stageUpsert).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-1",
      generationId: "generation-1",
      refKind: "generation_manifest",
      refKey: "root",
      fileId: "generation-manifest-generation-1",
      checksumSha256: "b".repeat(64),
      formatVersion: 1,
      logicalPath: null,
      sourceFileId: null,
      projectionShardId: null
    });
  });

  it("persists an impact failure and does not activate a partial generation", async () => {
    const failGeneration = vi.fn().mockResolvedValue(undefined);
    const activateGeneration = vi.fn();
    const processor = createPublicationRoleProcessor({
      generations: generationRepository({ failGeneration, activateGeneration }),
      impacts: {
        claimBatch: vi.fn().mockResolvedValueOnce([createImpact()]),
        heartbeat: vi.fn(),
        release: vi.fn(),
        complete: vi.fn(),
        fail: vi.fn().mockResolvedValue({ terminal: true, attemptCount: 3, maxAttempts: 3 }),
        countIncomplete: vi.fn()
      },
      validation: { validateChangedClosure: vi.fn() },
      references: referenceRepository(),
      immutableObjects: immutableWriter(),
      writers: [{ write: vi.fn().mockRejectedValue(new Error("Injected object failure")) }],
      finalizers: [],
      impactLockTtlSeconds: 60,
      retryDelayMs: 1_000,
      validationIssueLimit: 20
    });

    await expect(processor(createJob(), new AbortController().signal))
      .rejects.toMatchObject({ code: "PROJECTION_WRITE_FAILED", retryable: false });
    expect(failGeneration).toHaveBeenCalledWith(expect.objectContaining({
      code: "PROJECTION_WRITE_FAILED"
    }));
    expect(activateGeneration).not.toHaveBeenCalled();
  });

  it("fails the generation when the final publication job attempt cannot complete", async () => {
    const failGeneration = vi.fn().mockResolvedValue(undefined);
    const processor = createPublicationRoleProcessor({
      generations: generationRepository({ failGeneration }),
      impacts: {
        claimBatch: vi.fn().mockResolvedValueOnce([createImpact()]),
        heartbeat: vi.fn(),
        release: vi.fn(),
        complete: vi.fn(),
        fail: vi.fn().mockResolvedValue({ terminal: false, attemptCount: 1, maxAttempts: 3 }),
        countIncomplete: vi.fn()
      },
      validation: { validateChangedClosure: vi.fn() },
      references: referenceRepository(),
      immutableObjects: immutableWriter(),
      writers: [{ write: vi.fn().mockRejectedValue(new Error("Temporary object failure")) }],
      finalizers: [],
      impactLockTtlSeconds: 60,
      retryDelayMs: 1_000,
      validationIssueLimit: 20,
      now: () => new Date("2026-07-19T00:00:00.000Z")
    });

    await expect(processor(createJob({ attemptCount: 3, maxAttempts: 3 }), new AbortController().signal))
      .rejects.toMatchObject({
        code: "PUBLICATION_RETRIES_EXHAUSTED",
        retryable: false
      });
    expect(failGeneration).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-1",
      generationId: "generation-1",
      code: "PUBLICATION_RETRIES_EXHAUSTED",
      message: "Projection write will be retried",
      failedAt: "2026-07-19T00:00:00.000Z"
    });
  });

  it("fails the generation immediately when publication reaches a terminal error", async () => {
    const failGeneration = vi.fn().mockResolvedValue(undefined);
    const references = referenceRepository();
    references.findStagedByRef.mockResolvedValue(null);
    references.findActiveByRef.mockResolvedValue(null);
    const processor = createPublicationRoleProcessor({
      generations: generationRepository({ failGeneration }),
      impacts: {
        claimBatch: vi.fn().mockResolvedValue([]),
        heartbeat: vi.fn(),
        release: vi.fn(),
        complete: vi.fn(),
        fail: vi.fn(),
        countIncomplete: vi.fn().mockResolvedValue({ pending: 0, running: 0, failed: 0 })
      },
      validation: { validateChangedClosure: vi.fn().mockResolvedValue([]) },
      references,
      immutableObjects: immutableWriter(),
      writers: [],
      finalizers: [],
      impactLockTtlSeconds: 60,
      retryDelayMs: 1_000,
      validationIssueLimit: 20,
      now: () => new Date("2026-07-19T00:00:00.000Z")
    });

    await expect(processor(createJob(), new AbortController().signal))
      .rejects.toMatchObject({ code: "ROOT_REFERENCE_MISSING", retryable: false });
    expect(failGeneration).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-1",
      generationId: "generation-1",
      code: "ROOT_REFERENCE_MISSING",
      message: "Required root reference is unavailable: index.md",
      failedAt: "2026-07-19T00:00:00.000Z"
    });
  });

  it("writes one machine shard once for all claimed records in that shard", async () => {
    const first = createImpact({
      id: "impact-search-1",
      projectionKind: "search",
      projectionKey: "search/v1/0001",
      recordIdentity: "source-1"
    });
    const second = createImpact({
      id: "impact-search-2",
      projectionKind: "search",
      projectionKey: "search/v1/0001",
      recordIdentity: "source-2"
    });
    const write = vi.fn().mockResolvedValue({ handled: false, touchedShardCount: 0 });
    const writeBatch = vi.fn().mockResolvedValue({ handled: true, touchedShardCount: 1 });
    const complete = vi.fn().mockResolvedValue(true);
    const processor = createPublicationRoleProcessor({
      generations: generationRepository(),
      impacts: {
        claimBatch: vi.fn()
          .mockResolvedValueOnce([first, second])
          .mockResolvedValueOnce([]),
        heartbeat: vi.fn(),
        release: vi.fn(),
        complete,
        fail: vi.fn(),
        countIncomplete: vi.fn().mockResolvedValue({ pending: 0, running: 0, failed: 0 })
      },
      validation: { validateChangedClosure: vi.fn().mockResolvedValue([]) },
      references: referenceRepository(),
      immutableObjects: immutableWriter(),
      writers: [{ write, writeBatch }],
      finalizers: [],
      impactLockTtlSeconds: 60,
      retryDelayMs: 1_000,
      validationIssueLimit: 20
    });

    await processor(createJob(), new AbortController().signal);

    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(writeBatch).toHaveBeenCalledWith([first, second], {
      impactBatchSize: 10,
      impactConcurrency: 2,
      directoryIndexMaxEntries: 200,
      directoryIndexMaxBytes: 65_536
    });
    expect(write).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls.map((call) => call[0].touchedShardCount)).toEqual([1, 0]);
  });

  it("groups repeated root impacts by their effective root path", async () => {
    const first = createImpact({
      id: "impact-root-1",
      projectionKind: "root",
      projectionKey: "index.md",
      recordIdentity: "index.md",
      resourceRevision: 1
    });
    const second = createImpact({
      id: "impact-root-2",
      projectionKind: "root",
      projectionKey: "index.md",
      recordIdentity: "index.md",
      resourceRevision: 2
    });
    const write = vi.fn().mockResolvedValue({ handled: false, touchedShardCount: 0 });
    const writeBatch = vi.fn().mockResolvedValue({ handled: true, touchedShardCount: 1 });
    const processor = createPublicationRoleProcessor({
      generations: generationRepository(),
      impacts: impactRepositoryFor([first, second]),
      validation: { validateChangedClosure: vi.fn().mockResolvedValue([]) },
      references: referenceRepository(),
      immutableObjects: immutableWriter(),
      writers: [{ write, writeBatch }],
      finalizers: [],
      impactLockTtlSeconds: 60,
      retryDelayMs: 1_000,
      validationIssueLimit: 20
    });

    await processor(createJob(), new AbortController().signal);

    expect(writeBatch).toHaveBeenCalledOnce();
    expect(writeBatch).toHaveBeenCalledWith([first, second], expect.any(Object));
    expect(write).not.toHaveBeenCalled();
  });

  it("groups forward and reverse related-file impacts by their effective shard", async () => {
    const direct = createImpact({
      id: "impact-related-direct",
      projectionKind: "related_files",
      projectionKey: "source-2",
      recordIdentity: "source-2"
    });
    const reverse = createImpact({
      id: "impact-related-reverse",
      projectionKind: "graph_reverse_neighbor",
      projectionKey: "ignored-planner-key",
      recordIdentity: "source-2"
    });
    const write = vi.fn().mockResolvedValue({ handled: false, touchedShardCount: 0 });
    const writeBatch = vi.fn().mockResolvedValue({ handled: true, touchedShardCount: 1 });
    const processor = createPublicationRoleProcessor({
      generations: generationRepository(),
      impacts: impactRepositoryFor([direct, reverse]),
      validation: { validateChangedClosure: vi.fn().mockResolvedValue([]) },
      references: referenceRepository(),
      immutableObjects: immutableWriter(),
      writers: [{ write, writeBatch }],
      finalizers: [],
      impactLockTtlSeconds: 60,
      retryDelayMs: 1_000,
      validationIssueLimit: 20
    });

    await processor(createJob(), new AbortController().signal);

    expect(writeBatch).toHaveBeenCalledOnce();
    expect(writeBatch).toHaveBeenCalledWith([direct, reverse], expect.any(Object));
    expect(write).not.toHaveBeenCalled();
  });

  it("reschedules write-lease contention without consuming failure attempts", async () => {
    const impact = createImpact({ attemptCount: 3, maxAttempts: 3 });
    const failGeneration = vi.fn();
    const release = vi.fn().mockResolvedValue(1);
    const fail = vi.fn();
    const processor = createPublicationRoleProcessor({
      generations: generationRepository({ failGeneration }),
      impacts: {
        ...impactRepositoryFor([impact]),
        release,
        fail
      },
      validation: { validateChangedClosure: vi.fn() },
      references: referenceRepository(),
      immutableObjects: immutableWriter(),
      writers: [{
        write: vi.fn().mockRejectedValue(new ImmutableObjectWriteInProgressError())
      }],
      finalizers: [],
      impactLockTtlSeconds: 60,
      retryDelayMs: 1_000,
      validationIssueLimit: 20,
      now: () => new Date("2026-07-19T10:00:00.000Z")
    });

    await expect(processor(
      createJob({ attemptCount: 3, maxAttempts: 3 }),
      new AbortController().signal
    )).rejects.toBeInstanceOf(RoleJobReschedule);

    expect(release).toHaveBeenCalledWith({
      impactIds: [impact.id],
      workerId: "publication-worker-1",
      releasedAt: "2026-07-19T10:00:00.000Z"
    });
    expect(fail).not.toHaveBeenCalled();
    expect(failGeneration).not.toHaveBeenCalled();
  });

  it("processes independent impact groups with bounded snapshot concurrency", async () => {
    const impacts = ["source-1", "source-2", "source-3"].map((sourceFileId, index) =>
      createImpact({
        id: `impact-${index + 1}`,
        sourceFileId,
        sourceRevisionId: `revision-${index + 1}`,
        projectionKey: sourceFileId,
        recordIdentity: sourceFileId
      })
    );
    let active = 0;
    let maximumActive = 0;
    const write = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { handled: true, touchedShardCount: 0 };
    });
    const processor = createPublicationRoleProcessor({
      generations: generationRepository(),
      impacts: {
        claimBatch: vi.fn()
          .mockResolvedValueOnce(impacts)
          .mockResolvedValueOnce([]),
        heartbeat: vi.fn(),
        release: vi.fn(),
        complete: vi.fn().mockResolvedValue(true),
        fail: vi.fn(),
        countIncomplete: vi.fn().mockResolvedValue({ pending: 0, running: 0, failed: 0 })
      },
      validation: { validateChangedClosure: vi.fn().mockResolvedValue([]) },
      references: referenceRepository(),
      immutableObjects: immutableWriter(),
      writers: [{ write }],
      finalizers: [],
      impactLockTtlSeconds: 60,
      retryDelayMs: 1_000,
      validationIssueLimit: 20
    });

    await processor(createJob(), new AbortController().signal);

    expect(maximumActive).toBe(2);
    expect(write).toHaveBeenCalledTimes(3);
  });

  it("keeps impacts for one directory in a single ordered batch", async () => {
    const first = createImpact({
      id: "impact-directory-1",
      projectionKind: "directory",
      projectionKey: "docs",
      recordIdentity: "source-1:docs/one.md:docs"
    });
    const second = createImpact({
      id: "impact-directory-2",
      projectionKind: "directory",
      projectionKey: "docs",
      recordIdentity: "source-2:docs/two.md:docs"
    });
    const write = vi.fn().mockResolvedValue({ handled: false, touchedShardCount: 0 });
    const writeBatch = vi.fn().mockResolvedValue({ handled: true, touchedShardCount: 2 });
    const processor = createPublicationRoleProcessor({
      generations: generationRepository(),
      impacts: {
        claimBatch: vi.fn()
          .mockResolvedValueOnce([first, second])
          .mockResolvedValueOnce([]),
        heartbeat: vi.fn(),
        release: vi.fn(),
        complete: vi.fn().mockResolvedValue(true),
        fail: vi.fn(),
        countIncomplete: vi.fn().mockResolvedValue({ pending: 0, running: 0, failed: 0 })
      },
      validation: { validateChangedClosure: vi.fn().mockResolvedValue([]) },
      references: referenceRepository(),
      immutableObjects: immutableWriter(),
      writers: [{ write, writeBatch }],
      finalizers: [],
      impactLockTtlSeconds: 60,
      retryDelayMs: 1_000,
      validationIssueLimit: 20
    });

    await processor(createJob(), new AbortController().signal);

    expect(writeBatch).toHaveBeenCalledOnce();
    expect(writeBatch).toHaveBeenCalledWith([first, second], expect.objectContaining({
      impactConcurrency: 2
    }));
    expect(write).not.toHaveBeenCalled();
  });

  it("finalizes durable catalogs before validating and activating a generation", async () => {
    const sequence: string[] = [];
    const processor = createPublicationRoleProcessor({
      generations: generationRepository({
        markGenerationState: vi.fn(async () => {
          sequence.push("state");
          return true;
        }),
        activateGeneration: vi.fn(async () => {
          sequence.push("activate");
          return true;
        })
      }),
      impacts: {
        claimBatch: vi.fn().mockResolvedValue([]),
        heartbeat: vi.fn(),
        release: vi.fn(),
        complete: vi.fn(),
        fail: vi.fn(),
        countIncomplete: vi.fn().mockResolvedValue({ pending: 0, running: 0, failed: 0 })
      },
      validation: {
        validateChangedClosure: vi.fn(async () => {
          sequence.push("validate");
          return [];
        })
      },
      references: referenceRepository(),
      immutableObjects: immutableWriter(),
      writers: [],
      finalizers: [{
        finalize: vi.fn(async () => {
          sequence.push("catalog");
        })
      }],
      impactLockTtlSeconds: 60,
      retryDelayMs: 1_000,
      validationIssueLimit: 20
    });

    await processor(createJob(), new AbortController().signal);

    expect(sequence.indexOf("catalog")).toBeLessThan(sequence.indexOf("validate"));
    expect(sequence.indexOf("validate")).toBeLessThan(sequence.indexOf("activate"));
  });
});

function createImpact(
  overrides: Partial<ClaimedPublicationImpact> = {}
): ClaimedPublicationImpact {
  return {
    id: "impact-1",
    knowledgeBaseId: "kb-1",
    generationId: "generation-1",
    changeFactId: "change-1",
    changeKind: "source_created",
    sourceFileId: "source-1",
    sourceRevisionId: "revision-1",
    previousPath: null,
    path: "guide.md",
    resourceRevision: 1,
    projectionKind: "page",
    projectionKey: "source-1",
    recordIdentity: "source-1",
    action: "upsert",
    retryCursor: {},
    attemptCount: 1,
    maxAttempts: 3,
    projectionInput: { kind: "empty" },
    ...overrides
  };
}

function createJob(overrides: Partial<RoleJobRecord> = {}): RoleJobRecord {
  return {
    id: "job-1",
    role: "publication",
    kind: "generation_publication",
    knowledgeBaseId: "kb-1",
    sourceFileId: null,
    sourceRevisionId: null,
    generationId: "generation-1",
    payload: {},
    settingsSnapshot: {
      publication: {
        impactBatchSize: 10,
        impactConcurrency: 2,
        directoryIndexMaxEntries: 200,
        directoryIndexMaxBytes: 65_536
      }
    },
    status: "running",
    runAfter: "2026-07-17T12:00:00.000Z",
    attemptCount: 1,
    maxAttempts: 3,
    lockedBy: "publication-worker-1",
    lockedAt: "2026-07-17T12:00:00.000Z",
    heartbeatAt: "2026-07-17T12:00:00.000Z",
    createdAt: "2026-07-17T12:00:00.000Z",
    updatedAt: "2026-07-17T12:00:00.000Z",
    ...overrides
  };
}

function impactRepositoryFor(firstBatch: ClaimedPublicationImpact[]) {
  return {
    claimBatch: vi.fn()
      .mockResolvedValueOnce(firstBatch)
      .mockResolvedValueOnce([]),
    heartbeat: vi.fn(),
    release: vi.fn().mockResolvedValue(0),
    complete: vi.fn().mockResolvedValue(true),
    fail: vi.fn(),
    countIncomplete: vi.fn().mockResolvedValue({ pending: 0, running: 0, failed: 0 })
  };
}

function generationRepository(overrides: Record<string, unknown> = {}) {
  return {
    commitSourceCompletion: vi.fn(),
    freezeGeneration: vi.fn().mockResolvedValue({
      generationId: "generation-1",
      predecessorGenerationId: null,
      state: "frozen",
      totalImpactCount: 1,
      frozenAt: "2026-07-17T12:00:00.000Z"
    }),
    markGenerationState: vi.fn().mockResolvedValue(true),
    activateGeneration: vi.fn().mockResolvedValue(true),
    failGeneration: vi.fn(),
    ...overrides
  } as any;
}

function referenceRepository() {
  return {
    stageUpsert: vi.fn(),
    stageDelete: vi.fn(),
    findActiveByPath: vi.fn(),
    findActiveByRef: vi.fn(),
    findStagedByRef: vi.fn().mockImplementation(async ({ refKey }: { refKey: string }) => ({
      knowledgeBaseId: "kb-1",
      refKind: "root",
      refKey,
      lastChangedGenerationId: "generation-1",
      checksumSha256: "a".repeat(64),
      formatVersion: 1,
      logicalPath: refKey,
      sourceFileId: null,
      projectionShardId: null,
      objectKey: `objects/${refKey}`,
      contentType: refKey.endsWith(".json") ? "application/json" : "text/markdown",
      sizeBytes: 100
    }))
  };
}

function immutableWriter() {
  return {
    write: vi.fn().mockResolvedValue({
      checksumSha256: "b".repeat(64),
      formatVersion: 1,
      objectKey: "objects/root-manifest",
      contentType: "application/json; charset=utf-8",
      sizeBytes: 500,
      reused: false
    })
  };
}

import { describe, expect, it, vi } from "vitest";
import { createPublicationSubtaskRuntime } from "../src/worker/publication-subtask-runtime.js";
import type { PublicationSubtask } from "../src/application/ports/publication-subtask-repository.js";
import type { ClaimedPublicationImpact } from "../src/application/ports/publication-impact-repository.js";
import { ImmutableObjectWriteInProgressError } from "../src/publication/immutable-object-writer.js";
import { RoleJobFailure } from "../src/domain/role-job.js";

describe("publication subtask runtime", () => {
  it("claims one physical partition, completes its impacts, and closes the durable task", async () => {
    const task = createTask();
    const impact = createImpact();
    const completeTask = vi.fn().mockResolvedValue(true);
    const completeBatch = vi.fn().mockResolvedValue(1);
    const runtime = createPublicationSubtaskRuntime({
      subtasks: subtaskRepository({ claim: vi.fn().mockResolvedValue([task]), complete: completeTask }),
      impacts: impactRepository({
        claimPartitionBatch: vi.fn()
          .mockResolvedValueOnce([impact])
          .mockResolvedValueOnce([]),
        completeBatch,
        countPartitionIncomplete: vi.fn().mockResolvedValue({
          pending: 0,
          running: 0,
          failed: 0,
          completed: 1
        })
      }),
      writers: [{ write: vi.fn().mockResolvedValue({ handled: true, touchedShardCount: 1 }) }],
      settings: workerSettings(),
      workerId: "publication-subtask-worker",
      now: () => new Date("2026-07-20T00:00:00.000Z")
    });

    expect(await runtime.tick()).toBe(1);
    expect(completeBatch).toHaveBeenCalledWith(expect.objectContaining({
      completions: [{ impactId: impact.id, touchedShardCount: 1 }]
    }));
    expect(completeTask).toHaveBeenCalledWith(expect.objectContaining({
      taskId: task.id,
      processedCount: 1
    }));
  });

  it("reschedules immutable-object contention without consuming the partition retry budget", async () => {
    const task = createTask();
    const reschedule = vi.fn().mockResolvedValue(true);
    const runtime = createPublicationSubtaskRuntime({
      subtasks: subtaskRepository({ claim: vi.fn().mockResolvedValue([task]), reschedule }),
      impacts: impactRepository({
        claimPartitionBatch: vi.fn().mockResolvedValue([createImpact()]),
        release: vi.fn().mockResolvedValue(1)
      }),
      writers: [{ write: vi.fn().mockRejectedValue(new ImmutableObjectWriteInProgressError()) }],
      settings: workerSettings(),
      workerId: "publication-subtask-worker",
      now: () => new Date("2026-07-20T00:00:00.000Z")
    });

    expect(await runtime.tick()).toBe(1);
    expect(reschedule).toHaveBeenCalledWith(expect.objectContaining({
      taskId: task.id,
      preserveAttempt: true
    }));
  });

  it("executes terminal phases without claiming projection impacts", async () => {
    const task = createTask({ taskKind: "object", projectionKind: "", physicalPartition: "workflow" });
    const complete = vi.fn().mockResolvedValue(true);
    const object = vi.fn().mockResolvedValue(undefined);
    const claimPartitionBatch = vi.fn();
    const runtime = createPublicationSubtaskRuntime({
      subtasks: subtaskRepository({ claim: vi.fn().mockResolvedValue([task]), complete }),
      impacts: impactRepository({ claimPartitionBatch }),
      writers: [],
      terminalHandlers: { object, validation: vi.fn(), activation: vi.fn() },
      settings: workerSettings(),
      workerId: "publication-subtask-worker",
      now: () => new Date("2026-07-20T00:00:00.000Z")
    });

    expect(await runtime.tick()).toBe(1);
    expect(object).toHaveBeenCalledWith(task);
    expect(claimPartitionBatch).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      taskId: task.id,
      processedCount: 1
    }));
  });

  it("reschedules object finalization contention without consuming its retry budget", async () => {
    const task = createTask({ taskKind: "object", projectionKind: "", physicalPartition: "workflow" });
    const reschedule = vi.fn().mockResolvedValue(true);
    const fail = vi.fn();
    const runtime = createPublicationSubtaskRuntime({
      subtasks: subtaskRepository({
        claim: vi.fn().mockResolvedValue([task]),
        reschedule,
        fail
      }),
      impacts: impactRepository({}),
      writers: [],
      terminalHandlers: {
        object: vi.fn().mockRejectedValue(new ImmutableObjectWriteInProgressError()),
        validation: vi.fn(),
        activation: vi.fn()
      },
      settings: workerSettings(),
      workerId: "publication-subtask-worker",
      now: () => new Date("2026-07-20T00:00:00.000Z")
    });

    await runtime.tick();
    expect(reschedule).toHaveBeenCalledWith(expect.objectContaining({
      taskId: task.id,
      preserveAttempt: true
    }));
    expect(fail).not.toHaveBeenCalled();
  });

  it("reschedules retryable activation ordering without consuming its retry budget", async () => {
    const task = createTask({ taskKind: "activation", projectionKind: "", physicalPartition: "workflow" });
    const reschedule = vi.fn().mockResolvedValue(true);
    const fail = vi.fn();
    const runtime = createPublicationSubtaskRuntime({
      subtasks: subtaskRepository({
        claim: vi.fn().mockResolvedValue([task]),
        reschedule,
        fail
      }),
      impacts: impactRepository({}),
      writers: [],
      terminalHandlers: {
        object: vi.fn(),
        validation: vi.fn(),
        activation: vi.fn().mockRejectedValue(new RoleJobFailure({
          code: "PUBLICATION_PHASE_BUSY",
          message: "Generation activation is busy",
          retryable: true
        }))
      },
      settings: workerSettings(),
      workerId: "publication-subtask-worker",
      now: () => new Date("2026-07-20T00:00:00.000Z")
    });

    await runtime.tick();
    expect(reschedule).toHaveBeenCalledWith(expect.objectContaining({
      taskId: task.id,
      preserveAttempt: true
    }));
    expect(fail).not.toHaveBeenCalled();
  });

  it("runs projection and directory tasks through independent resource budgets", async () => {
    const projectionRun = vi.fn();
    const directoryRun = vi.fn();
    const tasks = [
      createTask(),
      createTask({
        id: "publication-subtask-directory",
        taskKind: "directory",
        projectionKind: "directory",
        physicalPartition: "directory\u001fpages"
      })
    ];
    const runtime = createPublicationSubtaskRuntime({
      subtasks: subtaskRepository({ claim: vi.fn().mockResolvedValue(tasks) }),
      impacts: impactRepository({
        claimPartitionBatch: vi.fn().mockResolvedValue([]),
        countPartitionIncomplete: vi.fn().mockResolvedValue({
          pending: 0,
          running: 0,
          failed: 0,
          completed: 0
        })
      }),
      writers: [],
      resourceBudgets: {
        projectionPartition: {
          async run<T>(operation: () => Promise<T>): Promise<T> {
            projectionRun();
            return operation();
          }
        },
        directory: {
          async run<T>(operation: () => Promise<T>): Promise<T> {
            directoryRun();
            return operation();
          }
        }
      },
      settings: workerSettings(),
      workerId: "publication-subtask-worker",
      now: () => new Date("2026-07-20T00:00:00.000Z")
    });

    expect(await runtime.tick()).toBe(2);
    expect(projectionRun).toHaveBeenCalledTimes(1);
    expect(directoryRun).toHaveBeenCalledTimes(1);
  });

  it("does not consume projection budgets for terminal workflow tasks", async () => {
    const projectionRun = vi.fn();
    const directoryRun = vi.fn();
    const runtime = createPublicationSubtaskRuntime({
      subtasks: subtaskRepository({
        claim: vi.fn().mockResolvedValue([
          createTask({ taskKind: "activation", projectionKind: "", physicalPartition: "workflow" })
        ])
      }),
      impacts: impactRepository({}),
      writers: [],
      terminalHandlers: {
        object: vi.fn(),
        validation: vi.fn(),
        activation: vi.fn().mockResolvedValue(undefined)
      },
      resourceBudgets: {
        projectionPartition: { run: projectionRun },
        directory: { run: directoryRun }
      },
      settings: workerSettings(),
      workerId: "publication-subtask-worker",
      now: () => new Date("2026-07-20T00:00:00.000Z")
    });

    expect(await runtime.tick()).toBe(1);
    expect(projectionRun).not.toHaveBeenCalled();
    expect(directoryRun).not.toHaveBeenCalled();
  });
});

function createTask(overrides: Partial<PublicationSubtask> = {}): PublicationSubtask {
  return {
    id: "publication-subtask-1",
    knowledgeBaseId: "kb-1",
    generationId: "generation-1",
    taskKind: "projection_partition",
    projectionKind: "search",
    physicalPartition: "search\u001fsearch/v1/0001",
    settingsSnapshot: {
      publication: {
        impactBatchSize: 10,
        impactConcurrency: 2,
        directoryIndexMaxEntries: 100,
        directoryIndexMaxBytes: 65_536
      }
    },
    attemptCount: 1,
    maxAttempts: 5,
    processedCount: 0,
    totalCount: 1,
    leaseOwner: "publication-subtask-worker",
    leaseToken: "lease-token",
    ...overrides
  };
}

function createImpact(): ClaimedPublicationImpact {
  return {
    id: "impact-1",
    knowledgeBaseId: "kb-1",
    generationId: "generation-1",
    changeFactId: "fact-1",
    changeKind: "source_created",
    sourceFileId: "source-1",
    sourceRevisionId: "revision-1",
    previousPath: null,
    path: "pages/a.md",
    resourceRevision: 1,
    projectionKind: "search",
    projectionKey: "search/v1/0001",
    recordIdentity: "source-1",
    action: "upsert",
    retryCursor: {},
    attemptCount: 1,
    maxAttempts: 3,
    projectionInput: null
  };
}

function workerSettings() {
  return {
    claimBatchSize: 4,
    concurrency: 2,
    pollIntervalMs: 10,
    lockTtlSeconds: 60,
    heartbeatIntervalMs: 10,
    retryDelayMs: 1_000
  };
}

function subtaskRepository(overrides: Record<string, unknown>) {
  return {
    ensureGenerationTasks: vi.fn(),
    claim: vi.fn().mockResolvedValue([]),
    heartbeat: vi.fn().mockResolvedValue(0),
    complete: vi.fn().mockResolvedValue(true),
    reschedule: vi.fn().mockResolvedValue(true),
    fail: vi.fn().mockResolvedValue({ terminal: false }),
    getGenerationStatus: vi.fn(),
    ...overrides
  } as never;
}

function impactRepository(overrides: Record<string, unknown>) {
  return {
    claimBatch: vi.fn(),
    claimPartitionBatch: vi.fn().mockResolvedValue([]),
    heartbeat: vi.fn(),
    release: vi.fn(),
    complete: vi.fn(),
    completeBatch: vi.fn(),
    fail: vi.fn(),
    countIncomplete: vi.fn(),
    countPartitionIncomplete: vi.fn().mockResolvedValue({
      pending: 0,
      running: 0,
      failed: 0,
      completed: 0
    }),
    ...overrides
  } as never;
}

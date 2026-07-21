import { describe, expect, it, vi } from "vitest";
import type { RoleJobRepository } from "../src/application/ports/role-job-repository.js";
import { RoleJobReschedule, type RoleJobRecord } from "../src/domain/role-job.js";
import { createRoleWorkerRuntime } from "../src/worker/role-runtime.js";

describe("role worker runtime", () => {
  it("claims only the configured role and records a role heartbeat", async () => {
    const repository = createFakeRepository([createJob("source")]);
    const process = vi.fn(async () => undefined);
    const runtime = createRoleWorkerRuntime({
      role: "source",
      workerId: "source-worker-a",
      repository,
      process,
      settings: settings()
    });

    await expect(runtime.tick()).resolves.toBe(1);

    expect(repository.claim).toHaveBeenCalledWith(expect.objectContaining({
      role: "source",
      workerId: "source-worker-a"
    }));
    expect(repository.heartbeat).toHaveBeenCalledWith(expect.objectContaining({
      role: "source",
      workerId: "source-worker-a"
    }));
    expect(process).toHaveBeenCalledOnce();
    expect(repository.complete).toHaveBeenCalledOnce();
  });

  it("dispatches durable source markers before claiming source work", async () => {
    const repository = createFakeRepository([]);
    const beforeClaim = vi.fn(async () => undefined);
    const runtime = createRoleWorkerRuntime({
      role: "source",
      workerId: "source-worker-a",
      repository,
      process: vi.fn(async () => undefined),
      beforeClaim,
      settings: settings()
    });

    await runtime.tick();

    expect(beforeClaim).toHaveBeenCalledOnce();
    expect(repository.claim).toHaveBeenCalledOnce();
    expect(beforeClaim.mock.invocationCallOrder[0]).toBeLessThan(
      repository.claim.mock.invocationCallOrder[0]!
    );
  });

  it("retries retryable failures and dead-letters terminal attempts", async () => {
    const retryRepository = createFakeRepository([createJob("source")]);
    const retryRuntime = createRoleWorkerRuntime({
      role: "source",
      workerId: "source-worker-a",
      repository: retryRepository,
      process: async () => {
        throw new Error("temporary");
      },
      settings: settings()
    });
    await retryRuntime.tick();
    expect(retryRepository.retry).toHaveBeenCalledOnce();

    const terminalRepository = createFakeRepository([
      createJob("source", { attemptCount: 3, maxAttempts: 3 })
    ]);
    const terminalRuntime = createRoleWorkerRuntime({
      role: "source",
      workerId: "source-worker-b",
      repository: terminalRepository,
      process: async () => {
        throw new Error("terminal");
      },
      settings: settings()
    });
    await terminalRuntime.tick();
    expect(terminalRepository.fail).toHaveBeenCalledOnce();
  });

  it("reschedules bounded continuation without consuming an attempt", async () => {
    const repository = createFakeRepository([createJob("source")]);
    const runtime = createRoleWorkerRuntime({
      role: "source",
      workerId: "source-worker-a",
      repository,
      process: async () => {
        throw new RoleJobReschedule("2026-07-17T00:00:01.000Z");
      },
      settings: settings()
    });

    await runtime.tick();

    expect(repository.reschedule).toHaveBeenCalledWith(expect.objectContaining({
      jobId: "job-source",
      runAfter: "2026-07-17T00:00:01.000Z"
    }));
    expect(repository.retry).not.toHaveBeenCalled();
    expect(repository.fail).not.toHaveBeenCalled();
  });

  it("releases claimed jobs when shutdown begins before processing", async () => {
    const repository = createFakeRepository([createJob("maintenance")]);
    const controller = new AbortController();
    repository.claim.mockImplementationOnce(async () => {
      controller.abort();
      return [createJob("maintenance")];
    });
    const runtime = createRoleWorkerRuntime({
      role: "maintenance",
      workerId: "maintenance-worker-a",
      repository,
      process: vi.fn(async () => undefined),
      settings: settings()
    });

    await expect(runtime.tick(controller.signal)).resolves.toBe(0);
    expect(repository.release).toHaveBeenCalledWith(expect.objectContaining({
      jobIds: ["job-maintenance"]
    }));
  });

  it("serializes process heartbeats while concurrent jobs are running", async () => {
    const jobs = Array.from({ length: 4 }, (_, index) => createJob("source", {
      id: `job-source-${index}`,
      sourceFileId: `source-file-${index}`
    }));
    const repository = createFakeRepository(jobs);
    let activeHeartbeats = 0;
    let maximumActiveHeartbeats = 0;
    repository.heartbeat.mockImplementation(async () => {
      activeHeartbeats += 1;
      maximumActiveHeartbeats = Math.max(maximumActiveHeartbeats, activeHeartbeats);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeHeartbeats -= 1;
    });
    const runtime = createRoleWorkerRuntime({
      role: "source",
      workerId: "source-worker-heartbeat",
      repository,
      process: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      },
      settings: settings()
    });

    await expect(runtime.tick()).resolves.toBe(4);

    expect(maximumActiveHeartbeats).toBe(1);
  });
});

function settings() {
  return {
    claimBatchSize: 4,
    concurrency: 2,
    pollIntervalMs: 1,
    lockTtlSeconds: 30,
    heartbeatIntervalMs: 5,
    retryDelayMs: 100
  };
}

function createJob(
  role: RoleJobRecord["role"],
  override: Partial<RoleJobRecord> = {}
): RoleJobRecord {
  return {
    id: `job-${role}`,
    role,
    kind: role === "source" ? "source_processing" : role === "publication"
      ? "generation_publication" : "projection_audit",
    knowledgeBaseId: "kb-role-runtime",
    sourceFileId: role === "source" ? "source-file-a" : null,
    sourceRevisionId: role === "source" ? "source-revision-a" : null,
    generationId: role === "publication" ? "generation-a" : null,
    payload: {},
    settingsSnapshot: {},
    status: "running",
    runAfter: "2026-07-17T00:00:00.000Z",
    attemptCount: 1,
    maxAttempts: 3,
    lockedBy: "source-worker-a",
    lockedAt: "2026-07-17T00:00:00.000Z",
    heartbeatAt: "2026-07-17T00:00:00.000Z",
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
    ...override
  };
}

function createFakeRepository(jobs: RoleJobRecord[]) {
  return {
    getQueueSummary: vi.fn(async () => ({
      queuedCount: 0,
      runningCount: 0,
      completedCount: 0,
      failedCount: 0,
      deadLetterCount: 0,
      oldestQueuedAt: null,
      oldestQueuedAgeSeconds: null
    })),
    enqueue: vi.fn(async () => jobs[0]!),
    cancelSourceJobsForDeletionIntent: vi.fn(async () => 0),
    cancelKnowledgeBaseJobs: vi.fn(async () => 0),
    claim: vi.fn(async () => jobs),
    heartbeat: vi.fn(async () => undefined),
    complete: vi.fn(async () => undefined),
    retry: vi.fn(async () => undefined),
    reschedule: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
    removeHeartbeat: vi.fn(async () => undefined)
  } satisfies RoleJobRepository as RoleJobRepository & {
    [K in keyof RoleJobRepository]: ReturnType<typeof vi.fn>;
  };
}

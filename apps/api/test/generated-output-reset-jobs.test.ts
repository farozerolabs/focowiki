import { describe, expect, it, vi } from "vitest";
import type { GeneratedOutputResetRepository } from "../src/application/ports/generated-output-reset-repository.js";
import type { RedisCoordinator } from "../src/redis/coordination.js";
import type { StorageAdapter } from "../src/storage/s3.js";
import { processGeneratedOutputResetJob } from "../src/worker/generated-output-reset-jobs.js";

describe("generated output reset worker", () => {
  it("deletes release prefixes in bounded batches before scheduling one canonical rebuild", async () => {
    const prefixA = "root/releases/a/bundle/";
    const prefixB = "root/releases/b/bundle/";
    const prefixQueue = [prefixA, prefixB];
    const objects = new Map([
      [prefixA, ["a/1.md", "a/2.md", "a/3.md"]],
      [prefixB, ["b/1.md"]]
    ]);
    const repository = createRepository({
      listPendingPrefixes: vi.fn(async () => prefixQueue.splice(0, 1))
    });
    const storage = createStorage(objects);
    const redis = createRedis();

    await expect(processGeneratedOutputResetJob({
      jobId: "worker-job-reset",
      knowledgeBaseId: "kb-test",
      repository,
      storage,
      redis,
      lockTtlSeconds: 900,
      objectBatchSize: 2,
      versionPurgeEnabled: false,
      publicationJobMaxAttempts: 3,
      now: () => "2026-07-13T00:00:00.000Z"
    })).resolves.toEqual({ completed: true, retryAfter: null });

    expect(redis.clearKnowledgeBaseRuntimeKeys).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-test"
    });
    expect(storage.deleteObjects).toHaveBeenNthCalledWith(1, ["a/1.md", "a/2.md"]);
    expect(storage.deleteObjects).toHaveBeenNthCalledWith(2, ["a/3.md"]);
    expect(storage.deleteObjects).toHaveBeenNthCalledWith(3, ["b/1.md"]);
    expect(repository.markPrefixDeleted).toHaveBeenCalledTimes(2);
    expect(repository.completeResetAndEnqueueRebuild).toHaveBeenCalledTimes(1);
    expect(repository.completeResetAndEnqueueRebuild).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-test",
      completedAt: "2026-07-13T00:00:00.000Z",
      publicationJobMaxAttempts: 3
    });
    expect(redis.releaseKnowledgeBasePublicationLock).toHaveBeenCalledWith(
      "kb-test",
      "generated-output-reset:worker-job-reset"
    );
  });

  it("leaves a prefix retryable until storage deletion and durable acknowledgement both succeed", async () => {
    const objects = new Map([["root/releases/a/bundle/", ["a/1.md"]]]);
    const markPrefixDeleted = vi.fn()
      .mockRejectedValueOnce(new Error("Database unavailable"))
      .mockResolvedValue(undefined);
    const repository = createRepository({
      listPendingPrefixes: vi.fn()
        .mockResolvedValueOnce(["root/releases/a/bundle/"])
        .mockResolvedValueOnce(["root/releases/a/bundle/"])
        .mockResolvedValue([]),
      markPrefixDeleted
    });
    const storage = createStorage(objects);
    const input = {
      jobId: "worker-job-reset",
      knowledgeBaseId: "kb-test",
      repository,
      storage,
      redis: createRedis(),
      lockTtlSeconds: 900,
      objectBatchSize: 2,
      versionPurgeEnabled: false,
      publicationJobMaxAttempts: 3,
      now: () => "2026-07-13T00:00:00.000Z"
    };

    await expect(processGeneratedOutputResetJob(input)).rejects.toThrow("Database unavailable");
    await expect(processGeneratedOutputResetJob(input)).resolves.toEqual({
      completed: true,
      retryAfter: null
    });

    expect(storage.deleteObjects).toHaveBeenCalledTimes(1);
    expect(markPrefixDeleted).toHaveBeenCalledTimes(2);
    expect(repository.completeResetAndEnqueueRebuild).toHaveBeenCalledTimes(1);
  });

  it("retries the same durable prefix after storage deletion fails", async () => {
    const prefix = "root/releases/a/bundle/";
    const repository = createRepository({
      listPendingPrefixes: vi.fn()
        .mockResolvedValueOnce([prefix])
        .mockResolvedValueOnce([prefix])
        .mockResolvedValue([])
    });
    const storage = createStorage(new Map([[prefix, ["a/1.md"]]]));
    const deleteObjects = vi.mocked(storage.deleteObjects!);
    deleteObjects.mockRejectedValueOnce(new Error("Storage unavailable"));
    const input = {
      jobId: "worker-job-reset",
      knowledgeBaseId: "kb-test",
      repository,
      storage,
      redis: createRedis(),
      lockTtlSeconds: 900,
      objectBatchSize: 2,
      versionPurgeEnabled: false,
      publicationJobMaxAttempts: 3,
      now: () => "2026-07-13T00:00:00.000Z"
    };

    await expect(processGeneratedOutputResetJob(input)).rejects.toThrow("Storage unavailable");
    expect(repository.markPrefixDeleted).not.toHaveBeenCalled();

    await expect(processGeneratedOutputResetJob(input)).resolves.toEqual({
      completed: true,
      retryAfter: null
    });
    expect(deleteObjects).toHaveBeenCalledTimes(2);
    expect(repository.markPrefixDeleted).toHaveBeenCalledTimes(1);
    expect(repository.completeResetAndEnqueueRebuild).toHaveBeenCalledTimes(1);
  });

  it("defers without touching storage when the publication lock is held", async () => {
    const repository = createRepository();
    const storage = createStorage(new Map());
    const redis = createRedis({
      acquireKnowledgeBasePublicationLock: vi.fn(async () => false)
    });

    const result = await processGeneratedOutputResetJob({
      jobId: "worker-job-reset",
      knowledgeBaseId: "kb-test",
      repository,
      storage,
      redis,
      lockTtlSeconds: 900,
      objectBatchSize: 2,
      versionPurgeEnabled: false,
      publicationJobMaxAttempts: 3,
      now: () => "2026-07-13T00:00:00.000Z"
    });

    expect(result.completed).toBe(false);
    expect(result.retryAfter).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(storage.listObjectKeys).not.toHaveBeenCalled();
    expect(repository.completeResetAndEnqueueRebuild).not.toHaveBeenCalled();
  });
});

function createRepository(
  overrides: Partial<GeneratedOutputResetRepository> = {}
): GeneratedOutputResetRepository {
  return {
    beginReset: vi.fn(async (): Promise<"running"> => "running"),
    listPendingPrefixes: vi.fn(async () => []),
    markPrefixDeleted: vi.fn(async () => undefined),
    completeResetAndEnqueueRebuild: vi.fn(async () => undefined),
    failReset: vi.fn(async () => undefined),
    isResetPending: vi.fn(async () => true),
    ...overrides
  };
}

function createStorage(objects: Map<string, string[]>): StorageAdapter {
  const deleteObjects = vi.fn(async (keys: string[]) => {
    for (const [prefix, values] of objects) {
      objects.set(prefix, values.filter((value) => !keys.includes(value)));
    }
  });
  return {
    keyspace: {} as StorageAdapter["keyspace"],
    putObject: vi.fn(),
    getObjectText: vi.fn(),
    listObjectKeys: vi.fn(async ({ prefix, limit }) => ({
      keys: (objects.get(prefix) ?? []).slice(0, limit),
      nextContinuationToken: null
    })),
    deleteObjects
  } as unknown as StorageAdapter;
}

function createRedis(overrides: Partial<RedisCoordinator> = {}): RedisCoordinator {
  return {
    clearKnowledgeBaseRuntimeKeys: vi.fn(async () => 0),
    acquireKnowledgeBasePublicationLock: vi.fn(async () => true),
    releaseKnowledgeBasePublicationLock: vi.fn(async () => undefined),
    ...overrides
  } as unknown as RedisCoordinator;
}

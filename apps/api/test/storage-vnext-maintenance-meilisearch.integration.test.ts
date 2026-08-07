import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { StorageVnextSearchCleanupRepository } from
  "../src/storage-vnext/search/cleanup-repository.js";
import { createMeilisearchTransport } from
  "../src/infrastructure/meilisearch/meilisearch-transport.js";
import { createMeilisearchProviderRuntime } from
  "../src/infrastructure/meilisearch/meilisearch-provider-runtime.js";
import { createStorageVnextMaintenanceSearchCleanupAdapter } from
  "../src/storage-vnext/maintenance/search-cleanup-adapter.js";
import { createStorageVnextSearchCleanup } from
  "../src/storage-vnext/search/search-cleanup.js";

const endpoint = process.env.FOCOWIKI_TEST_MEILISEARCH_URL;
const apiKey = process.env.FOCOWIKI_TEST_MEILISEARCH_API_KEY;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const hasOwnedTarget = Boolean(
  endpoint && apiKey && runOwner && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner)
);
const describeOwnedMeilisearch = hasOwnedTarget ? describe : describe.skip;

describeOwnedMeilisearch("storage vNext maintenance against real Meilisearch", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const prefix = `svnext_maintenance_${suffix}`;
  const unifiedIndexUid = `${prefix}_unified`;
  const oldIndexUid = `${prefix}_old_candidate`;
  const transport = createMeilisearchTransport({
    endpoint: endpoint ?? "http://127.0.0.1:7700",
    apiKey: apiKey ?? "unused-test-key",
    timeoutMs: 5_000,
    maxAttempts: 2,
    retryDelayMs: 20
  });
  const repository = createCleanupRepository(unifiedIndexUid);
  const cleanup = createStorageVnextSearchCleanup({
    repository,
    provider: createMeilisearchProviderRuntime(transport),
    indexUidPrefix: prefix,
    indexPageSize: 100,
    taskPageSize: 1_000,
    maxDeletesPerRun: 100,
    maxPollAttempts: 200,
    pollIntervalMs: 20,
    highWaterRatio: 0.99,
    minimumReclaimableBytes: Number.MAX_SAFE_INTEGER,
    sleep: () => new Promise<void>((resolve) => setTimeout(resolve, 20))
  });
  const maintenanceCleanup = createStorageVnextMaintenanceSearchCleanupAdapter({
    cleanup,
    now: () => "2099-08-01T00:00:00.000Z",
    availableDiskBytes: async () => Number.MAX_SAFE_INTEGER,
    maximumPages: 20
  });
  const created = new Set([unifiedIndexUid, oldIndexUid]);

  afterAll(async () => {
    for (const indexUid of created) {
      if (!await transport.getIndex({ indexUid }).catch(() => null)) continue;
      const deletion = await transport.deleteIndex(indexUid);
      await waitForTask(deletion.taskUid);
    }
    await removeOwnedTasks();
  }, 30_000);

  it("keeps exactly one unified index and removes old indexes and provider tasks", async () => {
    await createIndex(oldIndexUid);
    await createIndex(unifiedIndexUid);
    await addUnifiedDocuments(oldIndexUid);
    await addUnifiedDocuments(unifiedIndexUid);

    const result = await maintenanceCleanup.cleanupMaintenance({
      knowledgeBaseId: "kb-maintenance-unified",
      operationPublicId: "operation-maintenance-unified",
      candidatePublicId: "candidate-maintenance-unified",
      outcome: "completed",
      promotedCandidatePublicId: "candidate-maintenance-unified",
      failedCandidatePublicId: null
    });

    expect(result).toMatchObject({
      deletedIndexes: 1,
      deletedTasks: expect.any(Number),
      compaction: { outcome: "not_needed" }
    });
    expect(result.deletedTasks).toBeGreaterThan(0);
    const indexes = await transport.listIndexes?.({ offset: 0, limit: 1_000 });
    expect(indexes?.indexes.filter((index) => index.uid.startsWith(prefix)))
      .toEqual([expect.objectContaining({ uid: unifiedIndexUid })]);
    const documents = await transport.listDocuments?.({
      indexUid: unifiedIndexUid,
      offset: 0,
      limit: 100,
      fields: ["id", "knowledgeBaseId", "documentKind"]
    });
    expect(documents).toMatchObject({
      total: 2,
      documents: expect.arrayContaining([
        expect.objectContaining({ documentKind: "content" }),
        expect.objectContaining({ documentKind: "graph_seed" })
      ])
    });
    const tasks = await transport.listFinishedTasks?.({
      statuses: ["succeeded", "failed", "canceled"],
      beforeFinishedAt: "2099-08-01T00:00:00.000Z",
      from: null,
      limit: 1_000
    });
    expect(tasks?.tasks.filter((task) => task.indexUid?.startsWith(prefix)))
      .toEqual([]);
    const stats = await transport.getDatabaseStats?.();
    expect(stats?.databaseSizeBytes).toBeGreaterThanOrEqual(
      stats?.usedDatabaseSizeBytes ?? 0
    );
  }, 30_000);

  async function createIndex(indexUid: string): Promise<void> {
    const creation = await transport.createIndex({ indexUid, primaryKey: "id" });
    await waitForTask(creation.taskUid);
  }

  async function addUnifiedDocuments(indexUid: string): Promise<void> {
    const addition = await transport.addDocuments({
      indexUid,
      primaryKey: "id",
      correlation: `maintenance-seed-${indexUid}`,
      documents: [
        {
          id: "content-document",
          knowledgeBaseId: "kb-maintenance-unified",
          documentKind: "content"
        },
        {
          id: "graph-seed-document",
          knowledgeBaseId: "kb-maintenance-unified",
          documentKind: "graph_seed"
        }
      ]
    });
    await waitForTask(addition.taskUid);
  }

  async function removeOwnedTasks(): Promise<void> {
    const tasks = await transport.listFinishedTasks?.({
      statuses: ["succeeded", "failed", "canceled"],
      beforeFinishedAt: "2099-08-01T00:00:00.000Z",
      from: null,
      limit: 1_000
    });
    const taskUids = (tasks?.tasks ?? [])
      .filter((task) => task.indexUid?.startsWith(prefix))
      .map((task) => task.taskUid);
    if (taskUids.length === 0) return;
    const deletion = await transport.deleteFinishedTasks?.({ taskUids });
    if (deletion) await waitForTask(deletion.taskUid);
  }

  async function waitForTask(taskUid: number): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const task = await transport.getTask(taskUid);
      if (task.status === "succeeded") return;
      if (task.status === "failed" || task.status === "canceled") {
        throw new Error(`Meilisearch task ${taskUid} failed`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Meilisearch task ${taskUid} timed out`);
  }
});

function createCleanupRepository(
  retainedIndexUid: string
): StorageVnextSearchCleanupRepository {
  return {
    async claimFailedCandidate() { return null; },
    async listRetainedProviderIndexUids(input) {
      return input.providerIndexUids.filter((value) => value === retainedIndexUid);
    },
    async claimActiveCompaction() { return null; },
    async recordCleanupOperation() {},
    async clearCleanupOperation() {},
    async completeFailedCandidateCleanup() {},
    async completeCompaction() {}
  };
}

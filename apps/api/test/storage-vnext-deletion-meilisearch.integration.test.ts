import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { SearchEngineSettings } from
  "../src/application/ports/search-engine-transport.js";
import { createMeilisearchTransport } from
  "../src/infrastructure/meilisearch/meilisearch-transport.js";
import { createStorageVnextUnifiedSearchDeletion } from
  "../src/storage-vnext/deletion/unified-search-deletion.js";

const endpoint = process.env.FOCOWIKI_TEST_MEILISEARCH_URL;
const apiKey = process.env.FOCOWIKI_TEST_MEILISEARCH_API_KEY;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const hasOwnedTarget = Boolean(
  endpoint && apiKey && runOwner && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner)
);
const describeOwnedMeilisearch = hasOwnedTarget ? describe : describe.skip;

const settings: SearchEngineSettings = {
  searchableAttributes: ["searchText"],
  filterableAttributes: [
    "knowledgeBaseId", "sourceFilePublicId", "documentKind"
  ],
  displayedAttributes: [
    "id", "knowledgeBaseId", "sourceFilePublicId", "documentKind", "searchText"
  ],
  sortableAttributes: [],
  rankingRules: ["words", "typo", "proximity", "attribute", "sort", "exactness"],
  distinctAttribute: null,
  pagination: { maxTotalHits: 1_000 },
  searchCutoffMs: 1_000,
  localizedAttributes: [],
  typoTolerance: { disableOnAttributes: [] }
};

describeOwnedMeilisearch("storage vNext deletion against real unified Meilisearch indexes", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const prefix = `svnext_delete_${suffix}`;
  const transport = createMeilisearchTransport({
    endpoint: endpoint ?? "http://127.0.0.1:7700",
    apiKey: apiKey ?? "unused-test-key",
    timeoutMs: 5_000,
    maxAttempts: 2,
    retryDelayMs: 20
  });
  const deletion = createStorageVnextUnifiedSearchDeletion({
    transport,
    indexUidPrefix: prefix,
    maximumPollAttempts: 200,
    maximumSourceFiles: 100,
    taskPageSize: 1_000,
    sleep: () => new Promise<void>((resolve) => setTimeout(resolve, 20))
  });
  const created = new Set<string>();

  afterAll(async () => {
    for (const indexUid of created) {
      if (!await transport.getIndex({ indexUid }).catch(() => null)) continue;
      const task = await transport.deleteIndex(indexUid);
      await waitForTask(task.taskUid);
    }
    const tasks = await transport.listFinishedTasks?.({
      statuses: ["succeeded", "failed", "canceled"],
      beforeFinishedAt: "2099-08-01T00:00:00.000Z",
      from: null,
      limit: 1_000
    });
    const taskUids = (tasks?.tasks ?? [])
      .filter((task) => task.indexUid?.startsWith(prefix))
      .map((task) => task.taskUid);
    if (taskUids.length > 0) {
      const cleanup = await transport.deleteFinishedTasks?.({ taskUids });
      if (cleanup) await waitForTask(cleanup.taskUid);
    }
  }, 30_000);

  it("keeps one active unified index after source deletion and removes its candidate", async () => {
    const active = `${prefix}_active_source`;
    const candidate = `${prefix}_candidate_source`;
    await createUnifiedIndex(active);
    await createUnifiedIndex(candidate);
    await addDocuments(active, "kb-unified-source");
    await addDocuments(candidate, "kb-unified-source");

    await expect(deletion.deleteSourceScope({
      knowledgeBaseId: "kb-unified-source",
      operationPublicId: "operation-unified-source",
      activeProviderIndexUid: active,
      candidateProviderIndexUid: candidate,
      sourceFilePublicIds: ["source-delete"]
    })).resolves.toEqual({
      deletedDocuments: true,
      deletedIndexes: 1,
      deletedTasks: 2
    });

    expect(await transport.listDocuments?.({
      indexUid: active,
      offset: 0,
      limit: 100,
      fields: ["id", "sourceFilePublicId", "documentKind"]
    })).toMatchObject({
      total: 2,
      documents: [
        expect.objectContaining({ sourceFilePublicId: "source-keep" }),
        expect.objectContaining({ sourceFilePublicId: "source-keep" })
      ]
    });
    await expect(transport.getIndex({ indexUid: candidate })).resolves.toBeNull();
    const indexes = await transport.listIndexes?.({ offset: 0, limit: 1_000 });
    expect(indexes?.indexes.filter((index) => index.uid.startsWith(prefix)))
      .toHaveLength(1);
  }, 30_000);

  it("removes both unified index roles and their finished tasks for knowledge-base deletion", async () => {
    const active = `${prefix}_active_whole`;
    const candidate = `${prefix}_candidate_whole`;
    await createUnifiedIndex(active);
    await createUnifiedIndex(candidate);
    await addDocuments(active, "kb-unified-whole");
    await addDocuments(candidate, "kb-unified-whole");

    const result = await deletion.deleteKnowledgeBaseScope({
      knowledgeBaseId: "kb-unified-whole",
      operationPublicId: "operation-unified-whole",
      activeProviderIndexUid: active,
      candidateProviderIndexUid: candidate,
      finishedBefore: "2099-08-01T00:00:00.000Z",
      taskFrom: null
    });

    expect(result).toMatchObject({ deletedIndexes: 2, nextTaskFrom: null });
    await expect(transport.getIndex({ indexUid: active })).resolves.toBeNull();
    await expect(transport.getIndex({ indexUid: candidate })).resolves.toBeNull();
    const tasks = await transport.listFinishedTasks?.({
      statuses: ["succeeded", "failed", "canceled"],
      beforeFinishedAt: "2099-08-01T00:00:00.000Z",
      from: null,
      limit: 1_000
    });
    expect(tasks?.tasks.filter((task) =>
      task.indexUid === active || task.indexUid === candidate
    )).toEqual([]);
  }, 30_000);

  async function createUnifiedIndex(indexUid: string): Promise<void> {
    const creation = await transport.createIndex({ indexUid, primaryKey: "id" });
    created.add(indexUid);
    await waitForTask(creation.taskUid);
    const update = await transport.updateSettings({ indexUid, settings });
    await waitForTask(update.taskUid);
  }

  async function addDocuments(
    indexUid: string,
    knowledgeBaseId: string
  ): Promise<void> {
    const task = await transport.addDocuments({
      indexUid,
      primaryKey: "id",
      correlation: `seed-${indexUid}`,
      documents: [
        document("delete-content", knowledgeBaseId, "source-delete", "content"),
        document("delete-graph", knowledgeBaseId, "source-delete", "graph_seed"),
        document("keep-content", knowledgeBaseId, "source-keep", "content"),
        document("keep-graph", knowledgeBaseId, "source-keep", "graph_seed")
      ]
    });
    await waitForTask(task.taskUid);
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

function document(
  id: string,
  knowledgeBaseId: string,
  sourceFilePublicId: string,
  documentKind: string
) {
  return {
    id,
    knowledgeBaseId,
    sourceFilePublicId,
    documentKind,
    searchText: id
  };
}

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { MeilisearchClientPort } from
  "../src/infrastructure/meilisearch/meilisearch-client-port.js";
import type { SearchProviderKind } from
  "../src/application/ports/search-provider-runtime.js";
import { createMeilisearchProviderRuntime } from
  "../src/infrastructure/meilisearch/meilisearch-provider-runtime.js";

type SearchDeletion = {
  deleteSourceScope(input: {
    knowledgeBaseId: string;
    operationPublicId: string;
    activeProviderKind: SearchProviderKind | null;
    activeProviderIndexUid: string | null;
    candidateProviderKind: SearchProviderKind | null;
    candidateProviderIndexUid: string | null;
    sourceFilePublicIds: readonly string[];
  }): Promise<{
    deletedDocuments: boolean;
    deletedIndexes: number;
    deletedTasks: number;
    processedProviderKind: SearchProviderKind;
    remainingProviderKind: SearchProviderKind | null;
  }>;
  deleteKnowledgeBaseScope(input: {
    knowledgeBaseId: string;
    operationPublicId: string;
    activeProviderKind: SearchProviderKind | null;
    activeProviderIndexUid: string | null;
    candidateProviderKind: SearchProviderKind | null;
    candidateProviderIndexUid: string | null;
    finishedBefore: string;
    taskFrom: number | null;
  }): Promise<{
    deletedIndexes: number;
    deletedTasks: number;
    nextTaskFrom: number | null;
    processedProviderKind: SearchProviderKind;
    remainingProviderKind: SearchProviderKind | null;
  }>;
};

type SearchDeletionFactory = (input: {
  provider: ReturnType<typeof createFixture>["provider"];
  indexUidPrefix: string;
  maximumPollAttempts: number;
  maximumSourceFiles: number;
  taskPageSize: number;
  sleep?: () => Promise<void>;
}) => SearchDeletion;

let factory: SearchDeletionFactory | undefined;

beforeAll(async () => {
  const modulePath = resolve(
    import.meta.dirname,
    "../src/storage-vnext/deletion/unified-search-deletion.ts"
  );
  const loaded = await import(/* @vite-ignore */ pathToFileURL(modulePath).href)
    .catch(() => ({})) as {
      createStorageVnextUnifiedSearchDeletion?: SearchDeletionFactory;
    };
  factory = loaded.createStorageVnextUnifiedSearchDeletion;
});

describe("storage vNext unified search deletion", () => {
  it("accepts the validated runtime task timeout and poll interval ratio", () => {
    const fixture = createFixture();
    expect(factory).toBeTypeOf("function");
    expect(() => factory?.({
      provider: fixture.provider,
      indexUidPrefix: "unified",
      maximumPollAttempts: 1_200,
      maximumSourceFiles: 100,
      taskPageSize: 1_000,
      sleep: async () => undefined
    })).not.toThrow();
  });

  it("deletes content and graph seeds together from the one active index", async () => {
    const fixture = createFixture();
    const deletion = createDeletion(fixture);

    await expect(deletion.deleteSourceScope({
      knowledgeBaseId: "kb-search-delete",
      operationPublicId: "operation-search-delete",
      activeProviderKind: "meilisearch",
      activeProviderIndexUid: "unified_kb_search_delete_active",
      candidateProviderKind: "meilisearch",
      candidateProviderIndexUid: "unified_kb_search_delete_candidate",
      sourceFilePublicIds: ["file-search-delete"]
    })).resolves.toEqual({
      deletedDocuments: true,
      deletedIndexes: 1,
      deletedTasks: 0,
      processedProviderKind: "meilisearch",
      remainingProviderKind: null
    });
    expect(fixture.transport.deleteDocuments).toHaveBeenCalledTimes(1);
    expect(fixture.transport.deleteDocuments).toHaveBeenCalledWith({
      indexUid: "unified_kb_search_delete_active",
      filter: expect.stringContaining('sourceFilePublicId = "file-search-delete"'),
      correlation: expect.stringMatching(/^deletion-documents:/u)
    });
    expect(fixture.transport.deleteIndex).toHaveBeenCalledWith(
      "unified_kb_search_delete_candidate"
    );
    expect(fixture.transport.deleteIndex).not.toHaveBeenCalledWith(
      "unified_kb_search_delete_active"
    );
    expect(fixture.transport.deleteFinishedTasks).not.toHaveBeenCalled();
  });

  it("deduplicates and bounds one directory source page", async () => {
    const fixture = createFixture();
    const deletion = createDeletion(fixture);

    await deletion.deleteSourceScope({
      knowledgeBaseId: "kb-search-delete",
      operationPublicId: "operation-search-delete",
      activeProviderKind: "meilisearch",
      activeProviderIndexUid: "unified_kb_search_delete_active",
      candidateProviderKind: null,
      candidateProviderIndexUid: null,
      sourceFilePublicIds: ["file-a", "file-b", "file-a"]
    });
    expect(fixture.transport.deleteDocuments).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: expect.stringMatching(
          /sourceFilePublicId = "file-a".*sourceFilePublicId = "file-b"/u
        )
      })
    );
    await expect(deletion.deleteSourceScope({
      knowledgeBaseId: "kb-search-delete",
      operationPublicId: "operation-search-delete",
      activeProviderKind: "meilisearch",
      activeProviderIndexUid: "unified_kb_search_delete_active",
      candidateProviderKind: null,
      candidateProviderIndexUid: null,
      sourceFilePublicIds: ["a", "b", "c", "d"]
    })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("deletes at most the active and candidate identities for a whole knowledge base", async () => {
    const fixture = createFixture();
    const deletion = createDeletion(fixture);

    await expect(deletion.deleteKnowledgeBaseScope({
      knowledgeBaseId: "kb-search-delete",
      operationPublicId: "operation-search-delete",
      activeProviderKind: "meilisearch",
      activeProviderIndexUid: "unified_kb_search_delete_active",
      candidateProviderKind: "meilisearch",
      candidateProviderIndexUid: "unified_kb_search_delete_candidate",
      finishedBefore: "2026-08-01T05:59:00.000Z",
      taskFrom: null
    })).resolves.toEqual({
      deletedIndexes: 2,
      deletedTasks: 0,
      nextTaskFrom: null,
      processedProviderKind: "meilisearch",
      remainingProviderKind: null
    });
    expect(fixture.transport.deleteIndex.mock.calls.map((call) => call[0]))
      .toEqual([
        "unified_kb_search_delete_active",
        "unified_kb_search_delete_candidate"
      ]);
    expect(fixture.transport.deleteFinishedTasks).not.toHaveBeenCalled();
    expect(fixture.transport.deleteDocuments).not.toHaveBeenCalled();
  });

  it("never sends an index owned by another provider to the selected provider", async () => {
    const fixture = createFixture();
    const deletion = createDeletion(fixture);

    await expect(deletion.deleteKnowledgeBaseScope({
      knowledgeBaseId: "kb-search-delete",
      operationPublicId: "operation-search-delete",
      activeProviderKind: "opensearch",
      activeProviderIndexUid: "unified_kb_search_delete_active",
      candidateProviderKind: "meilisearch",
      candidateProviderIndexUid: "unified_kb_search_delete_candidate",
      finishedBefore: "2026-08-01T05:59:00.000Z",
      taskFrom: null
    })).resolves.toEqual({
      deletedIndexes: 1,
      deletedTasks: 0,
      nextTaskFrom: null,
      processedProviderKind: "meilisearch",
      remainingProviderKind: "opensearch"
    });
    expect(fixture.transport.deleteIndex.mock.calls.map((call) => call[0]))
      .toEqual(["unified_kb_search_delete_candidate"]);
  });

  it("leaves unrelated indexes and finished tasks untouched", async () => {
    const fixture = createFixture();
    const deletion = createDeletion(fixture);

    await deletion.deleteKnowledgeBaseScope({
      knowledgeBaseId: "kb-search-delete",
      operationPublicId: "operation-search-delete",
      activeProviderKind: "meilisearch",
      activeProviderIndexUid: "unified_kb_search_delete_active",
      candidateProviderKind: null,
      candidateProviderIndexUid: null,
      finishedBefore: "2026-08-01T05:59:00.000Z",
      taskFrom: null
    });
    expect(fixture.indexes.has("unified_other_active")).toBe(true);
    expect(fixture.tasks.has(99)).toBe(true);
  });

  it("leaves provider task history to optional maintenance", async () => {
    const fixture = createFixture();
    const familyPrefix = `unified_${createHash("sha256")
      .update("kb-search-delete").digest("hex").slice(0, 16)}_`;
    fixture.tasks.add(43);
    fixture.transport.listFinishedTasks.mockResolvedValueOnce({
      tasks: [
        {
          taskUid: 43,
          indexUid: `${familyPrefix}retired_candidate_incarnation`,
          status: "failed" as const,
          finishedAt: "2026-08-01T05:00:00.000Z"
        },
        {
          taskUid: 99,
          indexUid: "unified_other_active",
          status: "succeeded" as const,
          finishedAt: "2026-08-01T05:02:00.000Z"
        }
      ],
      next: null
    });
    const deletion = createDeletion(fixture);

    await expect(deletion.deleteKnowledgeBaseScope({
      knowledgeBaseId: "kb-search-delete",
      operationPublicId: "operation-search-delete",
      activeProviderKind: null,
      activeProviderIndexUid: null,
      candidateProviderKind: null,
      candidateProviderIndexUid: null,
      finishedBefore: "2026-08-01T05:59:00.000Z",
      taskFrom: null
    })).resolves.toMatchObject({ deletedTasks: 0, nextTaskFrom: null });

    expect(fixture.tasks.has(43)).toBe(true);
    expect(fixture.tasks.has(99)).toBe(true);
    expect(fixture.transport.listFinishedTasks).not.toHaveBeenCalled();
  });

  it("reports a provider task failure without issuing a duplicate retry task", async () => {
    const fixture = createFixture();
    fixture.failTask = true;
    const deletion = createDeletion(fixture);

    await expect(deletion.deleteSourceScope({
      knowledgeBaseId: "kb-search-delete",
      operationPublicId: "operation-search-delete",
      activeProviderKind: "meilisearch",
      activeProviderIndexUid: "unified_kb_search_delete_active",
      candidateProviderKind: null,
      candidateProviderIndexUid: null,
      sourceFilePublicIds: ["file-search-delete"]
    })).rejects.toMatchObject({ code: "provider_task_failed" });
    expect(fixture.transport.deleteDocuments).toHaveBeenCalledTimes(1);
  });

  it("does not inspect raw provider task timestamps during exact deletion", async () => {
    const fixture = createFixture();
    fixture.transport.listFinishedTasks.mockResolvedValueOnce({
      tasks: [{
        taskUid: 41,
        indexUid: "unified_kb_search_delete_active",
        status: "succeeded" as const,
        finishedAt: "invalid-provider-timestamp"
      }],
      next: null
    });
    const deletion = createDeletion(fixture);

    await expect(deletion.deleteKnowledgeBaseScope({
      knowledgeBaseId: "kb-search-delete",
      operationPublicId: "operation-search-delete",
      activeProviderKind: "meilisearch",
      activeProviderIndexUid: "unified_kb_search_delete_active",
      candidateProviderKind: null,
      candidateProviderIndexUid: null,
      finishedBefore: "2026-08-01T05:59:00.000Z",
      taskFrom: null
    })).resolves.toMatchObject({ deletedIndexes: 1, deletedTasks: 0 });
    expect(fixture.transport.listFinishedTasks).not.toHaveBeenCalled();
    expect(fixture.transport.deleteFinishedTasks).not.toHaveBeenCalled();
  });
});

function createDeletion(fixture: ReturnType<typeof createFixture>) {
  expect(factory).toBeTypeOf("function");
  if (!factory) throw new Error("Storage vNext unified search deletion is unavailable");
  return factory({
    provider: fixture.provider,
    indexUidPrefix: "unified",
    maximumPollAttempts: 2,
    maximumSourceFiles: 3,
    taskPageSize: 10,
    sleep: async () => undefined
  });
}

function createFixture() {
  const indexes = new Set([
    "unified_kb_search_delete_active",
    "unified_kb_search_delete_candidate",
    "unified_other_active"
  ]);
  const tasks = new Set([41, 42, 99]);
  let nextTaskUid = 100;
  const state = { failTask: false };
  const transport = {
    getIndex: vi.fn(async ({ indexUid }: { indexUid: string }) =>
      indexes.has(indexUid) ? { uid: indexUid, primaryKey: "id" } : null),
    deleteDocuments: vi.fn(async () => ({ taskUid: nextTaskUid++ })),
    deleteIndex: vi.fn(async (indexUid: string) => {
      indexes.delete(indexUid);
      return { taskUid: nextTaskUid++ };
    }),
    getTask: vi.fn(async (taskUid: number) => ({
      taskUid,
      status: state.failTask ? "failed" as const : "succeeded" as const,
      errorCode: state.failTask ? "provider_failure" : null
    })),
    listFinishedTasks: vi.fn(async () => ({
      tasks: [
        {
          taskUid: 41,
          indexUid: "unified_kb_search_delete_active",
          status: "succeeded" as const,
          finishedAt: "2026-08-01T05:00:00.000Z"
        },
        {
          taskUid: 42,
          indexUid: "unified_kb_search_delete_candidate",
          status: "failed" as const,
          finishedAt: "2026-08-01T05:01:00.000Z"
        },
        {
          taskUid: 99,
          indexUid: "unified_other_active",
          status: "succeeded" as const,
          finishedAt: "2026-08-01T05:02:00.000Z"
        }
      ],
      next: null
    })),
    deleteFinishedTasks: vi.fn(async ({ taskUids }: { taskUids: readonly number[] }) => {
      for (const taskUid of taskUids) tasks.delete(taskUid);
      return { taskUid: nextTaskUid++ };
    })
  };
  const provider = createMeilisearchProviderRuntime(
    transport as unknown as MeilisearchClientPort
  );
  return {
    transport,
    provider,
    indexes,
    tasks,
    get failTask() {
      return state.failTask;
    },
    set failTask(value: boolean) {
      state.failTask = value;
    }
  };
}

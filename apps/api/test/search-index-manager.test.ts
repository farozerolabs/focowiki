import { describe, expect, it, vi } from "vitest";
import type {
  SearchEngineSettings,
  SearchEngineTransport
} from "../src/application/ports/search-engine-transport.js";
import { createSearchIndexManager } from "../src/search/search-index-manager.js";

const settings: SearchEngineSettings = {
  searchableAttributes: ["title", "body"],
  filterableAttributes: ["sourceFileId"],
  displayedAttributes: ["id", "sourceFileId", "title", "body"],
  sortableAttributes: [],
  rankingRules: ["words", "typo", "proximity", "attribute", "sort", "exactness"],
  distinctAttribute: "sourceFileId",
  pagination: { maxTotalHits: 1000 },
  searchCutoffMs: 500,
  localizedAttributes: [],
  typoTolerance: { disableOnAttributes: [] }
};

describe("search index manager", () => {
  it("waits for index settings before allowing document submission", async () => {
    const calls: string[] = [];
    const transport = fakeTransport({
      async getIndex() {
        calls.push("get-index");
        return null;
      },
      async createIndex() {
        calls.push("create-index");
        return { taskUid: 1 };
      },
      async updateSettings() {
        calls.push("update-settings");
        return { taskUid: 2 };
      },
      async getSettings() {
        calls.push("get-settings");
        return settings;
      },
      async getTask(uid) {
        calls.push(`task-${uid}`);
        return { taskUid: uid, status: "succeeded", errorCode: null };
      }
    });
    const manager = createSearchIndexManager({
      transport,
      pollIntervalMs: 1,
      taskTimeoutMs: 100,
      sleep: async () => undefined
    });

    await manager.prepareStagingIndex({
      indexUid: "content_staging_1",
      primaryKey: "id",
      settings,
      settingsChecksum: manager.settingsChecksum(settings),
      buildId: "content-build-1"
    });

    expect(calls).toEqual([
      "get-index",
      "create-index",
      "task-1",
      "update-settings",
      "task-2",
      "get-settings",
      "task-1"
    ]);
  });

  it("rejects incompatible primary keys and failed tasks", async () => {
    const manager = createSearchIndexManager({
      transport: fakeTransport({
        async getIndex() {
          return { uid: "content", primaryKey: "legacy_id" };
        }
      }),
      pollIntervalMs: 1,
      taskTimeoutMs: 100,
      sleep: async () => undefined
    });

    await expect(manager.prepareStagingIndex({
      indexUid: "content",
      primaryKey: "id",
      settings,
      settingsChecksum: manager.settingsChecksum(settings),
      buildId: "content-build-1"
    })).rejects.toMatchObject({
      code: "SEARCH_INDEX_INCOMPATIBLE"
    });
  });

  it("atomically activates both staging indexes and detects completed replay", async () => {
    const calls: string[] = [];
    const activeBuilds = new Map<string, string | null>([
      ["content_staging_1", "content-build-1"],
      ["graph_staging_1", "graph-build-1"]
    ]);
    const manager = createSearchIndexManager({
      transport: fakeTransport({
        async getIndex(input) {
          calls.push(`get-${input.indexUid}`);
          return activeBuilds.has(input.indexUid)
            ? { uid: input.indexUid, primaryKey: "id" }
            : null;
        },
        async getDocument(input) {
          return activeBuilds.get(input.indexUid)
            ? {
                id: input.documentId,
                buildId: activeBuilds.get(input.indexUid)
              }
            : null;
        },
        async createIndex(input) {
          calls.push(`create-${input.indexUid}`);
          activeBuilds.set(input.indexUid, null);
          return { taskUid: 3 };
        },
        async swapIndexes(input) {
          calls.push(`swap-${input.pairs.map((pair) =>
            `${pair.left}:${pair.right}`).join(",")}`);
          for (const pair of input.pairs) {
            const left = activeBuilds.get(pair.left) ?? null;
            activeBuilds.set(pair.left, activeBuilds.get(pair.right) ?? null);
            activeBuilds.set(pair.right, left);
          }
          return { taskUid: 4 };
        },
        async getTask(uid) {
          calls.push(`task-${uid}`);
          return { taskUid: uid, status: "succeeded", errorCode: null };
        }
      }),
      pollIntervalMs: 1,
      taskTimeoutMs: 100,
      sleep: async () => undefined
    });

    const activation = [{
      activeUid: "content_active",
      stagingUid: "content_staging_1",
      primaryKey: "id",
      buildId: "content-build-1"
    }, {
      activeUid: "graph_active",
      stagingUid: "graph_staging_1",
      primaryKey: "id",
      buildId: "graph-build-1"
    }];
    await manager.activateStagingIndexes(activation);
    await manager.activateStagingIndexes(activation);

    expect(calls).toEqual([
      "get-content_active",
      "create-content_active",
      "task-3",
      "get-content_staging_1",
      "get-graph_active",
      "create-graph_active",
      "task-3",
      "get-graph_staging_1",
      "swap-content_active:content_staging_1,graph_active:graph_staging_1",
      "task-4",
      "get-content_active",
      "get-graph_active"
    ]);
  });

  it("recovers an accepted index swap before submitting a duplicate", async () => {
    const transport = fakeTransport({
      getIndex: vi.fn(async ({ indexUid }) => ({
        uid: indexUid,
        primaryKey: "id"
      })),
      getDocument: vi.fn(async ({ indexUid }) => ({
        buildId: indexUid.includes("staging")
          ? "content-build-2"
          : "content-build-1"
      })),
      findIndexSwapTask: vi.fn(async () => ({
        taskUid: 77,
        status: "processing" as const,
        errorCode: null
      })),
      swapIndexes: vi.fn()
    });
    const manager = createSearchIndexManager({
      transport,
      pollIntervalMs: 1,
      taskTimeoutMs: 100,
      sleep: async () => undefined
    });
    const pairs = [{
      activeUid: "content-active",
      stagingUid: "content-staging-2",
      primaryKey: "id",
      buildId: "content-build-2"
    }];

    await expect(manager.submitStagingIndexActivation(pairs)).resolves.toEqual({
      taskUid: 77
    });
    expect(transport.findIndexSwapTask).toHaveBeenCalledWith({
      pairs: [{
        left: "content-active",
        right: "content-staging-2"
      }]
    });
    expect(transport.swapIndexes).not.toHaveBeenCalled();
  });

  it("submits an index swap without polling so the task UID can be persisted", async () => {
    const transport = fakeTransport({
      async getIndex(input) {
        return { uid: input.indexUid, primaryKey: "id" };
      },
      async getDocument(input) {
        return input.indexUid.endsWith("_staging_1")
          ? { id: input.documentId, buildId: "content-build-1" }
          : null;
      },
      async swapIndexes() {
        return { taskUid: 91 };
      }
    });
    const manager = createSearchIndexManager({
      transport,
      pollIntervalMs: 1,
      taskTimeoutMs: 100,
      sleep: async () => undefined
    });

    await expect(manager.submitStagingIndexActivation([{
      activeUid: "content_active",
      stagingUid: "content_staging_1",
      primaryKey: "id",
      buildId: "content-build-1"
    }])).resolves.toEqual({ taskUid: 91 });

    expect(transport.getTask).not.toHaveBeenCalled();
  });
});

function fakeTransport(
  overrides: Partial<SearchEngineTransport>
): SearchEngineTransport {
  return {
    health: vi.fn(async () => ({ available: true })),
    getPressure: vi.fn(),
    createIndex: vi.fn(async () => ({ taskUid: 1 })),
    getIndex: vi.fn(async () => null),
    getSettings: vi.fn(async () => settings),
    updateSettings: vi.fn(async () => ({ taskUid: 1 })),
    addDocuments: vi.fn(async () => ({ taskUid: 1 })),
    getDocument: vi.fn(async () => null),
    deleteDocuments: vi.fn(async () => ({ taskUid: 1 })),
    deleteIndex: vi.fn(async () => ({ taskUid: 1 })),
    swapIndexes: vi.fn(async () => ({ taskUid: 1 })),
    getTask: vi.fn(async (taskUid: number) => ({
      taskUid,
      status: "succeeded" as const,
      errorCode: null
    })),
    search: vi.fn(async () => ({
      hits: [],
      estimatedTotalHits: 0,
      processingTimeMs: 1
    })),
    ...overrides
  };
}

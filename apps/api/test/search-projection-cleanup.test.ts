import { describe, expect, it, vi } from "vitest";
import type {
  SearchEngineTransport
} from "../src/application/ports/search-engine-transport.js";
import type {
  SearchProjectionStateRepository
} from "../src/application/ports/search-projection-state-repository.js";
import {
  createSearchProjectionCleanup
} from "../src/search/search-projection-cleanup.js";

describe("search projection cleanup", () => {
  it("deletes stable and pending staging indexes for the knowledge base", async () => {
    const transport = fakeTransport();
    const cleanup = createSearchProjectionCleanup({
      transport,
      states: fakeStates(),
      indexPrefix: "focowiki",
      taskPollIntervalMs: 1,
      taskTimeoutMs: 1_000
    });

    await cleanup.deleteKnowledgeBase({
      knowledgeBaseId: "kb-one",
      correlation: "hard-delete-one"
    });

    expect(transport.deleteIndex).toHaveBeenCalledTimes(4);
    expect(transport.deleteIndex).toHaveBeenCalledWith(expect.stringMatching(
      /^focowiki_content_[a-f0-9]{16}$/u
    ));
    expect(transport.deleteIndex).toHaveBeenCalledWith(expect.stringMatching(
      /^focowiki_content_[a-f0-9]{16}_staging_3$/u
    ));
    expect(transport.deleteIndex).toHaveBeenCalledWith(expect.stringMatching(
      /^focowiki_graph_[a-f0-9]{16}$/u
    ));
    expect(transport.deleteIndex).toHaveBeenCalledWith(expect.stringMatching(
      /^focowiki_graph_[a-f0-9]{16}_staging_3$/u
    ));
    expect(transport.deleteDocuments).not.toHaveBeenCalled();
    expect(transport.getTask).toHaveBeenCalledTimes(4);
  });
});

function fakeStates(): SearchProjectionStateRepository {
  return {
    getState: vi.fn(async () => ({
      knowledgeBaseId: "kb-one",
      routeState: "meilisearch" as const,
      activeEpoch: 2,
      pendingEpoch: 3,
      pendingActivationState: "indexing" as const,
      pendingFullRebuild: true,
      activeGenerationId: "generation-active",
      pendingGenerationId: "generation-next",
      contentSchemaVersion: "content-v1",
      graphSchemaVersion: "graph-v1",
      contentSettingsChecksum: "a".repeat(64),
      graphSettingsChecksum: "b".repeat(64),
      pendingContentSchemaVersion: "content-v2",
      pendingGraphSchemaVersion: "graph-v2",
      pendingContentSettingsChecksum: "c".repeat(64),
      pendingGraphSettingsChecksum: "d".repeat(64),
      maintenanceRequired: true,
      updatedAt: "2026-07-29T00:00:00.000Z"
    })),
    reservePendingEpoch: vi.fn(),
    createWork: vi.fn(),
    getEpochProgress: vi.fn(),
    claimWork: vi.fn(),
    markSubmitted: vi.fn(),
    markSucceeded: vi.fn(),
    retryOrFail: vi.fn(),
    restartFailedEpoch: vi.fn(),
    rebaseFailedEpoch: vi.fn(),
    retryFailedCleanup: vi.fn(),
    beginActivation: vi.fn(),
    activateEpoch: vi.fn(),
    cancelForKnowledgeBase: vi.fn()
  };
}

function fakeTransport(): SearchEngineTransport {
  let taskUid = 0;
  return {
    health: vi.fn(),
    getPressure: vi.fn(),
    createIndex: vi.fn(),
    getIndex: vi.fn(async ({ indexUid }) => ({
      uid: indexUid,
      primaryKey: "id"
    })),
    getDocument: vi.fn(),
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
    addDocuments: vi.fn(),
    deleteDocuments: vi.fn(async () => ({ taskUid: taskUid += 1 })),
    deleteIndex: vi.fn(async () => ({ taskUid: taskUid += 1 })),
    swapIndexes: vi.fn(),
    getTask: vi.fn(async (uid) => ({
      taskUid: uid,
      status: "succeeded" as const,
      errorCode: null
    })),
    search: vi.fn()
  };
}

import { describe, expect, it, vi } from "vitest";
import type {
  SearchProjectionStateRepository
} from "../src/application/ports/search-projection-state-repository.js";
import {
  ensureSearchProjectionWork,
  readSearchProjectionCoordinationStatus
} from "../src/search/search-indexing-coordinator.js";

describe("search indexing coordinator", () => {
  it("delegates projection scanning to durable planning work", async () => {
    const created: Array<{ workKind: string; indexKind: string }> = [];
    const states = fakeStates({
      getState: vi.fn(async () => searchState({
        activeGenerationId: null,
        routeState: "postgres_compatibility"
      })),
      reservePendingEpoch: vi.fn(async () => ({
        outcome: "reserved" as const,
        state: searchState({
          activeGenerationId: null,
          pendingEpoch: 1,
          pendingGenerationId: "generation-one"
        })
      })),
      createWork: vi.fn(async (work) => {
        created.push(...work);
        return work.length;
      }),
      getEpochProgress: vi.fn(async () => ({
        total: created.length,
        queued: created.length,
        submitted: 0,
        retry: 0,
        succeeded: 0,
        failed: 0,
        canceled: 0,
        superseded: 0,
        activationReady: false
      }))
    });
    await ensureSearchProjectionWork({
      states,
      knowledgeBaseId: "kb-one",
      generationId: "generation-one",
      maintenanceRequestId: "maintenance-one",
      forceCompatibilityCutover: true,
      maxAttempts: 5,
      contract: searchContract(),
      now: "2026-07-29T00:00:00.000Z"
    });

    expect(created.map((work) => `${work.indexKind}:${work.workKind}`)).toEqual([
      "content:prepare_index",
      "content:plan_documents",
      "graph:prepare_index",
      "graph:plan_documents",
      "content:validate",
      "graph:validate",
      "content:activate",
      "content:cleanup",
      "graph:cleanup"
    ]);
  });

  it("streams deterministic work for a new knowledge base", async () => {
    const created: Array<{ workKind: string; indexKind: string }> = [];
    const states = fakeStates({
      getState: vi.fn(async () => searchState({
        activeGenerationId: null,
        routeState: "postgres_compatibility"
      })),
      reservePendingEpoch: vi.fn(async () => ({
        outcome: "reserved" as const,
        state: searchState({
          activeGenerationId: null,
          pendingEpoch: 1,
          pendingGenerationId: "generation-one"
        })
      })),
      createWork: vi.fn(async (work) => {
        created.push(...work);
        return work.length;
      }),
      getEpochProgress: vi.fn(async () => ({
        total: created.length,
        queued: created.length,
        submitted: 0,
        retry: 0,
        succeeded: 0,
        failed: 0,
        canceled: 0,
        superseded: 0,
        activationReady: false
      }))
    });
    const result = await ensureSearchProjectionWork({
      states,
      knowledgeBaseId: "kb-one",
      generationId: "generation-one",
      maintenanceRequestId: null,
      forceCompatibilityCutover: false,
      maxAttempts: 5,
      contract: searchContract(),
      now: "2026-07-29T00:00:00.000Z"
    });

    expect(result.status).toBe("pending");
    expect(created.map((work) => `${work.indexKind}:${work.workKind}`)).toEqual([
      "content:prepare_index",
      "content:plan_documents",
      "graph:prepare_index",
      "graph:plan_documents",
      "content:validate",
      "graph:validate",
      "content:activate",
      "content:cleanup",
      "graph:cleanup"
    ]);
  });

  it("creates planning work independently from projection page size", async () => {
    const states = fakeStates({
      getState: vi.fn(async () => searchState({
        activeGenerationId: null,
        routeState: "postgres_compatibility"
      })),
      reservePendingEpoch: vi.fn(async () => ({
        outcome: "reserved" as const,
        state: searchState({
          activeGenerationId: null,
          pendingEpoch: 1,
          pendingGenerationId: "generation-one"
        })
      })),
      createWork: vi.fn(async (work) => work.length),
      getEpochProgress: vi.fn(async () => ({
        total: 4,
        queued: 4,
        submitted: 0,
        retry: 0,
        succeeded: 0,
        failed: 0,
        canceled: 0,
        superseded: 0,
        activationReady: false
      }))
    });
    await expect(ensureSearchProjectionWork({
      states,
      knowledgeBaseId: "kb-one",
      generationId: "generation-one",
      maintenanceRequestId: null,
      forceCompatibilityCutover: false,
      maxAttempts: 5,
      contract: searchContract(),
      now: "2026-07-29T00:00:00.000Z"
    })).resolves.toEqual({ status: "pending", epoch: 1 });

    expect(states.createWork).toHaveBeenCalledTimes(3);
  });

  it("keeps released PostgreSQL search until explicit maintenance", async () => {
    const states = fakeStates({
      getState: vi.fn(async () => searchState({
        activeGenerationId: "generation-active",
        routeState: "postgres_compatibility"
      }))
    });

    const result = await ensureSearchProjectionWork({
      states,
      knowledgeBaseId: "kb-one",
      generationId: "generation-next",
      maintenanceRequestId: null,
      forceCompatibilityCutover: false,
      maxAttempts: 5,
      contract: searchContract(),
      now: "2026-07-29T00:00:00.000Z"
    });

    expect(result).toEqual({ status: "compatibility", epoch: null });
    expect(states.reservePendingEpoch).not.toHaveBeenCalled();
  });

  it("does not create another epoch after maintenance activated the current contract", async () => {
    const contract = searchContract();
    const states = fakeStates({
      getState: vi.fn(async () => searchState({
        routeState: "meilisearch",
        activeEpoch: 1,
        activeGenerationId: "generation-active",
        maintenanceRequired: false,
        contentSchemaVersion: contract.contentSchemaVersion,
        graphSchemaVersion: contract.graphSchemaVersion,
        contentSettingsChecksum: contract.contentSettingsChecksum,
        graphSettingsChecksum: contract.graphSettingsChecksum
      }))
    });

    await expect(ensureSearchProjectionWork({
      states,
      knowledgeBaseId: "kb-one",
      generationId: "generation-active",
      maintenanceRequestId: "maintenance-one",
      forceCompatibilityCutover: true,
      maxAttempts: 5,
      contract,
      now: "2026-07-29T00:00:00.000Z"
    })).resolves.toEqual({ status: "ready", epoch: 1 });

    expect(states.reservePendingEpoch).not.toHaveBeenCalled();
  });

  it("forces a full rebuild when the active physical indexes are unavailable", async () => {
    const contract = searchContract();
    const created: Array<{ workKind: string; indexKind: string }> = [];
    const states = fakeStates({
      getState: vi.fn(async () => searchState({
        routeState: "meilisearch",
        activeEpoch: 3,
        activeGenerationId: "generation-active",
        maintenanceRequired: false,
        contentSchemaVersion: contract.contentSchemaVersion,
        graphSchemaVersion: contract.graphSchemaVersion,
        contentSettingsChecksum: contract.contentSettingsChecksum,
        graphSettingsChecksum: contract.graphSettingsChecksum
      })),
      reservePendingEpoch: vi.fn(async () => ({
        outcome: "reserved" as const,
        state: searchState({
          routeState: "meilisearch",
          activeEpoch: 3,
          activeGenerationId: "generation-active",
          pendingEpoch: 4,
          pendingGenerationId: "generation-active",
          pendingFullRebuild: true,
          pendingContentSchemaVersion: contract.contentSchemaVersion,
          pendingGraphSchemaVersion: contract.graphSchemaVersion,
          pendingContentSettingsChecksum: contract.contentSettingsChecksum,
          pendingGraphSettingsChecksum: contract.graphSettingsChecksum
        })
      })),
      createWork: vi.fn(async (work) => {
        created.push(...work);
        return work.length;
      }),
      getEpochProgress: vi.fn(async () => ({
        total: created.length,
        queued: created.length,
        submitted: 0,
        retry: 0,
        succeeded: 0,
        failed: 0,
        canceled: 0,
        superseded: 0,
        activationReady: false
      }))
    });
    await expect(ensureSearchProjectionWork({
      states,
      knowledgeBaseId: "kb-one",
      generationId: "generation-active",
      maintenanceRequestId: "maintenance-data-loss",
      forceCompatibilityCutover: true,
      forceFullRebuild: true,
      maxAttempts: 5,
      contract,
      now: "2026-07-29T00:01:00.000Z"
    })).resolves.toEqual({ status: "pending", epoch: 4 });

    expect(states.reservePendingEpoch).toHaveBeenCalledWith(
      expect.objectContaining({ forceFullRebuild: true })
    );
    expect(created.map((work) => work.workKind)).toContain("plan_documents");
  });

  it("reports a pending publication without rescanning projection records", async () => {
    const states = fakeStates({
      getState: vi.fn(async () => searchState({
        routeState: "meilisearch",
        activeGenerationId: "generation-active",
        pendingEpoch: 2,
        pendingGenerationId: "generation-next"
      })),
      getEpochProgress: vi.fn(async () => ({
        total: 4,
        queued: 1,
        submitted: 0,
        retry: 0,
        succeeded: 3,
        failed: 0,
        canceled: 0,
        superseded: 0,
        activationReady: false
      }))
    });

    await expect(readSearchProjectionCoordinationStatus({
      states,
      knowledgeBaseId: "kb-one",
      generationId: "generation-next"
    })).resolves.toEqual({ status: "pending", epoch: 2 });
  });

  it("restarts a cleaned failed epoch before replanning the same generation", async () => {
    const states = fakeStates({
      getState: vi.fn(async () => searchState({
        routeState: "postgres_compatibility",
        activeGenerationId: "generation-active",
        pendingEpoch: 1,
        pendingGenerationId: "generation-active",
        pendingContentSchemaVersion: "content-v1",
        pendingGraphSchemaVersion: "graph-v1",
        pendingContentSettingsChecksum: "a".repeat(64),
        pendingGraphSettingsChecksum: "b".repeat(64)
      })),
      reservePendingEpoch: vi.fn(async () => ({
        outcome: "existing" as const,
        state: searchState({
          routeState: "postgres_compatibility",
          activeGenerationId: "generation-active",
          pendingEpoch: 1,
          pendingGenerationId: "generation-active",
          pendingContentSchemaVersion: "content-v1",
          pendingGraphSchemaVersion: "graph-v1",
          pendingContentSettingsChecksum: "a".repeat(64),
          pendingGraphSettingsChecksum: "b".repeat(64)
        })
      })),
      getEpochProgress: vi.fn()
        .mockResolvedValueOnce({
          total: 8,
          queued: 0,
          submitted: 0,
          retry: 0,
          succeeded: 6,
          failed: 1,
          canceled: 1,
          superseded: 0,
          activationReady: false
        })
        .mockResolvedValueOnce({
          total: 8,
          queued: 8,
          submitted: 0,
          retry: 0,
          succeeded: 0,
          failed: 0,
          canceled: 0,
          superseded: 0,
          activationReady: false
        }),
      restartFailedEpoch: vi.fn(async () => true),
      createWork: vi.fn(async () => 0)
    });

    await expect(ensureSearchProjectionWork({
      states,
      knowledgeBaseId: "kb-one",
      generationId: "generation-active",
      maintenanceRequestId: "maintenance-retry",
      forceCompatibilityCutover: true,
      maxAttempts: 5,
      contract: searchContract(),
      now: "2026-07-29T00:05:00.000Z"
    })).resolves.toEqual({ status: "pending", epoch: 1 });

    expect(states.restartFailedEpoch).toHaveBeenCalledWith(expect.objectContaining({
      knowledgeBaseId: "kb-one",
      generationId: "generation-active",
      epoch: 1,
      resetAll: true
    }));
  });

  it("schedules missing cleanup work before retrying an unsafe partial epoch", async () => {
    const created: Array<{ workKind: string; indexKind: string }> = [];
    const states = fakeStates({
      getState: vi.fn(async () => searchState({
        routeState: "postgres_compatibility",
        activeGenerationId: "generation-active",
        pendingEpoch: 1,
        pendingGenerationId: "generation-active",
        pendingFullRebuild: true,
        pendingContentSchemaVersion: "content-v1",
        pendingGraphSchemaVersion: "graph-v1",
        pendingContentSettingsChecksum: "a".repeat(64),
        pendingGraphSettingsChecksum: "b".repeat(64)
      })),
      reservePendingEpoch: vi.fn(async () => ({
        outcome: "existing" as const,
        state: searchState({
          routeState: "postgres_compatibility",
          activeGenerationId: "generation-active",
          pendingEpoch: 1,
          pendingGenerationId: "generation-active",
          pendingFullRebuild: true,
          pendingContentSchemaVersion: "content-v1",
          pendingGraphSchemaVersion: "graph-v1",
          pendingContentSettingsChecksum: "a".repeat(64),
          pendingGraphSettingsChecksum: "b".repeat(64)
        })
      })),
      getEpochProgress: vi.fn(async () => ({
        total: 92,
        queued: 0,
        submitted: 0,
        retry: 0,
        succeeded: 0,
        failed: 1,
        canceled: 91,
        superseded: 0,
        activationReady: false
      })),
      restartFailedEpoch: vi.fn(async () => false),
      retryFailedCleanup: vi.fn(async () => 0),
      createWork: vi.fn(async (work) => {
        created.push(...work);
        return work.length;
      })
    });
    await expect(ensureSearchProjectionWork({
      states,
      knowledgeBaseId: "kb-one",
      generationId: "generation-active",
      maintenanceRequestId: "maintenance-recovery",
      forceCompatibilityCutover: true,
      maxAttempts: 5,
      contract: searchContract(),
      now: "2026-07-29T00:05:00.000Z"
    })).resolves.toEqual({ status: "pending", epoch: 1 });

    expect(created.map((work) => `${work.indexKind}:${work.workKind}`)).toEqual([
      "content:cleanup",
      "graph:cleanup"
    ]);
    expect(states.retryFailedCleanup).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-one",
      generationId: "generation-active",
      maintenanceRequestId: "maintenance-recovery",
      epoch: 1,
      maxAttempts: 5,
      retriedAt: "2026-07-29T00:05:00.000Z"
    });
  });

  it("rebases a cleaned failed epoch onto a newer generation with a full rebuild", async () => {
    const created: Array<{ generationId: string | null }> = [];
    const failedState = searchState({
      routeState: "meilisearch",
      activeEpoch: 1,
      activeGenerationId: "generation-active",
      pendingEpoch: 2,
      pendingGenerationId: "generation-failed"
    });
    const rebasedState = searchState({
      routeState: "meilisearch",
      activeEpoch: 1,
      activeGenerationId: "generation-active",
      pendingEpoch: 2,
      pendingGenerationId: "generation-next",
      pendingFullRebuild: true,
      pendingContentSchemaVersion: "content-v1",
      pendingGraphSchemaVersion: "graph-v1",
      pendingContentSettingsChecksum: "a".repeat(64),
      pendingGraphSettingsChecksum: "b".repeat(64)
    });
    const states = fakeStates({
      getState: vi.fn(async () => failedState),
      reservePendingEpoch: vi.fn(async () => ({
        outcome: "busy" as const,
        state: failedState
      })),
      getEpochProgress: vi.fn()
        .mockResolvedValueOnce({
          total: 8,
          queued: 0,
          submitted: 0,
          retry: 0,
          succeeded: 6,
          failed: 1,
          canceled: 1,
          superseded: 0,
          activationReady: false
        })
        .mockResolvedValueOnce({
          total: 8,
          queued: 8,
          submitted: 0,
          retry: 0,
          succeeded: 0,
          failed: 0,
          canceled: 0,
          superseded: 0,
          activationReady: false
        }),
      rebaseFailedEpoch: vi.fn(async () => rebasedState),
      createWork: vi.fn(async (work) => {
        created.push(...work);
        return work.length;
      })
    });
    await expect(ensureSearchProjectionWork({
      states,
      knowledgeBaseId: "kb-one",
      generationId: "generation-next",
      maintenanceRequestId: null,
      forceCompatibilityCutover: true,
      maxAttempts: 5,
      contract: searchContract(),
      now: "2026-07-29T00:06:00.000Z"
    })).resolves.toEqual({ status: "pending", epoch: 2 });

    expect(states.rebaseFailedEpoch).toHaveBeenCalledWith(expect.objectContaining({
      knowledgeBaseId: "kb-one",
      generationId: "generation-next",
      epoch: 2
    }));
    expect(created.every((work) => work.generationId === "generation-next")).toBe(true);
  });
});

function searchContract() {
  return {
    contentSchemaVersion: "content-v1",
    graphSchemaVersion: "graph-v1",
    contentSettingsChecksum: "a".repeat(64),
    graphSettingsChecksum: "b".repeat(64)
  };
}

function fakeStates(
  overrides: Partial<SearchProjectionStateRepository>
): SearchProjectionStateRepository {
  return {
    getState: vi.fn(),
    reservePendingEpoch: vi.fn(),
    createWork: vi.fn(),
    getEpochProgress: vi.fn(),
    claimWork: vi.fn(),
    markSubmitted: vi.fn(),
    markSucceeded: vi.fn(),
    continuePlanning: vi.fn(),
    retryOrFail: vi.fn(),
    restartFailedEpoch: vi.fn(),
    rebaseFailedEpoch: vi.fn(),
    retryFailedCleanup: vi.fn(),
    beginActivation: vi.fn(),
    activateEpoch: vi.fn(),
    cancelForKnowledgeBase: vi.fn(),
    ...overrides
  };
}

function searchState(overrides: Record<string, unknown> = {}) {
  return {
    knowledgeBaseId: "kb-one",
    routeState: "postgres_compatibility" as const,
    activeEpoch: 0,
    pendingEpoch: null,
    pendingActivationState: "indexing" as const,
    pendingFullRebuild: false,
    activeGenerationId: null,
    pendingGenerationId: null,
    contentSchemaVersion: null,
    graphSchemaVersion: null,
    contentSettingsChecksum: null,
    graphSettingsChecksum: null,
    pendingContentSchemaVersion: null,
    pendingGraphSchemaVersion: null,
    pendingContentSettingsChecksum: null,
    pendingGraphSettingsChecksum: null,
    maintenanceRequired: true,
    updatedAt: "2026-07-29T00:00:00.000Z",
    ...overrides
  };
}

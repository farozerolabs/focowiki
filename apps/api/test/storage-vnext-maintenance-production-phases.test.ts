import { describe, expect, it, vi } from "vitest";
import {
  createStorageVnextMaintenanceProductionPhases
} from "../src/storage-vnext/maintenance/production-phases.js";
import { createStorageVnextMaintenanceCandidatePublicId } from
  "../src/storage-vnext/maintenance/identity.js";
import type { StorageVnextMaintenanceCheckpoint } from
  "../src/storage-vnext/maintenance/ports.js";

describe("storage vNext maintenance production phases", () => {
  it("rebuilds and activates the same unified search and release candidate", async () => {
    const candidatePublicId = createStorageVnextMaintenanceCandidatePublicId({
      knowledgeBaseId: "kb-maintenance",
      operationPublicId: "operation-maintenance"
    });
    const prepareCandidate = vi.fn();
    const validateCandidate = vi.fn();
    const queryCases = [{
      kind: "exact" as const,
      query: "Alpha",
      attributesToSearchOn: ["title"],
      documentKind: "content" as const,
      limit: 10,
      relevantSources: [{ sourceFilePublicId: "file-alpha", relevance: 3 }],
      minimumRecall: 1,
      minimumNdcg: 1
    }];
    const reconcile = vi.fn(async () => ({ sourceCount: 2, edgeCount: 3 }));
    const publish = vi.fn(async () => ({ artifactCount: 9 }));
    const cleanupCandidateObjects = vi.fn(async () => ({
      outcome: "phase_completed" as const,
      cursor: null,
      completedDelta: 2,
      expectedCount: 2,
      processedBytesDelta: 0,
      batchOrdinalDelta: 1
    }));
    const validateRelease = vi.fn(async () => ({ manifestChecksum: "d".repeat(64) }));
    const activateCandidate = vi.fn(async () => ({
      outcome: "activated" as const,
      snapshot: {
        knowledgeBaseId: "kb-maintenance",
        releaseRootPublicId: "maintenance-root",
        searchProjectionPublicId: candidatePublicId,
        manifestChecksum: "d".repeat(64),
        revision: 8,
        activatedByOperationPublicId: "operation-maintenance",
        publiclyVisibleAt: "2026-08-02T00:00:00.000Z"
      },
      rollbackRootPublicId: "root-active"
    }));
    const phases = createStorageVnextMaintenanceProductionPhases({
      planner: {
        plan: vi.fn(async () => ({
          candidatePublicId,
          candidateRootPublicId: "maintenance-root",
          sourceCount: 2,
          directoryCount: 1
        }))
      },
      catalog: {
        getKnowledgeBase: vi.fn(async () => ({
          publicId: "kb-maintenance",
          revision: 11,
          visibility: "current" as const
        }))
      },
      releases: {
        hasCandidateCatalogEntries: vi.fn(async () => false),
        getActiveRoot: vi.fn(async () => ({ publicId: "root-active", revision: 7 })),
        getLiveCandidate: vi.fn(async () => ({
          publicId: candidatePublicId,
          knowledgeBaseId: "kb-maintenance",
          operationPublicId: "operation-maintenance",
          expectedActiveRootPublicId: "root-active",
          expectedActiveRevision: 7
        })),
        activateCandidate
      },
      pipeline: {
        schemaChecksum: "a".repeat(64),
        settingsChecksum: "b".repeat(64),
        searchLifecycle: { prepareCandidate },
        searchValidation: { validateCandidate },
        buildSearchCandidate: vi.fn(async () => ({
          sourceCount: 2,
          graphSeedCount: 2,
          documentCount: 6,
          batchCount: 3,
          compressedBytes: 512,
          documentChecksum: "c".repeat(64),
          queryCases
        })),
        graphReconciler: { reconcile },
        artifacts: { publish },
        releaseValidation: { validate: validateRelease }
      },
      objectReconciliation: {
        runPage: vi.fn(async () => ({
          outcome: "phase_completed" as const,
          cursor: null,
          completedDelta: 0,
          expectedCount: 0,
          processedBytesDelta: 0,
          batchOrdinalDelta: 1
        }))
      },
      candidateObjectCleanup: { runPage: cleanupCandidateObjects },
      clock: () => "2026-08-02T00:00:00.000Z",
      rollbackRetentionMilliseconds: 86_400_000,
      resultRetentionMilliseconds: 86_400_000
    });

    for (const phase of [
      "planning",
      "search_rebuild",
      "projection_repair",
      "catch_up",
      "validation",
      "activation",
      "cleanup"
    ] as const) {
      await expect(phases.runPhase({
        knowledgeBaseId: "kb-maintenance",
        operationPublicId: "operation-maintenance",
        checkpoint: checkpoint(phase),
        searchProjection: {
          activeRole: "active",
          candidateRole: "candidate",
          documentKinds: ["content", "graph_seed"]
        },
        signal: new AbortController().signal
      })).resolves.toMatchObject({ outcome: "phase_completed" });
    }

    expect(prepareCandidate).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-maintenance",
      candidatePublicId,
      schemaChecksum: "a".repeat(64),
      settingsChecksum: "b".repeat(64)
    });
    expect(validateCandidate).toHaveBeenCalledWith(expect.objectContaining({
      candidatePublicId,
      expectedDocumentCount: 6,
      documentChecksum: "c".repeat(64),
      queryCases
    }));
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({
      candidatePublicId,
      searchProjectionPublicId: candidatePublicId
    }));
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      candidatePublicId
    }));
    expect(validateRelease).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-maintenance",
      candidatePublicId,
      searchProjectionPublicId: candidatePublicId
    });
    expect(activateCandidate).toHaveBeenCalledWith(expect.objectContaining({
      candidatePublicId,
      searchProjectionPublicId: candidatePublicId,
      expectedActiveRootPublicId: "root-active",
      expectedActiveRevision: 7
    }));
    expect(cleanupCandidateObjects).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-maintenance",
      operationPublicId: "operation-maintenance",
      signal: expect.any(AbortSignal)
    });
  });

  it("resumes artifact publication without repeating a completed graph reconciliation", async () => {
    const reconcile = vi.fn(async () => ({ sourceCount: 2, edgeCount: 3 }));
    const publish = vi.fn(async () => ({ artifactCount: 9 }));
    const phases = createStorageVnextMaintenanceProductionPhases({
      planner: { plan: vi.fn() },
      catalog: { getKnowledgeBase: vi.fn() },
      releases: {
        hasCandidateCatalogEntries: vi.fn(async () => true),
        getActiveRoot: vi.fn(),
        getLiveCandidate: vi.fn(),
        activateCandidate: vi.fn()
      },
      pipeline: {
        ...pipelineFixture(),
        graphReconciler: { reconcile },
        artifacts: { publish }
      },
      objectReconciliation: { runPage: vi.fn() },
      candidateObjectCleanup: { runPage: vi.fn() },
      clock: () => "2026-08-02T00:00:00.000Z",
      rollbackRetentionMilliseconds: 1,
      resultRetentionMilliseconds: 1
    });

    await expect(phases.runPhase({
      knowledgeBaseId: "kb-maintenance",
      operationPublicId: "operation-maintenance",
      checkpoint: checkpoint("projection_repair"),
      searchProjection: {
        activeRole: "active",
        candidateRole: "candidate",
        documentKinds: ["content", "graph_seed"]
      },
      signal: new AbortController().signal
    })).resolves.toMatchObject({
      outcome: "phase_completed",
      completedDelta: 9,
      expectedCount: 9
    });

    expect(reconcile).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledOnce();
  });

  it("supersedes catch-up after a current resource revision change", async () => {
    const phases = createStorageVnextMaintenanceProductionPhases({
      planner: { plan: vi.fn() },
      catalog: {
        getKnowledgeBase: vi.fn(async () => ({
          publicId: "kb-maintenance",
          revision: 12,
          visibility: "current" as const
        }))
      },
      releases: {
        hasCandidateCatalogEntries: vi.fn(async () => false),
        getActiveRoot: vi.fn(),
        getLiveCandidate: vi.fn(),
        activateCandidate: vi.fn()
      },
      pipeline: pipelineFixture(),
      objectReconciliation: { runPage: vi.fn() },
      candidateObjectCleanup: { runPage: vi.fn() },
      clock: () => "2026-08-02T00:00:00.000Z",
      rollbackRetentionMilliseconds: 1,
      resultRetentionMilliseconds: 1
    });

    await expect(phases.runPhase({
      knowledgeBaseId: "kb-maintenance",
      operationPublicId: "operation-maintenance",
      checkpoint: checkpoint("catch_up"),
      searchProjection: {
        activeRole: "active",
        candidateRole: "candidate",
        documentKinds: ["content", "graph_seed"]
      },
      signal: new AbortController().signal
    })).rejects.toMatchObject({ code: "stale_plan" });
  });
});

function checkpoint(
  phase: StorageVnextMaintenanceCheckpoint["phase"]
): StorageVnextMaintenanceCheckpoint {
  return {
    version: 1,
    trigger: "manual",
    phase,
    cursor: null,
    batchOrdinal: 0,
    baseResourceRevision: 11,
    completedCount: 0,
    expectedCount: 0,
    processedBytes: 0,
    startedAt: "2026-08-02T00:00:00.000Z",
    lastProgressAt: "2026-08-02T00:00:00.000Z",
    elapsedActiveMs: 0,
    throughputPerSecond: 0,
    estimatedCompletionAt: null,
    maxAttempts: 3,
    resultExpiresAt: "2026-08-03T00:00:00.000Z"
  };
}

function pipelineFixture() {
  return {
    schemaChecksum: "a".repeat(64),
    settingsChecksum: "b".repeat(64),
    searchLifecycle: { prepareCandidate: vi.fn() },
    searchValidation: { validateCandidate: vi.fn() },
    buildSearchCandidate: vi.fn(),
    graphReconciler: { reconcile: vi.fn() },
    artifacts: { publish: vi.fn() },
    releaseValidation: { validate: vi.fn() }
  };
}

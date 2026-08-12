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

  it("pages, waits for, and activates an explicit semantic adoption snapshot", async () => {
    const candidatePublicId = createStorageVnextMaintenanceCandidatePublicId({
      knowledgeBaseId: "kb-maintenance",
      operationPublicId: "operation-maintenance"
    });
    const planSourcePage = vi.fn()
      .mockResolvedValueOnce({ sourceCount: 2, stageCount: 10, nextCursor: "source-2" })
      .mockResolvedValueOnce({ sourceCount: 1, stageCount: 5, nextCursor: null });
    const validateSemantic = vi.fn()
      .mockResolvedValueOnce({
        outcome: "pending" as const,
        summary: { totalCount: 15, completedCount: 10 }
      })
      .mockResolvedValueOnce({
        outcome: "pending" as const,
        summary: { totalCount: 15, completedCount: 10 }
      })
      .mockResolvedValueOnce({
        outcome: "ready" as const,
        summary: { totalCount: 15, completedCount: 15 }
      })
      .mockResolvedValueOnce({
        outcome: "ready" as const,
        summary: { totalCount: 15, completedCount: 15 }
      });
    const activateSemantic = vi.fn();
    const pipeline = pipelineFixture();
    pipeline.buildSearchCandidate.mockResolvedValue({
      sourceCount: 3,
      graphSeedCount: 0,
      documentCount: 3,
      batchCount: 1,
      compressedBytes: 128,
      documentChecksum: "c".repeat(64),
      queryCases: []
    });
    const phases = createStorageVnextMaintenanceProductionPhases({
      semanticAdoption: {
        planSourcePage,
        validateCandidate: validateSemantic,
        activateCandidate: activateSemantic
      },
      planner: { plan: vi.fn(async () => ({
        candidatePublicId,
        candidateRootPublicId: "root-candidate",
        sourceCount: 3,
        directoryCount: 0
      })) },
      catalog: { getKnowledgeBase: vi.fn(async () => ({
        publicId: "kb-maintenance", revision: 11, visibility: "current" as const
      })) },
      releases: {
        hasCandidateCatalogEntries: vi.fn(),
        getActiveRoot: vi.fn(async () => null),
        getLiveCandidate: vi.fn(async () => null),
        activateCandidate: vi.fn(async () => ({ outcome: "activated" as const }))
      },
      pipeline,
      objectReconciliation: { runPage: vi.fn() },
      candidateObjectCleanup: { runPage: vi.fn() },
      clock: () => "2026-08-02T00:00:00.000Z",
      rollbackRetentionMilliseconds: 1,
      resultRetentionMilliseconds: 1
    });
    const semanticAdoption = semanticAdoptionSnapshot();

    const first = await phases.runPhase(phaseRequest({
      ...checkpoint("planning"),
      semanticAdoption
    }));
    expect(first).toMatchObject({ outcome: "progress", cursor: "source-2" });

    const second = await phases.runPhase(phaseRequest({
      ...checkpoint("planning"),
      cursor: "source-2",
      batchOrdinal: 1,
      semanticAdoption
    }));
    expect(second).toMatchObject({ outcome: "phase_completed" });
    expect(planSourcePage).toHaveBeenLastCalledWith(expect.objectContaining({
      cursor: "source-2",
      expectedPredecessorPublicId: "semantic-active"
    }));

    const pendingSemantic = await phases.runPhase(phaseRequest({
      ...checkpoint("search_rebuild"), semanticAdoption
    }));
    expect(pendingSemantic).toMatchObject({
      outcome: "progress",
      cursor: "semantic-stages:0:10",
      completedDelta: 10,
      expectedCount: 15,
      batchOrdinalDelta: 0
    });
    expect(pipeline.buildSearchCandidate).not.toHaveBeenCalled();
    await expect(phases.runPhase(phaseRequest({
      ...checkpoint("search_rebuild"),
      cursor: pendingSemantic.outcome === "progress"
        ? pendingSemantic.cursor
        : null,
      completedCount: 10,
      expectedCount: 15,
      semanticAdoption
    }))).resolves.toMatchObject({
      outcome: "progress",
      cursor: "semantic-stages:0:10",
      completedDelta: 0,
      expectedCount: 15,
      batchOrdinalDelta: 0
    });
    await expect(phases.runPhase(phaseRequest({
      ...checkpoint("search_rebuild"),
      cursor: pendingSemantic.outcome === "progress"
        ? pendingSemantic.cursor
        : null,
      completedCount: 10,
      expectedCount: 15,
      semanticAdoption
    }))).resolves.toMatchObject({
      outcome: "phase_completed",
      completedDelta: 8,
      expectedCount: 18
    });
    expect(pipeline.buildSearchCandidate).toHaveBeenCalledOnce();
    await expect(phases.runPhase(phaseRequest({
      ...checkpoint("catch_up"), semanticAdoption
    }))).resolves.toMatchObject({ outcome: "phase_completed" });

    await phases.runPhase(phaseRequest({
      ...checkpoint("activation"), semanticAdoption
    }));
    expect(activateSemantic).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-maintenance",
      operationPublicId: "operation-maintenance",
      activatedAt: "2026-08-02T00:00:00.000Z"
    });
  });

  it("reuses predecessor facts and validates embedding-only adoption", async () => {
    const candidatePublicId = createStorageVnextMaintenanceCandidatePublicId({
      knowledgeBaseId: "kb-maintenance",
      operationPublicId: "operation-maintenance"
    });
    const planSourcePage = vi.fn(async () => ({
      sourceCount: 2,
      stageCount: 4,
      nextCursor: null
    }));
    const validateCandidate = vi.fn(async () => ({
      outcome: "ready" as const,
      summary: { totalCount: 4, completedCount: 4 }
    }));
    const pipeline = pipelineFixture();
    pipeline.buildSearchCandidate.mockResolvedValue({
      sourceCount: 2,
      graphSeedCount: 0,
      documentCount: 2,
      batchCount: 1,
      compressedBytes: 64,
      documentChecksum: "c".repeat(64),
      queryCases: []
    });
    const phases = createStorageVnextMaintenanceProductionPhases({
      semanticAdoption: {
        planSourcePage,
        validateCandidate,
        activateCandidate: vi.fn()
      },
      planner: { plan: vi.fn(async () => ({
        candidatePublicId,
        candidateRootPublicId: "root-candidate",
        sourceCount: 2,
        directoryCount: 0
      })) },
      catalog: { getKnowledgeBase: vi.fn() },
      releases: {
        hasCandidateCatalogEntries: vi.fn(),
        getActiveRoot: vi.fn(),
        getLiveCandidate: vi.fn(),
        activateCandidate: vi.fn()
      },
      pipeline,
      objectReconciliation: { runPage: vi.fn() },
      candidateObjectCleanup: { runPage: vi.fn() },
      clock: () => "2026-08-02T00:00:00.000Z",
      rollbackRetentionMilliseconds: 1,
      resultRetentionMilliseconds: 1
    });
    const semanticAdoption = {
      ...semanticAdoptionSnapshot(),
      mode: "embedding_only" as const
    };

    await phases.runPhase(phaseRequest({
      ...checkpoint("planning"),
      semanticAdoption
    }));
    await phases.runPhase(phaseRequest({
      ...checkpoint("search_rebuild"),
      semanticAdoption
    }));

    expect(planSourcePage).toHaveBeenCalledWith(expect.objectContaining({
      expectedPredecessorPublicId: "semantic-active",
      reusePredecessorFacts: true
    }));
    expect(validateCandidate).toHaveBeenCalledOnce();
    expect(pipeline.buildSearchCandidate).toHaveBeenCalledOnce();
  });

  it("adopts a provider by rebuilding and activating only search", async () => {
    const planner = { plan: vi.fn() };
    const prepareCandidate = vi.fn();
    const graphReconcile = vi.fn();
    const publishArtifacts = vi.fn();
    const activateRelease = vi.fn();
    const reconcileObjects = vi.fn();
    const cleanupCandidateObjects = vi.fn();
    const activateProvider = vi.fn(async () => ({ outcome: "activated" as const }));
    const phases = createStorageVnextMaintenanceProductionPhases({
      providerAdoption: { activate: activateProvider },
      planner,
      catalog: {
        getKnowledgeBase: vi.fn(async () => ({
          publicId: "kb-maintenance",
          revision: 11,
          visibility: "current" as const
        }))
      },
      releases: {
        hasCandidateCatalogEntries: vi.fn(),
        getActiveRoot: vi.fn(),
        getLiveCandidate: vi.fn(),
        activateCandidate: activateRelease
      },
      pipeline: {
        ...pipelineFixture(),
        searchLifecycle: { prepareCandidate },
        buildSearchCandidate: vi.fn(async () => ({
          sourceCount: 2,
          graphSeedCount: 1,
          documentCount: 4,
          batchCount: 1,
          compressedBytes: 128,
          documentChecksum: "c".repeat(64),
          queryCases: []
        })),
        graphReconciler: { reconcile: graphReconcile },
        artifacts: { publish: publishArtifacts }
      },
      objectReconciliation: { runPage: reconcileObjects },
      candidateObjectCleanup: { runPage: cleanupCandidateObjects },
      clock: () => "2026-08-02T00:00:00.000Z",
      rollbackRetentionMilliseconds: 86_400_000,
      resultRetentionMilliseconds: 86_400_000
    });

    for (const phase of [
      "planning",
      "search_rebuild",
      "projection_repair",
      "object_reconciliation",
      "catch_up",
      "validation",
      "activation",
      "cleanup"
    ] as const) {
      await expect(phases.runPhase({
        knowledgeBaseId: "kb-maintenance",
        operationPublicId: "operation-maintenance",
        checkpoint: {
          ...checkpoint(phase),
          maintenanceKind: "provider_adoption"
        },
        searchProjection: {
          activeRole: "active",
          candidateRole: "candidate",
          documentKinds: ["content", "graph_seed"]
        },
        signal: new AbortController().signal
      })).resolves.toMatchObject({ outcome: "phase_completed" });
    }

    expect(prepareCandidate).toHaveBeenCalledOnce();
    expect(activateProvider).toHaveBeenCalledWith(expect.objectContaining({
      expectedResourceRevision: 11,
      cleanupNotBefore: "2026-08-03T00:00:00.000Z"
    }));
    expect(planner.plan).not.toHaveBeenCalled();
    expect(graphReconcile).not.toHaveBeenCalled();
    expect(publishArtifacts).not.toHaveBeenCalled();
    expect(activateRelease).not.toHaveBeenCalled();
    expect(reconcileObjects).not.toHaveBeenCalled();
    expect(cleanupCandidateObjects).not.toHaveBeenCalled();
  });

  it("rebuilds semantic provider state from artifacts without full semantic stages", async () => {
    const semanticAdoption = {
      planSourcePage: vi.fn(),
      validateCandidate: vi.fn(),
      activateCandidate: vi.fn()
    };
    const planProviderPage = vi.fn(async () => ({
      sourceCount: 1,
      documentCount: 4,
      nextCursor: null,
      candidateIndexUid: "semantic-candidate"
    }));
    const validateProvider = vi.fn();
    const activateProviderProjection = vi.fn();
    const phases = createStorageVnextMaintenanceProductionPhases({
      semanticAdoption,
      semanticProviderAdoption: {
        planSourcePage: planProviderPage,
        validate: validateProvider,
        activate: activateProviderProjection
      },
      providerAdoption: { activate: vi.fn(async () => ({ outcome: "activated" as const })) },
      planner: { plan: vi.fn() },
      catalog: { getKnowledgeBase: vi.fn(async () => ({
        publicId: "kb-maintenance", revision: 11, visibility: "current" as const
      })) },
      releases: {
        hasCandidateCatalogEntries: vi.fn(),
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
    const providerOnly = {
      ...semanticAdoptionSnapshot(),
      mode: "provider_only" as const
    };

    await phases.runPhase(phaseRequest({
      ...checkpoint("planning"),
      maintenanceKind: "provider_adoption",
      semanticAdoption: providerOnly
    }));
    await phases.runPhase(phaseRequest({
      ...checkpoint("catch_up"),
      maintenanceKind: "provider_adoption",
      semanticAdoption: providerOnly
    }));
    await phases.runPhase(phaseRequest({
      ...checkpoint("activation"),
      maintenanceKind: "provider_adoption",
      semanticAdoption: providerOnly
    }));

    expect(planProviderPage).toHaveBeenCalledOnce();
    expect(validateProvider).toHaveBeenCalledOnce();
    expect(activateProviderProjection).toHaveBeenCalledWith(expect.objectContaining({
      operationPublicId: "operation-maintenance",
      semanticGenerationPublicId: "semantic-active",
      expectedGenerationRevision: 3,
      cleanupNotBefore: "2026-08-02T00:00:00.001Z"
    }));
    expect(semanticAdoption.planSourcePage).not.toHaveBeenCalled();
    expect(semanticAdoption.validateCandidate).not.toHaveBeenCalled();
    expect(semanticAdoption.activateCandidate).not.toHaveBeenCalled();
  });

  it("adopts a compatible query policy without rebuilding any projection", async () => {
    const adoptQueryPolicy = vi.fn(async () => ({
      adopted: true as const,
      reusedVectorArtifacts: true as const
    }));
    const semanticAdoption = {
      planSourcePage: vi.fn(),
      validateCandidate: vi.fn(),
      activateCandidate: vi.fn(),
      adoptQueryPolicy
    };
    const planner = { plan: vi.fn() };
    const pipeline = pipelineFixture();
    const phases = createStorageVnextMaintenanceProductionPhases({
      semanticAdoption,
      planner,
      catalog: { getKnowledgeBase: vi.fn() },
      releases: {
        hasCandidateCatalogEntries: vi.fn(),
        getActiveRoot: vi.fn(),
        getLiveCandidate: vi.fn(),
        activateCandidate: vi.fn()
      },
      pipeline,
      objectReconciliation: { runPage: vi.fn() },
      candidateObjectCleanup: { runPage: vi.fn() },
      clock: () => "2026-08-02T00:00:00.000Z",
      rollbackRetentionMilliseconds: 1,
      resultRetentionMilliseconds: 1
    });
    const queryPolicyOnly = {
      ...semanticAdoptionSnapshot(),
      mode: "query_policy_only" as const,
      target: {
        ...semanticAdoptionSnapshot().target,
        embeddingQueryPolicyRevisionPublicId: "embedding-revision-2",
        minimumVectorRelevance: 0.42
      }
    };

    for (const phase of [
      "planning", "search_rebuild", "projection_repair", "catch_up",
      "validation", "activation", "cleanup"
    ] as const) {
      await phases.runPhase(phaseRequest({
        ...checkpoint(phase),
        semanticAdoption: queryPolicyOnly
      }));
    }

    expect(adoptQueryPolicy).toHaveBeenCalledOnce();
    expect(adoptQueryPolicy).toHaveBeenCalledWith(expect.objectContaining({
      semanticGenerationPublicId: "semantic-active",
      expectedGenerationRevision: 3,
      target: expect.objectContaining({ minimumVectorRelevance: 0.42 })
    }));
    expect(planner.plan).not.toHaveBeenCalled();
    expect(pipeline.buildSearchCandidate).not.toHaveBeenCalled();
    expect(semanticAdoption.planSourcePage).not.toHaveBeenCalled();
    expect(semanticAdoption.validateCandidate).not.toHaveBeenCalled();
    expect(semanticAdoption.activateCandidate).not.toHaveBeenCalled();
  });
});

function checkpoint(
  phase: StorageVnextMaintenanceCheckpoint["phase"]
): StorageVnextMaintenanceCheckpoint {
  return {
    version: 1,
    searchProviderKind: "meilisearch",
    trigger: "manual",
    maintenanceKind: "standard",
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

function phaseRequest(checkpointValue: StorageVnextMaintenanceCheckpoint) {
  return {
    knowledgeBaseId: "kb-maintenance",
    operationPublicId: "operation-maintenance",
    checkpoint: checkpointValue,
    searchProjection: {
      activeRole: "active" as const,
      candidateRole: "candidate" as const,
      documentKinds: ["content", "graph_seed"] as const
    },
    signal: new AbortController().signal
  };
}

function semanticAdoptionSnapshot() {
  return {
    mode: "full" as const,
    target: {
      knowledgeBaseId: "kb-maintenance",
      generationModelConfigurationPublicId: "model-1",
      generationModelConfigurationRevision: 1,
      extractionContractVersion: "extraction-v1",
      graphSchemaVersion: "graph-v1",
      promptContractVersion: "prompt-v1",
      embeddingConfigurationRevisionPublicId: "embedding-revision-1",
      embeddingQueryPolicyRevisionPublicId: "embedding-revision-1",
      minimumVectorRelevance: 0.7,
      resolvedDimension: 3,
      normalization: "l2" as const,
      artifactSchemaVersion: "artifact-v1",
      vectorSchemaVersion: "vector-v1",
      searchProviderKind: "meilisearch" as const,
      mappingFingerprintSha256: "a".repeat(64)
    },
    stageSettings: { runtimeSettingsRevisionPublicId: "settings-1" },
    expectedPredecessorPublicId: "semantic-active",
    expectedPredecessorRevision: 3,
    sourcePageSize: 20
  };
}

import { describe, expect, it, vi } from "vitest";
import { createSemanticSourceHandoff } from
  "../src/semantic/application/source-handoff.js";
import {
  SEMANTIC_EXTRACTION_CONTRACT_VERSION,
  SEMANTIC_GRAPH_SCHEMA_VERSION,
  SEMANTIC_PROMPT_CONTRACT_VERSION
} from "../src/semantic/domain/contracts.js";

describe("semantic source handoff", () => {
  it("queues revision-bound active-contract stages without creating a CRUD generation", async () => {
    const enqueue = vi.fn(async ({ items }: { items: readonly unknown[] }) => items.length);
    const requestCancellation = vi.fn(async () => 0);
    const handoff = createSemanticSourceHandoff({
      generations: { getActiveProjection: async () => activeProjection() },
      generationModels: { getModel: async () => pinnedGenerationModel() },
      stages: { enqueue, requestCancellation },
      embeddingConfigurations: {
        getRevision: async () => embeddingRevision()
      },
      resolveRuntimeSettings: async () => runtimeSnapshot(),
      searchProviderKind: "opensearch",
      maximumAttempts: 3
    });
    await expect(handoff.enqueue(sourceRequest())).resolves.toMatchObject({
      state: "queued",
      semanticGenerationPublicId: "semantic-active",
      stageCount: 7,
      safeCode: null
    });
    const items = enqueue.mock.calls[0]![0].items as Array<Record<string, unknown>>;
    expect(items.map((item) => item.stageKind)).toEqual([
      "extraction", "reconciliation", "community", "embedding",
      "vector", "publication", "validation"
    ]);
    expect(items.every((item) => item.semanticGenerationPublicId === "semantic-active"))
      .toBe(true);
    expect(items.every((item) => (
      item.settingsSnapshot as Record<string, unknown>
    ).publicationDelayMilliseconds === 0)).toBe(true);
    expect(items.every((item) => (
      item.settingsSnapshot as Record<string, unknown>
    ).skeletonAcceptedEdgeCount === 2)).toBe(true);
    expect(items[0]?.settingsSnapshot).toMatchObject({
      skeletonContentProfileHeadingCount: 3,
      skeletonContentProfileDefinitionCount: 2,
      skeletonContentProfileExplicitReferenceCount: 1
    });
    expect(requestCancellation).toHaveBeenCalledWith(expect.objectContaining({
      sourceFilePublicIds: ["file-a"],
      exceptOperationPublicId: "operation-source"
    }));
  });

  it("queues only publication and validation when resuming a failed publication", async () => {
    const enqueue = vi.fn(async ({ items }: { items: readonly unknown[] }) => items.length);
    const handoff = createSemanticSourceHandoff({
      generations: { getActiveProjection: async () => activeProjection() },
      generationModels: { getModel: async () => pinnedGenerationModel() },
      stages: { enqueue, requestCancellation: async () => 0 },
      embeddingConfigurations: { getRevision: async () => embeddingRevision() },
      resolveRuntimeSettings: async () => runtimeSnapshot(),
      searchProviderKind: "opensearch",
      maximumAttempts: 3
    });

    await expect(handoff.enqueue({
      ...sourceRequest(),
      resumeFromStage: "publication"
    })).resolves.toMatchObject({
      state: "queued",
      stageCount: 2
    });

    const items = enqueue.mock.calls[0]![0].items as Array<Record<string, unknown>>;
    expect(items.map((item) => item.stageKind)).toEqual(["publication", "validation"]);
  });

  it("continues with the knowledge-base-pinned model after global activation changes", async () => {
    const enqueue = vi.fn(async ({ items }: { items: readonly unknown[] }) => items.length);
    const snapshot = runtimeSnapshot();
    snapshot.activeModel = {
      ...pinnedGenerationModel(),
      id: "model-new",
      configurationRevision: 1
    };
    const handoff = createSemanticSourceHandoff({
      generations: { getActiveProjection: async () => activeProjection() },
      generationModels: { getModel: async () => pinnedGenerationModel() },
      stages: { enqueue, requestCancellation: async () => 0 },
      embeddingConfigurations: { getRevision: async () => embeddingRevision() },
      resolveRuntimeSettings: async () => snapshot,
      searchProviderKind: "opensearch",
      maximumAttempts: 3
    });

    await expect(handoff.enqueue(sourceRequest())).resolves.toMatchObject({
      state: "queued",
      semanticGenerationPublicId: "semantic-active",
      stageCount: 7,
      safeCode: null
    });
    const items = enqueue.mock.calls[0]![0].items as Array<Record<string, unknown>>;
    expect(items[0]?.settingsSnapshot).toMatchObject({
      generationModelConfigurationPublicId: "model-a",
      generationModelConfigurationRevision: 2
    });
  });

  it("reports an explicit pinned model-revision block without partial work", async () => {
    const enqueue = vi.fn(async () => 0);
    const snapshot = runtimeSnapshot();
    const handoff = createSemanticSourceHandoff({
      generations: { getActiveProjection: async () => activeProjection() },
      generationModels: {
        getModel: async () => ({
          ...pinnedGenerationModel(),
          configurationRevision: 3
        })
      },
      stages: { enqueue, requestCancellation: async () => 0 },
      embeddingConfigurations: { getRevision: async () => embeddingRevision() },
      resolveRuntimeSettings: async () => snapshot,
      searchProviderKind: "opensearch",
      maximumAttempts: 3
    });
    await expect(handoff.enqueue(sourceRequest())).resolves.toEqual({
      state: "blocked",
      semanticGenerationPublicId: "semantic-active",
      stageCount: 0,
      safeCode: "semantic_generation_model_revision_mismatch"
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("keeps an uncontracted knowledge base out of partial semantic processing", async () => {
    const enqueue = vi.fn(async () => 0);
    const requestCancellation = vi.fn(async () => 0);
    const handoff = createSemanticSourceHandoff({
      generations: { getActiveProjection: async () => null },
      generationModels: { getModel: async () => pinnedGenerationModel() },
      stages: { enqueue, requestCancellation },
      embeddingConfigurations: {
        getRevision: async () => embeddingRevision()
      },
      resolveRuntimeSettings: async () => runtimeSnapshot(),
      searchProviderKind: "opensearch",
      maximumAttempts: 3
    });

    await expect(handoff.enqueue(sourceRequest())).resolves.toEqual({
      state: "disabled",
      semanticGenerationPublicId: null,
      stageCount: 0,
      safeCode: "semantic_contract_not_adopted"
    });
    expect(enqueue).not.toHaveBeenCalled();
    expect(requestCancellation).not.toHaveBeenCalled();
  });

  it("blocks a legacy extraction generation until explicit destructive adoption", async () => {
    const enqueue = vi.fn(async () => 0);
    const handoff = createSemanticSourceHandoff({
      generations: {
        getActiveProjection: async () => ({
          ...activeProjection(),
          extractionContractVersion: "focowiki-semantic-extraction-v1",
          promptContractVersion: "general-purpose-graph-v1"
        })
      },
      generationModels: { getModel: async () => pinnedGenerationModel() },
      stages: { enqueue, requestCancellation: async () => 0 },
      embeddingConfigurations: { getRevision: async () => embeddingRevision() },
      resolveRuntimeSettings: async () => runtimeSnapshot(),
      searchProviderKind: "opensearch",
      maximumAttempts: 3
    });

    await expect(handoff.enqueue(sourceRequest())).resolves.toEqual({
      state: "blocked",
      semanticGenerationPublicId: "semantic-active",
      stageCount: 0,
      safeCode: "semantic_contract_adoption_required"
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("keeps a CRUD enqueue failure bounded to the affected source", async () => {
    const enqueue = vi.fn(async (_input: { items: readonly unknown[] }) => {
      throw Object.assign(new Error("Queue unavailable"), {
        code: "semantic_queue_unavailable"
      });
    });
    const handoff = createSemanticSourceHandoff({
      generations: { getActiveProjection: async () => activeProjection() },
      generationModels: { getModel: async () => pinnedGenerationModel() },
      stages: { enqueue, requestCancellation: async () => 0 },
      embeddingConfigurations: {
        getRevision: async () => embeddingRevision()
      },
      resolveRuntimeSettings: async () => runtimeSnapshot(),
      searchProviderKind: "opensearch",
      maximumAttempts: 3
    });

    await expect(handoff.enqueue(sourceRequest())).rejects.toMatchObject({
      code: "semantic_queue_unavailable"
    });
    expect(enqueue).toHaveBeenCalledOnce();
    const items = enqueue.mock.calls[0]![0].items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(7);
    expect(items.every((item) =>
      item.sourceFilePublicId === "file-a"
      && item.operationPublicId === "operation-source"
    )).toBe(true);
    expect(items.map((item) => item.stageKind)).toContain("validation");
  });
});

function activeProjection() {
  return {
    publicId: "semantic-active",
    knowledgeBaseId: "kb-a",
    operationPublicId: "operation-adoption",
    expectedPredecessorPublicId: null,
    role: "active" as const,
    state: "active" as const,
    contractFingerprintSha256: "a".repeat(64),
    revision: 2,
    generationModelConfigurationPublicId: "model-a",
    generationModelConfigurationRevision: 2,
    extractionContractVersion: SEMANTIC_EXTRACTION_CONTRACT_VERSION,
    graphSchemaVersion: SEMANTIC_GRAPH_SCHEMA_VERSION,
    promptContractVersion: SEMANTIC_PROMPT_CONTRACT_VERSION,
    projectionContractPublicId: "projection-a",
    embeddingConfigurationRevisionPublicId: "embedding-revision-a",
    embeddingQueryPolicyRevisionPublicId: "embedding-revision-a",
    minimumVectorRelevance: 0.7,
    searchProviderKind: "opensearch" as const,
    resolvedDimension: 3,
    normalization: "l2" as const,
    artifactSchemaVersion: "artifact-v1",
    vectorSchemaVersion: "vector-v1",
    mappingFingerprintSha256: "b".repeat(64)
  };
}

function embeddingRevision() {
  return {
    publicId: "embedding-a",
    revisionPublicId: "embedding-revision-a",
    revision: 2,
    displayName: "Embedding",
    authenticationMode: "none" as const,
    baseUrl: "http://embedding.local/v1",
    encryptedApiKey: null,
    apiKeyConfigured: false,
    modelName: "embedding-model",
    requestedDimension: 3,
    resolvedDimension: 3,
    normalization: "l2" as const,
    maximumInputTokens: 8_192,
    batchSize: 16,
    timeoutMs: 5_000,
    retryCount: 1,
    minimumIntervalMs: 0,
    concurrency: 2,
    maximumResponseBytes: 1_048_576,
    minimumVectorRelevance: 0.7,
    vectorProducingRevisionPublicId: "embedding-revision-a",
    queryPolicyRevisionPublicId: "embedding-revision-a",
    validationStatus: "valid" as const,
    validationFingerprintSha256: "c".repeat(64),
    safeValidationErrorCode: null,
    lifecycleStatus: "active" as const,
    createdAt: "2026-08-08T00:00:00.000Z"
  };
}

function runtimeSnapshot(): any {
  return {
    activeModel: pinnedGenerationModel(),
    publication: { mode: "per_file", intervalSeconds: 300 },
    search: { indexBatchDocumentCount: 100 },
    semantic: {
      maximumChunkCharacters: 16_000,
      maximumChunks: 32,
      maximumEvidenceTargets: 64,
      maximumCommunityPartitions: 256,
      maximumCommunityEntities: 10_000,
      maximumCommunityRelationships: 20_000,
      maximumCommunityBoundaryRelationships: 10_000,
      maximumCommunitySummaryCharacters: 8_000,
      communityAdapterTimeoutMs: 30_000
    }
  };
}

function pinnedGenerationModel(): any {
  return {
    id: "model-a",
    displayName: "Generation",
    apiMode: "responses",
    baseUrl: "http://model.local/v1",
    apiKey: "test-key",
    apiKeyFingerprint: "test-fingerprint",
    modelName: "generation-model",
    contextWindowTokens: 128_000,
    requestMaxTimeoutMs: 30_000,
    requestIdleTimeoutMs: 10_000,
    suggestionConcurrency: 2,
    transientRetryDelayMs: 1_000,
    requestMinIntervalMs: 0,
    status: "active",
    isActive: false,
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    deletedAt: null,
    configurationRevision: 2
  };
}

function sourceRequest(): any {
  return {
    operationPublicId: "operation-source",
    knowledgeBaseId: "kb-a",
    settingsRevisionPublicId: "settings-a",
    sourceFile: { publicId: "file-a" },
    sourceRevision: { publicId: "revision-a" },
    skeletonGraphSignals: {
      acceptedEdgeCount: 2,
      inboundEdgeCount: 0,
      outboundEdgeCount: 2,
      distinctNeighborCount: 2,
      relationKindCount: 1,
      contentProfileHeadingCount: 3,
      contentProfileDefinitionCount: 2,
      contentProfileExplicitReferenceCount: 1
    },
    enqueuedAt: "2026-08-08T00:00:00.000Z"
  };
}

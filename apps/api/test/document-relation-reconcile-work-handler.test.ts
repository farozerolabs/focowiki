import { describe, expect, it, vi } from "vitest";
import { createProductionDocumentRelationReconcileWorkHandler } from
  "../src/document-indexing/infrastructure/production-document-relation-reconcile-work-handler.js";

describe("document relation reconciliation work handler", () => {
  it("turns grounded GraphRAG mentions into staged file-relation evidence", async () => {
    const body = "See Climate Operations for the maintenance workflow.";
    const semanticFacts = vi.fn(async () => ({
      knowledgeBaseId: "knowledge-base-a",
      semanticGenerationPublicId: "semantic-generation-a",
      sourceFilePublicId: "source-a",
      sourceRevisionPublicId: "revision-a",
      entities: [{
        publicId: "entity-a",
        canonicalKey: "document:climate operations",
        kind: "document",
        label: "Climate Operations",
        description: null,
        aliases: ["Climate Operations"],
        extractionContractVersion: "semantic-skeleton-v2",
        confidence: 1,
        provenance: "model" as const,
        revision: 1
      }],
      evidence: [{
        publicId: "evidence-a",
        sourceFilePublicId: "source-a",
        sourceRevisionPublicId: "revision-a",
        logicalPath: "a.md",
        startOffset: 0,
        endOffset: body.length,
        excerptChecksumSha256: "a".repeat(64),
        extractionContractVersion: "semantic-skeleton-v2"
      }],
      mentions: [{
        publicId: "mention-a",
        entityPublicId: "entity-a",
        evidencePublicId: "evidence-a",
        sourceFilePublicId: "source-a",
        sourceRevisionPublicId: "revision-a",
        text: "Climate Operations",
        confidence: 1
      }],
      relationships: [],
      communities: [],
      communityReports: []
    }));
    const addEvidence = vi.fn(async () => undefined);
    const handler = createProductionDocumentRelationReconcileWorkHandler({
      contexts: { read: async () => context() } as never,
      preparedSources: (async () => ({
        body,
        parsedMetadata: {},
        resolvedMetadata: { title: "Source A" },
        referenceProfile: { references: [] }
      })) as never,
      firstLayers: (async () => firstLayer()) as never,
      semanticFacts: semanticFacts as never,
      referenceFacts: {
        async findTargetsByIdentityKeys() { return [targetSource()]; },
        async findReferencingIdentityKeys() { return []; }
      } as never,
      ...modelDeltaDependencies(),
      pairs: {
        async enqueue() { return "pair-a"; },
        addEvidence,
        async stageCanonical() { return undefined; }
      } as never,
      now: () => "2026-08-16T00:00:00.000Z"
    });

    await handler({
      claimed: {
        publicId: "work-a",
        knowledgeBaseId: "knowledge-base-a",
        documentJobPublicId: "job-a",
        sourceFilePublicId: "source-a",
        sourceRevisionPublicId: "revision-a",
        kind: "relation_reconcile",
        resourceLane: "generation_model",
        inputFingerprintSha256: "d".repeat(64),
        attemptCount: 1,
        maximumAttempts: 3,
        leaseOwner: "worker-a",
        leaseExpiresAt: "2026-08-16T00:01:00.000Z",
        startedAt: "2026-08-16T00:00:00.000Z"
      },
      signal: new AbortController().signal
    });

    expect(semanticFacts).toHaveBeenCalledOnce();
    expect(addEvidence).toHaveBeenCalledWith(expect.objectContaining({
      evidenceKind: "graphrag",
      sourceFilePublicId: "source-a",
      targetSourceFilePublicId: "source-b",
      evidence: expect.objectContaining({
        target: "Climate Operations",
        sourceExcerpt: body
      })
    }));
  });

  it("treats an empty internal search result as a successful zero-candidate delta", async () => {
    const addEvidence = vi.fn(async () => undefined);
    const findTargetsByIdentityKeys = vi.fn(async (request: {
      identityKeys: readonly string[];
    }) => request.identityKeys.includes("path:climate-operations.md")
      ? [targetSource()]
      : []);
    const handler = createProductionDocumentRelationReconcileWorkHandler({
      contexts: { read: async () => context() } as never,
      preparedSources: (async () => ({
        body: "Climate Operations defines the maintenance workflow.",
        parsedMetadata: {},
        resolvedMetadata: { title: "Source A" },
        referenceProfile: { references: [] }
      })) as never,
      firstLayers: (async () => firstLayer()) as never,
      semanticFacts: (async () => ({
        entities: [], evidence: [], mentions: [], relationships: [], communities: [],
        communityReports: []
      })) as never,
      referenceFacts: {
        findTargetsByIdentityKeys,
        async findReferencingIdentityKeys() { return []; }
      } as never,
      ...modelDeltaDependencies(),
      pairs: {
        async enqueue() { return "pair-a"; },
        addEvidence,
        async stageCanonical() { return undefined; }
      } as never,
      now: () => "2026-08-16T00:00:00.000Z"
    });

    await handler({
      claimed: claimedWork(),
      signal: new AbortController().signal
    });

    expect(findTargetsByIdentityKeys).not.toHaveBeenCalled();
    expect(addEvidence).not.toHaveBeenCalled();
  });

  it("carries source-grounded incoming evidence across a path-only revision", async () => {
    const addEvidence = vi.fn(async () => undefined);
    const listReusableEvidence = vi.fn(async () => [{
      sourceFilePublicId: "source-b",
      sourceRevisionPublicId: "revision-b",
      targetSourceFilePublicId: "source-a",
      targetSourceRevisionPublicId: "revision-a",
      relationKind: "related" as const,
      evidenceKind: "first_layer" as const,
      evidenceFingerprintSha256: "e".repeat(64),
      evidence: { reason: "The same source-grounded platform is referenced." }
    }]);
    const handler = createProductionDocumentRelationReconcileWorkHandler({
      contexts: {
        read: async () => ({
          ...context(),
          job: { ...context().job, operationKind: "source_file_move" },
          source: {
            ...context().source,
            priorActiveSourceRevisionPublicId: "revision-a-old"
          }
        })
      } as never,
      preparedSources: (async () => ({
        body: "Unchanged body.",
        parsedMetadata: { title: "Source A" },
        resolvedMetadata: { title: "Source A" },
        referenceProfile: { references: [] }
      })) as never,
      firstLayers: (async () => firstLayer()) as never,
      semanticFacts: (async () => ({
        entities: [], evidence: [], mentions: [], relationships: [], communities: [],
        communityReports: []
      })) as never,
      referenceFacts: {
        async findTargetsByIdentityKeys() { return []; },
        async findReferencingIdentityKeys() { return []; }
      } as never,
      ...modelDeltaDependencies(),
      pairs: {
        listReusableEvidence,
        async listActiveNeighborSourceFilePublicIds() { return ["source-b"]; },
        async enqueue() { return "pair-carried"; },
        addEvidence,
        async stageCanonical() { return "relation-carried"; }
      } as never,
      now: () => "2026-08-16T00:00:00.000Z"
    });

    await handler({ claimed: claimedWork(), signal: new AbortController().signal });

    expect(listReusableEvidence).toHaveBeenCalledWith({
      knowledgeBaseId: "knowledge-base-a",
      sourceFilePublicId: "source-a",
      priorSourceRevisionPublicId: "revision-a-old",
      currentSourceRevisionPublicId: "revision-a",
      limit: 64
    });
    expect(addEvidence).toHaveBeenCalledWith(expect.objectContaining({
      pairPublicId: "pair-carried",
      sourceFilePublicId: "source-b",
      sourceRevisionPublicId: "revision-b",
      targetSourceFilePublicId: "source-a",
      targetSourceRevisionPublicId: "revision-a",
      evidenceKind: "first_layer"
    }));
  });

  it("keeps prior active neighbors in the replacement projection closure", async () => {
    const listActiveNeighborSourceFilePublicIds = vi.fn(async () => [
      "source-b",
      "source-c"
    ]);
    const handler = createProductionDocumentRelationReconcileWorkHandler({
      contexts: {
        read: async () => ({
          ...context(),
          job: { ...context().job, operationKind: "source_body_replace" },
          source: {
            ...context().source,
            priorActiveSourceRevisionPublicId: "revision-a-old"
          }
        })
      } as never,
      preparedSources: (async () => ({
        body: "A standalone replacement.",
        parsedMetadata: { title: "Standalone" },
        resolvedMetadata: { title: "Standalone" },
        referenceProfile: { references: [] }
      })) as never,
      firstLayers: (async () => firstLayer()) as never,
      semanticFacts: (async () => ({
        entities: [], evidence: [], mentions: [], relationships: [], communities: [],
        communityReports: []
      })) as never,
      referenceFacts: {
        async findTargetsByIdentityKeys() { return []; },
        async findReferencingIdentityKeys() { return []; }
      } as never,
      ...modelDeltaDependencies(),
      pairs: {
        listActiveNeighborSourceFilePublicIds,
        async enqueue() { throw new Error("unexpected relation"); },
        async addEvidence() { throw new Error("unexpected evidence"); },
        async stageCanonical() { throw new Error("unexpected canonical relation"); }
      } as never,
      now: () => "2026-08-16T00:00:00.000Z"
    });

    const result = await handler({
      claimed: claimedWork(),
      signal: new AbortController().signal
    });

    expect(listActiveNeighborSourceFilePublicIds).toHaveBeenCalledWith({
      knowledgeBaseId: "knowledge-base-a",
      sourceFilePublicId: "source-a",
      limit: 64
    });
    expect(result.value.affectedSourceFilePublicIds).toEqual([
      "source-a",
      "source-b",
      "source-c"
    ]);
  });
});

function claimedWork() {
  return {
    publicId: "work-a",
    knowledgeBaseId: "knowledge-base-a",
    documentJobPublicId: "job-a",
    sourceFilePublicId: "source-a",
    sourceRevisionPublicId: "revision-a",
    kind: "relation_reconcile" as const,
    resourceLane: "generation_model" as const,
    inputFingerprintSha256: "d".repeat(64),
    attemptCount: 1,
    maximumAttempts: 3,
    leaseOwner: "worker-a",
    leaseExpiresAt: "2026-08-16T00:01:00.000Z",
    startedAt: "2026-08-16T00:00:00.000Z"
  };
}

function context() {
  return {
    job: {
      readinessSequence: 1,
      operationKind: "upload",
      semanticGenerationPublicId: "semantic-generation-a",
      embeddingConfigurationRevisionPublicId: "embedding-revision-a"
    },
    source: { logicalPath: "a.md", normalizedPath: "a.md" },
    runtimeSettings: {
      schemaVersion: "storage-vnext-settings-v1",
      version: 1,
      source: "bootstrap",
      sections: {
        generated: {
          directoryIndexMaxEntries: 200,
          directoryIndexMaxBytes: 65_536,
          rootSummaryLimit: 200,
          okfLogMaxEntries: 200,
          okfLogMaxBytes: 65_536
        },
        graph: {
          candidateLimit: 128,
          acceptedEdgeLimit: 64,
          searchDefaultDepth: 1,
          searchMaxDepth: 2,
          searchDefaultFanout: 10,
          searchMaxFanout: 50,
          shardSize: 500,
          genericPhraseThreshold: 3
        },
        search: {
          requestTimeoutMs: 10_000,
          engineSearchCutoffMs: 5_000,
          overfetchFactor: 4,
          indexBatchDocumentCount: 100,
          indexBatchCompressedBytes: 1_048_576,
          maxInFlightTasks: 4,
          taskPollIntervalMs: 100,
          taskTimeoutMs: 30_000,
          maxAttempts: 4,
          retryDelayMs: 1_000,
          cleanupBatchSize: 100,
          cropLength: 1_000
        },
        semantic: {
          maximumChunkCharacters: 8_000,
          maximumChunks: 32,
          maximumEvidenceTargets: 64,
          graphRagAdapterTimeoutMs: 30_000,
          searchLaneCutoffMs: 2_500,
          queryEmbeddingConcurrency: 4,
          queryEmbeddingCacheEntries: 1_000
        }
      }
    }
  };
}

function firstLayer() {
  return {
    suggestions: null,
    contentProfile: {
      summary: "Source summary",
      subjects: [],
      entities: [],
      keywords: [],
      relationshipHints: [],
      versionHints: [],
      explicitReferences: [],
      tags: [],
      headingOutline: [],
      language: "en"
    }
  };
}

function modelDeltaDependencies() {
  return {
    internalCandidates: { async find() { return []; } } as never,
    modelRevisions: {} as never,
    modelLayerExecutions: {} as never,
    modelEvaluations: {} as never,
    generation: {} as never,
    deploymentSecret: "test-secret"
  };
}

function targetSource() {
  return {
    knowledgeBaseId: "knowledge-base-a",
    sourceFilePublicId: "source-b",
    sourceRevisionPublicId: "revision-b",
    normalizedPath: "climate-operations.md",
    title: "Climate Operations",
    aliases: [],
    sourceType: "document",
    tags: []
  };
}

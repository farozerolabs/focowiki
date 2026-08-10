import { describe, expect, it, vi } from "vitest";
import { createSemanticExtractionStageHandler } from
  "../src/semantic/application/extraction-stage-handler.js";
import type { SemanticStageWorkClaim } from
  "../src/semantic/application/stage-ports.js";
import {
  SEMANTIC_EXTRACTION_CONTRACT_VERSION,
  SEMANTIC_PROMPT_CONTRACT_VERSION
} from "../src/semantic/domain/contracts.js";

describe("semantic extraction stage handler", () => {
  it("reads only the claimed current revision and persists its desired facts", async () => {
    const replaceSourceFacts = vi.fn(async () => ({
      knowledgeBaseId: "kb-a",
      sourceFilePublicIds: ["file-a"],
      sourceRevisionPublicIds: ["revision-a"],
      entityPublicIds: ["entity-a"],
      relationshipPublicIds: [], evidencePublicIds: [], reverseReferencePublicIds: [],
      vectorOwnerPublicIds: ["entity-a"], dirtyPartitionKeys: ["partition-a"],
      affectedFileNeighborPublicIds: [], generatedLogicalPaths: [],
      graphShardPublicIds: [], searchShardPublicIds: []
    }));
    const extract = vi.fn(async () => ({
      desiredFacts: desiredFacts(),
      chunks: [{ id: "chunk-a", text: "# Alpha", startOffset: 0, endOffset: 7 }],
      promptRevision: SEMANTIC_PROMPT_CONTRACT_VERSION,
      canonicalInputHash: "a".repeat(64),
      generationRequestCount: 1,
      generationServiceTimeMilliseconds: 75,
      selection: selectedDecision()
    }));
    const handler = createSemanticExtractionStageHandler({
      catalog: catalog(),
      loadSkeletonGraphSignals: async () => ({
        acceptedEdgeCount: 1,
        inboundEdgeCount: 1,
        outboundEdgeCount: 0,
        distinctNeighborCount: 1,
        relationKindCount: 1
      }),
      bodyStore: {
        readVerifiedStream: async () => chunks(Buffer.from("# Alpha", "utf8"))
      },
      facts: {
        hasSourceRevisionFacts: async () => false,
        replaceSourceFacts
      },
      resolveExtractor: async () => ({ extract })
    });
    await expect(handler(claim())).resolves.toMatchObject({
      checkpoint: {
        reconciliationState: "created",
        entityCount: 1,
        dirtyPartitionCount: 1,
        graphRagGenerationRequestCount: 1,
        graphRagGenerationServiceTimeMilliseconds: 75
      },
      reusedArtifactCount: 0
    });
    expect(extract).toHaveBeenCalledWith(expect.objectContaining({
      sourceRevisionPublicId: "revision-a",
      markdown: "# Alpha",
      skeletonGraphSignals: {
        acceptedEdgeCount: 1,
        inboundEdgeCount: 1,
        outboundEdgeCount: 0,
        distinctNeighborCount: 1,
        relationKindCount: 1
      }
    }));
    expect(replaceSourceFacts).toHaveBeenCalledWith(desiredFacts(), {
      extractionContractVersion: SEMANTIC_EXTRACTION_CONTRACT_VERSION,
      canonicalInputSha256: "a".repeat(64),
      skeletonPolicyVersion: "semantic-skeleton-policy-v2",
      skeletonSelected: true,
      sourceChunkCount: 1,
      selectedChunkCount: 1,
      selectionReasons: ["stable_sample"],
      selectionDecisionSha256: "b".repeat(64)
    });
  });

  it("reuses an already reconciled revision without S3 or model work", async () => {
    const readVerifiedStream = vi.fn();
    const resolveExtractor = vi.fn();
    const handler = createSemanticExtractionStageHandler({
      catalog: catalog(),
      bodyStore: { readVerifiedStream },
      facts: {
        hasSourceRevisionFacts: async () => true,
        replaceSourceFacts: vi.fn()
      },
      resolveExtractor
    });
    await expect(handler(claim())).resolves.toMatchObject({
      checkpoint: { reconciliationState: "reused" },
      reusedArtifactCount: 1
    });
    expect(readVerifiedStream).not.toHaveBeenCalled();
    expect(resolveExtractor).not.toHaveBeenCalled();
  });

  it("rejects a legacy extraction or prompt contract before S3 and model work", async () => {
    const readVerifiedStream = vi.fn();
    const resolveExtractor = vi.fn();
    const handler = createSemanticExtractionStageHandler({
      catalog: catalog(),
      bodyStore: { readVerifiedStream },
      facts: {
        hasSourceRevisionFacts: vi.fn(),
        replaceSourceFacts: vi.fn()
      },
      resolveExtractor
    });
    await expect(handler({
      ...claim(),
      extractionContractVersion: "legacy-extraction-v1",
      settingsSnapshot: {
        ...claim().settingsSnapshot,
        promptContractVersion: "legacy-prompt-v1"
      }
    })).rejects.toMatchObject({
      code: "semantic_contract_maintenance_required",
      retryable: false
    });
    expect(readVerifiedStream).not.toHaveBeenCalled();
    expect(resolveExtractor).not.toHaveBeenCalled();
  });

  it("accepts an operation-owned candidate revision without making it current", async () => {
    const candidateCatalog = catalog();
    candidateCatalog.getSourceFile = async () => ({
      publicId: "file-a", logicalPath: "alpha.md",
      currentRevisionPublicId: "revision-old", visibility: "current"
    });
    candidateCatalog.getCurrentSourceRevision = async () => ({
      publicId: "revision-old"
    });
    const isOwnedRevision = vi.fn(async () => true);
    const handler = createSemanticExtractionStageHandler({
      catalog: candidateCatalog,
      isOwnedRevision,
      bodyStore: {
        readVerifiedStream: async () => chunks(Buffer.from("# Alpha", "utf8"))
      },
      facts: {
        hasSourceRevisionFacts: async () => false,
        replaceSourceFacts: async () => ({
          knowledgeBaseId: "kb-a", sourceFilePublicIds: ["file-a"],
          sourceRevisionPublicIds: ["revision-a"], entityPublicIds: [],
          relationshipPublicIds: [], evidencePublicIds: [],
          reverseReferencePublicIds: [], vectorOwnerPublicIds: [],
          dirtyPartitionKeys: [], affectedFileNeighborPublicIds: [],
          generatedLogicalPaths: [], graphShardPublicIds: [],
          searchShardPublicIds: []
        })
      },
      resolveExtractor: async () => ({
        extract: async () => ({
          desiredFacts: { ...desiredFacts(), entities: [] },
          chunks: [{ id: "chunk-a", text: "# Alpha", startOffset: 0, endOffset: 7 }],
          promptRevision: SEMANTIC_PROMPT_CONTRACT_VERSION,
          canonicalInputHash: "a".repeat(64),
          generationRequestCount: 0,
          generationServiceTimeMilliseconds: 0,
          selection: unselectedDecision()
        })
      })
    });

    await expect(handler(claim())).resolves.toMatchObject({
      checkpoint: { sourceRevisionPublicId: "revision-a" }
    });
    expect(isOwnedRevision).toHaveBeenCalledWith(claim());
  });
});

function claim(): SemanticStageWorkClaim {
  return {
    publicId: "stage-a", knowledgeBaseId: "kb-a",
    operationPublicId: "operation-a", semanticGenerationPublicId: "generation-a",
    sourceFilePublicId: "file-a", sourceRevisionPublicId: "revision-a",
    stageKind: "extraction", partitionKey: "file-a",
    extractionContractVersion: SEMANTIC_EXTRACTION_CONTRACT_VERSION,
    embeddingConfigurationRevisionPublicId: "embedding-revision-a",
    settingsSnapshot: {
      maximumSourceBytes: 1024,
      promptContractVersion: SEMANTIC_PROMPT_CONTRACT_VERSION
    },
    maximumAttempts: 3, state: "running", attemptCount: 1,
    checkpoint: {}, leaseOwner: "worker-a",
    leaseExpiresAt: "2026-08-08T00:01:00.000Z",
    cancellationRequestedAt: null, revision: 1
  };
}

function catalog(): any {
  const revision = {
    publicId: "revision-a", sourceFilePublicId: "file-a", knowledgeBaseId: "kb-a",
    objectId: "source-a", checksum: "a".repeat(64), byteCount: 7,
    contentType: "text/markdown; charset=utf-8"
  };
  return {
    getSourceFile: async () => ({
      publicId: "file-a", logicalPath: "alpha.md",
      currentRevisionPublicId: "revision-a", visibility: "current"
    }),
    getSourceRevision: async () => revision,
    getCurrentSourceRevision: async () => revision
  };
}

function desiredFacts(): any {
  return {
    knowledgeBaseId: "kb-a", semanticGenerationPublicId: "generation-a",
    sourceFilePublicId: "file-a", sourceRevisionPublicId: "revision-a",
    entities: [{ publicId: "entity-a" }], evidence: [], mentions: [],
    relationships: [], communities: [], communityReports: []
  };
}

async function* chunks(value: Uint8Array) { yield value; }

function selectedDecision() {
  return {
    policyVersion: "semantic-skeleton-policy-v2",
    selected: true,
    selectedChunkIds: ["chunk-a"],
    reasons: ["stable_sample" as const],
    decisionSha256: "b".repeat(64),
    sourceChunkCount: 1
  };
}

function unselectedDecision() {
  return {
    policyVersion: "semantic-skeleton-policy-v2",
    selected: false,
    selectedChunkIds: [],
    reasons: [],
    decisionSha256: "c".repeat(64),
    sourceChunkCount: 1
  };
}

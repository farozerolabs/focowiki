import { describe, expect, it, vi } from "vitest";
import { createSemanticProviderAdoptionService } from
  "../src/semantic/application/provider-adoption.js";
import { vectorDocumentPublicId } from
  "../src/semantic/application/vector-stage-handler.js";
import { encodeVectorArtifact } from
  "../src/semantic/embedding/vector-artifact-codec.js";
import type { SemanticMaintenanceTarget } from
  "../src/semantic/domain/contracts.js";

const NOW = "2026-08-08T00:00:00.000Z";

describe("semantic provider-only adoption", () => {
  it("rebuilds from verified artifacts without any model or embedding port", async () => {
    const artifact = encodeVectorArtifact({ vector: [0.2, 0.4, 0.8], normalization: "l2" });
    const createIndex = vi.fn(async () => ({ state: "completed" as const }));
    const writeDocuments = vi.fn(async () => ({ state: "completed" as const }));
    const activateProviderProjection = vi.fn(async () => true);
    const service = createSemanticProviderAdoptionService({
      indexPrefix: "focowiki",
      catalog: {
        async listCurrentSources(input) {
          return {
            items: input.cursor
              ? [currentSource("b")]
              : [currentSource("a"), currentSource("failed", "failed")],
            nextCursor: input.cursor ? null : "source-b"
          };
        }
      },
      artifacts: {
        async listSourceReferences(input) {
          return [{
            artifact: {
              publicId: `artifact-${input.sourceFilePublicId}`,
              objectId: "object-vector",
              storageKey: "semantic/vector.bin",
              knowledgeBaseId: "kb-1",
              ownerKind: "content" as const,
              ownerPublicId: input.sourceFilePublicId,
              sourceRevisionPublicId: input.sourceRevisionPublicId,
              canonicalInputSha256: "a".repeat(64),
              inputKind: "content" as const,
              embeddingConfigurationRevisionPublicId: "embedding-revision-1",
              normalization: "l2" as const,
              dimension: 3,
              artifactSchemaVersion: "focowiki-vector-artifact-v1",
              vectorChecksumSha256: artifact.checksumSha256,
              byteCount: artifact.byteCount,
              state: "verified" as const
            },
            sourceFilePublicId: input.sourceFilePublicId,
            evidenceTargetPath: `${input.sourceFilePublicId}.md`,
            sourceExcerpt: "Source-grounded excerpt.",
            fileKind: "page",
            okfSignals: {
              status: null,
              trustTier: null,
              staleAfterEpochDay: null,
              generatedAtEpochMs: null,
              latestVerifiedAtEpochMs: null,
              sourceCount: null
            }
          }];
        }
      },
      store: { readVerified: vi.fn(async () => artifact.bytes) },
      repository: {
        countActiveVectorDocuments: vi.fn(async () => 2),
        activateProviderProjection
      },
      provider: {
        createIndex,
        deleteIndex: vi.fn(),
        getIndexDefinition: vi.fn(async () => null),
        writeDocuments,
        deleteDocuments: vi.fn(),
        query: vi.fn(),
        count: vi.fn(),
        scan: vi.fn(),
        validate: vi.fn(async () => ({ valid: true, documentCount: 2 })),
        activateCandidate: vi.fn(),
        getOperation: vi.fn(),
        findOperationByCorrelation: vi.fn()
      }
    });

    const first = await service.planSourcePage({
      knowledgeBaseId: "kb-1",
      semanticGenerationPublicId: "semantic-active",
      target: target(),
      cursor: null,
      pageSize: 20
    });
    const second = await service.planSourcePage({
      knowledgeBaseId: "kb-1",
      semanticGenerationPublicId: "semantic-active",
      target: target(),
      cursor: first.nextCursor,
      pageSize: 20
    });
    expect(first.documentCount).toBe(1);
    expect(first.sourceCount).toBe(1);
    expect(second.sourceCount).toBe(1);
    expect(second.nextCursor).toBeNull();
    expect(createIndex).toHaveBeenCalledOnce();
    expect(writeDocuments).toHaveBeenCalledTimes(2);
    expect(writeDocuments).toHaveBeenLastCalledWith(expect.objectContaining({
      documents: [expect.objectContaining({
        semanticGenerationPublicId: "semantic-active",
        embeddingConfigurationRevisionPublicId: "embedding-revision-1",
        vector: expect.arrayContaining([
          expect.any(Number), expect.any(Number), expect.any(Number)
        ])
      })]
    }));

    await expect(service.validate({
      knowledgeBaseId: "kb-1",
      semanticGenerationPublicId: "semantic-active",
      target: target()
    })).resolves.toMatchObject({ expectedDocumentCount: 2 });
    await service.activate({
      knowledgeBaseId: "kb-1",
      operationPublicId: "maintenance-provider",
      semanticGenerationPublicId: "semantic-active",
      expectedGenerationRevision: 4,
      cleanupNotBefore: "2026-08-15T00:00:00.000Z",
      target: target()
    });
    expect(activateProviderProjection).toHaveBeenCalledWith(expect.objectContaining({
      expectedGenerationRevision: 4,
      target: expect.objectContaining({ searchProviderKind: "opensearch" })
    }));
  });

  it("switches providers from the same artifacts without a model call or mixed active identity", async () => {
    const artifact = encodeVectorArtifact({
      vector: [0.2, 0.4, 0.8],
      normalization: "l2"
    });
    const readVerified = vi.fn(async () => artifact.bytes);
    let activeProvider: "opensearch" | "meilisearch" = "opensearch";
    let activeMapping = "b".repeat(64);
    const repository = {
      countActiveVectorDocuments: vi.fn(async () => 1),
      activateProviderProjection: vi.fn(async (request: {
        target: SemanticMaintenanceTarget;
      }) => {
        activeProvider = request.target.searchProviderKind;
        activeMapping = request.target.mappingFingerprintSha256;
        return true;
      })
    };
    const providerWrites = new Map<string, Array<Record<string, unknown>>>();
    const createService = (providerKind: "opensearch" | "meilisearch") =>
      createSemanticProviderAdoptionService({
        indexPrefix: "focowiki",
        catalog: {
          async listCurrentSources() {
            return { items: [currentSource("a")], nextCursor: null };
          }
        },
        artifacts: {
          async listSourceReferences(input) {
            return [{
              artifact: {
                publicId: "artifact-shared",
                objectId: "object-vector",
                storageKey: "semantic/vector.bin",
                knowledgeBaseId: "kb-1",
                ownerKind: "content" as const,
                ownerPublicId: input.sourceFilePublicId,
                sourceRevisionPublicId: input.sourceRevisionPublicId,
                canonicalInputSha256: "a".repeat(64),
                inputKind: "content" as const,
                embeddingConfigurationRevisionPublicId: "embedding-revision-1",
                normalization: "l2" as const,
                dimension: 3,
                artifactSchemaVersion: "focowiki-vector-artifact-v1",
                vectorChecksumSha256: artifact.checksumSha256,
                byteCount: artifact.byteCount,
                state: "verified" as const
              },
              sourceFilePublicId: input.sourceFilePublicId,
              evidenceTargetPath: "file-a.md",
              sourceExcerpt: "Source-grounded excerpt.",
              fileKind: "page",
              okfSignals: {
                status: null,
                trustTier: null,
                staleAfterEpochDay: null,
                generatedAtEpochMs: null,
                latestVerifiedAtEpochMs: null,
                sourceCount: null
              }
            }];
          }
        },
        store: { readVerified },
        repository,
        provider: {
          createIndex: vi.fn(async () => ({ state: "completed" as const })),
          deleteIndex: vi.fn(),
          getIndexDefinition: vi.fn(async () => ({
            mappingFingerprintSha256: providerKind === "opensearch"
              ? "b".repeat(64)
              : "d".repeat(64),
            families: ["content", "entity", "relationship", "community"] as const,
            similarity: "cosine" as const,
            dimension: 3,
            schemaVersion: "focowiki-semantic-vector-v1"
          })),
          writeDocuments: vi.fn(async (request) => {
            providerWrites.set(providerKind, request.documents.map((item: {
              id: string;
              evidenceTargetPath: string;
              vector: readonly number[];
            }) => ({
              id: item.id,
              evidenceTargetPath: item.evidenceTargetPath,
              vector: [...item.vector]
            })));
            return { state: "completed" as const };
          }),
          deleteDocuments: vi.fn(),
          query: vi.fn(),
          count: vi.fn(),
          scan: vi.fn(),
          validate: vi.fn(async () => ({ valid: true, documentCount: 1 })),
          activateCandidate: vi.fn(),
          getOperation: vi.fn(),
          findOperationByCorrelation: vi.fn()
        }
      });
    const firstTarget = target({
      searchProviderKind: "opensearch",
      mappingFingerprintSha256: "b".repeat(64)
    });
    const secondTarget = target({
      searchProviderKind: "meilisearch",
      mappingFingerprintSha256: "d".repeat(64)
    });
    const firstService = createService("opensearch");
    const secondService = createService("meilisearch");
    const first = await firstService.planSourcePage({
      knowledgeBaseId: "kb-1",
      semanticGenerationPublicId: "semantic-active",
      target: firstTarget,
      cursor: null,
      pageSize: 20
    });
    await firstService.validate({
      knowledgeBaseId: "kb-1",
      semanticGenerationPublicId: "semantic-active",
      target: firstTarget
    });
    await firstService.activate({
      knowledgeBaseId: "kb-1",
      operationPublicId: "maintenance-opensearch",
      semanticGenerationPublicId: "semantic-active",
      expectedGenerationRevision: 4,
      cleanupNotBefore: "2026-08-15T00:00:00.000Z",
      target: firstTarget
    });
    const second = await secondService.planSourcePage({
      knowledgeBaseId: "kb-1",
      semanticGenerationPublicId: "semantic-active",
      target: secondTarget,
      cursor: null,
      pageSize: 20
    });
    await secondService.validate({
      knowledgeBaseId: "kb-1",
      semanticGenerationPublicId: "semantic-active",
      target: secondTarget
    });
    await secondService.activate({
      knowledgeBaseId: "kb-1",
      operationPublicId: "maintenance-meilisearch",
      semanticGenerationPublicId: "semantic-active",
      expectedGenerationRevision: 5,
      cleanupNotBefore: "2026-08-15T00:00:00.000Z",
      target: secondTarget
    });

    expect(first.candidateIndexUid).not.toBe(second.candidateIndexUid);
    expect(readVerified).toHaveBeenCalledTimes(2);
    expect(providerWrites.get("opensearch")).toEqual(
      providerWrites.get("meilisearch")
    );
    expect(providerWrites.get("meilisearch")).toEqual([
      expect.objectContaining({
        id: vectorDocumentPublicId(
          "semantic-active",
          "content",
          "file-a",
          "revision-a"
        ),
        evidenceTargetPath: "file-a.md"
      })
    ]);
    expect(activeProvider).toBe("meilisearch");
    expect(activeMapping).toBe("d".repeat(64));
  });
});

function target(
  overrides: Partial<SemanticMaintenanceTarget> = {}
): SemanticMaintenanceTarget {
  return {
    knowledgeBaseId: "kb-1",
    generationModelConfigurationPublicId: "model-1",
    generationModelConfigurationRevision: 1,
    extractionContractVersion: "focowiki-semantic-extraction-v2",
    graphSchemaVersion: "focowiki-semantic-graph-v1",
    promptContractVersion: "general-purpose-graph-v2",
    embeddingConfigurationRevisionPublicId: "embedding-revision-1",
    embeddingQueryPolicyRevisionPublicId: "embedding-revision-1",
    minimumVectorRelevance: 0.7,
    resolvedDimension: 3,
    normalization: "l2",
    artifactSchemaVersion: "focowiki-vector-artifact-v1",
    vectorSchemaVersion: "focowiki-semantic-vector-v1",
    searchProviderKind: "opensearch",
    mappingFingerprintSha256: "b".repeat(64),
    ...overrides
  };
}

function currentSource(id: string, status: "ready" | "failed" = "ready") {
  return {
    sourceFile: {
      publicId: `file-${id}`,
      knowledgeBaseId: "kb-1",
      directoryPublicId: null,
      logicalPath: `${id}.md`,
      normalizedPath: `${id}.md`,
      title: id,
      metadata: {},
      currentRevisionPublicId: `revision-${id}`,
      status,
      safeErrorCode: status === "failed" ? "SEMANTIC_STAGE_FAILED" : null,
      safeErrorMessage: status === "failed" ? "Semantic stage failed." : null,
      revision: 1,
      visibility: "current" as const
    },
    sourceRevision: {
      publicId: `revision-${id}`,
      knowledgeBaseId: "kb-1",
      sourceFilePublicId: `file-${id}`,
      objectId: `object-${id}`,
      checksum: "c".repeat(64),
      byteCount: 10,
      contentType: "text/markdown",
      createdAt: NOW
    }
  };
}

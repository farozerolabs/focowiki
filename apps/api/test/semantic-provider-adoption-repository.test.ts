import { describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import { createPostgresSemanticProviderAdoptionRepository } from
  "../src/semantic/infrastructure/postgres-provider-adoption-repository.js";

describe("semantic provider adoption repository", () => {
  it("transfers vector-index cleanup ownership without leaving a reactivated index queued", async () => {
    const sql = sqlFixture();
    const repository = createPostgresSemanticProviderAdoptionRepository(
      sql as unknown as DatabaseClient,
      { indexPrefix: "focowiki_dev" }
    );

    await expect(repository.activateProviderProjection({
      knowledgeBaseId: "kb-provider",
      operationPublicId: "maintenance-provider",
      semanticGenerationPublicId: "semantic-active",
      expectedGenerationRevision: 4,
      cleanupNotBefore: "2026-08-18T00:00:00.000Z",
      target: target()
    })).resolves.toBe(true);

    const source = sql.sources.join("\n");
    expect(source).toContain("FROM focowiki.cleanup_actions");
    expect(source).toContain("DELETE FROM focowiki.cleanup_actions");
    expect(source).toContain("INSERT INTO focowiki.cleanup_actions");
    expect(source).toContain("'provider_adoption'");
    expect(source).toContain("'search_index'");
    expect(source).toContain("FROM focowiki.operations operation");
  });

  it("rejects activation while cleanup already owns the target index", async () => {
    const sql = sqlFixture("running");
    const repository = createPostgresSemanticProviderAdoptionRepository(
      sql as unknown as DatabaseClient,
      { indexPrefix: "focowiki_dev" }
    );

    await expect(repository.activateProviderProjection({
      knowledgeBaseId: "kb-provider",
      operationPublicId: "maintenance-provider",
      semanticGenerationPublicId: "semantic-active",
      expectedGenerationRevision: 4,
      cleanupNotBefore: "2026-08-18T00:00:00.000Z",
      target: target()
    })).resolves.toBe(false);

    const source = sql.sources.join("\n");
    expect(source).not.toContain("UPDATE focowiki.semantic_projection_contracts");
    expect(source).not.toContain("INSERT INTO focowiki.cleanup_actions");
  });
});

function sqlFixture(cleanupState?: "running") {
  const sources: string[] = [];
  const query = vi.fn(async (strings: TemplateStringsArray) => {
    const source = strings.join(" ");
    sources.push(source);
    if (source.includes("FROM focowiki.semantic_generations generation")) {
      return [{
        public_id: "semantic-active",
        search_provider_kind: "meilisearch",
        mapping_fingerprint_sha256: "b".repeat(64),
        vector_document_count: "4"
      }];
    }
    if (source.includes("FROM focowiki.operations operation")) {
      return [{ operation_public_id: "maintenance-provider" }];
    }
    if (source.includes("FROM focowiki.cleanup_actions")) {
      return cleanupState
        ? [{ public_id: "cleanup-target", state: cleanupState }]
        : [];
    }
    if (source.includes("UPDATE focowiki.semantic_generations")) {
      return [{ public_id: "semantic-active" }];
    }
    return [];
  });
  return Object.assign(query, {
    begin: vi.fn(async (callback: (transaction: typeof query) => unknown) =>
      callback(query)),
    json: (value: unknown) => value,
    sources
  });
}

function target() {
  return {
    knowledgeBaseId: "kb-provider",
    generationModelConfigurationPublicId: "generation-model",
    generationModelConfigurationRevision: 1,
    embeddingConfigurationRevisionPublicId: "embedding-revision",
    embeddingQueryPolicyRevisionPublicId: "embedding-revision",
    minimumVectorRelevance: 0.7,
    resolvedDimension: 1024,
    normalization: "l2" as const,
    extractionContractVersion: "general-purpose-graph-v2",
    graphSchemaVersion: "focowiki-semantic-graph-v1",
    promptContractVersion: "general-purpose-graph-v2",
    adapterVersion: "focowiki-python-graphrag-adapter-v1",
    artifactSchemaVersion: "focowiki-vector-artifact-v1",
    vectorSchemaVersion: "focowiki-semantic-vector-v1",
    searchProviderKind: "opensearch" as const,
    mappingFingerprintSha256: "c".repeat(64),
    contractFingerprintSha256: "d".repeat(64)
  };
}

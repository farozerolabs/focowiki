import { describe, expect, it, vi } from "vitest";
import type { SearchProviderRuntime } from
  "../src/application/ports/search-provider-runtime.js";
import type { RuntimeConfig } from "../src/config.js";
import type { DatabaseClient } from "../src/db/client.js";
import { createProductionDocumentInternalHybridCandidateSearch } from
  "../src/document-indexing/infrastructure/production-document-internal-hybrid-candidate-search.js";
import type { EmbeddingGateway } from
  "../src/semantic/embedding/gateway.js";
import type { EmbeddingConfigurationRepository } from
  "../src/semantic/embedding/repository.js";

describe("production document internal hybrid candidate search", () => {
  it.each(["opensearch", "meilisearch"] as const)(
    "fuses %s staged and active lanes before PostgreSQL eligibility hydration",
    async (providerKind) => {
      const query = vi.fn(async (request: Parameters<
        SearchProviderRuntime["query"]["query"]
      >[0]) => ({
        hits: request.evidenceFamilies.includes("exact")
          ? [providerHit("active", "revision-active", "Exact evidence")]
          : request.evidenceFamilies.includes("jieba")
            ? [providerHit("staged", "revision-staged", "Jieba evidence")]
            : [
                providerHit("active", "revision-active", "Lexical evidence"),
                providerHit("stale", "revision-stale", "Stale evidence"),
                providerHit("failed", "revision-failed", "Failed evidence")
              ],
        continuation: null,
        processingTimeMs: 1
      }));
      const vectorQuery = vi.fn(async () => ({
        hits: [{
          documentId: "vector-active",
          sourceFilePublicId: "active",
          sourceRevisionPublicId: "revision-active",
          ownerPublicId: "content-active",
          family: "content" as const,
          evidenceTargetPath: "active.md",
          sourceExcerpt: "Vector evidence",
          rank: 1
        }],
        processingTimeMs: 1
      }));
      const hydrateEligible = vi.fn(async () => [{
        sourceFilePublicId: "active",
        sourceRevisionPublicId: "revision-active",
        normalizedPath: "authoritative/active.md",
        title: "Authoritative active",
        sourceType: "document"
      }, {
        sourceFilePublicId: "staged",
        sourceRevisionPublicId: "revision-staged",
        normalizedPath: "authoritative/staged.md",
        title: "Authoritative staged",
        sourceType: "document"
      }]);
      const find = createProductionDocumentInternalHybridCandidateSearch({
        sql: fakeSql(),
        config: { search: { indexPrefix: "focowiki-test" } } as RuntimeConfig,
        provider: {
          kind: providerKind,
          query: { query },
          vector: { query: vectorQuery }
        } as unknown as Pick<SearchProviderRuntime, "kind" | "query" | "vector">,
        embeddingConfigurations: {
          getRevision: vi.fn(async () => ({
            revisionPublicId: "embedding-revision",
            vectorProducingRevisionPublicId: "embedding-vector-revision",
            resolvedDimension: 3,
            validationStatus: "valid"
          }))
        } as unknown as EmbeddingConfigurationRepository,
        embeddingGateway: {
          embed: vi.fn(async () => [[0.1, 0.2, 0.3]])
        } satisfies EmbeddingGateway,
        referenceFacts: {
          hydrateEligible
        } as never
      });

      const result = await find.find({
        knowledgeBaseId: "knowledge-base-a",
        sourceFilePublicId: "current",
        sourceRevisionPublicId: "revision-current",
        semanticGenerationPublicId: "semantic-generation-a",
        embeddingConfigurationRevisionPublicId: "embedding-revision",
        terms: ["coastal maintenance", "气象设备维护"],
        limit: 8,
        signal: new AbortController().signal
      });

      expect(query).toHaveBeenCalledTimes(4);
      expect(query.mock.calls.every(([request]) => request.filters
        && request.returnFields.includes("sourceRevisionPublicId"))).toBe(true);
      expect(vectorQuery).toHaveBeenCalledOnce();
      expect(hydrateEligible).toHaveBeenCalledOnce();
      expect(result).toEqual([
        expect.objectContaining({
          sourceFilePublicId: "active",
          sourceRevisionPublicId: "revision-active",
          logicalPath: "authoritative/active.md",
          rankingTerms: ["active-target-term"],
          retrievalFamilies: expect.arrayContaining([
            "content_vector", "exact", "lexical", "metadata"
          ])
        }),
        expect.objectContaining({
          sourceFilePublicId: "staged",
          sourceRevisionPublicId: "revision-staged",
          logicalPath: "authoritative/staged.md",
          retrievalFamilies: ["jieba"]
        })
      ]);
      expect(result.map((item) => item.sourceFilePublicId))
        .not.toEqual(expect.arrayContaining(["stale", "failed"]));
    }
  );

  it("returns a successful empty set and avoids vector work for empty terms", async () => {
    const query = vi.fn();
    const embed = vi.fn();
    const find = createProductionDocumentInternalHybridCandidateSearch({
      sql: fakeSql(),
      config: { search: { indexPrefix: "focowiki-test" } } as RuntimeConfig,
      provider: {
        kind: "opensearch",
        query: { query },
        vector: { query: vi.fn() }
      } as unknown as Pick<SearchProviderRuntime, "kind" | "query" | "vector">,
      embeddingConfigurations: {} as EmbeddingConfigurationRepository,
      embeddingGateway: { embed } as EmbeddingGateway,
      referenceFacts: { hydrateEligible: vi.fn() } as never
    });

    await expect(find.find({
      knowledgeBaseId: "knowledge-base-a",
      sourceFilePublicId: "current",
      sourceRevisionPublicId: "revision-current",
      semanticGenerationPublicId: "semantic-generation-a",
      embeddingConfigurationRevisionPublicId: "embedding-revision",
      terms: ["", "   "],
      limit: 8,
      signal: new AbortController().signal
    })).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
  });

  it("treats a nonempty provider index with no hits as a successful empty result", async () => {
    const query = vi.fn(async () => ({
      hits: [], continuation: null, processingTimeMs: 1
    }));
    const vectorQuery = vi.fn(async () => ({ hits: [], processingTimeMs: 1 }));
    const hydrateEligible = vi.fn();
    const find = createProductionDocumentInternalHybridCandidateSearch({
      sql: fakeSql(),
      config: { search: { indexPrefix: "focowiki-test" } } as RuntimeConfig,
      provider: {
        kind: "opensearch",
        query: { query },
        vector: { query: vectorQuery }
      } as unknown as Pick<SearchProviderRuntime, "kind" | "query" | "vector">,
      embeddingConfigurations: {
        getRevision: vi.fn(async () => ({
          revisionPublicId: "embedding-revision",
          vectorProducingRevisionPublicId: "embedding-vector-revision",
          resolvedDimension: 3,
          validationStatus: "valid"
        }))
      } as unknown as EmbeddingConfigurationRepository,
      embeddingGateway: {
        embed: vi.fn(async () => [[0.1, 0.2, 0.3]])
      } satisfies EmbeddingGateway,
      referenceFacts: { hydrateEligible } as never
    });

    await expect(find.find({
      knowledgeBaseId: "knowledge-base-a",
      sourceFilePublicId: "current",
      sourceRevisionPublicId: "revision-current",
      semanticGenerationPublicId: "semantic-generation-a",
      embeddingConfigurationRevisionPublicId: "embedding-revision",
      terms: ["unmatched semantic phrase"],
      limit: 8,
      signal: new AbortController().signal
    })).resolves.toEqual([]);
    expect(query).toHaveBeenCalledTimes(3);
    expect(vectorQuery).toHaveBeenCalledOnce();
    expect(hydrateEligible).not.toHaveBeenCalled();
  });

  it.each(["opensearch", "meilisearch"] as const)(
    "uses bounded single-intent discovery queries for %s instead of one strict term bundle",
    async (providerKind) => {
      const query = vi.fn(async (request: Parameters<
        SearchProviderRuntime["query"]["query"]
      >[0]) => ({
        hits: request.query === "bitcoin"
          ? [providerHit("related", "revision-related", "Bitcoin evidence")]
          : [],
        continuation: null,
        processingTimeMs: 1
      }));
      const vectorQuery = vi.fn(async () => ({ hits: [], processingTimeMs: 1 }));
      const find = createProductionDocumentInternalHybridCandidateSearch({
        sql: fakeSql(),
        config: { search: { indexPrefix: "focowiki-test" } } as RuntimeConfig,
        provider: {
          kind: providerKind,
          query: { query },
          vector: { query: vectorQuery }
        } as unknown as Pick<SearchProviderRuntime, "kind" | "query" | "vector">,
        embeddingConfigurations: {
          getRevision: vi.fn(async () => ({
            revisionPublicId: "embedding-revision",
            vectorProducingRevisionPublicId: "embedding-vector-revision",
            resolvedDimension: 3,
            validationStatus: "valid"
          }))
        } as unknown as EmbeddingConfigurationRepository,
        embeddingGateway: {
          embed: vi.fn(async () => [[0.1, 0.2, 0.3]])
        } satisfies EmbeddingGateway,
        referenceFacts: {
          hydrateEligible: vi.fn(async () => [{
            sourceFilePublicId: "related",
            sourceRevisionPublicId: "revision-related",
            normalizedPath: "related.md",
            title: "Related Bitcoin document",
            sourceType: "document"
          }])
        } as never
      });

      const result = await find.find({
        knowledgeBaseId: "knowledge-base-a",
        sourceFilePublicId: "current",
        sourceRevisionPublicId: "revision-current",
        semanticGenerationPublicId: "semantic-generation-a",
        embeddingConfigurationRevisionPublicId: "embedding-revision",
        terms: [
          "A unique current document title",
          "bitcoin",
          "blockchain",
          "distributed ledger",
          "cryptographic transaction",
          ...Array.from({ length: 40 }, (_, index) => `background-${index}`)
        ],
        limit: 8,
        signal: new AbortController().signal
      });

      expect(result).toEqual([
        expect.objectContaining({
          sourceFilePublicId: "related",
          retrievalFamilies: expect.arrayContaining(["lexical", "metadata"])
        })
      ]);
      expect(query.mock.calls.some(([request]) => request.query === "bitcoin"))
        .toBe(true);
      expect(query.mock.calls.some(([request]) =>
        request.query.includes("background-10"))).toBe(false);
      expect(query.mock.calls.every(([request]) =>
        Buffer.byteLength(request.query, "utf8") <= 512)).toBe(true);
      expect(vectorQuery).toHaveBeenCalledWith(expect.objectContaining({
        minimumRelevance: 0.45
      }));
    }
  );
});

function fakeSql(): DatabaseClient {
  return (async (strings: TemplateStringsArray) => {
    const query = strings.join("?");
    if (query.includes("FROM focowiki.search_projections")) {
      return [{
        public_id: "search-projection-a",
        provider_index_uid: "focowiki-test-content",
        schema_checksum_sha256: "a".repeat(64)
      }];
    }
    if (query.includes("FROM focowiki.semantic_projection_contracts")) {
      return [{
        public_id: "semantic-projection-a",
        mapping_fingerprint_sha256: "b".repeat(64)
      }];
    }
    throw new Error(`Unexpected SQL: ${query}`);
  }) as unknown as DatabaseClient;
}

function providerHit(
  sourceFilePublicId: string,
  sourceRevisionPublicId: string,
  excerpt: string
) {
  return {
    documentId: `${sourceFilePublicId}-${sourceRevisionPublicId}`,
    sourceFilePublicId,
    sourceRevisionPublicId,
    logicalPath: `${sourceFilePublicId}.md`,
    title: sourceFilePublicId,
    normalizedScore: 1,
    snippets: [excerpt],
    sortKey: [sourceFilePublicId],
    continuationAfter: sourceFilePublicId,
    document: { rankingTerms: [`${sourceFilePublicId}-target-term`] }
  };
}

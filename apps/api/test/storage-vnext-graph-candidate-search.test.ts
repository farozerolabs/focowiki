import { describe, expect, it, vi } from "vitest";
import type { MeilisearchClientPort } from
  "../src/infrastructure/meilisearch/meilisearch-client-port.js";
import {
  createStorageVnextGraphCandidateSearch,
  createStorageVnextGraphCandidateSearchForProjection
} from "../src/storage-vnext/search/graph-candidate-search.js";
import type { StorageVnextGraphNodeFact } from
  "../src/storage-vnext/graph/ports.js";
import { createMeilisearchProviderRuntime } from
  "../src/infrastructure/meilisearch/meilisearch-provider-runtime.js";
import { STORAGE_VNEXT_GRAPH_SEED_SCHEMA_VERSION } from
  "../src/storage-vnext/search/documents.js";
import { SearchProviderError } from
  "../src/application/ports/search-provider-runtime.js";

describe("storage vNext graph candidate search", () => {
  it("hydrates current graph nodes from the knowledge-base unified active index", async () => {
    const alpha = graphNode("source-alpha", "revision-alpha", "pages/alpha.md");
    const stale = graphNode("source-stale", "revision-current", "pages/current.md");
    const transport = transportWithHits([
      searchHit("source-current", "revision-current", "pages/current.md"),
      searchHit("source-alpha", "revision-alpha", "pages/alpha.md"),
      searchHit("source-stale", "revision-old", "pages/old.md")
    ]);
    const listNodesBySourceFiles = vi.fn(async () => [stale, alpha]);
    const search = createStorageVnextGraphCandidateSearch({
      projections: {
        getActiveProjection: vi.fn(async () => ({
          publicId: "projection-active",
          knowledgeBaseId: "kb-1",
          providerKind: "meilisearch" as const,
          role: "active" as const,
          providerIndexUid: "kb-1-unified-active",
          schemaChecksum: "a".repeat(64),
          settingsChecksum: "b".repeat(64),
          documentCount: 3,
          documentChecksum: "c".repeat(64),
          providerOperationRef: null,
          state: "active" as const,
          createdAt: "2026-08-02T00:00:00.000Z",
          activatedAt: "2026-08-02T00:00:00.000Z",
          cleanupAfter: null
        }))
      },
      provider: createMeilisearchProviderRuntime(transport),
      deadlineMs: 5_000,
      graph: { listNodesBySourceFiles }
    });

    await expect(search.findCandidates({
      knowledgeBaseId: "kb-1",
      sourceFilePublicId: "source-current",
      terms: ["atomic index swap", "rollback", "rollback"],
      limit: 20
    })).resolves.toEqual([alpha]);

    expect(transport.search).toHaveBeenCalledWith(expect.objectContaining({
      indexUid: "kb-1-unified-active",
      query: "atomic index swap rollback",
      filter: [
        "knowledgeBaseId = \"kb-1\"",
        "documentKind = \"graph_seed\"",
        `schemaVersion = "${STORAGE_VNEXT_GRAPH_SEED_SCHEMA_VERSION}"`
      ].join(" AND "),
      limit: 21,
      attributesToSearchOn: ["title", "logicalPath", "searchText", "rankingTerms"],
      attributesToRetrieve: [
        "sourceFilePublicId",
        "sourceRevisionPublicId",
        "logicalPath"
      ],
      attributesToCrop: [],
      cropLength: 0,
      matchingStrategy: "last",
      distinct: "sourceFilePublicId"
    }));
    expect(listNodesBySourceFiles).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-1",
      sourceFilePublicIds: ["source-alpha", "source-stale"],
      limit: 20
    });
  });

  it("returns no semantic candidates before the first unified index activates", async () => {
    const transport = transportWithHits([]);
    const listNodesBySourceFiles = vi.fn();
    const search = createStorageVnextGraphCandidateSearch({
      projections: { getActiveProjection: vi.fn(async () => null) },
      provider: createMeilisearchProviderRuntime(transport),
      deadlineMs: 5_000,
      graph: { listNodesBySourceFiles }
    });

    await expect(search.findCandidates({
      knowledgeBaseId: "kb-new",
      sourceFilePublicId: "source-new",
      terms: ["first document"],
      limit: 10
    })).resolves.toEqual([]);
    expect(transport.search).not.toHaveBeenCalled();
    expect(listNodesBySourceFiles).not.toHaveBeenCalled();
  });

  it("resolves the active-search deadline for every candidate query", async () => {
    const query = vi.fn(async () => ({
      hits: [],
      continuation: null,
      processingTimeMs: 1
    }));
    let deadlineMs = 1_000;
    const search = createStorageVnextGraphCandidateSearch({
      projections: {
        getActiveProjection: vi.fn(async () => ({
          publicId: "projection-active",
          knowledgeBaseId: "kb-1",
          providerKind: "opensearch" as const,
          role: "active" as const,
          providerIndexUid: "kb-1-unified-active",
          schemaChecksum: "a".repeat(64),
          settingsChecksum: "b".repeat(64),
          documentCount: 0,
          documentChecksum: "c".repeat(64),
          providerOperationRef: null,
          state: "active" as const,
          createdAt: "2026-08-02T00:00:00.000Z",
          activatedAt: "2026-08-02T00:00:00.000Z",
          cleanupAfter: null
        }))
      },
      provider: { kind: "opensearch", query: { query } },
      resolveDeadlineMs: async () => deadlineMs,
      graph: { listNodesBySourceFiles: vi.fn() }
    });

    await search.findCandidates({
      knowledgeBaseId: "kb-1",
      sourceFilePublicId: "source-current",
      terms: ["first"],
      limit: 10
    });
    deadlineMs = 2_000;
    await search.findCandidates({
      knowledgeBaseId: "kb-1",
      sourceFilePublicId: "source-current",
      terms: ["second"],
      limit: 10
    });

    expect(query).toHaveBeenNthCalledWith(1, expect.objectContaining({
      deadlineMs: 1_000
    }));
    expect(query).toHaveBeenNthCalledWith(2, expect.objectContaining({
      deadlineMs: 2_000
    }));
  });

  it("retries transient provider overloads without restarting source model processing", async () => {
    const query = vi.fn()
      .mockRejectedValueOnce(new SearchProviderError("SEARCH_ENGINE_OVERLOADED", true))
      .mockRejectedValueOnce(new SearchProviderError("SEARCH_ENGINE_TIMEOUT", true))
      .mockResolvedValue({ hits: [], continuation: null, processingTimeMs: 1 });
    const sleep = vi.fn(async () => undefined);
    const search = createStorageVnextGraphCandidateSearch({
      projections: {
        getActiveProjection: vi.fn(async () => ({
          publicId: "projection-active",
          knowledgeBaseId: "kb-1",
          providerKind: "opensearch" as const,
          role: "active" as const,
          providerIndexUid: "kb-1-unified-active",
          schemaChecksum: "a".repeat(64),
          settingsChecksum: "b".repeat(64),
          documentCount: 0,
          documentChecksum: "c".repeat(64),
          providerOperationRef: null,
          state: "active" as const,
          createdAt: "2026-08-02T00:00:00.000Z",
          activatedAt: "2026-08-02T00:00:00.000Z",
          cleanupAfter: null
        }))
      },
      provider: { kind: "opensearch", query: { query } },
      deadlineMs: 5_000,
      retry: { maximumAttempts: 3, delayMs: 25, sleep },
      graph: { listNodesBySourceFiles: vi.fn() }
    });

    await expect(search.findCandidates({
      knowledgeBaseId: "kb-1",
      sourceFilePublicId: "source-current",
      terms: ["transient overload"],
      limit: 10
    })).resolves.toEqual([]);

    expect(query).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 25);
    expect(sleep).toHaveBeenNthCalledWith(2, 50);
  });

  it("does not retry non-retryable candidate search failures", async () => {
    const error = new SearchProviderError("SEARCH_ENGINE_AUTHORIZATION_FAILED", false);
    const query = vi.fn(async () => { throw error; });
    const sleep = vi.fn(async () => undefined);
    const search = createStorageVnextGraphCandidateSearch({
      projections: {
        getActiveProjection: vi.fn(async () => ({
          publicId: "projection-active",
          knowledgeBaseId: "kb-1",
          providerKind: "opensearch" as const,
          role: "active" as const,
          providerIndexUid: "kb-1-unified-active",
          schemaChecksum: "a".repeat(64),
          settingsChecksum: "b".repeat(64),
          documentCount: 0,
          documentChecksum: "c".repeat(64),
          providerOperationRef: null,
          state: "active" as const,
          createdAt: "2026-08-02T00:00:00.000Z",
          activatedAt: "2026-08-02T00:00:00.000Z",
          cleanupAfter: null
        }))
      },
      provider: { kind: "opensearch", query: { query } },
      deadlineMs: 5_000,
      retry: { maximumAttempts: 3, delayMs: 25, sleep },
      graph: { listNodesBySourceFiles: vi.fn() }
    });

    await expect(search.findCandidates({
      knowledgeBaseId: "kb-1",
      sourceFilePublicId: "source-current",
      terms: ["authorization failure"],
      limit: 10
    })).rejects.toBe(error);
    expect(query).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("bounds long candidate terms to the Meilisearch query byte contract", async () => {
    const transport = transportWithHits([]);
    const search = createStorageVnextGraphCandidateSearch({
      projections: {
        getActiveProjection: vi.fn(async () => ({
          publicId: "projection-active",
          knowledgeBaseId: "kb-1",
          providerKind: "meilisearch" as const,
          role: "active" as const,
          providerIndexUid: "kb-1-unified-active",
          schemaChecksum: "a".repeat(64),
          settingsChecksum: "b".repeat(64),
          documentCount: 0,
          documentChecksum: "c".repeat(64),
          providerOperationRef: null,
          state: "active" as const,
          createdAt: "2026-08-02T00:00:00.000Z",
          activatedAt: "2026-08-02T00:00:00.000Z",
          cleanupAfter: null
        }))
      },
      provider: createMeilisearchProviderRuntime(transport),
      deadlineMs: 5_000,
      graph: { listNodesBySourceFiles: vi.fn() }
    });

    await expect(search.findCandidates({
      knowledgeBaseId: "kb-1",
      sourceFilePublicId: "source-current",
      terms: Array.from({ length: 100 }, (_, index) =>
        `${index}-${"长期有效的候选检索词".repeat(18)}`),
      limit: 20
    })).resolves.toEqual([]);

    const query = vi.mocked(transport.search).mock.calls[0]?.[0]?.query ?? "";
    expect(Buffer.byteLength(query, "utf8")).toBeLessThanOrEqual(4_096);
    expect(query.length).toBeGreaterThan(0);
  });

  it("uses the same unified candidate index for first-publication graph reconciliation", async () => {
    const alpha = graphNode("source-alpha", "revision-alpha", "pages/alpha.md");
    const transport = transportWithHits([
      searchHit("source-alpha", "revision-alpha", "pages/alpha.md")
    ]);
    const getCandidate = vi.fn(async () => ({
      publicId: "candidate-first",
      knowledgeBaseId: "kb-1",
      providerKind: "meilisearch" as const,
      providerIndexUid: "kb-1-unified-candidate",
      schemaChecksum: "a".repeat(64),
      settingsChecksum: "b".repeat(64),
      documentChecksum: null,
      state: "indexing" as const,
      documentCount: 2,
      nextBatchOrdinal: 1,
      lastBatchOrdinal: 0,
      lastBatchChecksum: "c".repeat(64),
      correlationPublicId: null,
      providerOperationRef: null,
      revision: 3
    }));
    const search = createStorageVnextGraphCandidateSearchForProjection({
      searchProjectionPublicId: "candidate-first",
      projections: { getCandidate },
      provider: createMeilisearchProviderRuntime(transport),
      deadlineMs: 5_000,
      graph: { listNodesBySourceFiles: vi.fn(async () => [alpha]) }
    });

    await expect(search.findCandidates({
      knowledgeBaseId: "kb-1",
      sourceFilePublicId: "source-current",
      terms: ["first publication"],
      limit: 10
    })).resolves.toEqual([alpha]);

    expect(getCandidate).toHaveBeenCalledWith("candidate-first");
    expect(transport.search).toHaveBeenCalledWith(expect.objectContaining({
      indexUid: "kb-1-unified-candidate",
      filter: expect.stringContaining('documentKind = "graph_seed"')
    }));
  });
});

function searchHit(
  sourceFilePublicId: string,
  sourceRevisionPublicId: string,
  logicalPath: string
) {
  return { sourceFilePublicId, sourceRevisionPublicId, logicalPath };
}

function graphNode(
  sourceFilePublicId: string,
  sourceRevisionPublicId: string,
  logicalPath: string
): StorageVnextGraphNodeFact {
  return {
    publicId: `node-${sourceFilePublicId}`,
    knowledgeBaseId: "kb-1",
    sourceFilePublicId,
    sourceRevisionPublicId,
    logicalPath,
    label: sourceFilePublicId,
    kind: "guide",
    metadata: {},
    evidence: [],
    revision: 1
  };
}

function transportWithHits(hits: Array<Record<string, unknown>>) {
  return {
    search: vi.fn(async () => ({
      hits,
      estimatedTotalHits: hits.length,
      processingTimeMs: 1
    }))
  } as unknown as MeilisearchClientPort;
}

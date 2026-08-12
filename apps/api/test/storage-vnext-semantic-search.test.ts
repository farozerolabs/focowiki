import { describe, expect, it, vi } from "vitest";
import {
  createStorageVnextSemanticSearch,
  type StorageVnextSemanticPaginationState
} from
  "../src/storage-vnext/search/semantic-search.js";

describe("storage vNext optional semantic search", () => {
  it("paginates deterministic semantic results and hydrates only active source DTOs", async () => {
    const semantic = vi.fn(async () => ({
      items: ["a", "b", "c"].map((id, index) => ({
        sourceFilePublicId: `file-${id}`,
        sourceRevisionPublicId: `revision-${id}`,
        logicalPath: `${id}.md`,
        title: id.toUpperCase(),
        score: 1 - index / 10,
        evidenceFamilies: ["content_vector"],
        matchedFields: ["content"],
        evidenceTypes: ["content"],
        sourceExcerpt: `${id} evidence`,
        explanations: [`${id} evidence`]
      })),
      semanticStatus: { state: "ready" as const, safeCode: null }
    }));
    const search = createStorageVnextSemanticSearch({
      semanticGenerations: generationRepository(),
      semantic: { search: semantic },
      fallback: fallback(),
      hydration: hydration(),
      providerKind: "opensearch",
      vectorIndexPrefix: "focowiki",
      maxPageSize: 200,
      resolveRuntimeSettings: async () => ({
        requestTimeoutMs: 3000,
        searchLaneCutoffMs: 1000
      })
    });

    const first = await search.search(request());
    expect(first.items.map((item) => item.sourceFilePublicId)).toEqual([
      "file-a", "file-b"
    ]);
    expect(first.items[0]).toMatchObject({
      logicalPath: "a.md",
      snippet: "a evidence",
      kind: "file",
      metadata: { language: "en" }
    });
    expect(first.semanticStatus).toEqual({ state: "ready", safeCode: null });
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await search.search({ ...request(), cursor: first.nextCursor });
    expect(second.items.map((item) => item.sourceFilePublicId)).toEqual(["file-c"]);
    expect(second.nextCursor).toBeNull();
    expect(semantic).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 4 }));
  });

  it("does not repeat a source when approximate semantic ordering drifts between pages", async () => {
    let call = 0;
    const orderings = [
      ["a", "b", "c"],
      ["b", "a", "c"],
      ["c", "b", "a"]
    ];
    const semantic = vi.fn(async (input: { limit: number }) => ({
      items: (orderings[Math.min(call++, orderings.length - 1)] ?? [])
        .slice(0, input.limit)
        .map((id) => semanticItem(id)),
      semanticStatus: { state: "ready" as const, safeCode: null },
      hasMore: input.limit < 3
    }));
    const pagination = paginationStore();
    const search = createStorageVnextSemanticSearch({
      semanticGenerations: generationRepository(),
      semantic: { search: semantic },
      fallback: fallback(),
      hydration: hydration(),
      pagination,
      providerKind: "opensearch",
      vectorIndexPrefix: "focowiki",
      maxPageSize: 200,
      resolveRuntimeSettings: async () => ({
        requestTimeoutMs: 3000,
        searchLaneCutoffMs: 1000
      })
    });

    const first = await search.search({ ...request(), limit: 1 });
    const second = await search.search({
      ...request(), limit: 1, cursor: first.nextCursor
    });
    const third = await search.search({
      ...request(), limit: 1, cursor: second.nextCursor
    });

    expect([
      first.items[0]?.sourceFilePublicId,
      second.items[0]?.sourceFilePublicId,
      third.items[0]?.sourceFilePublicId
    ]).toEqual(["file-a", "file-b", "file-c"]);
    expect(third.nextCursor).toBeNull();
    expect(pagination.write).toHaveBeenCalledTimes(2);
  });

  it("continues a legacy inline cursor after Redis pagination is enabled", async () => {
    const semantic = {
      search: async () => ({
        items: ["a", "b"].map((id) => semanticItem(id)),
        semanticStatus: { state: "ready" as const, safeCode: null }
      })
    };
    const common = {
      semanticGenerations: generationRepository(),
      semantic,
      fallback: fallback(),
      hydration: hydration(),
      providerKind: "opensearch" as const,
      vectorIndexPrefix: "focowiki",
      maxPageSize: 200,
      resolveRuntimeSettings: async () => ({
        requestTimeoutMs: 3000,
        searchLaneCutoffMs: 1000
      })
    };
    const legacy = createStorageVnextSemanticSearch(common);
    const first = await legacy.search({ ...request(), limit: 1 });
    const current = createStorageVnextSemanticSearch({
      ...common,
      pagination: paginationStore()
    });

    await expect(current.search({
      ...request(), limit: 1, cursor: first.nextCursor
    })).resolves.toMatchObject({
      items: [{ sourceFilePublicId: "file-b" }],
      nextCursor: null
    });
  });

  it("keeps lexical continuity when semantic adoption is unavailable or OKF filters apply", async () => {
    const fallbackSearch = vi.fn(async () => ({
      items: [],
      nextCursor: null,
      evidenceStatus: {
        completedFamilies: ["lexical", "file_graph"],
        degradedFamilies: [
          "exact_path",
          "exact_title",
          "jieba",
          "content_vector",
          "entity_vector",
          "relationship_vector",
          "community_vector"
        ]
      }
    }));
    const search = createStorageVnextSemanticSearch({
      semanticGenerations: { getActiveProjection: async () => null },
      semantic: { search: vi.fn() },
      fallback: { search: fallbackSearch },
      hydration: hydration(),
      providerKind: "opensearch",
      vectorIndexPrefix: "focowiki",
      maxPageSize: 200,
      resolveRuntimeSettings: async () => ({
        requestTimeoutMs: 3000,
        searchLaneCutoffMs: 1000
      })
    });
    await expect(search.search(request())).resolves.toMatchObject({
      semanticStatus: { state: "unavailable", safeCode: "SEMANTIC_ADOPTION_REQUIRED" },
      evidenceStatus: {
        completedFamilies: ["lexical", "file_graph"],
        degradedFamilies: [
          "exact_path",
          "exact_title",
          "jieba",
          "content_vector",
          "entity_vector",
          "relationship_vector",
          "community_vector"
        ]
      }
    });
    expect(fallbackSearch).toHaveBeenCalledOnce();
  });

  it("reports degraded semantic families when a fallback omits evidence status", async () => {
    const search = createStorageVnextSemanticSearch({
      semanticGenerations: { getActiveProjection: async () => null },
      semantic: { search: vi.fn() },
      fallback: fallback(),
      hydration: hydration(),
      providerKind: "opensearch",
      vectorIndexPrefix: "focowiki",
      maxPageSize: 200,
      resolveRuntimeSettings: async () => ({
        requestTimeoutMs: 3000,
        searchLaneCutoffMs: 1000
      })
    });

    await expect(search.search(request())).resolves.toMatchObject({
      evidenceStatus: {
        completedFamilies: [],
        degradedFamilies: [
          "exact_path",
          "exact_title",
          "lexical",
          "jieba",
          "file_graph",
          "content_vector",
          "entity_vector",
          "relationship_vector",
          "community_vector"
        ]
      }
    });
  });

  it("keeps lexical continuity when the configured lexical projection is unavailable", async () => {
    const fallbackSearch = vi.fn(async () => ({ items: [], nextCursor: null }));
    const semanticSearch = vi.fn();
    const search = createStorageVnextSemanticSearch({
      semanticGenerations: generationRepository(),
      lexicalProjections: { getActiveProjection: async () => null },
      semantic: { search: semanticSearch },
      fallback: { search: fallbackSearch },
      hydration: hydration(),
      providerKind: "opensearch",
      vectorIndexPrefix: "focowiki",
      maxPageSize: 200,
      resolveRuntimeSettings: async () => ({
        requestTimeoutMs: 3000,
        searchLaneCutoffMs: 1000
      })
    });

    await expect(search.search(request())).resolves.toMatchObject({
      semanticStatus: {
        state: "unavailable",
        safeCode: "SEMANTIC_LEXICAL_PROJECTION_UNAVAILABLE"
      }
    });
    expect(fallbackSearch).toHaveBeenCalledOnce();
    expect(semanticSearch).not.toHaveBeenCalled();
  });

  it("rejects a cursor after the semantic contract changes", async () => {
    let generation = generationRepository();
    const search = createStorageVnextSemanticSearch({
      semanticGenerations: {
        getActiveProjection: (knowledgeBaseId) =>
          generation.getActiveProjection(knowledgeBaseId)
      },
      semantic: { search: async () => ({
        items: ["a", "b"].map((id) => semanticItem(id)),
        semanticStatus: { state: "ready" as const, safeCode: null }
      }) },
      fallback: fallback(),
      hydration: hydration(),
      providerKind: "opensearch",
      vectorIndexPrefix: "focowiki",
      maxPageSize: 200,
      resolveRuntimeSettings: async () => ({
        requestTimeoutMs: 3000,
        searchLaneCutoffMs: 1000
      })
    });
    const first = await search.search({ ...request(), limit: 1 });
    generation = generationRepository({ publicId: "semantic-new" });
    await expect(search.search({
      ...request(), limit: 1, cursor: first.nextCursor
    })).rejects.toMatchObject({ code: "INVALID_SEARCH_CURSOR" });
  });

  it("binds the cursor to effective request-scoped reranker controls", async () => {
    const search = createStorageVnextSemanticSearch({
      semanticGenerations: generationRepository(),
      semantic: { search: async () => ({
        items: ["a", "b"].map((id) => semanticItem(id)),
        semanticStatus: { state: "ready" as const, safeCode: null }
      }) },
      fallback: fallback(),
      hydration: hydration(),
      providerKind: "opensearch",
      vectorIndexPrefix: "focowiki",
      maxPageSize: 50,
      resolveRuntimeSettings: async () => ({
        requestTimeoutMs: 3000,
        searchLaneCutoffMs: 1000
      })
    });
    const first = await search.search({
      ...request(), limit: 1, rerank: false,
      rerankTopK: null, rerankScoreThreshold: null
    } as Parameters<typeof search.search>[0]);

    await expect(search.search({
      ...request(), limit: 1, cursor: first.nextCursor,
      rerank: true, rerankTopK: 30, rerankScoreThreshold: 0.35
    } as Parameters<typeof search.search>[0])).rejects.toMatchObject({
      code: "INVALID_SEARCH_CURSOR"
    });
  });

  it("binds enabled reranker cursors to the active model revision", async () => {
    let activeRevision = "reranker-revision-a";
    const resolveActiveRerankerRevision = vi.fn(async () => activeRevision);
    const search = createStorageVnextSemanticSearch({
      semanticGenerations: generationRepository(),
      resolveActiveRerankerRevision,
      semantic: { search: async () => ({
        items: ["a", "b"].map((id) => semanticItem(id)),
        semanticStatus: { state: "ready" as const, safeCode: null }
      }) },
      fallback: fallback(),
      hydration: hydration(),
      providerKind: "opensearch",
      vectorIndexPrefix: "focowiki",
      maxPageSize: 50,
      resolveRuntimeSettings: async () => ({
        requestTimeoutMs: 3000,
        searchLaneCutoffMs: 1000
      })
    });
    const rerankedRequest = {
      ...request(), limit: 1, rerank: true,
      rerankTopK: 30, rerankScoreThreshold: 0.35
    } as Parameters<typeof search.search>[0];
    const first = await search.search(rerankedRequest);
    activeRevision = "reranker-revision-b";

    await expect(search.search({
      ...rerankedRequest,
      cursor: first.nextCursor
    })).rejects.toMatchObject({ code: "INVALID_SEARCH_CURSOR" });
    expect(resolveActiveRerankerRevision).toHaveBeenCalledTimes(2);
  });

  it("does not resolve a reranker revision when reranking is disabled", async () => {
    const resolveActiveRerankerRevision = vi.fn();
    const search = createStorageVnextSemanticSearch({
      semanticGenerations: generationRepository(),
      resolveActiveRerankerRevision,
      semantic: { search: async () => ({
        items: [semanticItem("a")],
        semanticStatus: { state: "ready" as const, safeCode: null }
      }) },
      fallback: fallback(),
      hydration: hydration(),
      providerKind: "opensearch",
      vectorIndexPrefix: "focowiki",
      maxPageSize: 50,
      resolveRuntimeSettings: async () => ({
        requestTimeoutMs: 3000,
        searchLaneCutoffMs: 1000
      })
    });

    await search.search(request());
    expect(resolveActiveRerankerRevision).not.toHaveBeenCalled();
  });

  it("keeps semantic retrieval available when reranker revision identity is unavailable", async () => {
    const semantic = vi.fn(async () => ({
      items: [semanticItem("a")],
      semanticStatus: { state: "ready" as const, safeCode: null },
      rerankerStatus: {
        state: "degraded" as const,
        safeCode: "RERANKER_CONFIGURATION_UNAVAILABLE"
      }
    }));
    const search = createStorageVnextSemanticSearch({
      semanticGenerations: generationRepository(),
      resolveActiveRerankerRevision: async () => {
        throw new Error("repository unavailable");
      },
      semantic: { search: semantic },
      fallback: fallback(),
      hydration: hydration(),
      providerKind: "opensearch",
      vectorIndexPrefix: "focowiki",
      maxPageSize: 50,
      resolveRuntimeSettings: async () => ({
        requestTimeoutMs: 3000,
        searchLaneCutoffMs: 1000
      })
    });

    await expect(search.search({
      ...request(), rerank: true,
      rerankTopK: 30, rerankScoreThreshold: 0.35
    })).resolves.toMatchObject({
      items: [{ sourceFilePublicId: "file-a" }],
      rerankerStatus: {
        state: "degraded",
        safeCode: "RERANKER_CONFIGURATION_UNAVAILABLE"
      }
    });
    expect(semantic).toHaveBeenCalledOnce();
  });
});

function request() {
  return {
    knowledgeBaseId: "kb-main",
    query: "shared concept",
    kinds: ["file", "graph"] as const,
    limit: 2,
    cursor: null
  };
}

function generationRepository(overrides: Record<string, unknown> = {}) {
  return {
    async getActiveProjection(_knowledgeBaseId?: string) {
      return {
        publicId: "semantic-main",
        knowledgeBaseId: "kb-main",
        embeddingConfigurationRevisionPublicId: "embedding-revision-a",
        searchProviderKind: "opensearch" as const,
        resolvedDimension: 3,
        mappingFingerprintSha256: "a".repeat(64),
        ...overrides
      };
    }
  };
}

function fallback() {
  return { search: vi.fn(async () => ({ items: [], nextCursor: null })) };
}

function hydration() {
  return {
    async hydrateCurrentSources(input: { sourceFilePublicIds: readonly string[] }) {
      return input.sourceFilePublicIds.map((id) => ({
        sourceFilePublicId: id,
        sourceRevisionPublicId: id.replace("file-", "revision-"),
        logicalPath: `${id.replace("file-", "")}.md`,
        title: id.toUpperCase(),
        metadata: { language: "en" }
      }));
    }
  };
}

function semanticItem(id: string) {
  return {
    sourceFilePublicId: `file-${id}`,
    sourceRevisionPublicId: `revision-${id}`,
    logicalPath: `${id}.md`,
    title: id.toUpperCase(),
    score: 1,
    evidenceFamilies: ["content_vector"],
    matchedFields: ["content"],
    evidenceTypes: ["content"],
    sourceExcerpt: null,
    explanations: []
  };
}

function paginationStore() {
  const values = new Map<string, StorageVnextSemanticPaginationState>();
  let sequence = 0;
  return {
    read: vi.fn(async (scopeHash: string, cursor: string) =>
      values.get(`${scopeHash}:${cursor}`) ?? null),
    write: vi.fn(async (
      scopeHash: string,
      value: StorageVnextSemanticPaginationState
    ) => {
      sequence += 1;
      const cursor = `search-cursor-${sequence}`;
      values.set(`${scopeHash}:${cursor}`, value);
      return cursor;
    })
  };
}

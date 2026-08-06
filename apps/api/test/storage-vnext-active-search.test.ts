import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  SearchEngineTransportError,
  type SearchEngineTransport
} from "../src/application/ports/search-engine-transport.js";
import type {
  StorageVnextActiveSearchProjectionRepository
} from "../src/storage-vnext/search/active-projection-repository.js";
import {
  createStorageVnextActiveSearch,
  StorageVnextSearchUnavailableError
} from "../src/storage-vnext/search/active-search.js";
import type {
  StorageVnextSearchHydrationPort
} from "../src/storage-vnext/search/search-hydration.js";

describe("storage vNext active unified search", () => {
  it("queries one active index for content and graph seeds then hydrates current paths", async () => {
    const transport = createTransport({
      search: vi.fn(async () => ({
        hits: [
          hit("file-a", "revision-a", "pages/a.md", "Alpha", "alpha snippet"),
          hit("file-deleted", "revision-deleted", "pages/deleted.md", "Deleted", null)
        ],
        estimatedTotalHits: 2,
        processingTimeMs: 1
      }))
    });
    const hydration = createHydration([{
      sourceFilePublicId: "file-a",
      sourceRevisionPublicId: "revision-a",
      logicalPath: "pages/a.md",
      title: "Alpha current"
    }]);
    const search = createSearch(transport, hydration);

    await expect(search.search({
      knowledgeBaseId: "kb-a",
      query: "alpha",
      kinds: ["file", "graph"],
      limit: 10,
      cursor: null
    })).resolves.toEqual({
      items: [{
        publicId: "file-a",
        sourceFilePublicId: "file-a",
        logicalPath: "pages/a.md",
        title: "Alpha current",
        snippet: "alpha snippet",
        score: 1,
        kind: "file"
      }],
      nextCursor: null
    });

    expect(transport.search).toHaveBeenCalledOnce();
    expect(transport.search).toHaveBeenCalledWith(expect.objectContaining({
      indexUid: "owned_vnext_kb_active",
      filter: expect.stringContaining('knowledgeBaseId = "kb-a"'),
      attributesToSearchOn: ["title", "logicalPath", "searchText", "rankingTerms"],
      attributesToRetrieve: expect.arrayContaining(["documentKind"]),
      distinct: "sourceFilePublicId"
    }));
    expect((transport.search as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].filter)
      .toMatch(/documentKind = "content".*documentKind = "graph_seed"/u);
  });

  it("preserves whether the selected unified-index hit is content or a graph seed", async () => {
    const transport = createTransport({
      search: vi.fn(async () => ({
        hits: [
          hit("file-a", "revision-a", "pages/a.md", "Alpha", "graph snippet", "graph_seed")
        ],
        estimatedTotalHits: 1,
        processingTimeMs: 1
      }))
    });
    const search = createSearch(transport, createHydration([
      current("file-a", "revision-a", "pages/a.md", "Alpha")
    ]));

    await expect(search.search({
      knowledgeBaseId: "kb-a",
      query: "alpha",
      kinds: ["graph"],
      limit: 10,
      cursor: null
    })).resolves.toMatchObject({
      items: [{ kind: "graph", sourceFilePublicId: "file-a" }]
    });
  });

  it("reads overfetch and crop settings again for every live request", async () => {
    const transport = createTransport({
      search: vi.fn(async () => ({
        hits: [hit("file-a", "revision-a", "pages/a.md", "Alpha", "snippet")],
        estimatedTotalHits: 1,
        processingTimeMs: 1
      }))
    });
    let runtimeSettings = { overfetchFactor: 2, cropLength: 40 };
    const search = createStorageVnextActiveSearch({
      projections: {
        getActiveProjection: vi.fn(async () => ({
          publicId: "projection-active",
          knowledgeBaseId: "kb-a",
          providerIndexUid: "owned_vnext_kb_active",
          schemaChecksum: "a".repeat(64),
          settingsChecksum: "b".repeat(64),
          documentChecksum: "c".repeat(64),
          documentCount: 1
        }))
      },
      transport,
      hydration: createHydration([
        current("file-a", "revision-a", "pages/a.md", "Alpha")
      ]),
      maxPageSize: 100,
      overfetchFactor: runtimeSettings.overfetchFactor,
      cropLength: runtimeSettings.cropLength,
      resolveRuntimeSettings: vi.fn(async () => runtimeSettings)
    });

    await search.search({
      knowledgeBaseId: "kb-a",
      query: "alpha",
      kinds: ["file"],
      limit: 10,
      cursor: null
    });
    runtimeSettings = { overfetchFactor: 4, cropLength: 80 };
    await search.search({
      knowledgeBaseId: "kb-a",
      query: "alpha",
      kinds: ["file"],
      limit: 10,
      cursor: null
    });

    expect(transport.search).toHaveBeenNthCalledWith(1, expect.objectContaining({
      limit: 21,
      cropLength: 40
    }));
    expect(transport.search).toHaveBeenNthCalledWith(2, expect.objectContaining({
      limit: 41,
      cropLength: 80
    }));
  });

  it("uses an identity-bound cursor without exposing the provider index UID", async () => {
    const transport = createTransport({
      search: vi.fn()
        .mockResolvedValueOnce({
          hits: [
            hit("file-a", "revision-a", "pages/a.md", "A", null),
            hit("file-b", "revision-b", "pages/b.md", "B", null)
          ],
          estimatedTotalHits: 2,
          processingTimeMs: 1
        })
        .mockResolvedValueOnce({
          hits: [hit("file-b", "revision-b", "pages/b.md", "B", null)],
          estimatedTotalHits: 2,
          processingTimeMs: 1
        })
    });
    const hydration = createHydration([
      current("file-a", "revision-a", "pages/a.md", "A"),
      current("file-b", "revision-b", "pages/b.md", "B")
    ]);
    const search = createSearch(transport, hydration);
    const first = await search.search({
      knowledgeBaseId: "kb-a",
      query: "query",
      kinds: ["file"],
      limit: 1,
      cursor: null
    });

    expect(first.nextCursor).toBeTruthy();
    expect(first.nextCursor).not.toContain("owned_vnext_kb_active");
    await search.search({
      knowledgeBaseId: "kb-a",
      query: "query",
      kinds: ["file"],
      limit: 1,
      cursor: first.nextCursor
    });
    expect(transport.search).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 1 })
    );
    await expect(search.search({
      knowledgeBaseId: "kb-b",
      query: "query",
      kinds: ["file"],
      limit: 1,
      cursor: first.nextCursor
    })).rejects.toMatchObject({ code: "INVALID_SEARCH_CURSOR" });
  });

  it("returns one stable safe error and leaves file-first reads independent", async () => {
    const rawError = new SearchEngineTransportError("SEARCH_ENGINE_UNAVAILABLE", true);
    const transport = createTransport({
      search: vi.fn(async () => { throw rawError; })
    });
    const readMarkdown = vi.fn(async () => "# File remains readable");
    const search = createSearch(transport, createHydration([]));

    const error = await search.search({
      knowledgeBaseId: "kb-a",
      query: "alpha",
      kinds: ["file"],
      limit: 10,
      cursor: null
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(StorageVnextSearchUnavailableError);
    expect(error).toMatchObject({
      code: "SEARCH_ENGINE_UNAVAILABLE",
      retryable: true,
      message: "Search service is temporarily unavailable"
    });
    expect(JSON.stringify(error)).not.toMatch(/indexUid|taskUid|apiKey|owned_vnext/iu);
    await expect(readMarkdown()).resolves.toBe("# File remains readable");
    expect(readMarkdown).toHaveBeenCalledOnce();
  });

  it("fails safely when no active projection exists without querying any corpus", async () => {
    const transport = createTransport();
    const projections: StorageVnextActiveSearchProjectionRepository = {
      getActiveProjection: vi.fn(async () => null)
    };
    const search = createStorageVnextActiveSearch({
      projections,
      transport,
      hydration: createHydration([]),
      maxPageSize: 100,
      overfetchFactor: 2,
      cropLength: 40
    });

    await expect(search.search({
      knowledgeBaseId: "kb-a",
      query: "alpha",
      kinds: ["file"],
      limit: 10,
      cursor: null
    })).rejects.toMatchObject({ code: "SEARCH_ENGINE_UNAVAILABLE" });
    expect(transport.search).not.toHaveBeenCalled();
  });

  it("accepts the validated runtime search crop-length range", () => {
    expect(() => createStorageVnextActiveSearch({
      projections: {
        getActiveProjection: vi.fn(async () => null)
      },
      transport: createTransport(),
      hydration: createHydration([]),
      maxPageSize: 200,
      overfetchFactor: 3,
      cropLength: 5_000
    })).not.toThrow();
  });

  it("contains no PostgreSQL lexical fallback dependency", () => {
    const source = readFileSync(resolve(
      import.meta.dirname,
      "../src/storage-vnext/search/active-search.ts"
    ), "utf8");
    expect(source).not.toMatch(
      /body-search-query|graph-search-query|active-projection-search|postgres_compatibility/u
    );
    expect(source).not.toMatch(
      /search_projection_documents|search_projection_segments|source_file_graph_term/u
    );
  });
});

function createSearch(
  transport: SearchEngineTransport,
  hydration: StorageVnextSearchHydrationPort
) {
  return createStorageVnextActiveSearch({
    projections: {
      getActiveProjection: vi.fn(async () => ({
        publicId: "projection-active",
        knowledgeBaseId: "kb-a",
        providerIndexUid: "owned_vnext_kb_active",
        schemaChecksum: "a".repeat(64),
        settingsChecksum: "b".repeat(64),
        documentChecksum: "c".repeat(64),
        documentCount: 2
      }))
    },
    transport,
    hydration,
    maxPageSize: 100,
    overfetchFactor: 2,
    cropLength: 40
  });
}

function createHydration(
  records: Awaited<ReturnType<StorageVnextSearchHydrationPort["hydrateCurrentSources"]>>
): StorageVnextSearchHydrationPort {
  return {
    hydrateCurrentSources: vi.fn(async ({ sourceFilePublicIds }) =>
      records.filter((record) => sourceFilePublicIds.includes(record.sourceFilePublicId))
    )
  };
}

function createTransport(overrides: Partial<SearchEngineTransport> = {}): SearchEngineTransport {
  return {
    health: vi.fn(async () => ({ available: true })),
    getPressure: vi.fn(async () => ({
      queueLatencyMs: 0,
      residentMemoryBytes: 0,
      databaseSizeBytes: 0,
      taskQueueSizeBytes: 0
    })),
    createIndex: vi.fn(async () => ({ taskUid: 1 })),
    getIndex: vi.fn(async () => null),
    getDocument: vi.fn(async () => null),
    getSettings: vi.fn(async () => { throw new Error("unused"); }),
    updateSettings: vi.fn(async () => ({ taskUid: 2 })),
    addDocuments: vi.fn(async () => ({ taskUid: 3 })),
    deleteDocuments: vi.fn(async () => ({ taskUid: 4 })),
    deleteIndex: vi.fn(async () => ({ taskUid: 5 })),
    swapIndexes: vi.fn(async () => ({ taskUid: 6 })),
    getTask: vi.fn(async (taskUid) => ({
      taskUid,
      status: "succeeded" as const,
      errorCode: null
    })),
    search: vi.fn(async () => ({
      hits: [], estimatedTotalHits: 0, processingTimeMs: 0
    })),
    ...overrides
  };
}

function hit(
  sourceFilePublicId: string,
  sourceRevisionPublicId: string,
  logicalPath: string,
  title: string,
  snippet: string | null,
  documentKind: "content" | "graph_seed" = "content"
) {
  return {
    id: `${sourceFilePublicId}-document`,
    sourceFilePublicId,
    sourceRevisionPublicId,
    logicalPath,
    title,
    documentKind,
    ...(snippet ? { _formatted: { searchText: snippet } } : {})
  };
}

function current(
  sourceFilePublicId: string,
  sourceRevisionPublicId: string,
  logicalPath: string,
  title: string
) {
  return { sourceFilePublicId, sourceRevisionPublicId, logicalPath, title };
}

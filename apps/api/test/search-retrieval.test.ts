import { describe, expect, it, vi } from "vitest";
import type {
  SearchEngineSearchRequest,
  SearchEngineTransport
} from "../src/application/ports/search-engine-transport.js";
import {
  SearchRetrievalInputError,
  createSearchRetrieval
} from "../src/search/search-retrieval.js";

describe("Meilisearch retrieval", () => {
  it("runs scoped exact and strict branches without application tokenization", async () => {
    const requests: SearchEngineSearchRequest[] = [];
    const transport = fakeTransport(async (request) => {
      requests.push(request);
      if (request.attributesToSearchOn?.[0] === "title") {
        return {
          hits: [
            hit({
              sourceFileId: "source-exact",
              sourceRevisionId: "revision-exact",
              title: "中华人民共和国劳动合同法",
              logicalPath: "pages/labor-contract-law.md"
            }),
            hit({
              sourceFileId: "source-near",
              sourceRevisionId: "revision-near",
              title: "中华人民共和国劳动法",
              logicalPath: "pages/labor-law.md"
            })
          ],
          estimatedTotalHits: 2,
          processingTimeMs: 3
        };
      }
      if (request.attributesToSearchOn?.[0] === "logicalPath") {
        return emptySearch();
      }
      return {
        hits: [
          hit({
            sourceFileId: "source-body",
            sourceRevisionId: "revision-body",
            title: "Employment contract overview",
            logicalPath: "pages/employment-contract.md"
          })
        ],
        estimatedTotalHits: 1,
        processingTimeMs: 4
      };
    });
    const retrieval = createSearchRetrieval({
      transport,
      indexPrefix: "focowiki",
      branchCandidateLimit: 10,
      fusedCandidateLimit: 20,
      cropLength: 240
    });

    const result = await retrieval.searchContent({
      knowledgeBaseId: "kb-a\"b",
      activeEpoch: 7,
      query: "  中华人民共和国劳动合同法  ",
      limit: 2,
      cursor: null
    });

    expect(requests).toHaveLength(3);
    expect(requests.map((request) => request.matchingStrategy)).toEqual([
      "all",
      "all",
      "all"
    ]);
    expect(requests[0]?.attributesToSearchOn).toEqual(["title"]);
    expect(requests[1]?.attributesToSearchOn).toEqual(["logicalPath"]);
    for (const request of requests) {
      expect(request.query).toBe("中华人民共和国劳动合同法");
      expect(request.filter).toContain("knowledgeBaseId = \"kb-a\\\"b\"");
      expect(request.filter).toContain("visibleFromEpoch <= 7");
      expect(request.filter).toContain(
        "(visibleUntilEpoch IS NULL OR visibleUntilEpoch > 7)"
      );
      expect(request.filter).toContain("schemaVersion = \"content-segment-v1\"");
    }
    expect(result.items.map((item) => item.sourceFileId)).toEqual([
      "source-exact",
      "source-body"
    ]);
    expect(result.items[0]?.families).toContain("exact_title");
    expect(result.items.some((item) => item.sourceFileId === "source-near")).toBe(false);
  });

  it("uses the relaxed branch only when stronger branches underfill", async () => {
    const requests: SearchEngineSearchRequest[] = [];
    const transport = fakeTransport(async (request) => {
      requests.push(request);
      if (request.matchingStrategy === "last") {
        return {
          hits: [
            hit({
              sourceFileId: "source-relaxed",
              sourceRevisionId: "revision-relaxed",
              title: "Typo tolerant result",
              logicalPath: "pages/typo.md"
            })
          ],
          estimatedTotalHits: 1,
          processingTimeMs: 2
        };
      }
      return emptySearch();
    });
    const retrieval = createSearchRetrieval({
      transport,
      indexPrefix: "focowiki",
      branchCandidateLimit: 10,
      fusedCandidateLimit: 20,
      cropLength: 240
    });

    const result = await retrieval.searchContent({
      knowledgeBaseId: "kb-one",
      activeEpoch: 2,
      query: "employmnt contract",
      limit: 5,
      cursor: null
    });

    expect(requests).toHaveLength(4);
    expect(requests.at(-1)?.matchingStrategy).toBe("last");
    expect(result.items[0]).toMatchObject({
      sourceFileId: "source-relaxed",
      sourceRevisionId: "revision-relaxed",
      families: ["typo"]
    });
  });

  it("applies file-kind and field-scope constraints to every retrieval branch", async () => {
    const requests: SearchEngineSearchRequest[] = [];
    const retrieval = createSearchRetrieval({
      transport: fakeTransport(async (request) => {
        requests.push(request);
        return emptySearch();
      }),
      indexPrefix: "focowiki",
      branchCandidateLimit: 10,
      fusedCandidateLimit: 20,
      cropLength: 240
    });

    await retrieval.searchContent({
      knowledgeBaseId: "kb-one",
      activeEpoch: 2,
      query: "guides",
      scope: "path",
      fileKind: "page",
      limit: 5,
      cursor: null
    });

    expect(requests).toHaveLength(3);
    expect(requests.every((request) =>
      request.attributesToSearchOn?.length === 1
      && request.attributesToSearchOn[0] === "logicalPath"
    )).toBe(true);
    expect(requests.every((request) =>
      request.filter?.includes('fileKind = "page"')
    )).toBe(true);
  });

  it("rejects unsafe or unbounded plain-text queries before transport", async () => {
    const transport = fakeTransport(async () => emptySearch());
    const retrieval = createSearchRetrieval({
      transport,
      indexPrefix: "focowiki",
      branchCandidateLimit: 10,
      fusedCandidateLimit: 20,
      cropLength: 240
    });

    await expect(retrieval.searchContent({
      knowledgeBaseId: "kb-one",
      activeEpoch: 1,
      query: "\u0000",
      limit: 5,
      cursor: null
    })).rejects.toBeInstanceOf(SearchRetrievalInputError);
    await expect(retrieval.searchContent({
      knowledgeBaseId: "kb-one",
      activeEpoch: 1,
      query: "x".repeat(513),
      limit: 5,
      cursor: null
    })).rejects.toMatchObject({ code: "INVALID_SEARCH_QUERY" });
  });

  it("reads bounded runtime settings for each later request", async () => {
    const requests: SearchEngineSearchRequest[] = [];
    let branchCandidateLimit = 10;
    const retrieval = createSearchRetrieval({
      transport: fakeTransport(async (request) => {
        requests.push(request);
        return emptySearch();
      }),
      indexPrefix: "focowiki",
      getSettings: async () => ({
        branchCandidateLimit,
        fusedCandidateLimit: branchCandidateLimit,
        cropLength: 240
      })
    });

    await retrieval.searchContent({
      knowledgeBaseId: "kb-one",
      activeEpoch: 1,
      query: "first",
      limit: 5,
      cursor: null
    });
    branchCandidateLimit = 20;
    await retrieval.searchContent({
      knowledgeBaseId: "kb-one",
      activeEpoch: 1,
      query: "second",
      limit: 5,
      cursor: null
    });

    expect(requests.slice(0, 4).every((request) => request.limit === 10)).toBe(true);
    expect(requests.slice(4).every((request) => request.limit === 20)).toBe(true);
  });
});

function hit(input: {
  sourceFileId: string;
  sourceRevisionId: string;
  title: string;
  logicalPath: string;
}): Record<string, unknown> {
  return {
    id: `segment-${input.sourceFileId}`,
    ...input,
    body: "Matched body excerpt",
    sourceUrl: null,
    schemaVersion: "content-segment-v1"
  };
}

function emptySearch() {
  return {
    hits: [],
    estimatedTotalHits: 0,
    processingTimeMs: 1
  };
}

function fakeTransport(
  search: SearchEngineTransport["search"]
): SearchEngineTransport {
  return {
    health: vi.fn(),
    getPressure: vi.fn(),
    createIndex: vi.fn(),
    getIndex: vi.fn(),
    getDocument: vi.fn(),
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
    addDocuments: vi.fn(),
    deleteDocuments: vi.fn(),
    deleteIndex: vi.fn(),
    swapIndexes: vi.fn(),
    getTask: vi.fn(),
    search
  };
}

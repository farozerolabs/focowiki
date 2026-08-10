import { describe, expect, it, vi } from "vitest";
import type { LexicalTokenizer } from
  "../src/application/ports/lexical-tokenizer.js";
import type { SearchProviderQueryRequest } from
  "../src/application/ports/search-provider-runtime.js";
import type { OpenSearchClientPort } from
  "../src/infrastructure/opensearch/opensearch-client-port.js";
import { createOpenSearchQueryPort } from
  "../src/infrastructure/opensearch/opensearch-query-runtime.js";

describe("OpenSearch query runtime", () => {
  it("builds structured exact, text, phrase, typo, Jieba, graph, and filter clauses", async () => {
    const client = createClient();
    const tokenizer = createTokenizer();
    const query = createOpenSearchQueryPort({
      client,
      tokenizer,
      maximumResultWindow: 2_000,
      engineSearchCutoffMs: 1_000
    });
    vi.mocked(client.search).mockResolvedValue(searchResponse([]));

    await query.query(request({
      query: "Employment 合同 ) OR *",
      filters: {
        kind: "equals",
        field: "knowledgeBaseId",
        value: "kb-a\") OR *"
      }
    }));

    expect(tokenizer.tokenizeQuery).toHaveBeenCalledWith(
      "Employment 合同 ) OR *",
      64
    );
    const sent = vi.mocked(client.search).mock.calls[0]![0];
    const serialized = JSON.stringify(sent);
    expect(serialized).not.toContain("query_string");
    expect(serialized).not.toContain("simple_query_string");
    expect(sent).toMatchObject({
      index: "owned_candidate_a",
      body: {
        size: 3,
        timeout: "750ms",
        collapse: {
          field: "sourceFilePublicId",
          inner_hits: { name: "best_segment", size: 1 }
        },
        query: {
          bool: {
            filter: [{ term: { knowledgeBaseId: "kb-a\") OR *" } }]
          }
        }
      }
    });
    expect(vi.mocked(client.search).mock.calls[0]?.[1]).toEqual({
      requestTimeout: 750
    });
    expect(serialized).toContain("_focowikiTitleExact");
    expect(serialized).toContain("multi_match");
    expect(serialized).toContain('"type":"phrase"');
    expect(serialized).toContain("fuzziness");
    expect(serialized).toContain("_focowikiJiebaText");
    expect(serialized).toContain("rankingTerms");
  });

  it("normalizes collapsed hits, bounded snippets, scores, and stable continuations", async () => {
    const client = createClient();
    const query = createOpenSearchQueryPort({
      client,
      tokenizer: createTokenizer(),
      maximumResultWindow: 2_000,
      engineSearchCutoffMs: 1_000
    });
    vi.mocked(client.search).mockResolvedValue(searchResponse([
      hit("doc-a", "file-a", 8, [8, "file-a", "doc-a"], "first <em>match</em>"),
      hit("doc-b", "file-b", 2, [2, "file-b", "doc-b"], "second match"),
      hit("doc-c", "file-c", 1, [1, "file-c", "doc-c"], "lookahead")
    ], 17));

    const first = await query.query(request());
    expect(first.processingTimeMs).toBe(17);
    expect(first.hits).toHaveLength(2);
    expect(first.hits[0]).toMatchObject({
      documentId: "doc-a",
      sourceFilePublicId: "file-a",
      sourceRevisionPublicId: "revision-file-a",
      logicalPath: "pages/file-a.md",
      title: "file-a",
      normalizedScore: 8 / 9,
      snippets: ["first <em>match</em>"],
      sortKey: [8, "file-a", "doc-a"]
    });
    expect(first.hits[0]!.continuationAfter).toEqual(expect.any(String));
    expect(first.continuation).toBe(first.hits[1]!.continuationAfter);

    vi.mocked(client.search).mockResolvedValueOnce(searchResponse([]));
    await query.query(request({ continuation: first.hits[0]!.continuationAfter }));
    expect(client.search).toHaveBeenLastCalledWith(expect.objectContaining({
      body: expect.objectContaining({
        from: 1
      })
    }), { requestTimeout: 750 });
  });

  it("renders nullable OKF equality and calendar-boundary filters without scripts", async () => {
    const client = createClient();
    const query = createOpenSearchQueryPort({
      client,
      tokenizer: createTokenizer(),
      maximumResultWindow: 2_000,
      engineSearchCutoffMs: 1_000
    });

    await query.query(request({
      filters: {
        kind: "and",
        operands: [{
          kind: "equals",
          field: "okfSignals.status",
          value: "stable"
        }, {
          kind: "equals",
          field: "okfSignals.trustTier",
          value: "human-reviewed"
        }, {
          kind: "range",
          field: "okfSignals.staleAfterEpochDay",
          operator: "lte",
          value: 20_672
        }]
      }
    }));

    const sent = vi.mocked(client.search).mock.calls[0]![0];
    expect(sent).toMatchObject({
      body: {
        query: {
          bool: {
            filter: [{
              bool: {
                filter: [
                  { term: { "okfSignals.status": "stable" } },
                  { term: { "okfSignals.trustTier": "human-reviewed" } },
                  { range: { "okfSignals.staleAfterEpochDay": { lte: 20_672 } } }
                ]
              }
            }]
          }
        }
      }
    });
    expect(JSON.stringify(sent)).not.toContain("script");
  });

  it("rejects stale provider cursors after index, query, or filter changes", async () => {
    const client = createClient();
    const query = createOpenSearchQueryPort({
      client,
      tokenizer: createTokenizer(),
      maximumResultWindow: 2_000,
      engineSearchCutoffMs: 1_000
    });
    vi.mocked(client.search).mockResolvedValueOnce(searchResponse([
      hit("doc-a", "file-a", 1, [1, "file-a", "doc-a"], "match"),
      hit("doc-b", "file-b", 0.5, [0.5, "file-b", "doc-b"], "lookahead")
    ]));
    const first = await query.query(request({ limit: 1 }));
    const calls = vi.mocked(client.search).mock.calls.length;

    for (const changed of [
      request({ indexUid: "owned_candidate_b", continuation: first.continuation }),
      request({ query: "different", continuation: first.continuation }),
      request({
        continuation: first.continuation,
        filters: { kind: "equals", field: "knowledgeBaseId", value: "kb-b" }
      })
    ]) {
      await expect(query.query(changed)).rejects.toMatchObject({ retryable: false });
    }
    expect(client.search).toHaveBeenCalledTimes(calls);
  });

  it("does not add fuzzy evidence for a Han-only query", async () => {
    const client = createClient();
    const query = createOpenSearchQueryPort({
      client,
      tokenizer: createTokenizer(),
      maximumResultWindow: 2_000,
      engineSearchCutoffMs: 1_000
    });
    await query.query(request({ query: "劳动合同" }));
    expect(JSON.stringify(vi.mocked(client.search).mock.calls[0]![0]))
      .not.toContain("fuzziness");
  });

  it("requires corroborating terms when the portable last-word strategy is used", async () => {
    const client = createClient();
    const query = createOpenSearchQueryPort({
      client,
      tokenizer: createTokenizer(),
      maximumResultWindow: 2_000,
      engineSearchCutoffMs: 1_000
    });

    await query.query(request({ matchingStrategy: "last" }));

    const sent = vi.mocked(client.search).mock.calls[0]![0] as {
      body: { query: { bool: { should: Array<Record<string, unknown>> } } };
    };
    const multiMatches = sent.body.query.bool.should.flatMap((clause) =>
      clause.multi_match ? [clause.multi_match] : []
    );
    expect(multiMatches).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "best_fields",
        operator: "or",
        minimum_should_match: "2<-70%"
      })
    ]));
  });

  it("requires high Jieba term coverage for relaxed Han-language evidence", async () => {
    const client = createClient();
    const tokenizer = createTokenizer();
    tokenizer.tokenizeQuery.mockReturnValue([
      "存在", "火星", "海洋", "采矿", "许可", "如何", "续期"
    ]);
    const query = createOpenSearchQueryPort({
      client,
      tokenizer,
      maximumResultWindow: 2_000,
      engineSearchCutoffMs: 1_000
    });

    await query.query(request({
      query: "不存在的火星海洋采矿许可如何续期？",
      evidenceFamilies: ["text", "phrase", "typo"],
      matchingStrategy: "last"
    }));

    const sent = vi.mocked(client.search).mock.calls[0]![0] as {
      body: { query: { bool: { should: Array<Record<string, any>> } } };
    };
    expect(sent.body.query.bool.should).toEqual([
      expect.objectContaining({
        bool: expect.objectContaining({
          must: [{
            match: {
              _focowikiJiebaText: {
                query: "存在 火星 海洋 采矿 许可 续期",
                operator: "or",
                minimum_should_match: "2<-20%"
              }
            }
          }]
        })
      })
    ]);
  });

  it("bounds multilingual execution clauses below the managed OpenSearch limit", async () => {
    const client = createClient();
    const tokenizer: LexicalTokenizer = {
      contractVersion: "lexical-tokenizer-v1-test",
      tokenizeDocument: vi.fn(() => []),
      tokenizeQuery: vi.fn(() => Array.from(
        { length: 64 },
        (_, index) => `法规术语${index}`
      ))
    };
    const query = createOpenSearchQueryPort({
      client,
      tokenizer,
      maximumResultWindow: 2_000,
      engineSearchCutoffMs: 1_000
    });
    const original = "法规术语".repeat(300);

    await query.query(request({ query: original }));

    const sent = vi.mocked(client.search).mock.calls[0]![0] as {
      body: { query: { bool: { should: Array<Record<string, unknown>> } } };
    };
    const executionQueries = sent.body.query.bool.should.flatMap((clause) => {
      const multiMatch = clause.multi_match as { query?: unknown } | undefined;
      const jieba = clause.match as {
        _focowikiJiebaText?: { query?: unknown };
      } | undefined;
      return [multiMatch?.query, jieba?._focowikiJiebaText?.query]
        .filter((value): value is string => typeof value === "string");
    });
    expect(executionQueries.length).toBeGreaterThan(0);
    expect(executionQueries).not.toContain(original);
    expect(executionQueries.every((value) =>
      Array.from(value.replaceAll(" ", "")).length <= 64
    )).toBe(true);
  });

  it("rejects unknown fields and malformed responses safely", async () => {
    const client = createClient();
    const query = createOpenSearchQueryPort({
      client,
      tokenizer: createTokenizer(),
      maximumResultWindow: 2_000,
      engineSearchCutoffMs: 1_000
    });
    await expect(query.query(request({
      searchFields: ["title", "unknown"]
    }))).rejects.toMatchObject({ retryable: false });

    vi.mocked(client.search).mockResolvedValue({
      body: { took: 1, hits: { hits: [{ _id: "secret", _source: {} }] } }
    });
    const error = await query.query(request()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ retryable: false });
    expect(JSON.stringify(error)).not.toContain("secret");
  });
});

function request(
  overrides: Partial<SearchProviderQueryRequest> = {}
): SearchProviderQueryRequest {
  return {
    indexUid: "owned_candidate_a",
    query: "employment contract",
    evidenceFamilies: ["exact", "text", "phrase", "typo", "jieba", "graph"],
    filters: { kind: "equals", field: "knowledgeBaseId", value: "kb-a" },
    searchFields: ["title", "logicalPath", "searchText", "rankingTerms"],
    returnFields: [
      "documentKind", "sourceFilePublicId", "sourceRevisionPublicId",
      "logicalPath", "title", "searchText"
    ],
    limit: 2,
    continuation: null,
    cropLength: 120,
    deadlineMs: 750,
    matchingStrategy: "all",
    distinctBy: "sourceFilePublicId",
    ...overrides
  };
}

function createTokenizer(): LexicalTokenizer & {
  tokenizeQuery: ReturnType<typeof vi.fn>;
} {
  return {
    contractVersion: "lexical-tokenizer-v1-test",
    tokenizeDocument: vi.fn(() => ["document"]),
    tokenizeQuery: vi.fn(() => ["employment", "合同"])
  };
}

function createClient(): OpenSearchClientPort {
  return {
    search: vi.fn(async () => searchResponse([]))
  } as unknown as OpenSearchClientPort;
}

function searchResponse(hits: unknown[], took = 2) {
  return { body: { took, hits: { hits } } };
}

function hit(
  id: string,
  sourceFilePublicId: string,
  score: number,
  sort: unknown[],
  snippet: string
) {
  return {
    _id: id,
    _score: score,
    _source: {
      id,
      documentKind: "content",
      sourceFilePublicId,
      sourceRevisionPublicId: `revision-${sourceFilePublicId}`,
      logicalPath: `pages/${sourceFilePublicId}.md`,
      title: sourceFilePublicId,
      searchText: `complete body ${sourceFilePublicId}`
    },
    sort,
    highlight: { searchText: [snippet] }
  };
}

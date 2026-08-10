import { describe, expect, it, vi } from "vitest";
import { createSemanticSearchOrchestrator } from
  "../src/semantic/search/orchestrator.js";

describe("semantic search orchestrator", () => {
  it("starts safe lanes concurrently, shares one query vector, and resolves active sources", async () => {
    const started: string[] = [];
    let releaseEmbedding!: () => void;
    const embedding = new Promise<readonly number[]>((resolve) => {
      releaseEmbedding = () => resolve([1, 0, 0]);
    });
    const orchestrator = createSemanticSearchOrchestrator({
      queryEmbedding: { embed: async () => {
        started.push("embedding");
        return embedding;
      } },
      rankedLanes: {
        run: async ({ lane }) => {
          started.push(lane);
          return lane === "lexical" ? [candidate("file-lexical", lane, 1)] : [];
        }
      },
      vectors: {
        query: async ({ family }) => {
          started.push(`${family}_vector`);
          return { hits: [], processingTimeMs: 1 };
        }
      },
      vectorDocuments: vectorDocumentResolver(),
      sources: sourceResolver()
    });
    const result = orchestrator.search(request());
    await Promise.resolve();
    expect(started).toEqual(expect.arrayContaining([
      "exact_path", "exact_title", "lexical", "jieba", "file_graph", "embedding"
    ]));
    expect(started).not.toContain("content_vector");
    releaseEmbedding();
    await expect(result).resolves.toMatchObject({
      items: [expect.objectContaining({ sourceFilePublicId: "file-lexical" })],
      semanticStatus: { state: "ready", safeCode: null }
    });
    expect(started).toEqual(expect.arrayContaining([
      "content_vector", "entity_vector", "relationship_vector", "community_vector"
    ]));
  });

  it("uses deterministic weighted reciprocal-rank fusion with exact priority and duplicate collapse", async () => {
    const orchestrator = createSemanticSearchOrchestrator({
      queryEmbedding: { embed: async () => [1, 0, 0] },
      rankedLanes: {
        run: async ({ lane }) => {
          if (lane === "exact_path") return [candidate("file-exact", lane, 1)];
          if (lane === "exact_title") return [
            candidate("file-title-grounded", lane, 1),
            { ...candidate("file-title-only", lane, 2), bodyGrounded: false }
          ];
          if (lane === "lexical") return [
            candidate("file-semantic", lane, 1),
            candidate("file-title-grounded", lane, 2)
          ];
          return [];
        }
      },
      vectors: {
        query: async ({ family }) => ({
          hits: family === "entity"
            ? [vectorHit("file-semantic", family, 1)] : [],
          processingTimeMs: 1
        })
      },
      vectorDocuments: vectorDocumentResolver(),
      sources: sourceResolver()
    });
    const result = await orchestrator.search(request());
    expect(result.items.map((item) => item.sourceFilePublicId)).toEqual([
      "file-exact", "file-title-grounded", "file-semantic"
    ]);
    expect(result.items[1]!.evidenceFamilies).toEqual([
      "exact_title", "lexical"
    ]);
    expect(result.items[2]!.evidenceFamilies).toEqual([
      "entity_vector", "lexical"
    ]);
    expect(result.items.some((item) => item.sourceFilePublicId === "file-title-only"))
      .toBe(false);
  });

  it("counts each source once per lane when multiple semantic documents match", async () => {
    const orchestrator = createSemanticSearchOrchestrator({
      queryEmbedding: { embed: async () => [1, 0, 0] },
      rankedLanes: {
        run: async ({ lane }) => lane === "lexical"
          ? [candidate("file-grounded", lane, 1)] : []
      },
      vectors: {
        query: async ({ family }) => ({
          hits: family === "entity" ? [
            vectorHit("file-repeated", family, 1, "entity-one"),
            vectorHit("file-repeated", family, 2, "entity-two"),
            vectorHit("file-repeated", family, 3, "entity-three")
          ] : [],
          processingTimeMs: 1
        })
      },
      vectorDocuments: vectorDocumentResolver(),
      sources: sourceResolver()
    });

    const result = await orchestrator.search(request());

    expect(result.items.map((item) => item.sourceFilePublicId)).toEqual([
      "file-grounded", "file-repeated"
    ]);
    expect(result.items[1]!.evidenceFamilies).toEqual(["entity_vector"]);
  });

  it("returns completed lexical evidence as degraded when embedding or one lane times out", async () => {
    const orchestrator = createSemanticSearchOrchestrator({
      queryEmbedding: { embed: async ({ signal }) => new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }) },
      rankedLanes: {
        run: async ({ lane }) => lane === "lexical"
          ? [candidate("file-lexical", lane, 1)] : []
      },
      vectors: { query: vi.fn() },
      vectorDocuments: vectorDocumentResolver(),
      sources: sourceResolver()
    });
    const startedAt = Date.now();
    const result = await orchestrator.search({
      ...request(), overallDeadlineMs: 30, laneCutoffMs: 10
    });
    expect(Date.now() - startedAt).toBeLessThan(100);
    expect(result.items).toEqual([
      expect.objectContaining({ sourceFilePublicId: "file-lexical" })
    ]);
    expect(result.semanticStatus).toEqual({
      state: "degraded",
      safeCode: "SEMANTIC_LANE_PARTIAL_FAILURE"
    });
  });

  it.each([
    ["paraphrase", "content" as const, "file-content"],
    ["entity", "entity" as const, "file-entity"],
    ["multi-hop relationship", "relationship" as const, "file-relationship"],
    ["community theme", "community" as const, "file-community"]
  ])("retrieves %s evidence through its independently ranked family", async (
    _label,
    expectedFamily,
    expectedFile
  ) => {
    const orchestrator = createSemanticSearchOrchestrator({
      queryEmbedding: { embed: async () => [1, 0, 0] },
      rankedLanes: { run: async () => [] },
      vectors: {
        query: async ({ family }) => ({
          hits: family === expectedFamily
            ? [vectorHit(expectedFile, family, 1)] : [],
          processingTimeMs: 1
        })
      },
      vectorDocuments: vectorDocumentResolver(),
      sources: sourceResolver()
    });
    const result = await orchestrator.search(request());
    expect(result.items).toEqual([
      expect.objectContaining({ sourceFilePublicId: expectedFile })
    ]);
  });

  it("maps source evidence paths to generated page paths before ownership filtering", async () => {
    const orchestrator = createSemanticSearchOrchestrator({
      queryEmbedding: { embed: async () => [1, 0, 0] },
      rankedLanes: { run: async () => [] },
      vectors: {
        query: async ({ family }) => ({
          hits: family === "content" ? [{
            documentId: "vector-content-file-page",
            sourceFilePublicId: "file-page",
            sourceRevisionPublicId: "revision-file-page",
            ownerPublicId: "content-file-page",
            family,
            evidenceTargetPath: "guides/page.md",
            sourceExcerpt: "page evidence",
            rank: 1
          }] : [],
          processingTimeMs: 1
        })
      },
      vectorDocuments: vectorDocumentResolver(),
      sources: {
        async resolve() {
          return [{
            sourceFilePublicId: "file-page",
            sourceRevisionPublicId: "revision-file-page",
            logicalPath: "pages/guides/page.md",
            title: "Page"
          }];
        }
      }
    });

    await expect(orchestrator.search(request())).resolves.toMatchObject({
      items: [{
        sourceFilePublicId: "file-page",
        logicalPath: "pages/guides/page.md"
      }]
    });
  });

  it("keeps Chinese lexical evidence and returns an empty safe result when no lane matches", async () => {
    let matched = true;
    const orchestrator = createSemanticSearchOrchestrator({
      queryEmbedding: { embed: async () => [1, 0, 0] },
      rankedLanes: {
        run: async ({ lane }) => matched && lane === "jieba"
          ? [candidate("file-chinese", lane, 1)] : []
      },
      vectors: { query: async () => ({ hits: [], processingTimeMs: 0 }) },
      vectorDocuments: vectorDocumentResolver(),
      sources: sourceResolver()
    });
    await expect(orchestrator.search({ ...request(), query: "知识 图谱" }))
      .resolves.toMatchObject({
        items: [expect.objectContaining({ sourceFilePublicId: "file-chinese" })]
      });
    matched = false;
    await expect(orchestrator.search({ ...request(), query: "no result" }))
      .resolves.toMatchObject({ items: [] });
  });

  it("drops deleted, cross-knowledge-base, stale-revision, and candidate-generation hits", async () => {
    const queriedGenerations: string[] = [];
    const orchestrator = createSemanticSearchOrchestrator({
      queryEmbedding: { embed: async () => [1, 0, 0] },
      rankedLanes: { run: async () => [] },
      vectors: {
        query: async (input) => {
          queriedGenerations.push(input.semanticGenerationPublicId);
          return {
            hits: [
              vectorHit("file-active", input.family, 1),
              vectorHit("file-deleted", input.family, 2),
              vectorHit("file-cross-kb", input.family, 3),
              vectorHit("file-inactive-owner", input.family, 4),
              { ...vectorHit("file-stale", input.family, 5),
                sourceRevisionPublicId: "revision-stale-old" }
            ],
            processingTimeMs: 1
          };
        }
      },
      vectorDocuments: {
        async resolveActive({ documents }) {
          return documents
            .filter((document) => document.sourceFilePublicId
              !== "file-inactive-owner")
            .map((document) => document.documentId);
        }
      },
      sources: {
        async resolve({ knowledgeBaseId, sourceFilePublicIds }) {
          expect(knowledgeBaseId).toBe("kb-main");
          return sourceFilePublicIds
            .filter((id) => [
              "file-active", "file-stale", "file-inactive-owner"
            ].includes(id))
            .map((sourceFilePublicId) => ({
              sourceFilePublicId,
              sourceRevisionPublicId: `revision-${sourceFilePublicId}`,
              logicalPath: `pages/${sourceFilePublicId}.md`,
              title: sourceFilePublicId
            }));
        }
      }
    });
    const result = await orchestrator.search(request());
    expect(result.items.map((item) => item.sourceFilePublicId)).toEqual(["file-active"]);
    expect(new Set(queriedGenerations)).toEqual(new Set(["semantic-main"]));
  });

  it("oversamples every eligible family by at least thirty independently of corpus size", async () => {
    const requestedLimits: number[] = [];
    const orchestrator = createSemanticSearchOrchestrator({
      queryEmbedding: { embed: async () => [1, 0, 0] },
      rankedLanes: { run: async ({ limit }) => {
        requestedLimits.push(limit);
        return [];
      } },
      vectors: { query: async ({ limit }) => {
        requestedLimits.push(limit);
        return { hits: [], processingTimeMs: 0 };
      } },
      vectorDocuments: vectorDocumentResolver(),
      sources: sourceResolver()
    });

    await orchestrator.search({ ...request(), limit: 1 });
    expect(requestedLimits).toHaveLength(9);
    expect(new Set(requestedLimits)).toEqual(new Set([30]));
  });

  it("observes only bounded active source identities and stage ranks", async () => {
    const events: unknown[] = [];
    const orchestrator = createSemanticSearchOrchestrator({
      queryEmbedding: { embed: async () => [1, 0, 0] },
      rankedLanes: {
        run: async ({ lane }) => lane === "lexical"
          ? [candidate("file-active", lane, 1), candidate("file-stale", lane, 2)]
          : []
      },
      vectors: { query: async () => ({ hits: [], processingTimeMs: 0 }) },
      vectorDocuments: vectorDocumentResolver(),
      sources: {
        async resolve() {
          return [{
            sourceFilePublicId: "file-active",
            sourceRevisionPublicId: "revision-file-active",
            logicalPath: "pages/file-active.md",
            title: "Active"
          }];
        }
      },
      observer: { observe: (event) => events.push(event) }
    });

    await orchestrator.search({ ...request(), limit: 1 });
    expect(events).toContainEqual({
      stage: "lexical",
      items: [{ sourceFilePublicId: "file-active", rank: 1 }]
    });
    expect(events).toContainEqual({
      stage: "fused",
      items: [{ sourceFilePublicId: "file-active", rank: 1 }]
    });
    expect(JSON.stringify(events)).not.toMatch(
      /"snippet"|"title"|"sourceRevision|"semanticOwner/iu
    );
  });

  it("diversifies community candidates after RRF while preserving exact tiers", async () => {
    const events: unknown[] = [];
    const orchestrator = createSemanticSearchOrchestrator({
      queryEmbedding: { embed: async () => [1, 0, 0] },
      rankedLanes: {
        run: async ({ lane }) => lane === "exact_path"
          ? [candidate("file-exact", lane, 1)] : []
      },
      vectors: {
        query: async ({ family }) => ({
          hits: family === "community" ? [
            { ...vectorHit("file-a", family, 1), ownerPublicId: "community-one" },
            { ...vectorHit("file-b", family, 2), ownerPublicId: "community-one" },
            { ...vectorHit("file-c", family, 3), ownerPublicId: "community-two" }
          ] : [],
          processingTimeMs: 1
        })
      },
      vectorDocuments: vectorDocumentResolver(),
      sources: sourceResolver(),
      observer: { observe: (event) => events.push(event) }
    });

    const result = await orchestrator.search({ ...request(), limit: 4 });
    expect(result.items.map((item) => item.sourceFilePublicId)).toEqual([
      "file-exact", "file-a", "file-c", "file-b"
    ]);
    expect(events).toContainEqual({
      stage: "diversified",
      items: [
        { sourceFilePublicId: "file-exact", rank: 1 },
        { sourceFilePublicId: "file-a", rank: 2 },
        { sourceFilePublicId: "file-c", rank: 3 },
        { sourceFilePublicId: "file-b", rank: 4 }
      ]
    });
  });

  it("reranks only after active-source resolution and keeps truthful evidence", async () => {
    const order: string[] = [];
    const reranker = vi.fn(async (rerankRequest) => {
      order.push("reranker");
      expect(rerankRequest.candidates).toEqual([
        expect.objectContaining({
          sourceFilePublicId: "file-exact",
          priority: "exact_path",
          evidenceTypes: ["path"]
        }),
        expect.objectContaining({
          sourceFilePublicId: "file-a",
          priority: "fused",
          sourceExcerpt: "content_vector evidence",
          evidenceTypes: ["content"]
        }),
        expect.objectContaining({
          sourceFilePublicId: "file-b",
          priority: "fused",
          sourceExcerpt: "content_vector evidence",
          evidenceTypes: ["content"]
        })
      ]);
      return {
        candidates: [
          rerankRequest.candidates[0]!,
          rerankRequest.candidates[2]!
        ],
        status: { state: "applied" as const, safeCode: null },
        hasMore: false
      };
    });
    const orchestrator = createSemanticSearchOrchestrator({
      queryEmbedding: { embed: async () => [1, 0, 0] },
      rankedLanes: {
        run: async ({ lane }) => lane === "exact_path"
          ? [candidate("file-exact", lane, 1)] : []
      },
      vectors: {
        query: async ({ family }) => ({
          hits: family === "content"
            ? [
                { ...vectorHit("file-a", family, 1),
                  sourceExcerpt: "content_vector evidence" },
                { ...vectorHit("file-b", family, 2),
                  sourceExcerpt: "content_vector evidence" },
                { ...vectorHit("file-foreign", family, 3),
                  sourceExcerpt: "foreign knowledge-base evidence" }
              ]
            : [],
          processingTimeMs: 1
        })
      },
      vectorDocuments: vectorDocumentResolver(),
      sources: { resolve: async (sourceRequest) => {
        order.push("sources");
        return (await sourceResolver().resolve(sourceRequest)).filter(
          (source) => source.sourceFilePublicId !== "file-foreign"
        );
      } },
      reranker: { rerank: reranker }
    });

    const result = await orchestrator.search({
      ...request(), limit: 2, rerank: true,
      rerankTopK: 3, rerankScoreThreshold: 0.5
    });
    expect(order).toEqual(["sources", "reranker"]);
    expect(result.items.map((item) => item.sourceFilePublicId)).toEqual([
      "file-exact", "file-b"
    ]);
    expect(result.items[0]).toMatchObject({
      matchedFields: ["path"],
      evidenceTypes: ["path"],
      sourceExcerpt: null
    });
    expect(result.items[1]).toMatchObject({
      matchedFields: ["content"],
      evidenceTypes: ["content"],
      sourceExcerpt: "content_vector evidence"
    });
    expect(result.rerankerStatus).toEqual({ state: "applied", safeCode: null });
  });

  it("does not resolve a reranker when disabled", async () => {
    const reranker = vi.fn();
    const orchestrator = createSemanticSearchOrchestrator({
      queryEmbedding: { embed: async () => [1, 0, 0] },
      rankedLanes: {
        run: async ({ lane }) => lane === "lexical"
          ? [candidate("file-a", lane, 1)] : []
      },
      vectors: { query: async () => ({ hits: [], processingTimeMs: 0 }) },
      vectorDocuments: vectorDocumentResolver(),
      sources: sourceResolver(),
      reranker: { rerank: reranker }
    });

    const result = await orchestrator.search(request());
    expect(reranker).not.toHaveBeenCalled();
    expect(result.rerankerStatus).toEqual({
      state: "skipped",
      safeCode: "RERANKER_DISABLED"
    });
  });

  it("fails open to diversified results when the reranker boundary rejects", async () => {
    const orchestrator = createSemanticSearchOrchestrator({
      queryEmbedding: { embed: async () => [1, 0, 0] },
      rankedLanes: {
        run: async ({ lane }) => lane === "lexical"
          ? [candidate("file-a", lane, 1), candidate("file-b", lane, 2)] : []
      },
      vectors: { query: async () => ({ hits: [], processingTimeMs: 0 }) },
      vectorDocuments: vectorDocumentResolver(),
      sources: sourceResolver(),
      reranker: { rerank: async () => {
        throw new Error("reranker unavailable");
      } }
    });

    await expect(orchestrator.search({
      ...request(), limit: 2, rerank: true,
      rerankTopK: 30, rerankScoreThreshold: 0.35
    })).resolves.toMatchObject({
      items: [
        { sourceFilePublicId: "file-a" },
        { sourceFilePublicId: "file-b" }
      ],
      rerankerStatus: {
        state: "degraded",
        safeCode: "RERANKER_UNAVAILABLE"
      }
    });
  });

  it("bounds a stalled reranker inside the overall search deadline", async () => {
    const orchestrator = createSemanticSearchOrchestrator({
      queryEmbedding: { embed: async () => [1, 0, 0] },
      rankedLanes: {
        run: async ({ lane }) => lane === "lexical"
          ? [candidate("file-a", lane, 1)] : []
      },
      vectors: { query: async () => ({ hits: [], processingTimeMs: 0 }) },
      vectorDocuments: vectorDocumentResolver(),
      sources: sourceResolver(),
      reranker: { rerank: async () => new Promise(() => undefined) }
    });
    const startedAt = Date.now();

    const result = await orchestrator.search({
      ...request(), limit: 1, rerank: true,
      rerankTopK: 30, rerankScoreThreshold: 0.35,
      overallDeadlineMs: 30, laneCutoffMs: 10
    });

    expect(Date.now() - startedAt).toBeLessThan(100);
    expect(result).toMatchObject({
      items: [{ sourceFilePublicId: "file-a" }],
      rerankerStatus: {
        state: "degraded",
        safeCode: "RERANKER_UNAVAILABLE"
      }
    });
  });
});

function request() {
  return {
    knowledgeBaseId: "kb-main",
    query: "shared concept",
    mode: "hybrid" as const,
    limit: 10,
    overallDeadlineMs: 1_000,
    laneCutoffMs: 500,
    projection: {
      semanticGenerationPublicId: "semantic-main",
      embeddingConfigurationRevisionPublicId: "embedding-revision-1",
      vectorIndexUid: "semantic-vector-main",
      dimension: 3
    },
    signal: null
  };
}

function candidate(sourceFilePublicId: string, lane: string, rank: number) {
  return {
    sourceFilePublicId,
    sourceRevisionPublicId: `revision-${sourceFilePublicId}`,
    evidenceTargetPath: `pages/${sourceFilePublicId}.md`,
    rank,
    bodyGrounded: true,
    snippet: `${lane} evidence`
  };
}

function vectorHit(
  sourceFilePublicId: string,
  family: "content" | "entity" | "relationship" | "community",
  rank: number,
  ownerPublicId = `${family}-${sourceFilePublicId}`
) {
  return {
    documentId: `vector-${ownerPublicId}`,
    sourceFilePublicId,
    sourceRevisionPublicId: `revision-${sourceFilePublicId}`,
    ownerPublicId,
    family,
    evidenceTargetPath: `${sourceFilePublicId}.md`,
    sourceExcerpt: `${family}_vector evidence`,
    rank
  };
}

function sourceResolver() {
  return {
    async resolve({ sourceFilePublicIds }: { sourceFilePublicIds: readonly string[] }) {
      return sourceFilePublicIds.map((sourceFilePublicId) => ({
        sourceFilePublicId,
        sourceRevisionPublicId: `revision-${sourceFilePublicId}`,
        logicalPath: `pages/${sourceFilePublicId}.md`,
        title: sourceFilePublicId
      }));
    }
  };
}

function vectorDocumentResolver() {
  return {
    async resolveActive({ documents }: {
      documents: readonly { documentId: string }[];
    }) {
      return documents.map((document) => document.documentId);
    }
  };
}

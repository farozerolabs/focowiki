import { describe, expect, it, vi } from "vitest";

import { createSemanticSearchOrchestrator } from
  "../src/semantic/search/orchestrator.js";
import type { SearchProviderVectorFamily } from
  "../src/application/ports/search-provider-runtime.js";

describe("semantic search filter contract", () => {
  it("keeps file-kind and normalized OKF filters through every retrieval stage", async () => {
    const ranked = vi.fn(async ({ lane }: { lane: string }) => lane === "lexical"
      ? [candidate("file-eligible", lane)]
      : [candidate("file-ineligible", lane)]);
    const vectors = vi.fn(async ({ family }: {
      family: SearchProviderVectorFamily;
    }) => ({
      hits: [vectorHit(family, "file-eligible"), vectorHit(family, "file-ineligible")],
      processingTimeMs: 1
    }));
    const sourceResolve = vi.fn(async (request: {
      sourceFilePublicIds: readonly string[];
      fileKind?: string | null;
      okfFilters?: unknown;
    }) => {
      expect(request.fileKind).toBe("page");
      expect(request.okfFilters).toEqual(filters());
      return request.sourceFilePublicIds
        .filter((id) => id === "file-eligible")
        .map((sourceFilePublicId) => ({
          sourceFilePublicId,
          sourceRevisionPublicId: `revision-${sourceFilePublicId}`,
          logicalPath: `pages/${sourceFilePublicId}.md`,
          title: sourceFilePublicId,
          fileKind: "page",
          okfSignals: {
            status: "stable",
            trustTier: "human-reviewed",
            staleAfterEpochDay: 30_000
          }
        }));
    });
    const orchestrator = createSemanticSearchOrchestrator({
      queryEmbedding: { embed: async () => [1, 0, 0] },
      rankedLanes: { run: ranked },
      vectors: { query: vectors },
      vectorDocuments: {
        async resolveActive({ documents }) {
          return documents
            .filter((document) => document.sourceFilePublicId === "file-eligible")
            .map((document) => document.documentId);
        }
      },
      sources: { resolve: sourceResolve }
    });

    const result = await orchestrator.search({
      ...request(),
      scope: "all",
      fileKind: "page",
      okfFilters: filters()
    } as Parameters<typeof orchestrator.search>[0]);

    expect(result.items.map((item) => item.sourceFilePublicId))
      .toEqual(["file-eligible"]);
    for (const call of ranked.mock.calls) {
      expect(call[0]).toMatchObject({
        scope: "all",
        fileKind: "page",
        okfFilters: filters()
      });
    }
    for (const call of vectors.mock.calls) {
      expect(call[0]).toMatchObject({
        fileKind: "page",
        okfFilters: filters()
      });
    }
  });

  it.each([
    ["path", ["exact_path", "exact_title"]],
    ["metadata", ["lexical"]]
  ] as const)("constrains %s scope without declaring semantic search unavailable", async (
    scope,
    expectedLanes
  ) => {
    const started: string[] = [];
    const orchestrator = createSemanticSearchOrchestrator({
      queryEmbedding: { embed: async () => [1, 0, 0] },
      rankedLanes: { run: async ({ lane }) => {
        started.push(lane);
        return [];
      } },
      vectors: { query: async ({ family }) => {
        started.push(`${family}_vector`);
        return { hits: [], processingTimeMs: 1 };
      } },
      vectorDocuments: { resolveActive: async () => [] },
      sources: { resolve: async () => [] }
    });

    const result = await orchestrator.search({
      ...request(), scope, fileKind: "page", okfFilters: filters()
    } as Parameters<typeof orchestrator.search>[0]);
    expect(started.sort()).toEqual([...expectedLanes].sort());
    expect(result.semanticStatus.state).toBe("ready");
  });
});

function request() {
  return {
    knowledgeBaseId: "kb-main",
    query: "Which policy is current?",
    mode: "hybrid" as const,
    limit: 10,
    overallDeadlineMs: 1_000,
    laneCutoffMs: 500,
    projection: {
      semanticGenerationPublicId: "semantic-main",
      embeddingConfigurationRevisionPublicId: "embedding-revision-1",
      vectorIndexUid: "semantic-vector-main",
      lexicalIndexUid: "lexical-main",
      dimension: 3
    },
    signal: null
  };
}

function filters() {
  return {
    status: "stable" as const,
    trustTier: "human-reviewed" as const,
    freshness: "fresh" as const,
    requestEpochDay: 25_000
  };
}

function candidate(sourceFilePublicId: string, lane: string) {
  return {
    sourceFilePublicId,
    sourceRevisionPublicId: `revision-${sourceFilePublicId}`,
    evidenceTargetPath: `pages/${sourceFilePublicId}.md`,
    rank: 1,
    bodyGrounded: true,
    snippet: `${lane} evidence`
  };
}

function vectorHit(
  family: SearchProviderVectorFamily,
  sourceFilePublicId: string
) {
  return {
    documentId: `vector-${family}-${sourceFilePublicId}`,
    sourceFilePublicId,
    sourceRevisionPublicId: `revision-${sourceFilePublicId}`,
    ownerPublicId: `${family}-${sourceFilePublicId}`,
    family,
    evidenceTargetPath: `${sourceFilePublicId}.md`,
    sourceExcerpt: `${family} evidence`,
    rank: sourceFilePublicId === "file-eligible" ? 1 : 2
  };
}

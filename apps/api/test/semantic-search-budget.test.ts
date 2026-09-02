import { describe, expect, it } from "vitest";

import { createSemanticSearchBudget } from
  "../src/semantic/search/budget.js";

describe("semantic search budget", () => {
  it("keeps the full retrieval budget when reranking is disabled", () => {
    expect(createSemanticSearchBudget({
      overallDeadlineMs: 8_000,
      laneCutoffMs: 2_500,
      rerank: false
    })).toEqual({
      laneCutoffMs: 2_500,
      rerankerReserveMs: 0,
      retrievalDeadlineMs: 8_000
    });
  });

  it.each([
    [3_000, 2_500, 1_200, 1_800, 1_800],
    [8_000, 2_500, 3_200, 4_800, 2_500],
    [30_000, 3_000, 5_000, 25_000, 3_000]
  ])("reserves a bounded reranker window from %i ms", (
    overallDeadlineMs,
    configuredLaneCutoffMs,
    expectedReserveMs,
    expectedRetrievalDeadlineMs,
    expectedLaneCutoffMs
  ) => {
    expect(createSemanticSearchBudget({
      overallDeadlineMs,
      laneCutoffMs: configuredLaneCutoffMs,
      rerank: true
    })).toEqual({
      laneCutoffMs: expectedLaneCutoffMs,
      rerankerReserveMs: expectedReserveMs,
      retrievalDeadlineMs: expectedRetrievalDeadlineMs
    });
  });
});

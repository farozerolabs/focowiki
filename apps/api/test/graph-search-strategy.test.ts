import { describe, expect, it } from "vitest";
import { createGraphSearchStrategy } from
  "../src/infrastructure/postgres/graph-search-query.js";

describe("graph search strategy", () => {
  it("skips broad candidates for a selective long exact match", () => {
    expect(createGraphSearchStrategy({
      hasVisibleExactMatch: true,
      phrase: "A sufficiently specific exact document title for direct lookup"
    })).toEqual({
      runTermCandidates: false,
      runTrigramCandidates: false
    });
  });

  it("keeps related candidates for a short exact title", () => {
    expect(createGraphSearchStrategy({
      hasVisibleExactMatch: true,
      phrase: "缓存一致性指南"
    })).toEqual({
      runTermCandidates: true,
      runTrigramCandidates: true
    });
  });

  it("retains broad candidates when exact graph evidence is absent", () => {
    expect(createGraphSearchStrategy({
      hasVisibleExactMatch: false,
      phrase: "A sufficiently specific exact document title for direct lookup"
    })).toEqual({
      runTermCandidates: true,
      runTrigramCandidates: true
    });
  });
});

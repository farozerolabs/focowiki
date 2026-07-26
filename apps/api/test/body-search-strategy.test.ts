import { describe, expect, it } from "vitest";
import { createBodySearchStrategy } from
  "../src/infrastructure/postgres/body-search-query.js";

describe("body search strategy", () => {
  it("skips broad candidates for a selective long exact match", () => {
    expect(createBodySearchStrategy({
      hasVisibleExactMatch: true,
      phrase: "A sufficiently specific exact document title for direct lookup"
    })).toEqual({
      runTokenCandidates: false,
      runTrigramCandidates: false
    });
  });

  it("keeps related candidates for a short exact title", () => {
    expect(createBodySearchStrategy({
      hasVisibleExactMatch: true,
      phrase: "缓存一致性指南"
    })).toEqual({
      runTokenCandidates: true,
      runTrigramCandidates: true
    });
  });

  it("retains trigram candidates when exact title and path evidence is absent", () => {
    expect(createBodySearchStrategy({
      hasVisibleExactMatch: false,
      phrase: "A sufficiently specific exact document title for direct lookup"
    })).toEqual({
      runTokenCandidates: true,
      runTrigramCandidates: true
    });
  });
});

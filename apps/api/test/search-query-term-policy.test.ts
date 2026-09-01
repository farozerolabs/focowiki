import { describe, expect, it, vi } from "vitest";
import {
  createSearchTermPlan,
  requiredTermCoverage
} from "../src/application/search/query-term-policy.js";

describe("shared search query term policy", () => {
  it.each([
    [1, 1],
    [2, 2],
    [3, 2],
    [8, 2],
    [9, 3],
    [17, 6],
    [40, 6]
  ])("requires the documented coverage for %i informative terms", (
    count,
    expected
  ) => {
    expect(requiredTermCoverage(count)).toBe(expected);
  });

  it("keeps the full question unchanged for embedding while removing intent terms from lexical execution", () => {
    const tokenizer = {
      contractVersion: "test-v1",
      tokenizeDocument: vi.fn(() => []),
      tokenizeQuery: vi.fn(() => [
        "which", "documents", "explain", "hybrid", "retrieval"
      ])
    };
    const plan = createSearchTermPlan({
      query: "  Which documents explain hybrid retrieval?  ",
      tokenizer
    });
    expect(plan.fullQuestion).toBe(
      "Which documents explain hybrid retrieval?"
    );
    expect(plan.informativeTerms).toEqual(["hybrid", "retrieval"]);
    expect(plan.minimumShouldMatch).toBe(2);
  });

  it("permits one-term coverage only for the bounded empty-result relaxation", () => {
    const tokenizer = {
      contractVersion: "test-v1",
      tokenizeDocument: vi.fn(() => []),
      tokenizeQuery: vi.fn(() => ["alpha", "beta", "gamma", "delta"])
    };
    expect(createSearchTermPlan({
      query: "alpha beta gamma delta",
      tokenizer
    }).minimumShouldMatch).toBe(2);
    expect(createSearchTermPlan({
      query: "alpha beta gamma delta",
      tokenizer,
      relaxed: true
    }).minimumShouldMatch).toBe(1);
  });
});

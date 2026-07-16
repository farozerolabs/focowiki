import { describe, expect, it } from "vitest";
import { createSearchQueryTerms } from "../src/search/search-query-terms.js";

describe("search query terms", () => {
  it("splits a normalized multi-word query into bounded unique terms", () => {
    expect(createSearchQueryTerms("  Project   migration project  ")).toEqual([
      "project",
      "migration"
    ]);
  });

  it("keeps meaningful CJK terms for conjunctive retrieval", () => {
    expect(createSearchQueryTerms("七台河 立法条例")).toEqual(["七台河", "立法条例"]);
  });

  it("drops one-character noise when longer terms are available", () => {
    expect(createSearchQueryTerms("a migration b guide")).toEqual(["migration", "guide"]);
  });

  it("bounds query work without losing the original single phrase", () => {
    expect(createSearchQueryTerms("release")).toEqual(["release"]);
    expect(
      createSearchQueryTerms("one two three four five six seven eight nine ten")
    ).toHaveLength(8);
  });
});

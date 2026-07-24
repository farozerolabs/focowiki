import { describe, expect, it } from "vitest";
import { readDeveloperFileSearchFilters } from "../src/developer-openapi/file-search-filters.js";

describe("developer file search filters", () => {
  it("accepts bounded language-neutral search input", () => {
    expect(readDeveloperFileSearchFilters({
      query: "缓存 consistency 2026",
      scope: undefined,
      fileKind: undefined,
      mode: "hybrid",
      graphDepth: "2",
      graphFanout: "25"
    })).toEqual({
      ok: true,
      query: "缓存 consistency 2026",
      scope: "all",
      fileKind: "page",
      mode: "hybrid",
      graphDepth: 2,
      graphFanout: 25
    });
  });

  it.each([
    ["", "FILE_SEARCH_QUERY_REQUIRED"],
    ["a", "FILE_SEARCH_QUERY_TOO_SHORT"],
    ["x".repeat(161), "FILE_SEARCH_QUERY_TOO_LONG"],
    ["cache\u0000consistency", "INVALID_FILE_SEARCH_QUERY"],
    ["cache\nconsistency", "INVALID_FILE_SEARCH_QUERY"]
  ])("rejects invalid query input without database access", (query, code) => {
    expect(readDeveloperFileSearchFilters({
      query,
      scope: undefined,
      fileKind: undefined
    })).toEqual({ ok: false, code });
  });
});

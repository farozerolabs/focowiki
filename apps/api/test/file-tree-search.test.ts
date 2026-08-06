import { describe, expect, it } from "vitest";
import { readFileTreeSearchQuery } from "../src/admin/file-tree-search-filters.js";

describe("file tree search filters", () => {
  it("normalizes valid query text", () => {
    expect(readFileTreeSearchQuery(" pages ")).toEqual({
      ok: true,
      query: "pages"
    });
  });

  it("rejects empty, short, long, and unsafe query text", () => {
    expect(readFileTreeSearchQuery("")).toEqual({
      ok: false,
      code: "FILE_TREE_SEARCH_QUERY_REQUIRED"
    });
    expect(readFileTreeSearchQuery("a")).toEqual({
      ok: false,
      code: "FILE_TREE_SEARCH_QUERY_TOO_SHORT"
    });
    expect(readFileTreeSearchQuery("a".repeat(161))).toEqual({
      ok: false,
      code: "FILE_TREE_SEARCH_QUERY_TOO_LONG"
    });
    expect(readFileTreeSearchQuery("page\u0000")).toEqual({
      ok: false,
      code: "INVALID_FILE_TREE_SEARCH"
    });
  });
});

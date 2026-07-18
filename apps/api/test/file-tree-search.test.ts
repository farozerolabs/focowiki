import { describe, expect, it } from "vitest";
import { createFileTreeSearchCursorScope } from "../src/admin/file-tree-search-signature.js";
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

  it("creates stable cursor scopes from normalized query values", () => {
    const first = createFileTreeSearchCursorScope({
      knowledgeBaseId: "kb-001",
      generationId: "generation-001",
      query: "Intro",
      limit: 50
    });
    const second = createFileTreeSearchCursorScope({
      knowledgeBaseId: "kb-001",
      generationId: "generation-001",
      query: " intro ",
      limit: 50
    });
    const third = createFileTreeSearchCursorScope({
      knowledgeBaseId: "kb-001",
      generationId: "generation-001",
      query: "Setup",
      limit: 50
    });

    expect(first).toBe(second);
    expect(first).not.toBe(third);
    expect(first).toContain("file-tree-search:kb-001:generation-001:query=");
  });
});

import { describe, expect, it, vi } from "vitest";
import { createSemanticRankedLaneAdapter } from
  "../src/semantic/search/ranked-lanes.js";

describe("semantic ranked lane adapter", () => {
  it("uses bounded provider queries and keeps source-owned exact-title results", async () => {
    const query = vi.fn(async () => ({
      hits: [
        hit("file-a", 1, { title: "Shared concept", searchText: "Shared concept body" }),
        hit("file-b", 2, { title: "Shared concept", searchText: "" }),
        hit("file-c", 3, { title: "Different concept", searchText: "Shared concept body" })
      ],
      continuation: null,
      processingTimeMs: 1
    }));
    const lanes = createSemanticRankedLaneAdapter({ query: { query } });
    const result = await lanes.run({
      lane: "exact_title",
      indexUid: "lexical-active",
      knowledgeBaseId: "kb-main",
      query: "shared concept",
      limit: 10,
      deadlineMs: 1000,
      signal: new AbortController().signal
    });
    expect(result.map((item) => item.sourceFilePublicId)).toEqual(["file-a", "file-b"]);
    expect(result[0]).toMatchObject({
      rank: 1,
      normalizedScore: expect.any(Number),
      bodyGrounded: true
    });
    expect(result[1]).toMatchObject({ rank: 2, bodyGrounded: true });
    expect(query).toHaveBeenCalledWith(expect.objectContaining({
      indexUid: "lexical-active",
      limit: 10,
      continuation: null,
      searchFields: ["title"]
    }));
  });

  it.each([
    ["exact_path", ["logicalPath"]],
    ["lexical", ["title", "logicalPath", "searchText", "rankingTerms"]],
    ["jieba", ["searchText", "rankingTerms"]],
    ["file_graph", ["title", "logicalPath", "searchText", "rankingTerms"]]
  ] as const)("maps %s to its isolated provider branch", async (lane, fields) => {
    const query = vi.fn(async () => ({
      hits: [hit("file-a", 1, {
        title: "Title", logicalPath: "shared concept", searchText: "body"
      })],
      continuation: null,
      processingTimeMs: 1
    }));
    const lanes = createSemanticRankedLaneAdapter({ query: { query } });
    await lanes.run({
      lane,
      indexUid: "lexical-active",
      knowledgeBaseId: "kb-main",
      query: "shared concept",
      limit: 10,
      deadlineMs: 1000,
      signal: new AbortController().signal
    });
    expect(query).toHaveBeenCalledWith(expect.objectContaining({
      searchFields: [...fields]
    }));
  });
});

function hit(
  sourceFilePublicId: string,
  rank: number,
  document: Record<string, unknown>
) {
  return {
    documentId: `document-${sourceFilePublicId}`,
    sourceFilePublicId,
    sourceRevisionPublicId: `revision-${sourceFilePublicId}`,
    logicalPath: String(document.logicalPath ?? `${sourceFilePublicId}.md`),
    title: String(document.title ?? sourceFilePublicId),
    normalizedScore: 1 / rank,
    snippets: [`${sourceFilePublicId} evidence`],
    sortKey: [rank],
    continuationAfter: String(rank),
    document: {
      documentKind: "content",
      schemaVersion: "storage-vnext-content-v2",
      ...document
    }
  };
}

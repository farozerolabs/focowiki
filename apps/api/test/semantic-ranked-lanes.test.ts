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
    const lanes = createSemanticRankedLaneAdapter({
      query: { query },
      relationshipDocuments: activeRelationshipDocuments()
    });
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
      bodyGrounded: true,
      evidenceTargetPath: "pages/file-a.md"
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
    ["file_graph", ["title", "logicalPath", "searchText", "rankingTerms"]],
    ["file_relationship", [
      "title", "logicalPath", "targetTitle", "targetLogicalPath",
      "searchText", "rankingTerms"
    ]]
  ] as const)("maps %s to its isolated provider branch", async (lane, fields) => {
    const query = vi.fn(async () => ({
      hits: [hit("file-a", 1, {
        title: "Title", logicalPath: "shared concept.md", searchText: "body"
      })],
      continuation: null,
      processingTimeMs: 1
    }));
    const lanes = createSemanticRankedLaneAdapter({
      query: { query },
      relationshipDocuments: activeRelationshipDocuments()
    });
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

  it("drops relationship documents that PostgreSQL does not own as active", async () => {
    const query = vi.fn(async () => ({
      hits: [
        relationshipHit("file-a", "active-relationship"),
        relationshipHit("file-b", "obsolete-relationship")
      ],
      continuation: null,
      processingTimeMs: 1
    }));
    const resolveActive = vi.fn(async () => ["active-relationship"]);
    const lanes = createSemanticRankedLaneAdapter({
      query: { query },
      relationshipDocuments: { resolveActive }
    });

    await expect(lanes.run({
      lane: "file_relationship",
      indexUid: "lexical-active",
      knowledgeBaseId: "kb-main",
      query: "related concept",
      limit: 10,
      deadlineMs: 1000,
      signal: new AbortController().signal
    })).resolves.toEqual([
      expect.objectContaining({
        sourceFilePublicId: "file-a",
        sourceRevisionPublicId: "revision-file-a"
      })
    ]);
    expect(resolveActive).toHaveBeenCalledWith(expect.objectContaining({
      documents: expect.arrayContaining([expect.objectContaining({
        documentId: "active-relationship",
        targetSourceFilePublicId: "target-file-a",
        targetSourceRevisionPublicId: "target-revision-file-a"
      })])
    }));
  });
});

function activeRelationshipDocuments() {
  return {
    async resolveActive(input: { documents: readonly { documentId: string }[] }) {
      return input.documents.map((document) => document.documentId);
    }
  };
}

function relationshipHit(sourceFilePublicId: string, documentId: string) {
  return {
    ...hit(sourceFilePublicId, 1, {
      documentKind: "file_relationship",
      schemaVersion: "storage-vnext-file-relationship-v1",
      targetSourceFilePublicId: `target-${sourceFilePublicId}`,
      targetSourceRevisionPublicId: `target-revision-${sourceFilePublicId}`,
      searchText: "related concept"
    }),
    documentId
  };
}

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

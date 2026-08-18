import { describe, expect, it } from "vitest";
import { prepareDocumentSearchDocuments } from
  "../src/document-indexing/application/document-search-preparation.js";
import { prepareDocumentRelationshipSearchDocuments } from
  "../src/document-indexing/application/document-search-preparation.js";
import { canonicalFileRelation } from
  "../src/document-indexing/domain/file-relation.js";

describe("document search preparation", () => {
  it("creates deterministic provider-neutral revision and contract owned documents", () => {
    const request = {
      knowledgeBaseId: "knowledge-base-a",
      sourceFilePublicId: "source-file-a",
      sourceRevisionPublicId: "source-revision-a",
      searchContractSha256: "a".repeat(64),
      logicalPath: "guides/general.md",
      title: "General Guide",
      metadata: { tags: ["general"], custom: "retained" },
      fileSearchText: "General Guide\nguides/general.md\ngeneral",
      graphSeed: {
        searchText: "General Guide\nworkflow",
        rankingTerms: ["general workflow"]
      },
      segments: [{
        publicId: "segment-a",
        ordinal: 0,
        headingAncestors: ["General Guide"],
        searchText: "A general workflow.",
        embeddingArtifactPublicId: "embedding-content-a"
      }]
    } as const;

    const first = prepareDocumentSearchDocuments(request);
    const replay = prepareDocumentSearchDocuments(request);

    expect(replay).toEqual(first);
    expect(first).toHaveLength(3);
    expect(first.every((document) =>
      document.sourceRevisionPublicId === "source-revision-a"
      && document.searchContractSha256 === "a".repeat(64)
    )).toBe(true);
    expect(first[1]).toMatchObject({
      documentKind: "graph_seed",
      rankingTerms: ["general workflow"]
    });
    expect(first[2]).toMatchObject({
      documentKind: "segment",
      embeddingArtifactPublicId: "embedding-content-a"
    });
    expect(first[0]!.searchText).toContain('"custom":"retained"');
    expect(first[0]).not.toHaveProperty("providerIndex");
    expect(first[0]).not.toHaveProperty("vector");
  });

  it("changes physical identity when the search contract changes", () => {
    const common = {
      knowledgeBaseId: "knowledge-base-a",
      sourceFilePublicId: "source-file-a",
      sourceRevisionPublicId: "source-revision-a",
      logicalPath: "guide.md",
      title: "Guide",
      metadata: {},
      fileSearchText: "Guide",
      segments: []
    } as const;

    const first = prepareDocumentSearchDocuments({
      ...common,
      searchContractSha256: "a".repeat(64)
    });
    const changed = prepareDocumentSearchDocuments({
      ...common,
      searchContractSha256: "b".repeat(64)
    });

    expect(changed[0]!.publicId).not.toBe(first[0]!.publicId);
  });

  it("creates one revision-owned relationship document for each affected endpoint", () => {
    const relation = canonicalFileRelation({
      knowledgeBaseId: "knowledge-base-a",
      sourceFilePublicId: "source-file-a",
      targetSourceFilePublicId: "source-file-b",
      relationKind: "references",
      evidenceKind: "markdown_link",
      sourceRevisionPublicId: "source-revision-a",
      evidenceChecksumSha256: "b".repeat(64),
      evidence: { rawTarget: "b.md", excerpt: "Read B" }
    });
    const sources = [{
      sourceFilePublicId: "source-file-a",
      sourceRevisionPublicId: "source-revision-a",
      logicalPath: "a.md",
      title: "A",
      metadata: { tags: ["entry"] }
    }, {
      sourceFilePublicId: "source-file-b",
      sourceRevisionPublicId: "source-revision-b",
      logicalPath: "b.md",
      title: "B",
      metadata: { tags: ["target"] }
    }];

    const both = prepareDocumentRelationshipSearchDocuments({
      knowledgeBaseId: "knowledge-base-a",
      searchContractSha256: "a".repeat(64),
      affectedSourceFilePublicIds: ["source-file-a", "source-file-b"],
      sources,
      relations: [relation]
    });
    expect(both).toHaveLength(2);
    expect(both).toEqual(expect.arrayContaining([
      expect.objectContaining({
        documentKind: "file_relationship",
        sourceFilePublicId: "source-file-a",
        sourceRevisionPublicId: "source-revision-a",
        targetSourceFilePublicId: "source-file-b",
        targetSourceRevisionPublicId: "source-revision-b",
        direction: "outgoing",
        relationPublicId: relation.publicId,
        evidencePublicId: relation.evidence.publicId
      }),
      expect.objectContaining({
        sourceFilePublicId: "source-file-b",
        targetSourceFilePublicId: "source-file-a",
        direction: "incoming"
      })
    ]));
    expect(prepareDocumentRelationshipSearchDocuments({
      knowledgeBaseId: "knowledge-base-a",
      searchContractSha256: "a".repeat(64),
      affectedSourceFilePublicIds: ["source-file-b"],
      sources,
      relations: [relation]
    })).toEqual([expect.objectContaining({ sourceFilePublicId: "source-file-b" })]);
  });
});

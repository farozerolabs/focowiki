import { describe, expect, it } from "vitest";
import {
  fuseDocumentInternalHybridCandidates,
  hydrateDocumentInternalHybridCandidates
} from
  "../src/document-indexing/application/document-internal-hybrid-candidates.js";

describe("document internal hybrid candidates", () => {
  it("returns a successful empty set when every retrieval lane is empty", () => {
    expect(fuseDocumentInternalHybridCandidates({
      currentSourceFilePublicId: "source-file-current",
      limit: 8,
      lanes: []
    })).toEqual([]);
  });

  it("fuses provider-neutral lexical, jieba, metadata, and vector ranks", () => {
    const candidates = fuseDocumentInternalHybridCandidates({
      currentSourceFilePublicId: "source-file-current",
      limit: 2,
      lanes: [
        { family: "lexical", hits: [hit("a", "ra", "Lexical A"), hit("b", "rb", "Lexical B")] },
        { family: "jieba", hits: [hit("b", "rb", "Jieba B"), hit("a", "ra", "Jieba A")] },
        { family: "metadata", hits: [hit("a", "ra", "Metadata A")] },
        { family: "content_vector", hits: [hit("a", "ra", "Vector A")] }
      ]
    });

    expect(candidates.map((item) => item.sourceFilePublicId)).toEqual(["a", "b"]);
    expect(candidates[0]).toMatchObject({
      sourceRevisionPublicId: "ra",
      evidenceFamilies: ["content_vector", "jieba", "lexical", "metadata"]
    });
    expect(candidates[0]!.evidenceExcerpt).toBe("Lexical A");
  });

  it("drops the current source and keeps revision identity in the fused key", () => {
    expect(fuseDocumentInternalHybridCandidates({
      currentSourceFilePublicId: "source-file-current",
      limit: 8,
      lanes: [{
        family: "lexical",
        hits: [
          hit("source-file-current", "revision-current", "self"),
          hit("target", "revision-old", "old"),
          hit("target", "revision-new", "new")
        ]
      }]
    }).map((item) => [item.sourceFilePublicId, item.sourceRevisionPublicId]))
      .toEqual([["target", "revision-old"], ["target", "revision-new"]]);
  });

  it.each(["opensearch", "meilisearch"])(
    "hydrates %s hits only when PostgreSQL accepts the exact current revision",
    (providerKind) => {
      const fused = fuseDocumentInternalHybridCandidates({
        currentSourceFilePublicId: "current",
        limit: 8,
        lanes: [{
          family: "content_vector",
          hits: [
            hit("active", "revision-active", `${providerKind} active`),
            hit("stale", "revision-stale", `${providerKind} stale`),
            hit("failed", "revision-failed", `${providerKind} failed`)
          ]
        }]
      });

      expect(hydrateDocumentInternalHybridCandidates({
        candidates: fused,
        eligible: [{
          sourceFilePublicId: "active",
          sourceRevisionPublicId: "revision-active",
          logicalPath: "authoritative/active.md",
          title: "Authoritative active",
          kind: "document"
        }]
      })).toMatchObject([{
        sourceFilePublicId: "active",
        sourceRevisionPublicId: "revision-active",
        logicalPath: "authoritative/active.md"
      }]);
    }
  );
});

function hit(
  sourceFilePublicId: string,
  sourceRevisionPublicId: string,
  excerpt: string
) {
  return {
    sourceFilePublicId,
    sourceRevisionPublicId,
    logicalPath: `${sourceFilePublicId}.md`,
    title: sourceFilePublicId,
    evidenceExcerpt: excerpt
  };
}

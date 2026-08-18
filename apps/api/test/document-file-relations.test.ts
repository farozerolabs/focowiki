import { describe, expect, it } from "vitest";
import {
  canonicalFileRelation,
  relationDirectionFor
} from "../src/document-indexing/domain/file-relation.js";
import { buildDocumentRelationCandidates } from
  "../src/document-indexing/application/document-relation-candidates.js";
import { presentRelatedFiles } from
  "../src/document-indexing/application/document-related-file-presentation.js";

describe("document file relationships", () => {
  it("normalizes one canonical pair while retaining directional evidence", () => {
    const relation = canonicalFileRelation({
      knowledgeBaseId: "knowledge-base-a",
      sourceFilePublicId: "source-z",
      targetSourceFilePublicId: "source-a",
      relationKind: "references",
      evidenceKind: "markdown_link",
      sourceRevisionPublicId: "revision-z",
      evidenceChecksumSha256: "a".repeat(64),
      evidence: { rawTarget: "a.md" }
    });

    expect(relation).toMatchObject({
      firstSourceFilePublicId: "source-a",
      secondSourceFilePublicId: "source-z",
      evidence: { direction: "second_to_first" }
    });
    expect(relationDirectionFor(relation, "source-z")).toBe("outgoing");
    expect(relationDirectionFor(relation, "source-a")).toBe("incoming");
  });

  it("extracts explicit Markdown and metadata references without domain rules", () => {
    const candidates = buildDocumentRelationCandidates({
      sourceLogicalPath: "guides/start.md",
      references: [{
        label: "Operations",
        rawTarget: "operations.md#run",
        resolvedTarget: "/pages/guides/operations.md#run",
        startOffset: 12,
        endOffset: 49
      }],
      metadata: {
        references: ["Architecture", "../shared/terms.md"],
        aliases: ["Getting Started", "guide"]
      },
      semanticCandidates: [{
        target: "Incident Response",
        confidence: 0.93,
        sourceExcerpt: "Follow the Incident Response runbook.",
        startOffset: 80,
        endOffset: 117
      }]
    });

    expect(candidates.map((item) => item.referenceKind)).toEqual([
      "markdown_link", "okf_metadata", "okf_metadata", "semantic"
    ]);
    expect(candidates[0]).toMatchObject({
      normalizedTargetKey: "path:guides/operations.md"
    });
    expect(candidates).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ rawTarget: "guide" })
    ]));
  });

  it("rejects generic or ungrounded semantic phrases", () => {
    const candidates = buildDocumentRelationCandidates({
      sourceLogicalPath: "a.md",
      references: [],
      metadata: {},
      semanticCandidates: [{
        target: "Knowledge Base",
        confidence: 0.99,
        sourceExcerpt: "This knowledge base contains useful information.",
        startOffset: 0,
        endOffset: 45
      }, {
        target: "Specific Navigation Contract",
        confidence: 0.4,
        sourceExcerpt: "Specific Navigation Contract",
        startOffset: 46,
        endOffset: 74
      }]
    });

    expect(candidates).toEqual([]);
  });

  it("deduplicates one target and reports bidirectional evidence truthfully", () => {
    expect(presentRelatedFiles({
      sourceFilePublicId: "source-a",
      evidence: [{
        relationPublicId: "relation-ab",
        targetSourceFilePublicId: "source-b",
        direction: "outgoing",
        evidencePublicId: "evidence-a",
        evidenceKind: "markdown_link",
        evidence: { rawTarget: "b.md" }
      }, {
        relationPublicId: "relation-ab",
        targetSourceFilePublicId: "source-b",
        direction: "incoming",
        evidencePublicId: "evidence-b",
        evidenceKind: "markdown_link",
        evidence: { rawTarget: "a.md" }
      }]
    })).toEqual([expect.objectContaining({
      targetSourceFilePublicId: "source-b",
      direction: "bidirectional",
      evidence: [expect.objectContaining({ publicId: "evidence-a" }),
        expect.objectContaining({ publicId: "evidence-b" })]
    })]);
  });
});

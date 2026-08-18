import { describe, expect, it } from "vitest";
import { buildSemanticFileReferenceCandidates } from
  "../src/document-indexing/application/document-semantic-relation-candidates.js";

describe("document semantic relation candidates", () => {
  it("uses only model mentions with bounded source evidence", () => {
    const body = "See Climate Operations for the maintenance workflow.";
    const candidates = buildSemanticFileReferenceCandidates({
      body,
      maximumCandidates: 1,
      facts: {
        knowledgeBaseId: "knowledge-base-a",
        semanticGenerationPublicId: "semantic-generation-a",
        sourceFilePublicId: "source-a",
        sourceRevisionPublicId: "revision-a",
        entities: [{
          publicId: "entity-a",
          canonicalKey: "document:climate operations",
          kind: "document",
          label: "Climate Operations",
          description: null,
          aliases: ["Climate Operations"],
          extractionContractVersion: "semantic-skeleton-v2",
          confidence: 0,
          provenance: "model",
          revision: 1
        }],
        evidence: [{
          publicId: "evidence-a",
          sourceFilePublicId: "source-a",
          sourceRevisionPublicId: "revision-a",
          logicalPath: "a.md",
          startOffset: 0,
          endOffset: body.length,
          excerptChecksumSha256: "a".repeat(64),
          extractionContractVersion: "semantic-skeleton-v2"
        }],
        mentions: [{
          publicId: "mention-a",
          entityPublicId: "entity-a",
          evidencePublicId: "evidence-a",
          sourceFilePublicId: "source-a",
          sourceRevisionPublicId: "revision-a",
          text: "Climate Operations",
          confidence: 0
        }],
        relationships: [],
        communities: [],
        communityReports: []
      }
    });

    expect(candidates).toEqual([{
      target: "Climate Operations",
      confidence: 1,
      sourceExcerpt: body,
      startOffset: 0,
      endOffset: body.length
    }]);
  });

  it("bounds large multilingual evidence while preserving exact source offsets", () => {
    const body = `${"法律条款".repeat(2_000)}Climate Operations${"仲裁规则".repeat(2_000)}`;
    const candidates = buildSemanticFileReferenceCandidates({
      body,
      maximumCandidates: 1,
      facts: semanticFacts(body)
    });

    expect(candidates).toHaveLength(1);
    const candidate = candidates[0]!;
    expect(candidate.sourceExcerpt).toContain("Climate Operations");
    expect([...candidate.sourceExcerpt].length).toBeLessThanOrEqual(1_200);
    expect(Buffer.byteLength(candidate.sourceExcerpt, "utf8")).toBeLessThanOrEqual(4_096);
    expect(body.slice(candidate.startOffset, candidate.endOffset)).toBe(candidate.sourceExcerpt);
  });
});

function semanticFacts(body: string) {
  return {
    knowledgeBaseId: "knowledge-base-a",
    semanticGenerationPublicId: "semantic-generation-a",
    sourceFilePublicId: "source-a",
    sourceRevisionPublicId: "revision-a",
    entities: [{
      publicId: "entity-a",
      canonicalKey: "document:climate operations",
      kind: "document" as const,
      label: "Climate Operations",
      description: null,
      aliases: ["Climate Operations"],
      extractionContractVersion: "semantic-skeleton-v2",
      confidence: 0,
      provenance: "model" as const,
      revision: 1
    }],
    evidence: [{
      publicId: "evidence-a",
      sourceFilePublicId: "source-a",
      sourceRevisionPublicId: "revision-a",
      logicalPath: "a.md",
      startOffset: 0,
      endOffset: body.length,
      excerptChecksumSha256: "a".repeat(64),
      extractionContractVersion: "semantic-skeleton-v2"
    }],
    mentions: [{
      publicId: "mention-a",
      entityPublicId: "entity-a",
      evidencePublicId: "evidence-a",
      sourceFilePublicId: "source-a",
      sourceRevisionPublicId: "revision-a",
      text: "Climate Operations",
      confidence: 0
    }],
    relationships: [],
    communities: [],
    communityReports: []
  };
}

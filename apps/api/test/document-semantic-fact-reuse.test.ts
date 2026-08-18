import { describe, expect, it } from "vitest";
import { rebaseDocumentSemanticFacts } from
  "../src/document-indexing/application/document-semantic-fact-reuse.js";
import type { SemanticDesiredFactSet } from
  "../src/semantic/domain/contracts.js";

describe("document semantic fact reuse", () => {
  it("keeps semantic meaning while rebasing revision-owned evidence and paths", () => {
    const result = rebaseDocumentSemanticFacts({
      facts: facts(),
      manifest: {
        extractionContractVersion: "semantic-v1",
        canonicalInputSha256: "1".repeat(64),
        skeletonPolicyVersion: "policy-v1",
        skeletonSelected: true,
        sourceChunkCount: 2,
        selectedChunkCount: 1,
        selectionReasons: ["explicit_reference"],
        selectionDecisionSha256: "2".repeat(64)
      },
      targetSourceRevisionPublicId: "source-revision-new",
      targetLogicalPath: "Moved/Overview.md"
    });

    expect(result.facts.entities).toEqual(facts().entities);
    expect(result.facts.relationships[0]).toMatchObject({
      publicId: "relationship-1",
      fromEntityPublicId: "entity-1",
      toEntityPublicId: "entity-2"
    });
    expect(result.facts.evidence[0]).toMatchObject({
      sourceRevisionPublicId: "source-revision-new",
      logicalPath: "Moved/Overview.md",
      excerptChecksumSha256: "3".repeat(64)
    });
    expect(result.facts.evidence[0]!.publicId).not.toBe("evidence-old");
    expect(result.facts.mentions[0]).toMatchObject({
      sourceRevisionPublicId: "source-revision-new",
      evidencePublicId: result.facts.evidence[0]!.publicId
    });
    expect(result.facts.relationships[0]!.evidencePublicIds).toEqual([
      result.facts.evidence[0]!.publicId
    ]);
    expect(result.manifest).toMatchObject({
      skeletonSelected: true,
      selectionDecisionSha256: "2".repeat(64)
    });
    expect(result.manifest.canonicalInputSha256).toMatch(/^[0-9a-f]{64}$/u);
  });
});

function facts(): SemanticDesiredFactSet {
  return {
    knowledgeBaseId: "knowledge-base-1",
    semanticGenerationPublicId: "semantic-generation-1",
    sourceFilePublicId: "source-file-1",
    sourceRevisionPublicId: "source-revision-old",
    entities: [{
      publicId: "entity-1", canonicalKey: "concept:first", kind: "concept",
      label: "First", description: null, aliases: ["First"],
      extractionContractVersion: "semantic-v1", confidence: 0.9,
      provenance: "model", revision: 1
    }, {
      publicId: "entity-2", canonicalKey: "concept:second", kind: "concept",
      label: "Second", description: null, aliases: ["Second"],
      extractionContractVersion: "semantic-v1", confidence: 0.8,
      provenance: "model", revision: 1
    }],
    evidence: [{
      publicId: "evidence-old", sourceFilePublicId: "source-file-1",
      sourceRevisionPublicId: "source-revision-old", logicalPath: "Old.md",
      startOffset: 0, endOffset: 10, excerptChecksumSha256: "3".repeat(64),
      extractionContractVersion: "semantic-v1"
    }],
    mentions: [{
      publicId: "mention-old", entityPublicId: "entity-1",
      evidencePublicId: "evidence-old", sourceFilePublicId: "source-file-1",
      sourceRevisionPublicId: "source-revision-old", text: "First",
      confidence: 0.9
    }],
    relationships: [{
      publicId: "relationship-1", fromEntityPublicId: "entity-1",
      toEntityPublicId: "entity-2", kind: "related_to", description: "Related",
      evidencePublicIds: ["evidence-old"], confidence: 0.7,
      provenance: "model", revision: 1
    }],
    communities: [],
    communityReports: []
  };
}

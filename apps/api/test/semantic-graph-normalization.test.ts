import { describe, expect, it } from "vitest";
import { buildSemanticDesiredFactSet } from "../src/semantic/domain/graph-normalization.js";

describe("semantic graph normalization", () => {
  it("scopes identities, merges aliases, and retains only owned evidence", () => {
    const facts = buildSemanticDesiredFactSet(input());
    expect(facts.entities).toHaveLength(3);
    expect(facts.entities.filter((entity) => entity.canonicalKey.includes("shared concept")))
      .toHaveLength(2);
    expect(facts.mentions).toHaveLength(3);
    expect(facts.relationships).toHaveLength(1);
    expect(facts.relationships[0]).toMatchObject({ kind: "related_to", confidence: 0, provenance: "model" });
    expect(facts.relationships[0]!.evidencePublicIds).toEqual([facts.evidence[0]!.publicId]);
    expect(buildSemanticDesiredFactSet(input())).toEqual(facts);
    expect(buildSemanticDesiredFactSet({ ...input(), knowledgeBaseId: "kb-other" }).entities[0]!.publicId)
      .not.toBe(facts.entities[0]!.publicId);
  });

  it("rejects missing evidence, foreign ownership, orphan endpoints, and canonical self edges", () => {
    const missing = input();
    missing.extraction.relationships[0]!.evidenceId = "missing";
    expect(() => buildSemanticDesiredFactSet(missing)).toThrow("outside");
    const foreign = input();
    foreign.extraction.mentions[0]!.sourceRevisionId = "foreign";
    expect(() => buildSemanticDesiredFactSet(foreign)).toThrow("owner");
    const orphan = input();
    orphan.extraction.relationships[0]!.targetEntityId = "missing";
    expect(() => buildSemanticDesiredFactSet(orphan)).toThrow("endpoint");
    const self = input();
    self.extraction.relationships[0]!.targetEntityId = "adapter-entity-a";
    expect(() => buildSemanticDesiredFactSet(self)).toThrow("same canonical");
    const unsupported = input();
    unsupported.extraction.mentions = unsupported.extraction.mentions.filter(
      (mention) => mention.entityId !== "adapter-entity-collision"
    );
    expect(() => buildSemanticDesiredFactSet(unsupported)).toThrow("no owned evidence");
  });

  it("does not create facts from summaries or metadata", () => {
    const value = input() as ReturnType<typeof input> & { summaries?: unknown; metadata?: unknown };
    value.summaries = [{ text: "Unsupported inferred relationship" }];
    value.metadata = { category: "Special domain" };
    const facts = buildSemanticDesiredFactSet(value);
    expect(facts.relationships).toHaveLength(1);
    expect(JSON.stringify(facts)).not.toContain("Unsupported inferred relationship");
    expect(JSON.stringify(facts)).not.toContain("Special domain");
  });
});

function input() {
  return {
    knowledgeBaseId: "kb-main",
    semanticGenerationPublicId: "generation-main",
    sourceFilePublicId: "file-main",
    sourceRevisionPublicId: "revision-main",
    logicalPath: "concepts/overview.md",
    chunks: [{ evidenceId: "chunk-1", text: "Shared concept supports a system.", startOffset: 0, endOffset: 33 }],
    extraction: {
      entities: [
        { entityId: "adapter-entity-a", canonicalName: "Shared Concept", normalizedName: "shared concept", entityType: "CONCEPT", descriptions: ["A shared idea"] },
        { entityId: "adapter-entity-a-alias", canonicalName: "shared concept", normalizedName: "shared concept", entityType: "CONCEPT", descriptions: ["A shared idea"] },
        { entityId: "adapter-entity-collision", canonicalName: "Shared Concept", normalizedName: "shared concept", entityType: "DOCUMENT", descriptions: ["A document"] },
        { entityId: "adapter-entity-b", canonicalName: "Related System", normalizedName: "related system", entityType: "SYSTEM", descriptions: ["A system"] }
      ],
      mentions: [
        { mentionId: "mention-a", entityId: "adapter-entity-a", sourceFileId: "file-main", sourceRevisionId: "revision-main", evidenceId: "chunk-1" },
        { mentionId: "mention-a2", entityId: "adapter-entity-a-alias", sourceFileId: "file-main", sourceRevisionId: "revision-main", evidenceId: "chunk-1" },
        { mentionId: "mention-collision", entityId: "adapter-entity-collision", sourceFileId: "file-main", sourceRevisionId: "revision-main", evidenceId: "chunk-1" },
        { mentionId: "mention-b", entityId: "adapter-entity-b", sourceFileId: "file-main", sourceRevisionId: "revision-main", evidenceId: "chunk-1" }
      ],
      relationships: [{ relationshipId: "relationship-a", sourceEntityId: "adapter-entity-a", targetEntityId: "adapter-entity-b", description: "The source explicitly connects them", weight: 1, sourceFileId: "file-main", sourceRevisionId: "revision-main", evidenceId: "chunk-1" }]
    }
  };
}

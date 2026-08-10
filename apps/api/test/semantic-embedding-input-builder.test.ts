import { describe, expect, it } from "vitest";
import { createEmbeddingArtifactIdentity } from "../src/semantic/embedding/contract-identity.js";
import { buildSemanticEmbeddingInput } from "../src/semantic/embedding/input-builder.js";

const evidence = [{
  sourceFilePublicId: "file-1",
  sourceRevisionPublicId: "revision-1",
  evidencePublicId: "evidence-1",
  logicalPath: "concepts/overview.md"
}];

describe("semantic embedding input and identity", () => {
  it.each([
    ["content", { body: "  Shared   knowledge  " }],
    ["entity", { label: "Shared concept", kind: "CONCEPT", description: "A reusable idea" }],
    ["relationship", { sourceLabel: "Concept A", targetLabel: "System B", description: "A supports B" }],
    ["community", { label: "Shared theme", summary: "A bounded collection of related ideas" }]
  ] as const)("builds bounded canonical %s input retaining evidence", (inputKind, fields) => {
    const result = buildSemanticEmbeddingInput({
      inputKind,
      ownerPublicId: `${inputKind}-1`,
      sourceFilePublicId: "file-1",
      sourceRevisionPublicId: "revision-1",
      fields,
      evidenceTargets: evidence,
      maximumCharacters: 2_000,
      maximumEvidenceTargets: 4
    });
    expect(result.canonicalInputSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.canonicalText).not.toContain("  ");
    expect(result.evidenceTargets).toEqual(evidence);
  });

  it("changes artifact identity for every pinned contract dimension", () => {
    const base = {
      knowledgeBaseId: "kb-1",
      ownerKind: "content" as const,
      ownerPublicId: "content-1",
      sourceRevisionPublicId: "revision-1",
      canonicalInputSha256: "a".repeat(64),
      embeddingConfigurationRevisionPublicId: "embedding-revision-1",
      normalization: "l2" as const,
      dimension: 3,
      inputKind: "content" as const,
      artifactSchemaVersion: "artifact-v1"
    };
    const identity = createEmbeddingArtifactIdentity(base);
    for (const changed of [
      { sourceRevisionPublicId: "revision-2" },
      { canonicalInputSha256: "b".repeat(64) },
      { embeddingConfigurationRevisionPublicId: "embedding-revision-2" },
      { normalization: "none" as const },
      { dimension: 4 },
      { artifactSchemaVersion: "artifact-v2" }
    ]) {
      expect(createEmbeddingArtifactIdentity({ ...base, ...changed }).artifactPublicId)
        .not.toBe(identity.artifactPublicId);
    }
  });

  it("rejects missing evidence and oversized canonical input", () => {
    expect(() => buildSemanticEmbeddingInput({
      inputKind: "content",
      ownerPublicId: "content-1",
      sourceFilePublicId: "file-1",
      sourceRevisionPublicId: "revision-1",
      fields: { body: "content" },
      evidenceTargets: [],
      maximumCharacters: 100,
      maximumEvidenceTargets: 2
    })).toThrow("evidence");
    expect(() => buildSemanticEmbeddingInput({
      inputKind: "content",
      ownerPublicId: "content-1",
      sourceFilePublicId: "file-1",
      sourceRevisionPublicId: "revision-1",
      fields: { body: "long content" },
      evidenceTargets: evidence,
      maximumCharacters: 4,
      maximumEvidenceTargets: 2
    })).toThrow("bound");
  });
});

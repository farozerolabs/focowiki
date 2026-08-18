import { describe, expect, it } from "vitest";
import {
  createDocumentModelAnalysisFingerprint,
  createDocumentRelationshipEvaluationFingerprint
} from "../src/document-indexing/application/document-model-evaluation.js";

describe("document model evaluation fingerprints", () => {
  it("is stable across object key order and excludes candidate-set identity", () => {
    const first = createDocumentModelAnalysisFingerprint({
      sourceRevisionPublicId: "source-revision-a",
      modelConfigurationPublicId: "model-a",
      modelConfigurationRevision: 3,
      promptContractSha256: "a".repeat(64),
      modelInput: { title: "Guide", profile: { tags: ["alpha"], type: "page" } }
    });
    const reordered = createDocumentModelAnalysisFingerprint({
      sourceRevisionPublicId: "source-revision-a",
      modelConfigurationPublicId: "model-a",
      modelConfigurationRevision: 3,
      promptContractSha256: "a".repeat(64),
      modelInput: { profile: { type: "page", tags: ["alpha"] }, title: "Guide" }
    });
    const changed = createDocumentModelAnalysisFingerprint({
      sourceRevisionPublicId: "source-revision-a",
      modelConfigurationPublicId: "model-a",
      modelConfigurationRevision: 3,
      promptContractSha256: "a".repeat(64),
      modelInput: { title: "Changed Guide", profile: { tags: ["alpha"], type: "page" } }
    });

    expect(reordered).toEqual(first);
    expect(changed.publicId).not.toBe(first.publicId);
  });

  it("keys relationship decisions by exact source, target, evidence, model, and prompt", () => {
    const base = createDocumentRelationshipEvaluationFingerprint({
      sourceRevisionPublicId: "source-revision-a",
      targetRevisionPublicId: "source-revision-b",
      evidence: { term: "Operations", startOffset: 10, endOffset: 20 },
      modelConfigurationPublicId: "model-a",
      modelConfigurationRevision: 3,
      promptContractSha256: "b".repeat(64)
    });
    const changedEvidence = createDocumentRelationshipEvaluationFingerprint({
      sourceRevisionPublicId: "source-revision-a",
      targetRevisionPublicId: "source-revision-b",
      evidence: { term: "Recovery", startOffset: 30, endOffset: 40 },
      modelConfigurationPublicId: "model-a",
      modelConfigurationRevision: 3,
      promptContractSha256: "b".repeat(64)
    });

    expect(base.evidenceFingerprintSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(base.publicId).toMatch(/^relationship-evaluation-[0-9a-f]{64}$/u);
    expect(changedEvidence.publicId).not.toBe(base.publicId);
  });
});

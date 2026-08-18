import { createHash } from "node:crypto";
import type { EmbeddingInputKind } from "../domain/contracts.js";

export type SemanticEmbeddingEvidenceTarget = {
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  evidencePublicId: string;
  logicalPath: string;
};

export type SemanticEmbeddingInput = {
  inputKind: EmbeddingInputKind;
  ownerPublicId: string;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string | null;
  canonicalText: string;
  canonicalInputSha256: string;
  evidenceTargets: readonly SemanticEmbeddingEvidenceTarget[];
};

type InputFields = {
  label?: string | null;
  kind?: string | null;
  description?: string | null;
  body?: string | null;
  sourceLabel?: string | null;
  targetLabel?: string | null;
  summary?: string | null;
};

export function buildSemanticEmbeddingInput(input: {
  inputKind: EmbeddingInputKind;
  ownerPublicId: string;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string | null;
  fields: InputFields;
  evidenceTargets: readonly SemanticEmbeddingEvidenceTarget[];
  maximumCharacters: number;
  maximumEvidenceTargets: number;
}): SemanticEmbeddingInput {
  assertPositiveBound(input.maximumCharacters);
  assertPositiveBound(input.maximumEvidenceTargets);
  requireId(input.ownerPublicId);
  requireId(input.sourceFilePublicId);
  if (input.sourceRevisionPublicId !== null) requireId(input.sourceRevisionPublicId);
  if (
    input.evidenceTargets.length === 0
    || input.evidenceTargets.length > input.maximumEvidenceTargets
  ) throw new Error("Embedding evidence targets exceed their bound");
  const evidenceTargets = [...input.evidenceTargets]
    .map((target) => validateEvidenceTarget(target))
    .sort((left, right) =>
      left.sourceRevisionPublicId.localeCompare(right.sourceRevisionPublicId)
      || left.evidencePublicId.localeCompare(right.evidencePublicId));
  const sections = embeddingSections(input.inputKind, input.fields);
  const canonicalText = sections
    .map(([name, value]) => `${name}: ${normalizeText(value)}`)
    .join("\n");
  if (!canonicalText || canonicalText.length > input.maximumCharacters) {
    throw new Error("Embedding canonical input exceeds its bound");
  }
  return {
    inputKind: input.inputKind,
    ownerPublicId: input.ownerPublicId,
    sourceFilePublicId: input.sourceFilePublicId,
    sourceRevisionPublicId: input.sourceRevisionPublicId,
    canonicalText,
    canonicalInputSha256: createHash("sha256").update(canonicalText).digest("hex"),
    evidenceTargets
  };
}

function embeddingSections(
  inputKind: EmbeddingInputKind,
  fields: InputFields
): readonly (readonly [string, string])[] {
  switch (inputKind) {
    case "content":
      return [["content", requireText(fields.body, "body")]];
    case "entity":
      return [
        ["entity", requireText(fields.label, "label")],
        ["type", requireText(fields.kind, "kind")],
        ["description", requireText(fields.description, "description")]
      ];
    case "relationship":
      return [
        ["source", requireText(fields.sourceLabel, "sourceLabel")],
        ["target", requireText(fields.targetLabel, "targetLabel")],
        ["relationship", requireText(fields.description, "description")]
      ];
    case "community":
      return [
        ["community", requireText(fields.label, "label")],
        ["summary", requireText(fields.summary, "summary")]
      ];
  }
}

function validateEvidenceTarget(
  target: SemanticEmbeddingEvidenceTarget
): SemanticEmbeddingEvidenceTarget {
  requireId(target.sourceFilePublicId);
  requireId(target.sourceRevisionPublicId);
  requireId(target.evidencePublicId);
  if (!target.logicalPath || target.logicalPath.length > 4_096) {
    throw new Error("Embedding evidence target path is invalid");
  }
  return { ...target };
}

function requireId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u.test(value)) {
    throw new Error("Embedding input identifier is invalid");
  }
  return value;
}

function requireText(value: string | null | undefined, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Embedding ${field} is required`);
  }
  return value;
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function assertPositiveBound(value: number): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error("Embedding input bound is invalid");
}

import { createHash } from "node:crypto";

export const FILE_RELATION_EVIDENCE_KINDS = [
  "markdown_link", "okf_metadata", "stable_alias", "semantic"
] as const;
export type FileRelationEvidenceKind =
  (typeof FILE_RELATION_EVIDENCE_KINDS)[number];

export type CanonicalFileRelation = {
  publicId: string;
  knowledgeBaseId: string;
  firstSourceFilePublicId: string;
  secondSourceFilePublicId: string;
  relationKind: "references" | "related";
  evidence: {
    publicId: string;
    sourceFilePublicId: string;
    sourceRevisionPublicId: string;
    direction: "first_to_second" | "second_to_first";
    evidenceKind: FileRelationEvidenceKind;
    evidenceChecksumSha256: string;
    value: Readonly<Record<string, unknown>>;
  };
};

export function canonicalFileRelation(input: {
  knowledgeBaseId: string;
  sourceFilePublicId: string;
  targetSourceFilePublicId: string;
  relationKind: "references" | "related";
  evidenceKind: FileRelationEvidenceKind;
  sourceRevisionPublicId: string;
  evidenceChecksumSha256: string;
  evidence: Readonly<Record<string, unknown>>;
}): CanonicalFileRelation {
  validateInput(input);
  const sourceFirst = compareText(
    input.sourceFilePublicId,
    input.targetSourceFilePublicId
  ) < 0;
  const firstSourceFilePublicId = sourceFirst
    ? input.sourceFilePublicId : input.targetSourceFilePublicId;
  const secondSourceFilePublicId = sourceFirst
    ? input.targetSourceFilePublicId : input.sourceFilePublicId;
  const relationIdentity = digest([
    "file-relation-v1", input.knowledgeBaseId,
    firstSourceFilePublicId, secondSourceFilePublicId, input.relationKind
  ]);
  const evidenceIdentity = digest([
    "file-relation-evidence-v1", relationIdentity,
    input.sourceRevisionPublicId, sourceFirst ? "first_to_second" : "second_to_first",
    input.evidenceKind, input.evidenceChecksumSha256
  ]);
  return {
    publicId: `file-relation-${relationIdentity}`,
    knowledgeBaseId: input.knowledgeBaseId,
    firstSourceFilePublicId,
    secondSourceFilePublicId,
    relationKind: input.relationKind,
    evidence: {
      publicId: `file-relation-evidence-${evidenceIdentity}`,
      sourceFilePublicId: input.sourceFilePublicId,
      sourceRevisionPublicId: input.sourceRevisionPublicId,
      direction: sourceFirst ? "first_to_second" : "second_to_first",
      evidenceKind: input.evidenceKind,
      evidenceChecksumSha256: input.evidenceChecksumSha256,
      value: input.evidence
    }
  };
}

export function relationDirectionFor(
  relation: CanonicalFileRelation,
  sourceFilePublicId: string
): "incoming" | "outgoing" {
  const sourceIsFirst = relation.evidence.direction === "first_to_second";
  const evidenceSource = sourceIsFirst
    ? relation.firstSourceFilePublicId : relation.secondSourceFilePublicId;
  const evidenceTarget = sourceIsFirst
    ? relation.secondSourceFilePublicId : relation.firstSourceFilePublicId;
  if (sourceFilePublicId === evidenceSource) return "outgoing";
  if (sourceFilePublicId === evidenceTarget) return "incoming";
  throw relationError("source_not_in_relation");
}

function validateInput(input: {
  knowledgeBaseId: string;
  sourceFilePublicId: string;
  targetSourceFilePublicId: string;
  evidenceKind: string;
  sourceRevisionPublicId: string;
  evidenceChecksumSha256: string;
  evidence: Readonly<Record<string, unknown>>;
}): void {
  if ([input.knowledgeBaseId, input.sourceFilePublicId,
    input.targetSourceFilePublicId, input.sourceRevisionPublicId]
    .some((value) => !value || Buffer.byteLength(value, "utf8") > 255)
    || input.sourceFilePublicId === input.targetSourceFilePublicId
    || !FILE_RELATION_EVIDENCE_KINDS.includes(
      input.evidenceKind as FileRelationEvidenceKind
    )
    || !/^[0-9a-f]{64}$/u.test(input.evidenceChecksumSha256)
    || Buffer.byteLength(JSON.stringify(input.evidence), "utf8") > 16_384) {
    throw relationError("input_invalid");
  }
}

function digest(parts: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function relationError(code: string): Error & { code: string } {
  return Object.assign(new Error(`File relation error: ${code}`), { code });
}

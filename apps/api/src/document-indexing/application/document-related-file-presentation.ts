import type { FileRelationEvidenceKind } from "../domain/file-relation.js";

type RelatedEvidence = {
  relationPublicId: string;
  targetSourceFilePublicId: string;
  direction: "incoming" | "outgoing";
  evidencePublicId: string;
  evidenceKind: FileRelationEvidenceKind;
  evidence: Readonly<Record<string, unknown>>;
};

export function presentRelatedFiles(input: {
  sourceFilePublicId: string;
  evidence: readonly RelatedEvidence[];
}) {
  const grouped = new Map<string, {
    relationPublicId: string;
    targetSourceFilePublicId: string;
    directions: Set<"incoming" | "outgoing">;
    evidence: Array<{
      publicId: string;
      kind: FileRelationEvidenceKind;
      value: Readonly<Record<string, unknown>>;
    }>;
  }>();
  for (const item of input.evidence) {
    if (!item.targetSourceFilePublicId
      || item.targetSourceFilePublicId === input.sourceFilePublicId) continue;
    const current = grouped.get(item.targetSourceFilePublicId) ?? {
      relationPublicId: item.relationPublicId,
      targetSourceFilePublicId: item.targetSourceFilePublicId,
      directions: new Set<"incoming" | "outgoing">(),
      evidence: []
    };
    current.directions.add(item.direction);
    if (!current.evidence.some((evidence) =>
      evidence.publicId === item.evidencePublicId)) {
      current.evidence.push({
        publicId: item.evidencePublicId,
        kind: item.evidenceKind,
        value: item.evidence
      });
    }
    grouped.set(item.targetSourceFilePublicId, current);
  }
  return [...grouped.values()]
    .sort((left, right) => left.targetSourceFilePublicId
      .localeCompare(right.targetSourceFilePublicId, "en"))
    .map((item) => ({
      relationPublicId: item.relationPublicId,
      targetSourceFilePublicId: item.targetSourceFilePublicId,
      direction: item.directions.size === 2 ? "bidirectional" as const
        : item.directions.has("outgoing") ? "outgoing" as const
          : "incoming" as const,
      evidence: item.evidence.sort((left, right) =>
        left.publicId.localeCompare(right.publicId, "en"))
    }));
}

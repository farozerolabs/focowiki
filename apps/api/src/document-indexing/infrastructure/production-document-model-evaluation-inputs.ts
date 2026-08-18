import { createHash } from "node:crypto";
import type { GraphRelationshipConfirmation } from "@focowiki/okf";
import type { SourceContentProfile } from "../../graph/content-profile.js";
import type {
  DocumentGraphCandidate,
  DocumentProposedGraphEdge
} from "../application/document-model-graph-enrichment.js";
import type { DocumentRelationshipEvaluationFact } from
  "../application/document-model-evaluation.js";
import {
  DOCUMENT_EVIDENCE_EXCERPT_MAX_BYTES,
  truncateDocumentUtf8
} from "../domain/document-bounded-text.js";

export type DocumentModelEvaluationSource = {
  fileId: string;
  path: string;
  title: string;
  type: string;
  profile: SourceContentProfile;
};

export function documentModelInput(input: {
  source: DocumentModelEvaluationSource;
  body: string;
}): Readonly<Record<string, unknown>> {
  return {
    source: {
      title: input.source.title,
      type: input.source.type,
      profile: input.source.profile
    },
    bodySha256: createHash("sha256").update(input.body).digest("hex")
  };
}

export function relationshipDeltaEvidenceBody(
  edges: readonly DocumentProposedGraphEdge[],
  summary: string
): string {
  const excerpts = edges.flatMap((edge) => {
    const excerpt = edge.evidence.sourceExcerpt;
    return typeof excerpt === "string" && excerpt.trim()
      ? [excerpt.trim()] : [];
  });
  const evidence = [...new Set(excerpts)].join("\n\n");
  return truncateDocumentUtf8(
    evidence || summary || "No bounded source excerpt is available.",
    DOCUMENT_EVIDENCE_EXCERPT_MAX_BYTES
  );
}

export function documentModelSource(source: DocumentModelEvaluationSource) {
  return {
    fileId: "current",
    path: source.path,
    title: source.title,
    type: source.type,
    summary: source.profile.summary,
    subjects: source.profile.subjects,
    tags: source.profile.tags,
    entities: source.profile.entities,
    explicitReferences: source.profile.explicitReferences,
    relationshipHints: source.profile.relationshipHints,
    headings: source.profile.headingOutline,
    keywords: source.profile.keywords,
    language: source.profile.language
  };
}

export function documentCandidateTokenMap(
  candidates: readonly DocumentGraphCandidate[]
): ReadonlyMap<string, string> {
  return new Map(candidates.map((candidate, index) => [
    candidate.sourceFilePublicId,
    `candidate-${String(index + 1).padStart(4, "0")}`
  ]));
}

export function documentEdgeInputs(
  edges: readonly DocumentProposedGraphEdge[],
  tokens: ReadonlyMap<string, string>
) {
  return edges.map((edge) => ({
    fromFileId: "current",
    toFileId: requireCandidateToken(tokens, edge.toFileId),
    relationType: edge.relationType,
    weight: edge.weight,
    reason: edge.reason,
    source: "source_evidence",
    evidence: { ...edge.evidence }
  }));
}

export function documentCandidateFiles(
  candidates: readonly DocumentGraphCandidate[],
  tokens: ReadonlyMap<string, string>
) {
  return candidates.map((candidate) => ({
    fileId: requireCandidateToken(tokens, candidate.sourceFilePublicId),
    path: `pages/${candidate.logicalPath}`,
    title: candidate.title,
    type: candidate.kind,
    evidenceExcerpt: candidate.evidenceExcerpt,
    keywords: [...candidate.rankingTerms]
  }));
}

export function resolveDocumentCandidateConfirmations(
  confirmations: readonly GraphRelationshipConfirmation[],
  tokens: ReadonlyMap<string, string>
): GraphRelationshipConfirmation[] {
  const sourceByToken = new Map([...tokens].map(([sourceFileId, token]) => [
    token,
    sourceFileId
  ]));
  const seen = new Set<string>();
  return confirmations.map((confirmation) => {
    const sourceFileId = sourceByToken.get(confirmation.targetFileId);
    if (!sourceFileId) throw new Error("Model returned an unknown candidate id");
    if (seen.has(confirmation.targetFileId)) {
      throw new Error("Model returned a duplicate candidate id");
    }
    seen.add(confirmation.targetFileId);
    return { ...confirmation, targetFileId: sourceFileId };
  });
}

function requireCandidateToken(
  tokens: ReadonlyMap<string, string>,
  sourceFileId: string
): string {
  const token = tokens.get(sourceFileId);
  if (!token) throw new Error("Candidate token is missing");
  return token;
}

export function rejectedDocumentConfirmation(
  edge: DocumentProposedGraphEdge
): GraphRelationshipConfirmation {
  return {
    targetFileId: edge.toFileId,
    accepted: false,
    relationType: edge.relationType,
    weight: 0,
    reason: "No evidence-grounded relationship was returned."
  };
}

export function confirmationFromDocumentFact(
  fact: DocumentRelationshipEvaluationFact
): GraphRelationshipConfirmation {
  const targetFileId = fact.result.targetFileId;
  const accepted = fact.result.accepted;
  const relationType = fact.result.relationType;
  const weight = fact.result.weight;
  const reason = fact.result.reason;
  if (typeof targetFileId !== "string"
    || typeof accepted !== "boolean"
    || typeof relationType !== "string"
    || typeof weight !== "number" || !Number.isFinite(weight)
    || weight < 0 || weight > 1
    || typeof reason !== "string") {
    throw new Error("Stored relationship evaluation is invalid");
  }
  return { targetFileId, accepted, relationType, weight, reason };
}

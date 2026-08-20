import type { GraphRelationshipConfirmation, ModelSuggestions } from
  "@focowiki/okf";
import {
  isLowInformationSharedGraphTerm,
  validatePortableGeneratedText
} from "@focowiki/okf";
import { isUsefulTerm, type SourceContentProfile } from
  "../../graph/content-profile.js";
import type {
  DocumentGraphCandidate,
  DocumentModelGraphEnrichmentRequest,
  DocumentModelRelationCandidate,
  DocumentProposedGraphEdge
} from "./document-model-graph-enrichment.js";

const GENERIC_GRAPH_TERMS = new Set([
  "document", "file", "page", "guide", "overview", "introduction",
  "knowledge base", "documentation", "general", "content",
  "文档", "文件", "页面", "指南", "概述", "介绍", "知识库", "内容"
]);

export function proposeDocumentModelEdges(input: {
  request: DocumentModelGraphEnrichmentRequest;
  contentProfile: SourceContentProfile;
  suggestions: ModelSuggestions | null;
  candidates: readonly DocumentGraphCandidate[];
}): DocumentProposedGraphEdge[] {
  return input.candidates.flatMap((candidate) => {
    const edge = proposeEdge({ ...input, candidate });
    return edge ? [edge] : [];
  }).sort((left, right) => right.weight - left.weight
    || left.toFileId.localeCompare(right.toFileId, "en"))
    .slice(0, input.request.acceptedEdgeLimit);
}

export function documentModelRelationCandidates(
  accepted: readonly (DocumentProposedGraphEdge & {
    source: "deterministic" | "model_confirmed";
  })[],
  candidates: readonly DocumentGraphCandidate[]
): DocumentModelRelationCandidate[] {
  const byId = new Map(candidates.map((candidate) => [
    candidate.sourceFilePublicId,
    candidate
  ]));
  return accepted.flatMap((edge) => {
    const target = byId.get(edge.toFileId);
    const evidence = readEvidence(edge.evidence);
    if (!target || !evidence) return [];
    return [{
      target: target.logicalPath,
      targetSourceFilePublicId: target.sourceFilePublicId,
      targetSourceRevisionPublicId: target.sourceRevisionPublicId,
      confidence: edge.weight,
      sourceExcerpt: evidence.sourceExcerpt,
      startOffset: evidence.startOffset,
      endOffset: evidence.endOffset,
      evidenceTerms: evidence.evidenceTerms,
      relationType: edge.relationType,
      reason: edge.reason,
      source: edge.source
    } satisfies DocumentModelRelationCandidate];
  });
}

export function resolveAcceptedDocumentModelEdges(input: {
  proposed: readonly DocumentProposedGraphEdge[];
  confirmations: readonly GraphRelationshipConfirmation[];
}): Array<DocumentProposedGraphEdge & {
  source: "deterministic" | "model_confirmed";
}> {
  const proposedByTarget = new Map(input.proposed.map((edge) => [
    edge.toFileId,
    edge
  ]));
  const accepted = input.confirmations.flatMap((item) => {
    const edge = proposedByTarget.get(item.targetFileId);
    if (!edge || !item.accepted || !Number.isFinite(item.weight)
      || item.weight < 0 || item.weight > 1
      || !isPortableRelationshipReason(item.reason, edge)) return [];
    return [{
      ...edge,
      relationType: item.relationType,
      weight: edge.weight,
      reason: item.reason.trim().slice(0, 1_024),
      source: "model_confirmed" as const
    }];
  });
  return accepted;
}

export function documentModelCandidateTerms(
  title: string,
  profile: SourceContentProfile
): string[] {
  return [...new Set([
    title,
    ...profile.subjects,
    ...profile.entities,
    ...profile.keywords,
    ...profile.relationshipHints,
    ...profile.versionHints
  ].map((value) => value.trim()).filter((value) => value
    && Buffer.byteLength(value, "utf8") <= 512))].slice(0, 100);
}

function proposeEdge(input: {
  request: DocumentModelGraphEnrichmentRequest;
  contentProfile: SourceContentProfile;
  suggestions: ModelSuggestions | null;
  candidate: DocumentGraphCandidate;
}): DocumentProposedGraphEdge | null {
  const candidate = input.candidate;
  const explicit = input.contentProfile.explicitReferences.some((value) =>
    normalized(value).includes(normalized(candidate.logicalPath))
    || normalized(value).includes(normalized(candidate.title)));
  const sourceTerms = documentModelCandidateTerms(
    input.request.title,
    input.contentProfile
  ).map(normalized).filter((term) => specificTerm(
    term,
    input.request.genericPhraseThreshold
  ));
  const targetTerms = [candidate.title, ...candidate.rankingTerms]
    .map(normalized).filter((term) => specificTerm(
      term,
      input.request.genericPhraseThreshold
    ));
  const sharedTerms = [...new Set(sourceTerms.filter((term) =>
    targetTerms.some((target) => target === term || target.includes(term)
      || term.includes(target))))]
    .sort((left, right) => right.length - left.length)
    .slice(0, 8);
  const mentioned = evidenceTermInBody(input.request.body, [
    ...(specificTerm(normalized(candidate.title),
      input.request.genericPhraseThreshold) ? [candidate.title] : []),
    ...sharedTerms
  ]);
  const retrievalBacked = Boolean(candidate.evidenceExcerpt.trim()
    && candidate.retrievalFamilies?.length);
  if (!mentioned && !explicit && !retrievalBacked) return null;
  const evidenceTerm = mentioned ?? (explicit ? candidate.title : "");
  const evidence = evidenceTerm
    ? evidenceWindow(input.request.body, evidenceTerm)
    : leadingEvidenceWindow(input.request.body);
  if (!evidence) return null;
  const currentTitle = normalized(input.request.title);
  const targetTitle = normalized(candidate.title);
  const versionRelation = sharedTerms.length > 0
    && (currentTitle.includes(targetTitle) || targetTitle.includes(currentTitle)
      || input.contentProfile.versionHints.length > 0);
  const relationType = explicit ? "direct_reference"
    : versionRelation ? "version_relation"
      : retrievalBacked ? "retrieval_candidate" : "same_specific_subject";
  const weight = explicit ? 0.95 : versionRelation ? 0.9
    : sharedTerms.length >= 2 ? 0.72 : retrievalBacked ? 0.55 : 0.66;
  const evidenceTerms = [evidenceTerm, ...sharedTerms].filter(Boolean).slice(0, 8);
  return {
    fromFileId: input.request.sourceFilePublicId,
    toFileId: candidate.sourceFilePublicId,
    relationType,
    weight,
    reason: explicit
      ? `${input.request.title} explicitly references ${candidate.title}.`
      : versionRelation
        ? `${input.request.title} and ${candidate.title} share visible version evidence.`
        : retrievalBacked
          ? `${candidate.title} was retrieved for source-grounded relationship review.`
          : `${input.request.title} and ${candidate.title} share specific visible content evidence.`,
    source: "deterministic",
    evidence: {
      sourceExcerpt: evidence.sourceExcerpt,
      startOffset: evidence.startOffset,
      endOffset: evidence.endOffset,
      evidenceTerms: evidenceTerms.length > 0
        ? evidenceTerms : [evidence.sourceExcerpt.slice(0, 64)],
      targetEvidenceExcerpt: candidate.evidenceExcerpt,
      retrievalScore: candidate.retrievalScore ?? null,
      retrievalFamilies: candidate.retrievalFamilies ?? [],
      targetPath: candidate.logicalPath,
      targetTitle: candidate.title,
      sourcePath: input.request.logicalPath,
      sourceTitle: input.request.title
    }
  };
}

function isPortableRelationshipReason(
  value: string,
  edge: DocumentProposedGraphEdge
): boolean {
  const reason = value.trim();
  const sourceTitle = typeof edge.evidence.sourceTitle === "string"
    ? edge.evidence.sourceTitle : "";
  const targetTitle = typeof edge.evidence.targetTitle === "string"
    ? edge.evidence.targetTitle : "";
  if (!reason || !sourceTitle || !targetTitle) {
    return false;
  }
  try {
    validatePortableGeneratedText(reason, {
      userText: [sourceTitle, targetTitle]
    });
    return true;
  } catch {
    return false;
  }
}

function evidenceWindow(body: string, term: string): {
  sourceExcerpt: string;
  startOffset: number;
  endOffset: number;
} | null {
  const offset = body.toLocaleLowerCase("en-US")
    .indexOf(term.toLocaleLowerCase("en-US"));
  if (offset < 0) return null;
  const startOffset = Math.max(0, offset - 160);
  const endOffset = Math.min(body.length, offset + term.length + 160);
  return {
    sourceExcerpt: body.slice(startOffset, endOffset),
    startOffset,
    endOffset
  };
}

function leadingEvidenceWindow(body: string): {
  sourceExcerpt: string;
  startOffset: number;
  endOffset: number;
} | null {
  const startOffset = body.search(/\S/u);
  if (startOffset < 0) return null;
  const endOffset = Math.min(body.length, startOffset + 480);
  return {
    sourceExcerpt: body.slice(startOffset, endOffset),
    startOffset,
    endOffset
  };
}

function evidenceTermInBody(body: string, values: readonly string[]): string | null {
  const normalizedBody = body.toLocaleLowerCase("en-US");
  return values.map((value) => value.trim()).filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .find((value) => normalizedBody.includes(value.toLocaleLowerCase("en-US")))
    ?? null;
}

function readEvidence(value: Readonly<Record<string, unknown>>): {
  sourceExcerpt: string;
  startOffset: number;
  endOffset: number;
  evidenceTerms: string[];
} | null {
  const sourceExcerpt = typeof value.sourceExcerpt === "string"
    ? value.sourceExcerpt : null;
  const startOffset = Number(value.startOffset);
  const endOffset = Number(value.endOffset);
  const evidenceTerms = Array.isArray(value.evidenceTerms)
    ? value.evidenceTerms.filter((item): item is string => typeof item === "string")
    : [];
  return sourceExcerpt && Number.isSafeInteger(startOffset)
    && Number.isSafeInteger(endOffset) && endOffset > startOffset
    && evidenceTerms.length > 0
    ? { sourceExcerpt, startOffset, endOffset, evidenceTerms }
    : null;
}

function normalized(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US")
    .replace(/\s+/gu, " ");
}

function specificTerm(value: string, threshold: number): boolean {
  return [...value.replace(/\s+/gu, "")].length >= threshold
    && !GENERIC_GRAPH_TERMS.has(value)
    && isUsefulTerm(value)
    && !isLowInformationSharedGraphTerm(value);
}

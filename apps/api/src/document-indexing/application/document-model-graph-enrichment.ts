import type {
  GraphRelationshipConfirmation,
  ModelSuggestionResult,
  ModelSuggestions,
  SourceMetadataDefaults
} from "@focowiki/okf";
import type { LexicalTokenizer } from
  "../../application/ports/lexical-tokenizer.js";
import {
  buildSourceContentProfile,
  type SourceContentProfile
} from "../../graph/content-profile.js";
import {
  documentModelCandidateTerms,
  documentModelRelationCandidates,
  proposeDocumentModelEdges,
  resolveAcceptedDocumentModelEdges
} from "./document-model-graph-edge-resolution.js";
import type { DocumentModelEvaluationExecution } from
  "./document-model-evaluation.js";
import { DOCUMENT_EVIDENCE_EXCERPT_MAX_BYTES } from
  "../domain/document-bounded-text.js";

export type DocumentGraphCandidate = {
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  logicalPath: string;
  title: string;
  kind: string;
  rankingTerms: readonly string[];
  evidenceExcerpt: string;
  retrievalScore?: number;
  retrievalFamilies?: readonly string[];
};

export type DocumentProposedGraphEdge = {
  fromFileId: string;
  toFileId: string;
  relationType: string;
  weight: number;
  reason: string;
  source: "deterministic" | "model_confirmed";
  evidence: Readonly<Record<string, unknown>>;
};

export type DocumentModelRelationCandidate = {
  target: string;
  targetSourceFilePublicId: string;
  targetSourceRevisionPublicId: string;
  confidence: number;
  sourceExcerpt: string;
  startOffset: number;
  endOffset: number;
  evidenceTerms: readonly string[];
  relationType: string;
  reason: string;
  source: "deterministic" | "model_confirmed";
};

export type DocumentModelGraphEnrichmentRequest = {
  knowledgeBaseId: string;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  logicalPath: string;
  title: string;
  type: string;
  tags: readonly string[];
  body: string;
  metadata: SourceMetadataDefaults;
  contentProfile: SourceContentProfile;
  modelName: string;
  candidateLimit: number;
  acceptedEdgeLimit: number;
  genericPhraseThreshold: number;
  signal: AbortSignal;
};

export function createDocumentModelGraphEnrichment(input: {
  tokenizer: LexicalTokenizer;
  candidates: {
    find(request: {
      knowledgeBaseId: string;
      sourceFilePublicId: string;
      terms: readonly string[];
      limit: number;
      signal: AbortSignal;
    }): Promise<readonly DocumentGraphCandidate[]>;
  };
  model: {
    analyze(request: {
      modelName: string;
      source: {
        fileId: string;
        path: string;
        title: string;
        type: string;
        profile: SourceContentProfile;
      };
      body: string;
      candidates: readonly DocumentGraphCandidate[];
      edges: readonly DocumentProposedGraphEdge[];
      signal: AbortSignal;
    }): Promise<{
      suggestions: ModelSuggestionResult["suggestions"];
      confirmations: readonly GraphRelationshipConfirmation[];
      warnings: readonly string[];
      execution: DocumentModelEvaluationExecution;
    }>;
  };
}) {
  return async (request: DocumentModelGraphEnrichmentRequest) => {
    validateRequest(request);
    throwIfAborted(request.signal);
    const candidates = await input.candidates.find({
      knowledgeBaseId: request.knowledgeBaseId,
      sourceFilePublicId: request.sourceFilePublicId,
      terms: documentModelCandidateTerms(request.title, request.contentProfile),
      limit: request.candidateLimit,
      signal: request.signal
    });
    validateCandidates(candidates, request);
    throwIfAborted(request.signal);
    const preliminaryEdges = proposeDocumentModelEdges({
      request,
      contentProfile: request.contentProfile,
      suggestions: null,
      candidates
    });
    const analysis = await input.model.analyze({
      modelName: request.modelName,
      source: {
        fileId: request.sourceFilePublicId,
        path: `pages/${request.logicalPath}`,
        title: request.title,
        type: request.type,
        profile: request.contentProfile
      },
      body: request.body,
      candidates,
      edges: preliminaryEdges,
      signal: request.signal
    });
    const suggestions = validateSuggestions(analysis.suggestions);
    const warnings = validateWarnings(analysis.warnings);
    const contentProfile = buildSourceContentProfile({
      title: request.title,
      body: request.body,
      metadata: request.metadata,
      suggestions,
      tokenizer: input.tokenizer
    });
    const proposed = proposeDocumentModelEdges({
      request, contentProfile, suggestions, candidates
    });
    if (proposed.length === 0) {
      return result(
        suggestions, contentProfile, [], warnings, candidates, analysis.execution
      );
    }
    const accepted = resolveAcceptedDocumentModelEdges({
      proposed,
      confirmations: analysis.confirmations
    });
    return result(
      suggestions,
      contentProfile,
      documentModelRelationCandidates(accepted, candidates),
      warnings,
      candidates,
      analysis.execution
    );
  };
}

export function createDocumentModelRelationshipDeltaEnrichment(input: {
  model: {
    confirm(request: {
      modelName: string;
      source: {
        fileId: string;
        path: string;
        title: string;
        type: string;
        profile: SourceContentProfile;
      };
      body: string;
      candidates: readonly DocumentGraphCandidate[];
      edges: readonly DocumentProposedGraphEdge[];
      signal: AbortSignal;
    }): Promise<{
      confirmations: readonly GraphRelationshipConfirmation[];
      warnings: readonly string[];
    }>;
  };
}) {
  return async (delta: {
    request: DocumentModelGraphEnrichmentRequest;
    contentProfile: SourceContentProfile;
    suggestions: ModelSuggestions | null;
    candidates: readonly DocumentGraphCandidate[];
  }) => {
    validateRequest(delta.request);
    validateCandidates(delta.candidates, delta.request);
    throwIfAborted(delta.request.signal);
    const proposed = proposeDocumentModelEdges(delta);
    if (proposed.length === 0) return [];
    const confirmation = await input.model.confirm({
      modelName: delta.request.modelName,
      source: {
        fileId: delta.request.sourceFilePublicId,
        path: `pages/${delta.request.logicalPath}`,
        title: delta.request.title,
        type: delta.request.type,
        profile: delta.contentProfile
      },
      body: delta.request.body,
      candidates: delta.candidates,
      edges: proposed,
      signal: delta.request.signal
    });
    validateWarnings(confirmation.warnings);
    return documentModelRelationCandidates(resolveAcceptedDocumentModelEdges({
      proposed,
      confirmations: confirmation.confirmations
    }), delta.candidates);
  };
}

export function documentGraphCandidateTerms(
  title: string,
  profile: SourceContentProfile
): string[] {
  return documentModelCandidateTerms(title, profile);
}

function result(
  suggestions: ModelSuggestions | null,
  contentProfile: SourceContentProfile,
  relationCandidates: readonly DocumentModelRelationCandidate[],
  warnings: readonly string[],
  candidates: readonly DocumentGraphCandidate[],
  execution: DocumentModelEvaluationExecution
) {
  const relations = [...relationCandidates];
  return {
    suggestions,
    contentProfile,
    evaluatedCandidates: candidates.map((candidate) => ({ ...candidate })),
    relationCandidates: relations,
    modelExecution: execution,
    warnings: [...warnings].slice(0, 1_000),
    graphSignals: {
      acceptedEdgeCount: relations.length,
      inboundEdgeCount: 0,
      outboundEdgeCount: relations.length,
      distinctNeighborCount: new Set(relations.map((item) =>
        item.targetSourceFilePublicId)).size,
      relationKindCount: new Set(relations.map((item) => item.relationType)).size
    }
  };
}

function validateSuggestions(value: ModelSuggestions | null): ModelSuggestions | null {
  if (value === null) return null;
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (bytes > 64 * 1_024
    || value.tags.length > 16 || value.keywords.length > 32) {
    throw enrichmentError("model_suggestions_invalid");
  }
  return structuredClone(value);
}

function validateWarnings(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 1_000
    || value.some((warning) => typeof warning !== "string"
      || !warning || warning.length > 256)) {
    throw enrichmentError("model_warnings_invalid");
  }
  return [...value];
}

function validateCandidates(
  candidates: readonly DocumentGraphCandidate[],
  request: DocumentModelGraphEnrichmentRequest
): void {
  if (candidates.length > request.candidateLimit
    || candidates.some((candidate) => !candidate.sourceFilePublicId
      || candidate.sourceFilePublicId === request.sourceFilePublicId
      || !candidate.sourceRevisionPublicId || !candidate.logicalPath
      || !candidate.title || candidate.rankingTerms.length > 1_000
      || Buffer.byteLength(candidate.evidenceExcerpt, "utf8")
        > DOCUMENT_EVIDENCE_EXCERPT_MAX_BYTES)) {
    throw enrichmentError("graph_candidates_invalid");
  }
}

function validateRequest(input: DocumentModelGraphEnrichmentRequest): void {
  if ([input.knowledgeBaseId, input.sourceFilePublicId,
    input.sourceRevisionPublicId, input.logicalPath, input.title,
    input.modelName].some((value) => !value)
    || !Number.isSafeInteger(input.candidateLimit)
    || input.candidateLimit < 1 || input.candidateLimit > 1_000
    || !Number.isSafeInteger(input.acceptedEdgeLimit)
    || input.acceptedEdgeLimit < 1 || input.acceptedEdgeLimit > 1_000
    || !Number.isSafeInteger(input.genericPhraseThreshold)
    || input.genericPhraseThreshold < 1 || input.genericPhraseThreshold > 64) {
    throw enrichmentError("input_invalid");
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? enrichmentError("cancelled");
}

function enrichmentError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document model graph enrichment error: ${code}`), {
    code
  });
}

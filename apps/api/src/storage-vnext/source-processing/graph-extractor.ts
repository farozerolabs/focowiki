import { createHash } from "node:crypto";
import type { OkfGraphEdge, OkfGraphNode } from "@focowiki/okf";
import type { LexicalTokenizer } from
  "../../application/ports/lexical-tokenizer.js";
import { buildCandidateTerms } from "../../graph/graph-candidates.js";
import { confirmGraphEdges } from "../../graph/graph-edge-confirmation.js";
import {
  buildGraphEdges,
  type createGraphEdgeScorer
} from "../../graph/graph-edge-scoring.js";
import { createGraphNode } from "../../graph/graph-node-profile.js";
import type { GraphModelConfirmationOptions } from "../../graph/graph-types.js";
import {
  mapStorageVnextMarkdownGraph
} from "../graph/markdown-facts.js";
import type {
  StorageVnextGraphEdgeFact,
  StorageVnextGraphEvidence,
  StorageVnextGraphNodeFact
} from "../graph/ports.js";
import type {
  StorageVnextStructuredMetadata
} from "../shared/types.js";
import type { StorageVnextGraphCandidateSearchPort } from
  "../search/graph-candidate-search.js";
import {
  createStorageVnextGraphMetadata,
  MAXIMUM_GRAPH_METADATA_BYTES,
  toOkfGraphNode
} from "./graph-node-metadata.js";

type GraphFactRequest = {
  knowledgeBaseId: string;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  sourceLogicalPath: string;
  checksum: string;
  revision: number;
  body: string;
  sourceBody: string;
  signal: AbortSignal;
};

type GraphExtractionRequest = GraphFactRequest & {
  parsedMetadata: Parameters<typeof createGraphNode>[0]["metadata"];
  suggestions: Parameters<typeof createGraphNode>[0]["suggestions"];
};

type GraphReconciliationInput = {
  candidates: StorageVnextGraphCandidateSearchPort;
  edgeScorer?: ReturnType<typeof createGraphEdgeScorer>;
  limits: {
    maximumCandidateNodes: number;
    acceptedEdgeLimit: number;
    genericPhraseThreshold: number;
  };
  modelConfirmation?: GraphModelConfirmationOptions | null;
} & (
  | { tokenizer: LexicalTokenizer; candidateTerms?: never }
  | {
      tokenizer?: never;
      candidateTerms: (node: OkfGraphNode) => readonly string[];
    }
);

export function createStorageVnextSourceGraphExtractor(input: {
  tokenizer: LexicalTokenizer;
  candidates: StorageVnextGraphCandidateSearchPort;
  limits: {
    maximumCandidateNodes: number;
    acceptedEdgeLimit: number;
    genericPhraseThreshold: number;
  };
  modelConfirmation?: (
    request: GraphExtractionRequest
  ) => GraphModelConfirmationOptions | null;
}) {
  validateLimits(input.limits);
  return async (request: GraphExtractionRequest): Promise<{
    node: StorageVnextGraphNodeFact;
    edges: StorageVnextGraphEdgeFact[];
  }> => {
    throwIfAborted(request.signal);
    const source = createGraphNode({
      sourceFileId: request.sourceFilePublicId,
      sourceRelativePath: request.sourceLogicalPath,
      metadata: request.parsedMetadata,
      body: request.body,
      suggestions: request.suggestions,
      tokenizer: input.tokenizer
    });
    const terms = buildCandidateTerms(source, input.tokenizer);
    const candidateFacts = await input.candidates.findCandidates({
      knowledgeBaseId: request.knowledgeBaseId,
      sourceFilePublicId: request.sourceFilePublicId,
      terms,
      limit: input.limits.maximumCandidateNodes
    });
    throwIfAborted(request.signal);
    const candidates = candidateFacts.map(toOkfGraphNode);
    const proposed = buildGraphEdges({
      source,
      body: request.body,
      suggestions: request.suggestions,
      candidates,
      acceptedEdgeLimit: input.limits.acceptedEdgeLimit,
      genericPhraseThreshold: input.limits.genericPhraseThreshold
    });
    const confirmed = await confirmGraphEdges({
      node: source,
      body: request.body,
      candidates,
      edges: proposed,
      modelConfirmation: input.modelConfirmation?.(request) ?? null
    });
    throwIfAborted(request.signal);
    const graphMetadata = createStorageVnextGraphMetadata(
      source,
      request.suggestions
    );
    const markdown = mapStorageVnextMarkdownGraph({
      knowledgeBaseId: request.knowledgeBaseId,
      sourceFilePublicId: request.sourceFilePublicId,
      sourceRevisionPublicId: request.sourceRevisionPublicId,
      sourceLogicalPath: request.sourceLogicalPath,
      body: request.sourceBody,
      checksum: request.checksum,
      fallbackTitle: source.title,
      metadata: graphMetadata,
      targets: candidateFacts.map((candidate) => ({
        nodePublicId: candidate.publicId,
        sourceFilePublicId: candidate.sourceFilePublicId,
        sourceRevisionPublicId: candidate.sourceRevisionPublicId,
        logicalPath: candidate.logicalPath,
        label: candidate.label
      })),
      revision: request.revision
    });
    const node: StorageVnextGraphNodeFact = {
      ...markdown.node,
      label: source.title,
      kind: source.type?.trim() || "page",
      metadata: graphMetadata
    };
    return {
      node,
      edges: mergeEdges(
        markdown.edges,
        confirmed.edges.map((edge) => mapSemanticEdge({
          request,
          node,
          edge,
          target: requireTarget(candidateFacts, edge.toFileId)
        }))
      )
    };
  };
}

export async function reconcileStorageVnextGraphEdges(input: {
  tokenizer: LexicalTokenizer;
  candidates: StorageVnextGraphCandidateSearchPort;
  limits: {
    maximumCandidateNodes: number;
    acceptedEdgeLimit: number;
    genericPhraseThreshold: number;
  };
  modelConfirmation?: GraphModelConfirmationOptions | null;
}, request: {
  node: StorageVnextGraphNodeFact;
  checksum: string;
  body: string;
  signal: AbortSignal;
}): Promise<StorageVnextGraphEdgeFact[]> {
  return (await reconcileStorageVnextGraphFacts(input, request)).edges;
}

export async function reconcileStorageVnextGraphFacts(input: GraphReconciliationInput, request: {
  node: StorageVnextGraphNodeFact;
  checksum: string;
  body: string;
  signal: AbortSignal;
}): Promise<{
  node: StorageVnextGraphNodeFact;
  edges: StorageVnextGraphEdgeFact[];
}> {
  validateLimits(input.limits);
  throwIfAborted(request.signal);
  if (
    !request.node.logicalPath.startsWith("pages/")
    || !/^[0-9a-f]{64}$/u.test(request.checksum)
  ) throw graphExtractorError("invalid_reconciliation_input");
  const source = toOkfGraphNode(request.node);
  const terms = input.candidateTerms
    ? input.candidateTerms(source)
    : buildCandidateTerms(source, input.tokenizer);
  const candidateFacts = await input.candidates.findCandidates({
    knowledgeBaseId: request.node.knowledgeBaseId,
    sourceFilePublicId: request.node.sourceFilePublicId,
    terms,
    limit: input.limits.maximumCandidateNodes
  });
  throwIfAborted(request.signal);
  const candidates = candidateFacts.map(toOkfGraphNode);
  const edgeInput = {
    source,
    body: request.body,
    suggestions: null,
    candidates,
    acceptedEdgeLimit: input.limits.acceptedEdgeLimit,
    genericPhraseThreshold: input.limits.genericPhraseThreshold
  };
  const proposed = input.edgeScorer
    ? input.edgeScorer.build({
        ...edgeInput,
        profileKeys: {
          source: profileKey(request.node),
          candidates: candidateFacts.map(profileKey)
        }
      })
    : buildGraphEdges(edgeInput);
  const confirmed = await confirmGraphEdges({
    node: source,
    body: request.body,
    candidates,
    edges: proposed,
    modelConfirmation: input.modelConfirmation ?? null
  });
  throwIfAborted(request.signal);
  const factRequest: GraphFactRequest = {
    knowledgeBaseId: request.node.knowledgeBaseId,
    sourceFilePublicId: request.node.sourceFilePublicId,
    sourceRevisionPublicId: request.node.sourceRevisionPublicId,
    sourceLogicalPath: request.node.logicalPath.slice("pages/".length),
    checksum: request.checksum,
    revision: request.node.revision,
    body: request.body,
    sourceBody: request.body,
    signal: request.signal
  };
  const markdown = mapStorageVnextMarkdownGraph({
    knowledgeBaseId: factRequest.knowledgeBaseId,
    sourceFilePublicId: factRequest.sourceFilePublicId,
    sourceRevisionPublicId: factRequest.sourceRevisionPublicId,
    sourceLogicalPath: factRequest.sourceLogicalPath,
    body: factRequest.body,
    checksum: factRequest.checksum,
    fallbackTitle: request.node.label,
    metadata: request.node.metadata,
    targets: candidateFacts.map((candidate) => ({
      nodePublicId: candidate.publicId,
      sourceFilePublicId: candidate.sourceFilePublicId,
      sourceRevisionPublicId: candidate.sourceRevisionPublicId,
      logicalPath: candidate.logicalPath,
      label: candidate.label
    })),
    revision: factRequest.revision
  });
  const node: StorageVnextGraphNodeFact = {
    ...markdown.node,
    label: request.node.label,
    kind: request.node.kind,
    metadata: request.node.metadata
  };
  return {
    node,
    edges: mergeEdges(
      markdown.edges,
      confirmed.edges.map((edge) => mapSemanticEdge({
      request: factRequest,
      node,
      edge,
      target: requireTarget(candidateFacts, edge.toFileId)
      }))
    )
  };
}

function mapSemanticEdge(input: {
  request: GraphFactRequest;
  node: StorageVnextGraphNodeFact;
  edge: OkfGraphEdge;
  target: StorageVnextGraphNodeFact;
}): StorageVnextGraphEdgeFact {
  const publicId = stableId("graph-edge-v1", [
    input.request.knowledgeBaseId,
    input.node.publicId,
    input.target.publicId,
    input.edge.relationType
  ]);
  return {
    publicId,
    knowledgeBaseId: input.request.knowledgeBaseId,
    fromNodePublicId: input.node.publicId,
    toNodePublicId: input.target.publicId,
    relation: input.edge.relationType,
    weight: input.edge.weight,
    reason: input.edge.reason,
    source: input.edge.source,
    metadata: boundedEdgeMetadata(input.edge.evidence),
    evidence: createSemanticEvidence({
      request: input.request,
      edge: input.edge,
      edgePublicId: publicId,
      fallback: input.node.evidence[0] ?? null
    }),
    revision: input.request.revision
  };
}

function boundedEdgeMetadata(value: unknown): StorageVnextStructuredMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > MAXIMUM_GRAPH_METADATA_BYTES) {
    throw graphExtractorError("graph_metadata_too_large");
  }
  return JSON.parse(serialized) as StorageVnextStructuredMetadata;
}

function createSemanticEvidence(input: {
  request: GraphFactRequest;
  edge: OkfGraphEdge;
  edgePublicId: string;
  fallback: StorageVnextGraphEvidence | null;
}): StorageVnextGraphEvidence[] {
  const match = evidenceStrings(input.edge.evidence)
    .map((value) => ({ value, offset: input.request.sourceBody.indexOf(value) }))
    .find((candidate) => candidate.offset >= 0);
  const startOffset = match?.offset ?? input.fallback?.startOffset;
  const endOffset = match
    ? match.offset + match.value.length
    : input.fallback?.endOffset;
  if (startOffset === undefined || endOffset === undefined) return [];
  return [{
    publicId: stableId("graph-evidence-v1", [
      input.edgePublicId,
      input.request.sourceRevisionPublicId,
      String(startOffset),
      String(endOffset),
      input.request.checksum
    ]),
    sourceFilePublicId: input.request.sourceFilePublicId,
    sourceRevisionPublicId: input.request.sourceRevisionPublicId,
    logicalPath: `pages/${input.request.sourceLogicalPath}`,
    startOffset,
    endOffset,
    checksum: input.request.checksum
  }];
}

function evidenceStrings(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap(evidenceStrings);
  if (typeof value === "object" && value !== null) {
    return Object.values(value).flatMap(evidenceStrings);
  }
  return [];
}

function mergeEdges(
  markdownEdges: readonly StorageVnextGraphEdgeFact[],
  semanticEdges: readonly StorageVnextGraphEdgeFact[]
): StorageVnextGraphEdgeFact[] {
  const edges = new Map<string, StorageVnextGraphEdgeFact>();
  for (const edge of [...markdownEdges, ...semanticEdges]) {
    const key = `${edge.fromNodePublicId}\0${edge.toNodePublicId}\0${edge.relation}`;
    const current = edges.get(key);
    edges.set(key, current && current.evidence.length > edge.evidence.length
      ? { ...edge, evidence: current.evidence }
      : edge);
  }
  return [...edges.values()].sort((left, right) =>
    right.weight - left.weight
    || left.toNodePublicId.localeCompare(right.toNodePublicId, "en")
    || left.relation.localeCompare(right.relation, "en")
  );
}

function requireTarget(
  targets: readonly StorageVnextGraphNodeFact[],
  sourceFilePublicId: string
): StorageVnextGraphNodeFact {
  const target = targets.find((item) => item.sourceFilePublicId === sourceFilePublicId);
  if (!target) throw graphExtractorError("candidate_identity_missing");
  return target;
}

function validateLimits(input: {
  maximumCandidateNodes: number;
  acceptedEdgeLimit: number;
  genericPhraseThreshold: number;
}): void {
  if (
    !Number.isSafeInteger(input.maximumCandidateNodes)
    || input.maximumCandidateNodes < 1
    || input.maximumCandidateNodes > 1_000
    || !Number.isSafeInteger(input.acceptedEdgeLimit)
    || input.acceptedEdgeLimit < 1
    || input.acceptedEdgeLimit > 200
    || !Number.isSafeInteger(input.genericPhraseThreshold)
    || input.genericPhraseThreshold < 2
    || input.genericPhraseThreshold > 20
  ) throw graphExtractorError("invalid_limits");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException("Graph extraction aborted", "AbortError");
}

function stableId(kind: string, values: readonly string[]): string {
  return `${kind}:${createHash("sha256")
    .update([kind, ...values].join("\0"))
    .digest("hex")}`;
}

function profileKey(node: StorageVnextGraphNodeFact): string {
  return [
    node.knowledgeBaseId,
    node.sourceFilePublicId,
    node.sourceRevisionPublicId,
    String(node.revision)
  ].join("\0");
}

function graphExtractorError(code: string): Error & { code: string } {
  return Object.assign(
    new Error(`Storage vNext source graph extractor error: ${code}`),
    { code }
  );
}

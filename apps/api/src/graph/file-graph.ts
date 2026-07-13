import type { SourceMetadataDefaults, SourceModelSuggestions } from "@focowiki/okf";
import type { FileGraphRepository, SourceFileRecord } from "../db/admin-repositories.js";
import { buildCandidateTerms, listCandidateNodes } from "./graph-candidates.js";
import { confirmGraphEdges } from "./graph-edge-confirmation.js";
import { buildGraphEdges } from "./graph-edge-scoring.js";
import { createGraphNode } from "./graph-node-profile.js";
import type { GraphModelConfirmationOptions } from "./graph-types.js";

export type BuildSourceFileGraphInput = {
  graph: FileGraphRepository;
  knowledgeBaseId: string;
  source: SourceFileRecord;
  metadata: SourceMetadataDefaults;
  body: string;
  suggestions: SourceModelSuggestions | null;
  pageSize: number;
  maxCandidateNodes?: number;
  acceptedEdgeLimit?: number;
  genericPhraseThreshold?: number;
  modelConfirmation?: GraphModelConfirmationOptions | null;
};

export type BuildSourceFileGraphResult = {
  edgeCount: number;
  rejectedEdgeCount: number;
  affectedSourceFileIds: string[];
  warnings: string[];
};

export async function buildSourceFileGraph(
  input: BuildSourceFileGraphInput
): Promise<BuildSourceFileGraphResult> {
  const node = createGraphNode({
    sourceFileId: input.source.id,
    sourceRelativePath: input.source.relativePath,
    metadata: input.metadata,
    body: input.body,
    suggestions: input.suggestions
  });
  await input.graph.upsertGraphNode({
    knowledgeBaseId: input.knowledgeBaseId,
    node
  });

  const candidates = await listCandidateNodes({
    graph: input.graph,
    knowledgeBaseId: input.knowledgeBaseId,
    sourceFileId: input.source.id,
    candidateTerms: buildCandidateTerms(node),
    pageSize: input.pageSize,
    maxCandidateNodes: resolveMaxCandidateNodes(input)
  });
  const edges = buildGraphEdges({
    source: node,
    body: input.body,
    suggestions: input.suggestions,
    candidates,
    acceptedEdgeLimit: resolveAcceptedEdgeLimit(input),
    genericPhraseThreshold: resolveGenericPhraseThreshold(input)
  });
  const confirmation = await confirmGraphEdges({
    node,
    body: input.body,
    candidates,
    edges,
    modelConfirmation: input.modelConfirmation ?? null
  });

  const replacedTargetIds = (await input.graph.replaceGraphEdgesForSourceFile?.({
    knowledgeBaseId: input.knowledgeBaseId,
    sourceFileId: input.source.id
  })) ?? [];

  if (confirmation.edges.length > 0) {
    await input.graph.upsertGraphEdges({
      knowledgeBaseId: input.knowledgeBaseId,
      edges: confirmation.edges
    });
  }

  if (confirmation.rejectedEdges.length > 0) {
    await input.graph.upsertRejectedGraphEdges?.({
      knowledgeBaseId: input.knowledgeBaseId,
      edges: confirmation.rejectedEdges
    });
  }

  const explicitReferenceReconciliation = input.graph.reconcileExplicitReferenceEdgesForTarget
    ? await input.graph.reconcileExplicitReferenceEdgesForTarget({
        knowledgeBaseId: input.knowledgeBaseId,
        target: node,
        limit: resolveMaxCandidateNodes(input)
      })
    : { edgeCount: 0, sourceFileIds: [] };

  return {
    edgeCount: confirmation.edges.length + explicitReferenceReconciliation.edgeCount,
    rejectedEdgeCount: confirmation.rejectedEdges.length,
    affectedSourceFileIds: Array.from(
      new Set([
        input.source.id,
        ...replacedTargetIds,
        ...explicitReferenceReconciliation.sourceFileIds,
        ...confirmation.edges.flatMap((edge) => [edge.fromFileId, edge.toFileId])
      ])
    ),
    warnings: confirmation.warnings
  };
}

function resolveMaxCandidateNodes(input: BuildSourceFileGraphInput): number {
  const requested = input.maxCandidateNodes ?? input.pageSize * 4;

  return Math.max(1, Math.min(requested, 1_000));
}

function resolveAcceptedEdgeLimit(input: BuildSourceFileGraphInput): number {
  return Math.max(1, Math.min(input.acceptedEdgeLimit ?? 50, 200));
}

function resolveGenericPhraseThreshold(input: BuildSourceFileGraphInput): number {
  return Math.max(2, Math.min(input.genericPhraseThreshold ?? 4, 20));
}

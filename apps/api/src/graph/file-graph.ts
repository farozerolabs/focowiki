import type { SourceMetadataDefaults, SourceModelSuggestions } from "@focowiki/okf";
import type { FileGraphRepository, SourceFileRecord } from "../db/admin-repositories.js";
import { buildCandidateTerms, listCandidateNodes } from "./graph-candidates.js";
import { confirmGraphEdges } from "./graph-edge-confirmation.js";
import { buildGraphEdges } from "./graph-edge-scoring.js";
import { createGraphNode } from "./graph-node-profile.js";
import { buildGraphTermDocument } from "./graph-term-document.js";
import type { GraphModelConfirmationOptions } from "./graph-types.js";
import { readContentProfileStringArray } from "./graph-utils.js";
import type { ResourceBudget } from "../runtime/resource-budget.js";

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
  graphQueryBudget?: ResourceBudget;
  databaseMutationBudget?: ResourceBudget;
};

export type BuildSourceFileGraphResult = {
  edgeCount: number;
  rejectedEdgeCount: number;
  affectedSourceFileIds: string[];
  edgeIds: string[];
  removedEdgeIds: string[];
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
  const termDocument = buildGraphTermDocument({
    sourceFileId: input.source.id,
    sourceRevisionId: input.source.sourceRevisionId,
    title: node.title,
    body: input.body,
    headings: node.headings ?? [],
    phrases: [
      ...readContentProfileStringArray(node, "definitions"),
      ...readContentProfileStringArray(node, "evidencePhrases"),
      ...readContentProfileStringArray(node, "processHints"),
      ...readContentProfileStringArray(node, "versionHints")
    ],
    entities: node.entities ?? [],
    explicitReferences: node.explicitReferences ?? [],
    supplementalTerms: [
      ...(node.subjects ?? []),
      ...(node.tags ?? []),
      ...(node.keywords ?? []),
      ...(node.relationshipHints ?? [])
    ]
  });
  await runBudgeted(input.databaseMutationBudget, async () => {
    await input.graph.upsertGraphNode({
      knowledgeBaseId: input.knowledgeBaseId,
      node
    });
    await input.graph.upsertGraphTermDocument({
      knowledgeBaseId: input.knowledgeBaseId,
      document: termDocument
    });
  });

  const candidates = await runBudgeted(input.graphQueryBudget, () => listCandidateNodes({
    graph: input.graph,
    knowledgeBaseId: input.knowledgeBaseId,
    sourceFileId: input.source.id,
    candidateTerms: buildCandidateTerms(node),
    maxCandidateNodes: resolveMaxCandidateNodes(input)
  }));
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

  const mutation = await runBudgeted(input.databaseMutationBudget, () =>
    input.graph.applyGraphMutationSet({
      knowledgeBaseId: input.knowledgeBaseId,
      sourceFileId: input.source.id,
      target: node,
      acceptedEdges: confirmation.edges,
      rejectedEdges: confirmation.rejectedEdges,
      limit: resolveMaxCandidateNodes(input)
    }));

  return {
    edgeCount: mutation.edgeCount,
    rejectedEdgeCount: confirmation.rejectedEdges.length,
    affectedSourceFileIds: mutation.affectedSourceFileIds,
    edgeIds: mutation.edgeIds,
    removedEdgeIds: mutation.removedEdgeIds,
    warnings: confirmation.warnings
  };
}

function runBudgeted<T>(budget: ResourceBudget | undefined, operation: () => Promise<T>): Promise<T> {
  return budget ? budget.run(operation) : operation();
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

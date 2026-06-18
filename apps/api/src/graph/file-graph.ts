import {
  requestGraphRelationshipConfirmations,
  type ModelReceiveTimeouts,
  type OkfGraphEdge,
  type OkfGraphNode,
  type OpenAIResponsesClient,
  type SourceMetadataDefaults,
  type SourceModelSuggestions
} from "@focowiki/okf";
import type { FileGraphRepository, SourceFileRecord } from "../db/admin-repositories.js";

export type BuildSourceFileGraphInput = {
  graph: FileGraphRepository;
  knowledgeBaseId: string;
  source: SourceFileRecord;
  metadata: SourceMetadataDefaults;
  body: string;
  suggestions: SourceModelSuggestions | null;
  pageSize: number;
  maxCandidateNodes?: number;
  modelConfirmation?: GraphModelConfirmationOptions | null;
};

export type GraphModelConfirmationOptions = {
  client: OpenAIResponsesClient;
  modelName: string;
  contextWindowTokens: number;
  receiveTimeouts: ModelReceiveTimeouts;
};

export type BuildSourceFileGraphResult = {
  edgeCount: number;
  warnings: string[];
};

export async function buildSourceFileGraph(
  input: BuildSourceFileGraphInput
): Promise<BuildSourceFileGraphResult> {
  const node = createGraphNode(input);
  await input.graph.upsertGraphNode({
    knowledgeBaseId: input.knowledgeBaseId,
    node
  });

  const candidates = await listCandidateNodes({
    graph: input.graph,
    knowledgeBaseId: input.knowledgeBaseId,
    sourceFileId: input.source.id,
    pageSize: input.pageSize,
    maxCandidateNodes: resolveMaxCandidateNodes(input)
  });
  const edges = buildGraphEdges({
    source: node,
    body: input.body,
    suggestions: input.suggestions,
    candidates
  });
  const confirmation = await confirmGraphEdges({
    node,
    body: input.body,
    candidates,
    edges,
    modelConfirmation: input.modelConfirmation ?? null
  });

  if (confirmation.edges.length > 0) {
    await input.graph.upsertGraphEdges({
      knowledgeBaseId: input.knowledgeBaseId,
      edges: confirmation.edges
    });
  }

  return {
    edgeCount: confirmation.edges.length,
    warnings: confirmation.warnings
  };
}

function createGraphNode(input: BuildSourceFileGraphInput): OkfGraphNode {
  const title = readString(input.metadata.title) || stripMarkdownExtension(input.source.originalName);
  const tags = readStringArray(input.metadata.tags);
  const headings = extractHeadings(input.body);
  const keywords = unique([
    ...tokenize(title),
    ...tags.flatMap(tokenize),
    ...headings.flatMap(tokenize),
    ...(input.suggestions?.keywords ?? []).flatMap(tokenize)
  ]).slice(0, 50);

  return {
    fileId: input.source.id,
    path: `pages/${input.source.originalName}`,
    title,
    ...(readString(input.metadata.type) ? { type: readString(input.metadata.type) } : {}),
    ...(readString(input.metadata.description)
      ? { description: readString(input.metadata.description) }
      : {}),
    tags,
    headings,
    keywords,
    metadata: input.metadata
  };
}

async function listCandidateNodes(input: {
  graph: FileGraphRepository;
  knowledgeBaseId: string;
  sourceFileId: string;
  pageSize: number;
  maxCandidateNodes: number;
}): Promise<OkfGraphNode[]> {
  const candidates: OkfGraphNode[] = [];
  let cursor: string | null = null;

  do {
    const page = await input.graph.listGraphNodes({
      knowledgeBaseId: input.knowledgeBaseId,
      limit: input.pageSize,
      cursor
    });
    const remaining = input.maxCandidateNodes - candidates.length;
    candidates.push(
      ...page.items
        .filter((node) => node.fileId !== input.sourceFileId)
        .slice(0, Math.max(0, remaining))
    );
    cursor = page.nextCursor;
  } while (cursor && candidates.length < input.maxCandidateNodes);

  return candidates;
}

function buildGraphEdges(input: {
  source: OkfGraphNode;
  body: string;
  suggestions: SourceModelSuggestions | null;
  candidates: OkfGraphNode[];
}): OkfGraphEdge[] {
  const suggestedPaths = new Set(
    (input.suggestions?.related_links ?? []).map((link) => normalizePublicPath(link.path))
  );

  return input.candidates
    .map((candidate) => bestEdgeForCandidate(input.source, input.body, suggestedPaths, candidate))
    .filter((edge): edge is OkfGraphEdge => edge !== null)
    .sort(
      (left, right) =>
        right.weight - left.weight ||
        left.toFileId.localeCompare(right.toFileId) ||
        left.relationType.localeCompare(right.relationType)
    )
    .slice(0, 50);
}

async function confirmGraphEdges(input: {
  node: OkfGraphNode;
  body: string;
  candidates: OkfGraphNode[];
  edges: OkfGraphEdge[];
  modelConfirmation: GraphModelConfirmationOptions | null;
}): Promise<{ edges: OkfGraphEdge[]; warnings: string[] }> {
  if (!input.modelConfirmation || input.edges.length === 0) {
    return {
      edges: input.edges,
      warnings: []
    };
  }

  const result = await requestGraphRelationshipConfirmations({
    client: input.modelConfirmation.client,
    modelName: input.modelConfirmation.modelName,
    contextWindowTokens: input.modelConfirmation.contextWindowTokens,
    receiveTimeouts: input.modelConfirmation.receiveTimeouts,
    currentFile: input.node,
    body: input.body,
    candidates: input.edges,
    candidateFiles: listEdgeCandidateFiles(input.candidates, input.edges)
  });

  if (result.confirmations.length === 0) {
    return {
      edges: input.edges,
      warnings: result.warnings
    };
  }

  const confirmationByTarget = new Map(
    result.confirmations.map((confirmation) => [confirmation.targetFileId, confirmation])
  );
  return {
    edges: input.edges.map((edge) => {
      const confirmation = confirmationByTarget.get(edge.toFileId);

      if (!confirmation?.accepted) {
        return edge;
      }

      return {
        ...edge,
        relationType: confirmation.relationType.trim() || edge.relationType,
        weight: Math.max(edge.weight, confirmation.weight),
        reason: confirmation.reason.trim() || edge.reason,
        source: "model_confirmed",
        evidence: {
          ...(edge.evidence ?? {}),
          deterministicSource: edge.source,
          deterministicRelationType: edge.relationType
        }
      };
    }),
    warnings: result.warnings
  };
}

function resolveMaxCandidateNodes(input: BuildSourceFileGraphInput): number {
  const requested = input.maxCandidateNodes ?? input.pageSize * 4;
  return Math.max(1, Math.min(requested, 200));
}

function listEdgeCandidateFiles(candidates: OkfGraphNode[], edges: OkfGraphEdge[]): OkfGraphNode[] {
  const edgeTargetIds = new Set(edges.map((edge) => edge.toFileId));
  return candidates.filter((candidate) => edgeTargetIds.has(candidate.fileId));
}

function bestEdgeForCandidate(
  source: OkfGraphNode,
  body: string,
  suggestedPaths: Set<string>,
  candidate: OkfGraphNode
): OkfGraphEdge | null {
  const signals: OkfGraphEdge[] = [];
  const sharedTags = intersect(source.tags ?? [], candidate.tags ?? []);
  const sharedHeadings = intersect(source.headings ?? [], candidate.headings ?? []);
  const normalizedBody = body.toLowerCase();
  const candidateTitle = candidate.title.toLowerCase();

  if (suggestedPaths.has(normalizePublicPath(candidate.path))) {
    signals.push(createEdge(source, candidate, "model_related_link", 0.9, "The model selected this existing file path.", {
      path: candidate.path
    }));
  }

  if (sharedTags.length > 0) {
    signals.push(createEdge(source, candidate, "shared_tag", 0.8, "Both files share tags.", {
      tags: sharedTags
    }));
  }

  if (candidateTitle && normalizedBody.includes(candidateTitle)) {
    signals.push(createEdge(source, candidate, "title_mention", 0.7, "The source body mentions the related file title.", {
      title: candidate.title
    }));
  }

  if (sharedHeadings.length > 0) {
    signals.push(createEdge(source, candidate, "shared_heading", 0.55, "Both files share headings.", {
      headings: sharedHeadings
    }));
  }

  if (source.type && candidate.type && source.type === candidate.type) {
    signals.push(createEdge(source, candidate, "type_affinity", 0.35, "Both files share the same type.", {
      type: source.type
    }));
  }

  return signals.sort((left, right) => right.weight - left.weight)[0] ?? null;
}

function createEdge(
  source: OkfGraphNode,
  candidate: OkfGraphNode,
  relationType: string,
  weight: number,
  reason: string,
  evidence: Record<string, unknown>
): OkfGraphEdge {
  return {
    fromFileId: source.fileId,
    toFileId: candidate.fileId,
    relationType,
    weight,
    reason,
    source: "deterministic",
    evidence
  };
}

function extractHeadings(body: string): string[] {
  return unique(
    body
      .split(/\r?\n/u)
      .map((line) => line.match(/^#{1,6}\s+(.+)$/u)?.[1]?.trim() ?? "")
      .filter(Boolean)
  ).slice(0, 50);
}

function normalizePublicPath(path: string): string {
  return path.trim().replace(/^\/+/, "").replace(/#.*$/u, "");
}

function stripMarkdownExtension(fileName: string): string {
  return fileName.replace(/\.md$/iu, "");
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function intersect(left: string[], right: string[]): string[] {
  const rightValues = new Set(right.map((value) => value.toLowerCase()));
  return unique(left.filter((value) => rightValues.has(value.toLowerCase())));
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

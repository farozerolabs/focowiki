export type OkfGraphNode = {
  fileId: string;
  path: string;
  title: string;
  type?: string | null;
  description?: string | null;
  summary?: string | null;
  subjects?: string[];
  tags?: string[];
  entities?: string[];
  explicitReferences?: string[];
  relationshipHints?: string[];
  headings?: string[];
  keywords?: string[];
  language?: string | null;
  profileVersion?: string | null;
  profileSource?: string | null;
  metadata?: Record<string, unknown>;
};

export type OkfGraphEdgeSource = "deterministic" | "model_confirmed" | string;

export type OkfGraphEdge = {
  fromFileId: string;
  toFileId: string;
  relationType: string;
  weight: number;
  reason: string;
  source: OkfGraphEdgeSource;
  evidence?: Record<string, unknown>;
};

export type OkfGraphLimits = {
  pageRelatedLimit?: number;
  perFileLimit?: number;
  edgeShardSize?: number;
};

export type OkfGraphInput = {
  nodes: OkfGraphNode[];
  edges: OkfGraphEdge[];
  limits?: OkfGraphLimits;
};

export type OkfGraphRelationship = {
  fileId: string;
  path: string;
  title: string;
  relationType: string;
  direction: "outgoing" | "incoming";
  weight: number;
  reason: string;
  source: OkfGraphEdgeSource;
  evidence?: Record<string, unknown>;
};

export type NormalizedOkfGraph = {
  nodes: OkfGraphNode[];
  edges: OkfGraphEdge[];
  nodesByFileId: Map<string, OkfGraphNode>;
  limits: Required<OkfGraphLimits>;
};

export type GraphGeneratedFile = {
  path: string;
  content: string;
  kind: "graph_index" | "graph_manifest" | "graph_node_index" | "graph_edge_shard" | "graph_file";
};

const DEFAULT_GRAPH_LIMITS: Required<OkfGraphLimits> = {
  pageRelatedLimit: 10,
  perFileLimit: 50,
  edgeShardSize: 1000
};

export function normalizeOkfGraph(input: OkfGraphInput | undefined): NormalizedOkfGraph | null {
  if (!input) {
    return null;
  }

  const limits = normalizeGraphLimits(input.limits);
  const nodes = uniqueBy(input.nodes.map(normalizeNode).filter(isGraphNode), (node) => node.fileId)
    .sort((left, right) => left.fileId.localeCompare(right.fileId));
  const nodesByFileId = new Map(nodes.map((node) => [node.fileId, node]));
  const edges = uniqueBy(
    input.edges
      .map(normalizeEdge)
      .filter((edge): edge is OkfGraphEdge =>
        Boolean(
          edge &&
            edge.fromFileId !== edge.toFileId &&
            nodesByFileId.has(edge.fromFileId) &&
            nodesByFileId.has(edge.toFileId)
        )
      ),
    (edge) => `${edge.fromFileId}\u0000${edge.toFileId}\u0000${edge.relationType}`
  ).sort(compareEdges);

  return { nodes, edges, nodesByFileId, limits };
}

export function graphRefForFile(fileId: string): string {
  return `_graph/by-file/${encodeGraphFileId(fileId)}.json`;
}

export function pageGraphRefForFile(fileId: string): string {
  return `../${graphRefForFile(fileId)}`;
}

export function buildGraphGeneratedFiles(
  graph: NormalizedOkfGraph,
  generatedAt: string
): GraphGeneratedFile[] {
  const files: GraphGeneratedFile[] = [
    {
      path: "_graph/index.md",
      kind: "graph_index",
      content: renderGraphIndex(graph, generatedAt)
    },
    {
      path: "_graph/manifest.json",
      kind: "graph_manifest",
      content: stringifyJson({
        generated_at: generatedAt,
        node_count: graph.nodes.length,
        edge_count: graph.edges.length,
        by_file_pattern: "_graph/by-file/{fileId}.json",
        edge_shard_pattern: "_graph/edges/{shard}.jsonl"
      })
    },
    {
      path: "_graph/nodes.jsonl",
      kind: "graph_node_index",
      content: stringifyJsonLines(graph.nodes)
    },
    ...buildEdgeShardFiles(graph),
    ...graph.nodes.map((node) => ({
      path: graphRefForFile(node.fileId),
      kind: "graph_file" as const,
      content: stringifyJson({
        fileId: node.fileId,
        path: node.path,
        title: node.title,
        generatedAt,
        relationships: listGraphRelationships(graph, node.fileId, graph.limits.perFileLimit)
      })
    }))
  ];

  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export function listGraphRelationships(
  graph: NormalizedOkfGraph,
  fileId: string,
  limit: number
): OkfGraphRelationship[] {
  const relationships = graph.edges.flatMap((edge) => {
    if (edge.fromFileId === fileId) {
      return [toRelationship(graph, edge, edge.toFileId, "outgoing")];
    }

    if (edge.toFileId === fileId) {
      return [toRelationship(graph, edge, edge.fromFileId, "incoming")];
    }

    return [];
  });

  return relationships
    .filter((relationship): relationship is OkfGraphRelationship => relationship !== null)
    .sort(compareRelationships)
    .slice(0, Math.max(0, limit));
}

export function listPageRelatedGraphLinks(
  graph: NormalizedOkfGraph | null,
  fileId: string | undefined,
  publicPaths: Set<string>,
  limit?: number
): OkfGraphRelationship[] {
  if (!graph || !fileId) {
    return [];
  }

  const count = limit ?? graph.limits.pageRelatedLimit;
  return uniqueBy(
    listGraphRelationships(graph, fileId, graph.limits.perFileLimit).filter((relationship) =>
      publicPaths.has(relationship.path)
    ),
    (relationship) => relationship.fileId || relationship.path
  ).slice(0, count);
}

export function buildGraphLinkIndexEntries(graph: NormalizedOkfGraph): Array<{
  from: string;
  to: string;
  label: string;
  relation_type: string;
  weight: number;
  source: string;
  reason: string;
}> {
  return graph.edges.flatMap((edge) => {
    const from = graph.nodesByFileId.get(edge.fromFileId);
    const to = graph.nodesByFileId.get(edge.toFileId);

    if (!from || !to) {
      return [];
    }

    return [
      {
        from: from.path,
        to: to.path,
        label: to.title,
        relation_type: edge.relationType,
        weight: edge.weight,
        source: edge.source,
        reason: edge.reason
      }
    ];
  });
}

function buildEdgeShardFiles(graph: NormalizedOkfGraph): GraphGeneratedFile[] {
  const shardSize = graph.limits.edgeShardSize;
  const shards: GraphGeneratedFile[] = [];

  for (let index = 0; index < graph.edges.length; index += shardSize) {
    const shard = graph.edges.slice(index, index + shardSize);
    const shardName = String(shards.length).padStart(4, "0");
    shards.push({
      path: `_graph/edges/${shardName}.jsonl`,
      kind: "graph_edge_shard",
      content: stringifyJsonLines(shard)
    });
  }

  return shards;
}

function renderGraphIndex(graph: NormalizedOkfGraph, generatedAt: string): string {
  return [
    "---",
    'type: "graph-index"',
    'title: "File graph"',
    `generatedAt: ${JSON.stringify(generatedAt)}`,
    "---",
    "# File graph",
    "",
    "This directory contains file-first relationship data for Agent navigation.",
    "",
    `- Nodes: ${graph.nodes.length}`,
    `- Edges: ${graph.edges.length}`,
    "- Per-file relationships: `_graph/by-file/{fileId}.json`"
  ].join("\n");
}

function normalizeGraphLimits(limits: OkfGraphLimits | undefined): Required<OkfGraphLimits> {
  return {
    pageRelatedLimit: positiveIntegerOr(limits?.pageRelatedLimit, DEFAULT_GRAPH_LIMITS.pageRelatedLimit),
    perFileLimit: positiveIntegerOr(limits?.perFileLimit, DEFAULT_GRAPH_LIMITS.perFileLimit),
    edgeShardSize: positiveIntegerOr(limits?.edgeShardSize, DEFAULT_GRAPH_LIMITS.edgeShardSize)
  };
}

function normalizeNode(node: OkfGraphNode): OkfGraphNode {
  return {
    fileId: node.fileId.trim(),
    path: node.path.trim().replace(/^\/+/, ""),
    title: node.title.trim(),
    ...(node.type ? { type: node.type } : {}),
    ...(node.description ? { description: node.description } : {}),
    ...(node.summary ? { summary: node.summary } : {}),
    subjects: readStrings(node.subjects),
    tags: readStrings(node.tags),
    entities: readStrings(node.entities),
    explicitReferences: readStrings(node.explicitReferences),
    relationshipHints: readStrings(node.relationshipHints),
    headings: readStrings(node.headings),
    keywords: readStrings(node.keywords),
    ...(node.language ? { language: node.language } : {}),
    ...(node.profileVersion ? { profileVersion: node.profileVersion } : {}),
    ...(node.profileSource ? { profileSource: node.profileSource } : {}),
    ...(node.metadata ? { metadata: node.metadata } : {})
  };
}

function isGraphNode(node: OkfGraphNode): boolean {
  return Boolean(node.fileId && node.path && node.title);
}

function normalizeEdge(edge: OkfGraphEdge): OkfGraphEdge | null {
  const weight = Number.isFinite(edge.weight) ? Math.max(0, Math.min(1, edge.weight)) : 0;
  const normalized = {
    fromFileId: edge.fromFileId.trim(),
    toFileId: edge.toFileId.trim(),
    relationType: edge.relationType.trim(),
    weight,
    reason: edge.reason.trim(),
    source: edge.source,
    ...(edge.evidence ? { evidence: edge.evidence } : {})
  };

  return normalized.fromFileId && normalized.toFileId && normalized.relationType
    ? normalized
    : null;
}

function toRelationship(
  graph: NormalizedOkfGraph,
  edge: OkfGraphEdge,
  relatedFileId: string,
  direction: "outgoing" | "incoming"
): OkfGraphRelationship | null {
  const node = graph.nodesByFileId.get(relatedFileId);

  if (!node) {
    return null;
  }

  return {
    fileId: node.fileId,
    path: node.path,
    title: node.title,
    relationType: edge.relationType,
    direction,
    weight: edge.weight,
    reason: edge.reason,
    source: edge.source,
    ...(edge.evidence ? { evidence: edge.evidence } : {})
  };
}

function compareEdges(left: OkfGraphEdge, right: OkfGraphEdge): number {
  return (
    right.weight - left.weight ||
    left.fromFileId.localeCompare(right.fromFileId) ||
    left.toFileId.localeCompare(right.toFileId) ||
    left.relationType.localeCompare(right.relationType)
  );
}

function compareRelationships(left: OkfGraphRelationship, right: OkfGraphRelationship): number {
  const leftDirectionScore = left.direction === "outgoing" ? 0 : 1;
  const rightDirectionScore = right.direction === "outgoing" ? 0 : 1;

  return (
    right.weight - left.weight ||
    leftDirectionScore - rightDirectionScore ||
    left.title.localeCompare(right.title) ||
    left.fileId.localeCompare(right.fileId)
  );
}

function positiveIntegerOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function encodeGraphFileId(fileId: string): string {
  return fileId.split("/").map(encodeURIComponent).join("/");
}

function readStrings(values: string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
}

function stringifyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function stringifyJsonLines(values: unknown[]): string {
  return values.map((value) => JSON.stringify(value)).join("\n") + (values.length > 0 ? "\n" : "");
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];

  for (const item of items) {
    const itemKey = key(item);

    if (seen.has(itemKey)) {
      continue;
    }

    seen.add(itemKey);
    unique.push(item);
  }

  return unique;
}

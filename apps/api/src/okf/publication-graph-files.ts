import {
  graphRefForFile,
  pageGraphRefForFile,
  type OkfGraphEdge,
  type OkfGraphLimits,
  type OkfGraphNode,
  type OkfGraphRelationship
} from "@focowiki/okf";
import { attachGraphToPage, type BundleFileKind, type GeneratedOkfFile, type GeneratedPageSummary } from "./publication-files.js";
import { mapWithConcurrency, type CursorPage, type CursorPageRequest } from "../runtime/bounded.js";

export type PublicationPublicFilePlans = {
  bySourceId: Map<string, { publicFileName: string; pagePath: string }>;
  publicPaths: Set<string>;
};

export type PublicationGraphState = {
  available: boolean;
  limits: Required<OkfGraphLimits>;
};

export function resolvePublicationGraphState(input: {
  graph?: OkfGraphLimits | undefined;
  fetchGraphNodePage?: ((request: CursorPageRequest) => Promise<CursorPage<OkfGraphNode>>) | undefined;
  fetchGraphEdgePage?: ((request: CursorPageRequest) => Promise<CursorPage<OkfGraphEdge>>) | undefined;
}): PublicationGraphState {
  return {
    available: Boolean(input.fetchGraphNodePage && input.fetchGraphEdgePage),
    limits: normalizePublicationGraphLimits(input.graph)
  };
}

export function attachPublicationGraphToPage(
  page: GeneratedPageSummary,
  graph: PublicationGraphState,
  publicPaths: Set<string>
): GeneratedPageSummary {
  const attached = attachGraphToPage(page, null, publicPaths);

  if (!graph.available) {
    return attached;
  }

  return {
    ...attached,
    graphRef: graphRefForFile(page.fileId),
    metadata: {
      ...attached.metadata,
      fileId: page.fileId,
      graph: pageGraphRefForFile(page.fileId)
    }
  };
}

export async function writePublicationGraphFiles(input: {
  generatedAt: string;
  pageSize: number;
  concurrency: number;
  plans: PublicationPublicFilePlans;
  graphState: PublicationGraphState;
  fetchGraphNodePage?: ((request: CursorPageRequest) => Promise<CursorPage<OkfGraphNode>>) | undefined;
  fetchGraphEdgePage?: ((request: CursorPageRequest) => Promise<CursorPage<OkfGraphEdge>>) | undefined;
  fetchGraphNeighborhood?:
    | ((request: {
        sourceFileId: string;
        limit: number;
      }) => Promise<{ sourceFileId: string; relationships: OkfGraphRelationship[] }>)
    | undefined;
  writeFiles: (files: GeneratedOkfFile[]) => Promise<void>;
}): Promise<number> {
  if (!input.graphState.available || !input.fetchGraphNodePage || !input.fetchGraphEdgePage) {
    return 0;
  }

  let fileCount = 0;
  let nodeCount = 0;
  let edgeCount = 0;
  let nodeShardIndex = 0;
  let edgeShardIndex = 0;
  const nodeBuffer: string[] = [];
  const nodeShardDescriptors: Array<{ path: string; count: number }> = [];
  const edgeBuffer: OkfGraphEdge[] = [];
  let nodeCursor: string | null = null;

  do {
    const page = await input.fetchGraphNodePage({
      cursor: nodeCursor,
      limit: input.pageSize
    });

    const graphFiles = await mapWithConcurrency(page.items, input.concurrency, async (rawNode) => {
      const node = toPublicGraphNode(rawNode, input.plans);
      return {
        nodeLine: JSON.stringify(node),
        file: createGraphFile({
          logicalPath: graphRefForFile(node.fileId),
          fileKind: "graph_file",
          content: await renderGraphByFile(input, node)
        })
      };
    });

    for (const graphFile of graphFiles) {
      nodeBuffer.push(graphFile.nodeLine);
      fileCount += 1;
      nodeCount += 1;

      if (nodeBuffer.length >= input.graphState.limits.edgeShardSize) {
        const shard = await flushGraphNodeShard({
          index: nodeShardIndex,
          nodeBuffer,
          writeFiles: input.writeFiles
        });
        nodeShardDescriptors.push(shard);
        fileCount += 1;
        nodeShardIndex += 1;
      }
    }
    await input.writeFiles(graphFiles.map((graphFile) => graphFile.file));

    nodeCursor = page.nextCursor;
  } while (nodeCursor);

  if (nodeShardIndex === 0) {
    await input.writeFiles([createGraphFile({
      logicalPath: "_graph/nodes.jsonl",
      fileKind: "graph_node_index",
      content: nodeBuffer.length > 0 ? `${nodeBuffer.join("\n")}\n` : ""
    })]);
  } else {
    if (nodeBuffer.length > 0) {
      const shard = await flushGraphNodeShard({
        index: nodeShardIndex,
        nodeBuffer,
        writeFiles: input.writeFiles
      });
      nodeShardDescriptors.push(shard);
      fileCount += 1;
      nodeShardIndex += 1;
    }

    await input.writeFiles([createGraphFile({
      logicalPath: "_graph/nodes.jsonl",
      fileKind: "graph_node_index",
      content: stringifyJsonLines(
        nodeShardDescriptors.map((shard) => ({
          type: "graph_node_shard",
          path: shard.path,
          count: shard.count
        }))
      )
    })]);
  }
  fileCount += 1;

  let edgeCursor: string | null = null;
  do {
    const page = await input.fetchGraphEdgePage({
      cursor: edgeCursor,
      limit: input.pageSize
    });

    for (const edge of page.items) {
      edgeBuffer.push(edge);
      edgeCount += 1;

      if (edgeBuffer.length >= input.graphState.limits.edgeShardSize) {
        await input.writeFiles([createGraphFile({
          logicalPath: graphEdgeShardPath(edgeShardIndex),
          fileKind: "graph_edge_shard",
          content: stringifyJsonLines(edgeBuffer.splice(0, edgeBuffer.length))
        })]);
        fileCount += 1;
        edgeShardIndex += 1;
      }
    }

    edgeCursor = page.nextCursor;
  } while (edgeCursor);

  if (edgeBuffer.length > 0) {
    await input.writeFiles([createGraphFile({
      logicalPath: graphEdgeShardPath(edgeShardIndex),
      fileKind: "graph_edge_shard",
      content: stringifyJsonLines(edgeBuffer.splice(0, edgeBuffer.length))
    })]);
    fileCount += 1;
    edgeShardIndex += 1;
  }

  await input.writeFiles([
    createGraphFile({
      logicalPath: "_graph/index.md",
      fileKind: "graph_index",
      content: renderGraphIndexMarkdown({
        generatedAt: input.generatedAt,
        nodeCount,
        edgeCount
      })
    }),
    createGraphFile({
      logicalPath: "_graph/manifest.json",
      fileKind: "graph_manifest",
      content: stringifyJson({
        generated_at: input.generatedAt,
        node_count: nodeCount,
        edge_count: edgeCount,
        node_shard_count: nodeShardIndex,
        edge_shard_count: edgeShardIndex,
        node_shard_pattern: "_graph/nodes/{shard}.jsonl",
        by_file_pattern: "_graph/by-file/{fileId}.json",
        edge_shard_pattern: "_graph/edges/{shard}.jsonl"
      })
    })
  ]);

  return fileCount + 2;
}

async function flushGraphNodeShard(input: {
  index: number;
  nodeBuffer: string[];
  writeFiles: (files: GeneratedOkfFile[]) => Promise<void>;
}): Promise<{ path: string; count: number }> {
  const count = input.nodeBuffer.length;
  const path = graphNodeShardPath(input.index);
  await input.writeFiles([createGraphFile({
    logicalPath: path,
    fileKind: "graph_node_index",
    content: input.nodeBuffer.length > 0 ? `${input.nodeBuffer.join("\n")}\n` : ""
  })]);
  input.nodeBuffer.splice(0, input.nodeBuffer.length);
  return { path, count };
}

async function renderGraphByFile(
  input: Parameters<typeof writePublicationGraphFiles>[0],
  node: OkfGraphNode
): Promise<string> {
  const neighborhood = input.fetchGraphNeighborhood
    ? await input.fetchGraphNeighborhood({
        sourceFileId: node.fileId,
        limit: input.graphState.limits.perFileLimit
      })
    : { sourceFileId: node.fileId, relationships: [] };

  return stringifyJson({
    fileId: node.fileId,
    path: node.path,
    title: node.title,
    generatedAt: input.generatedAt,
    relationships: neighborhood.relationships.map((relationship) =>
      toPublicGraphRelationship(relationship, input.plans)
    )
  });
}

function createGraphFile(input: {
  logicalPath: string;
  fileKind: BundleFileKind;
  content: string;
}): GeneratedOkfFile {
  return {
    logicalPath: input.logicalPath,
    sourceFileId: null,
    fileKind: input.fileKind,
    content: input.content,
    metadata: null
  };
}

function normalizePublicationGraphLimits(
  limits: OkfGraphLimits | undefined
): Required<OkfGraphLimits> {
  return {
    pageRelatedLimit: normalizePositiveInteger(limits?.pageRelatedLimit, 10),
    perFileLimit: normalizePositiveInteger(limits?.perFileLimit, 50),
    edgeShardSize: normalizePositiveInteger(limits?.edgeShardSize, 1_000)
  };
}

function toPublicGraphNode(node: OkfGraphNode, plans: PublicationPublicFilePlans): OkfGraphNode {
  const plan = plans.bySourceId.get(node.fileId);
  return {
    ...node,
    ...(plan ? { path: plan.pagePath } : {})
  };
}

function toPublicGraphRelationship(
  relationship: OkfGraphRelationship,
  plans: PublicationPublicFilePlans
): OkfGraphRelationship {
  const plan = plans.bySourceId.get(relationship.fileId);
  return {
    ...relationship,
    ...(plan ? { path: plan.pagePath } : {})
  };
}

function renderGraphIndexMarkdown(input: {
  generatedAt: string;
  nodeCount: number;
  edgeCount: number;
}): string {
  return [
    "---",
    'type: "graph-index"',
    'title: "File graph"',
    `generatedAt: ${JSON.stringify(input.generatedAt)}`,
    "---",
    "# File graph",
    "",
    "This directory contains file-first relationship data for Agent navigation.",
    "",
    `- Nodes: ${input.nodeCount}`,
    `- Edges: ${input.edgeCount}`,
    "- Node index: `_graph/nodes.jsonl`",
    "- Per-file relationships: `_graph/by-file/{fileId}.json`"
  ].join("\n");
}

function graphNodeShardPath(index: number): string {
  return `_graph/nodes/${String(index).padStart(4, "0")}.jsonl`;
}

function graphEdgeShardPath(index: number): string {
  return `_graph/edges/${String(index).padStart(4, "0")}.jsonl`;
}

function stringifyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function stringifyJsonLines(values: unknown[]): string {
  return values.length > 0 ? `${values.map((value) => JSON.stringify(value)).join("\n")}\n` : "";
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

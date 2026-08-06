import { createHash } from "node:crypto";
import { generatedPagePath } from "../../domain/source-path.js";
import type {
  StorageVnextGraphEdgeFact,
  StorageVnextGraphNodeFact,
  StorageVnextGraphReadPort
} from "./ports.js";

export type StorageVnextGraphCatalogRecord =
  | {
      kind: "node";
      publicId: string;
      logicalPath: string;
      sourceFilePublicId: string;
      label: string;
    }
  | {
      kind: "edge";
      publicId: string;
      fromNodePublicId: string;
      toNodePublicId: string;
      relation: string;
      weight: number;
      reason: string | null;
    };

export type StorageVnextGraphSeedDocument = {
  publicId: string;
  knowledgeBaseId: string;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  logicalPath: string;
  title: string;
  searchText: string;
};

export type StorageVnextGraphSeedHit = {
  document: StorageVnextGraphSeedDocument;
  score: number;
};

export type StorageVnextHydratedGraphSeed = {
  publicId: string;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  logicalPath: string;
  title: string;
  score: number;
};

type CurrentFileHydration = {
  publicId: string;
  knowledgeBaseId: string;
  logicalPath: string;
  title: string;
  currentRevisionPublicId: string | null;
};

export async function readStorageVnextGraphCatalogPage(input: {
  graph: Pick<StorageVnextGraphReadPort, "listNodes" | "listEdges">;
  knowledgeBaseId: string;
  kind: "node" | "edge";
  limit: number;
  cursor: string | null;
}): Promise<{
  items: StorageVnextGraphCatalogRecord[];
  nextCursor: string | null;
}> {
  assertLimit(input.limit, "Graph catalog page");
  if (input.kind === "node") {
    const page = await input.graph.listNodes({
      knowledgeBaseId: input.knowledgeBaseId,
      limit: input.limit,
      cursor: input.cursor
    });
    return {
      items: page.items.map(mapCatalogNode),
      nextCursor: page.nextCursor
    };
  }
  const page = await input.graph.listEdges({
    knowledgeBaseId: input.knowledgeBaseId,
    limit: input.limit,
    cursor: input.cursor
  });
  return {
    items: page.items.map(mapCatalogEdge),
    nextCursor: page.nextCursor
  };
}

export function mapStorageVnextGraphSeedDocument(
  node: StorageVnextGraphNodeFact
): StorageVnextGraphSeedDocument {
  return {
    publicId: `graph-seed:${createHash("sha256")
      .update([
        "graph-seed-vnext-v1",
        node.knowledgeBaseId,
        node.sourceFilePublicId,
        node.sourceRevisionPublicId
      ].join("\u0000"))
      .digest("hex")}`,
    knowledgeBaseId: node.knowledgeBaseId,
    sourceFilePublicId: node.sourceFilePublicId,
    sourceRevisionPublicId: node.sourceRevisionPublicId,
    logicalPath: node.logicalPath,
    title: node.label,
    searchText: stableSearchText([node.label, node.kind])
  };
}

export async function hydrateStorageVnextGraphSeedHits(input: {
  knowledgeBaseId: string;
  hits: readonly StorageVnextGraphSeedHit[];
  limit: number;
  loadCurrentFiles: (
    sourceFilePublicIds: string[],
    limit: number
  ) => Promise<CurrentFileHydration[]>;
}): Promise<StorageVnextHydratedGraphSeed[]> {
  assertLimit(input.limit, "Graph seed hydration");
  const hits = deduplicateHits(input.hits).slice(0, input.limit);
  if (hits.length === 0) return [];
  const files = await input.loadCurrentFiles(
    hits.map((hit) => hit.document.sourceFilePublicId),
    input.limit
  );
  const byPublicId = new Map(files.map((file) => [file.publicId, file]));
  return hits.flatMap((hit) => {
    const document = hit.document;
    const file = byPublicId.get(document.sourceFilePublicId);
    if (
      !file
      || file.knowledgeBaseId !== input.knowledgeBaseId
      || file.currentRevisionPublicId !== document.sourceRevisionPublicId
      || generatedPagePath(file.logicalPath) !== document.logicalPath
      || !Number.isFinite(hit.score)
    ) {
      return [];
    }
    return [{
      publicId: document.publicId,
      sourceFilePublicId: document.sourceFilePublicId,
      sourceRevisionPublicId: document.sourceRevisionPublicId,
      logicalPath: document.logicalPath,
      title: document.title,
      score: hit.score
    }];
  });
}

function mapCatalogNode(node: StorageVnextGraphNodeFact): StorageVnextGraphCatalogRecord {
  return {
    kind: "node",
    publicId: node.publicId,
    logicalPath: node.logicalPath,
    sourceFilePublicId: node.sourceFilePublicId,
    label: node.label
  };
}

function mapCatalogEdge(edge: StorageVnextGraphEdgeFact): StorageVnextGraphCatalogRecord {
  return {
    kind: "edge",
    publicId: edge.publicId,
    fromNodePublicId: edge.fromNodePublicId,
    toNodePublicId: edge.toNodePublicId,
    relation: edge.relation,
    weight: edge.weight,
    reason: edge.reason
  };
}

function deduplicateHits(
  hits: readonly StorageVnextGraphSeedHit[]
): StorageVnextGraphSeedHit[] {
  const seen = new Set<string>();
  const output: StorageVnextGraphSeedHit[] = [];
  for (const hit of hits) {
    if (seen.has(hit.document.sourceFilePublicId)) continue;
    seen.add(hit.document.sourceFilePublicId);
    output.push(hit);
    if (output.length >= 1_000) break;
  }
  return output;
}

function stableSearchText(values: string[]): string {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
    .join(" ");
}

function assertLimit(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new Error(`${label} limit must be between 1 and 1000`);
  }
}

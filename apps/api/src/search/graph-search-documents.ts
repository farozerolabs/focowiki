import type { FileGraphRelatedRecord } from "../db/admin-repositories.js";
import { normalizeGeneratedFileSearchQuery } from "./generated-file-search-documents.js";

export type GraphSearchMode = "file" | "graph" | "hybrid";
export type GraphSearchDepth = 0 | 1 | 2;
export type GraphSearchMatchType = "file_direct" | "graph_node" | "graph_edge" | "graph_neighbor" | "hybrid";

export type GraphSearchContext = {
  graphRef: string;
  depth: GraphSearchDepth;
  seedSourceFileId: string;
  matchedNodeFields: string[];
  matchedRelationshipFields: string[];
  relationships: FileGraphRelatedRecord[];
  graphPaths: string[];
};

export type GraphSearchSummary = {
  available: boolean;
  indexedDocumentCount: number;
  indexedRelationshipCount: number;
  depth: GraphSearchDepth;
  fanout: number;
};

export const GRAPH_SEARCH_DEFAULT_DEPTH: GraphSearchDepth = 1;
export const GRAPH_SEARCH_MAX_DEPTH: GraphSearchDepth = 2;
export const GRAPH_SEARCH_DEFAULT_FANOUT = 10;
export const GRAPH_SEARCH_MAX_FANOUT = 25;

export function normalizeGraphSearchQuery(value: string): string {
  return normalizeGeneratedFileSearchQuery(value);
}

export function graphRefForSourceFile(sourceFileId: string): string {
  return `_graph/by-file/${sourceFileId}.json`;
}

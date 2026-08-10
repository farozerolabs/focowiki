import {
  GRAPH_SEARCH_DEFAULT_DEPTH,
  GRAPH_SEARCH_DEFAULT_FANOUT,
  GRAPH_SEARCH_MAX_DEPTH,
  GRAPH_SEARCH_MAX_FANOUT,
  type GraphSearchDepth
} from "../search/graph-search-documents.js";
import type { RuntimeGraphSettings } from "../runtime-settings/types.js";
import { normalizeAndValidateSearchQuery } from "./search-query-contract.js";

export const DEVELOPER_GRAPH_EXPANSION_ERROR_CODES = [
  "GRAPH_EXPANSION_SEED_REQUIRED",
  "GRAPH_EXPANSION_SEED_CONFLICT",
  "GRAPH_EXPANSION_QUERY_TOO_SHORT",
  "GRAPH_EXPANSION_QUERY_TOO_LONG",
  "INVALID_GRAPH_EXPANSION_QUERY",
  "INVALID_GRAPH_EXPANSION_DEPTH",
  "INVALID_GRAPH_EXPANSION_FANOUT"
] as const;

export type DeveloperGraphExpansionErrorCode =
  (typeof DEVELOPER_GRAPH_EXPANSION_ERROR_CODES)[number];

export type DeveloperGraphExpansionFilterResult =
  | {
      ok: true;
      fileId: string | null;
      nodeId: string | null;
      edgeId: string | null;
      query: string | null;
      depth: GraphSearchDepth;
      fanout: number;
    }
  | { ok: false; code: DeveloperGraphExpansionErrorCode };

export function readDeveloperGraphExpansionFilters(input: {
  fileId?: string | undefined;
  nodeId?: string | undefined;
  edgeId?: string | undefined;
  query?: string | undefined;
  depth?: string | undefined;
  fanout?: string | undefined;
  graphSettings?: RuntimeGraphSettings | undefined;
}): DeveloperGraphExpansionFilterResult {
  const fileId = input.fileId?.trim() || null;
  const nodeId = input.nodeId?.trim() || null;
  const edgeId = input.edgeId?.trim() || null;
  const rawQuery = input.query;
  const queryResult = rawQuery === undefined || rawQuery.trim() === ""
    ? null
    : normalizeAndValidateSearchQuery(rawQuery);
  const query = queryResult === null || !queryResult.ok ? null : queryResult.value;
  const seedCount = [fileId, nodeId, edgeId, query].filter(Boolean).length;

  if (seedCount === 0) {
    return { ok: false, code: "GRAPH_EXPANSION_SEED_REQUIRED" };
  }

  if (seedCount > 1) {
    return { ok: false, code: "GRAPH_EXPANSION_SEED_CONFLICT" };
  }

  if (queryResult && !queryResult.ok) return {
    ok: false,
    code: queryResult.error === "too_short"
      ? "GRAPH_EXPANSION_QUERY_TOO_SHORT"
      : queryResult.error === "too_long"
        ? "GRAPH_EXPANSION_QUERY_TOO_LONG"
        : "INVALID_GRAPH_EXPANSION_QUERY"
  };

  const depth = readGraphDepth(input.depth, input.graphSettings);

  if (depth === null) {
    return { ok: false, code: "INVALID_GRAPH_EXPANSION_DEPTH" };
  }

  const fanout = readGraphFanout(input.fanout, input.graphSettings);

  if (fanout === null) {
    return { ok: false, code: "INVALID_GRAPH_EXPANSION_FANOUT" };
  }

  return {
    ok: true,
    fileId,
    nodeId,
    edgeId,
    query,
    depth,
    fanout
  };
}

function readGraphDepth(
  value: string | undefined,
  graphSettings: RuntimeGraphSettings | undefined
): GraphSearchDepth | null {
  if (value === undefined || value.trim() === "") {
    return graphSettings?.searchDefaultDepth ?? GRAPH_SEARCH_DEFAULT_DEPTH;
  }

  const parsed = Number(value);
  const maxDepth = graphSettings?.searchMaxDepth ?? GRAPH_SEARCH_MAX_DEPTH;

  if (!Number.isInteger(parsed) || parsed < 0 || parsed > maxDepth) {
    return null;
  }

  return parsed as GraphSearchDepth;
}

function readGraphFanout(
  value: string | undefined,
  graphSettings: RuntimeGraphSettings | undefined
): number | null {
  if (value === undefined || value.trim() === "") {
    return graphSettings?.searchDefaultFanout ?? GRAPH_SEARCH_DEFAULT_FANOUT;
  }

  const parsed = Number(value);
  const maxFanout = graphSettings?.searchMaxFanout ?? GRAPH_SEARCH_MAX_FANOUT;

  if (!Number.isInteger(parsed) || parsed < 0 || parsed > maxFanout) {
    return null;
  }

  return parsed;
}

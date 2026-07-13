import type { BundleFileKind } from "../db/admin-repositories.js";
import type { GeneratedFileSearchScope } from "../search/generated-file-search-documents.js";
import {
  GRAPH_SEARCH_DEFAULT_DEPTH,
  GRAPH_SEARCH_DEFAULT_FANOUT,
  GRAPH_SEARCH_MAX_DEPTH,
  GRAPH_SEARCH_MAX_FANOUT,
  type GraphSearchDepth,
  type GraphSearchMode
} from "../search/graph-search-documents.js";
import type { RuntimeGraphSettings } from "../runtime-settings/types.js";

export type DeveloperFileSearchErrorCode =
  | "FILE_SEARCH_QUERY_REQUIRED"
  | "FILE_SEARCH_QUERY_TOO_SHORT"
  | "FILE_SEARCH_QUERY_TOO_LONG"
  | "INVALID_FILE_SEARCH_QUERY"
  | "INVALID_FILE_SEARCH_SCOPE"
  | "INVALID_FILE_SEARCH_KIND"
  | "INVALID_FILE_SEARCH_MODE"
  | "INVALID_FILE_SEARCH_GRAPH_DEPTH"
  | "INVALID_FILE_SEARCH_GRAPH_FANOUT";

export type DeveloperFileSearchFilterResult =
  | {
      ok: true;
      query: string;
      scope: GeneratedFileSearchScope;
      fileKind: BundleFileKind | null;
      mode: GraphSearchMode;
      graphDepth: GraphSearchDepth;
      graphFanout: number;
    }
  | { ok: false; code: DeveloperFileSearchErrorCode };

const SEARCH_QUERY_MIN_LENGTH = 2;
const SEARCH_QUERY_MAX_LENGTH = 160;
const SEARCH_SCOPES = new Set<GeneratedFileSearchScope>(["all", "path", "metadata"]);
const SEARCH_MODES = new Set<GraphSearchMode>(["file", "graph", "hybrid"]);
const SEARCH_FILE_KINDS = new Set<BundleFileKind | "all">([
  "all",
  "page",
  "index",
  "log",
  "history_page",
  "schema",
  "manifest_index",
  "manifest_index_shard",
  "search_index",
  "search_index_shard",
  "link_index",
  "link_index_shard",
  "change_index",
  "change_index_shard",
  "graph_index",
  "graph_manifest",
  "graph_node_index",
  "graph_edge_shard",
  "graph_file",
  "graph_community",
  "graph_insight"
]);

export function readDeveloperFileSearchFilters(input: {
  query: string | undefined;
  scope: string | undefined;
  fileKind: string | undefined;
  mode?: string | undefined;
  graphDepth?: string | undefined;
  graphFanout?: string | undefined;
  graphSettings?: RuntimeGraphSettings | undefined;
}): DeveloperFileSearchFilterResult {
  const query = input.query?.trim() ?? "";

  if (!query) {
    return { ok: false, code: "FILE_SEARCH_QUERY_REQUIRED" };
  }

  if (query.length < SEARCH_QUERY_MIN_LENGTH) {
    return { ok: false, code: "FILE_SEARCH_QUERY_TOO_SHORT" };
  }

  if (query.length > SEARCH_QUERY_MAX_LENGTH) {
    return { ok: false, code: "FILE_SEARCH_QUERY_TOO_LONG" };
  }

  if (containsUnsafeControlCharacter(query)) {
    return { ok: false, code: "INVALID_FILE_SEARCH_QUERY" };
  }

  const scope = input.scope?.trim() || "all";

  if (!SEARCH_SCOPES.has(scope as GeneratedFileSearchScope)) {
    return { ok: false, code: "INVALID_FILE_SEARCH_SCOPE" };
  }

  const fileKind = input.fileKind?.trim() || "page";

  if (!SEARCH_FILE_KINDS.has(fileKind as BundleFileKind | "all")) {
    return { ok: false, code: "INVALID_FILE_SEARCH_KIND" };
  }

  const mode = input.mode?.trim() || "file";

  if (!SEARCH_MODES.has(mode as GraphSearchMode)) {
    return { ok: false, code: "INVALID_FILE_SEARCH_MODE" };
  }

  const graphDepth = readGraphDepth(input.graphDepth, input.graphSettings);

  if (graphDepth === null) {
    return { ok: false, code: "INVALID_FILE_SEARCH_GRAPH_DEPTH" };
  }

  const graphFanout = readGraphFanout(input.graphFanout, input.graphSettings);

  if (graphFanout === null) {
    return { ok: false, code: "INVALID_FILE_SEARCH_GRAPH_FANOUT" };
  }

  return {
    ok: true,
    query,
    scope: scope as GeneratedFileSearchScope,
    fileKind: fileKind === "all" ? null : (fileKind as BundleFileKind),
    mode: mode as GraphSearchMode,
    graphDepth,
    graphFanout
  };
}

function containsUnsafeControlCharacter(value: string): boolean {
  return /[\u0000-\u001F\u007F]/u.test(value);
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

import type { BundleFileKind } from "../db/admin-repositories.js";
import type { GeneratedFileSearchScope } from "../search/generated-file-search-documents.js";

export type DeveloperFileSearchErrorCode =
  | "FILE_SEARCH_QUERY_REQUIRED"
  | "FILE_SEARCH_QUERY_TOO_SHORT"
  | "FILE_SEARCH_QUERY_TOO_LONG"
  | "INVALID_FILE_SEARCH_QUERY"
  | "INVALID_FILE_SEARCH_SCOPE"
  | "INVALID_FILE_SEARCH_KIND";

export type DeveloperFileSearchFilterResult =
  | {
      ok: true;
      query: string;
      scope: GeneratedFileSearchScope;
      fileKind: BundleFileKind | null;
    }
  | { ok: false; code: DeveloperFileSearchErrorCode };

const SEARCH_QUERY_MIN_LENGTH = 2;
const SEARCH_QUERY_MAX_LENGTH = 160;
const SEARCH_SCOPES = new Set<GeneratedFileSearchScope>(["all", "path", "metadata"]);
const SEARCH_FILE_KINDS = new Set<BundleFileKind | "all">([
  "all",
  "page",
  "index",
  "log",
  "schema",
  "manifest_index",
  "manifest_index_shard",
  "search_index",
  "search_index_shard",
  "link_index",
  "link_index_shard",
  "graph_index",
  "graph_manifest",
  "graph_node_index",
  "graph_edge_shard",
  "graph_file"
]);

export function readDeveloperFileSearchFilters(input: {
  query: string | undefined;
  scope: string | undefined;
  fileKind: string | undefined;
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

  return {
    ok: true,
    query,
    scope: scope as GeneratedFileSearchScope,
    fileKind: fileKind === "all" ? null : (fileKind as BundleFileKind)
  };
}

function containsUnsafeControlCharacter(value: string): boolean {
  return /[\u0000-\u001F\u007F]/u.test(value);
}

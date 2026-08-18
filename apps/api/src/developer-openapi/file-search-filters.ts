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
import {
  normalizeOkfSearchFilters,
  type OkfSearchFilters
} from "../storage-vnext/search/okf-signals.js";
import {
  normalizeAndValidateSearchQuery,
  parseSearchRequestControls
} from "./search-query-contract.js";

export const DEVELOPER_FILE_SEARCH_ERROR_CODES = [
  "FILE_SEARCH_QUERY_REQUIRED",
  "FILE_SEARCH_QUERY_TOO_SHORT",
  "FILE_SEARCH_QUERY_TOO_LONG",
  "INVALID_FILE_SEARCH_QUERY",
  "INVALID_FILE_SEARCH_SCOPE",
  "INVALID_FILE_SEARCH_KIND",
  "INVALID_FILE_SEARCH_MODE",
  "INVALID_FILE_SEARCH_GRAPH_DEPTH",
  "INVALID_FILE_SEARCH_GRAPH_FANOUT",
  "INVALID_FILE_SEARCH_OKF_STATUS",
  "INVALID_FILE_SEARCH_OKF_TRUST_TIER",
  "INVALID_FILE_SEARCH_OKF_FRESHNESS",
  "INVALID_FILE_SEARCH_LIMIT",
  "INVALID_FILE_SEARCH_RERANK_CONTROLS"
] as const;

export type DeveloperFileSearchErrorCode =
  (typeof DEVELOPER_FILE_SEARCH_ERROR_CODES)[number];

export type DeveloperFileSearchFilterResult =
  | {
      ok: true;
      query: string;
      scope: GeneratedFileSearchScope;
      fileKind: "page" | null;
      mode: GraphSearchMode;
      graphDepth: GraphSearchDepth;
      graphFanout: number;
      okfFilters: OkfSearchFilters;
      limit: number;
      rerank: boolean;
      rerankTopK: number | null;
      rerankScoreThreshold: number | null;
    }
  | { ok: false; code: DeveloperFileSearchErrorCode };

const SEARCH_SCOPES = new Set<GeneratedFileSearchScope>(["all", "path", "metadata"]);
const SEARCH_MODES = new Set<GraphSearchMode>(["file", "graph", "hybrid"]);
const OKF_STATUSES = new Set(["draft", "stable", "deprecated"]);
const OKF_TRUST_TIERS = new Set([
  "unverified", "machine-confirmed", "human-reviewed"
]);
const OKF_FRESHNESS_VALUES = new Set(["fresh", "stale"]);
const SEARCH_FILE_KINDS = new Set(["all", "page"]);

export function readDeveloperFileSearchFilters(input: {
  query: string | undefined;
  scope: string | undefined;
  fileKind: string | undefined;
  mode?: string | undefined;
  graphDepth?: string | undefined;
  graphFanout?: string | undefined;
  graphSettings?: RuntimeGraphSettings | undefined;
  okfStatus?: string | undefined;
  okfTrustTier?: string | undefined;
  okfFreshness?: string | undefined;
  requestDate?: string | undefined;
  limit?: string | undefined;
  rerank?: string | undefined;
  rerankTopK?: string | undefined;
  rerankScoreThreshold?: string | undefined;
}): DeveloperFileSearchFilterResult {
  const queryResult = normalizeAndValidateSearchQuery(input.query);
  if (!queryResult.ok) return { ok: false, code: queryErrorCode(queryResult.error) };
  const query = queryResult.value;

  const scope = input.scope?.trim() || "all";

  if (!SEARCH_SCOPES.has(scope as GeneratedFileSearchScope)) {
    return { ok: false, code: "INVALID_FILE_SEARCH_SCOPE" };
  }

  const fileKind = input.fileKind?.trim() || "page";

  if (!SEARCH_FILE_KINDS.has(fileKind)) {
    return { ok: false, code: "INVALID_FILE_SEARCH_KIND" };
  }

  const mode = input.mode?.trim() || "hybrid";

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

  const okfStatus = optionalValue(input.okfStatus);
  if (okfStatus !== null && !OKF_STATUSES.has(okfStatus)) {
    return { ok: false, code: "INVALID_FILE_SEARCH_OKF_STATUS" };
  }
  const okfTrustTier = optionalValue(input.okfTrustTier);
  if (okfTrustTier !== null && !OKF_TRUST_TIERS.has(okfTrustTier)) {
    return { ok: false, code: "INVALID_FILE_SEARCH_OKF_TRUST_TIER" };
  }
  const okfFreshness = optionalValue(input.okfFreshness);
  if (okfFreshness !== null && !OKF_FRESHNESS_VALUES.has(okfFreshness)) {
    return { ok: false, code: "INVALID_FILE_SEARCH_OKF_FRESHNESS" };
  }
  let okfFilters: OkfSearchFilters;
  try {
    okfFilters = normalizeOkfSearchFilters({
      okfStatus,
      okfTrustTier,
      okfFreshness,
      requestDate: input.requestDate ?? currentUtcDate()
    });
  } catch {
    return { ok: false, code: "INVALID_FILE_SEARCH_OKF_FRESHNESS" };
  }

  const requestControls = parseSearchRequestControls(input);
  if (!requestControls.ok) return {
    ok: false,
    code: requestControls.error === "invalid_limit"
      ? "INVALID_FILE_SEARCH_LIMIT"
      : "INVALID_FILE_SEARCH_RERANK_CONTROLS"
  };

  return {
    ok: true,
    query,
    scope: scope as GeneratedFileSearchScope,
    fileKind: fileKind === "all" ? null : "page",
    mode: mode as GraphSearchMode,
    graphDepth,
    graphFanout,
    okfFilters,
    ...requestControls.value
  };
}

function optionalValue(value: string | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}

function currentUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function queryErrorCode(
  error: "required" | "too_short" | "too_long" | "unsafe_control"
): DeveloperFileSearchErrorCode {
  if (error === "required") return "FILE_SEARCH_QUERY_REQUIRED";
  if (error === "too_short") return "FILE_SEARCH_QUERY_TOO_SHORT";
  if (error === "too_long") return "FILE_SEARCH_QUERY_TOO_LONG";
  return "INVALID_FILE_SEARCH_QUERY";
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

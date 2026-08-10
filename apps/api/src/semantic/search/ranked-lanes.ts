import type {
  SearchProviderQueryPort,
  SearchProviderQueryRequest
} from "../../application/ports/search-provider-runtime.js";
import {
  STORAGE_VNEXT_CONTENT_SCHEMA_VERSION,
  STORAGE_VNEXT_GRAPH_SEED_SCHEMA_VERSION
} from "../../storage-vnext/search/documents.js";
import type {
  SemanticLaneCandidate,
  SemanticRankedLane
} from "./orchestrator.js";
import type { OkfSearchFilters } from
  "../../storage-vnext/search/okf-signals.js";

const ALL_FIELDS = ["title", "logicalPath", "searchText", "rankingTerms"];

export function createSemanticRankedLaneAdapter(input: {
  query: SearchProviderQueryPort;
}) {
  return {
    async run(request: {
      lane: SemanticRankedLane;
      indexUid: string;
      knowledgeBaseId: string;
      query: string;
      scope?: "all" | "path" | "metadata";
      fileKind?: string | null;
      okfFilters?: OkfSearchFilters;
      limit: number;
      deadlineMs: number;
      signal: AbortSignal;
    }): Promise<readonly SemanticLaneCandidate[]> {
      if (request.signal.aborted) throw request.signal.reason;
      const normalizedRequest = {
        ...request,
        scope: request.scope ?? "all" as const,
        fileKind: request.fileKind === undefined ? "page" : request.fileKind,
        okfFilters: request.okfFilters ?? {
          status: null,
          trustTier: null,
          freshness: null,
          requestEpochDay: null
        }
      };
      const branch = laneDefinition(request.lane, normalizedRequest.scope);
      const response = await input.query.query({
        indexUid: request.indexUid,
        query: request.query,
        evidenceFamilies: branch.evidenceFamilies,
        filters: createFilters(normalizedRequest, branch),
        limit: request.limit,
        continuation: null,
        searchFields: branch.searchFields,
        returnFields: [
          "documentKind", "schemaVersion", "sourceFilePublicId",
          "sourceRevisionPublicId", "logicalPath", "title", "searchText"
        ],
        cropLength: 1_200,
        deadlineMs: request.deadlineMs,
        matchingStrategy: branch.matchingStrategy,
        distinctBy: "sourceFilePublicId"
      } satisfies SearchProviderQueryRequest);
      if (request.signal.aborted) throw request.signal.reason;
      const normalizedQuery = normalize(request.query);
      return response.hits.flatMap((hit) => {
        const title = readString(hit.document, "title");
        const path = readString(hit.document, "logicalPath") ?? hit.logicalPath;
        if (request.lane === "exact_path" && normalize(path) !== normalizedQuery) {
          return [];
        }
        if (
          request.lane === "exact_title"
          && normalize(title ?? "") !== normalizedQuery
        ) return [];
        return [{
          sourceFilePublicId: hit.sourceFilePublicId,
          sourceRevisionPublicId: hit.sourceRevisionPublicId,
          evidenceTargetPath: hit.logicalPath,
          rank: 0,
          normalizedScore: hit.normalizedScore,
          bodyGrounded: true,
          snippet: hit.snippets[0] ?? null
        }];
      }).map((candidate, index) => ({ ...candidate, rank: index + 1 }));
    }
  };
}

function laneDefinition(
  lane: SemanticRankedLane,
  scope: "all" | "path" | "metadata"
): {
  documentKind: "content" | "graph_seed";
  schemaVersion: string;
  searchFields: readonly string[];
  evidenceFamilies: SearchProviderQueryRequest["evidenceFamilies"];
  matchingStrategy: "all" | "last";
} {
  if (lane === "exact_path") return {
    documentKind: "content",
    schemaVersion: STORAGE_VNEXT_CONTENT_SCHEMA_VERSION,
    searchFields: ["logicalPath"],
    evidenceFamilies: ["exact"],
    matchingStrategy: "all"
  };
  if (lane === "exact_title") return {
    documentKind: "content",
    schemaVersion: STORAGE_VNEXT_CONTENT_SCHEMA_VERSION,
    searchFields: ["title"],
    evidenceFamilies: ["exact"],
    matchingStrategy: "all"
  };
  if (lane === "jieba") return {
    documentKind: "content",
    schemaVersion: STORAGE_VNEXT_CONTENT_SCHEMA_VERSION,
    searchFields: ["searchText", "rankingTerms"],
    evidenceFamilies: ["jieba"],
    matchingStrategy: "all"
  };
  return {
    documentKind: lane === "file_graph" ? "graph_seed" : "content",
    schemaVersion: lane === "file_graph"
      ? STORAGE_VNEXT_GRAPH_SEED_SCHEMA_VERSION
      : STORAGE_VNEXT_CONTENT_SCHEMA_VERSION,
    searchFields: scope === "metadata"
      ? ["title", "logicalPath", "searchText"]
      : ALL_FIELDS,
    evidenceFamilies: lane === "file_graph"
      ? ["graph"] : ["text", "phrase", "typo"],
    matchingStrategy: "last"
  };
}

function createFilters(
  request: {
    knowledgeBaseId: string;
    scope: "all" | "path" | "metadata";
    fileKind: string | null;
    okfFilters: OkfSearchFilters;
  },
  branch: ReturnType<typeof laneDefinition>
): SearchProviderQueryRequest["filters"] {
  const operands: SearchProviderQueryRequest["filters"][] = [
    { kind: "equals", field: "knowledgeBaseId", value: request.knowledgeBaseId },
    { kind: "equals", field: "documentKind", value: branch.documentKind },
    { kind: "equals", field: "schemaVersion", value: branch.schemaVersion }
  ];
  if (request.scope === "metadata") operands.push({
    kind: "equals",
    field: "contentKind",
    value: "file"
  });
  if (request.fileKind !== null) operands.push({
    kind: "equals",
    field: "fileKind",
    value: request.fileKind
  });
  if (request.okfFilters.status !== null) operands.push({
    kind: "equals",
    field: "okfSignals.status",
    value: request.okfFilters.status
  });
  if (request.okfFilters.trustTier !== null) operands.push({
    kind: "equals",
    field: "okfSignals.trustTier",
    value: request.okfFilters.trustTier
  });
  if (
    request.okfFilters.freshness !== null
    && request.okfFilters.requestEpochDay !== null
  ) operands.push({
    kind: "range",
    field: "okfSignals.staleAfterEpochDay",
    operator: request.okfFilters.freshness === "stale" ? "lte" : "gt",
    value: request.okfFilters.requestEpochDay
  });
  return { kind: "and", operands };
}

function normalize(value: string): string {
  return value.trim().normalize("NFKC").replace(/\s+/gu, " ")
    .toLocaleLowerCase("en-US");
}

function readString(value: Readonly<Record<string, unknown>>, key: string) {
  return typeof value[key] === "string" ? value[key] as string : null;
}

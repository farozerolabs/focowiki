import type {
  SearchEngineSearchRequest,
  SearchEngineSearchResult,
  SearchEngineTransport
} from "../application/ports/search-engine-transport.js";
import {
  SEARCH_CONTENT_SCHEMA_VERSION
} from "./content-segment-mapper.js";
import {
  SEARCH_GRAPH_SEED_SCHEMA_VERSION
} from "./graph-seed-mapper.js";
import {
  createStableSearchIndexUid
} from "./index-definitions.js";
import {
  fuseSearchCandidates,
  type SearchFusionCursor
} from "./rank-fusion.js";
import type {
  RankedSearchFamily
} from "./ranked-search-candidate.js";

const MAX_QUERY_BYTES = 512;
export const SEARCH_RETRIEVAL_VERSION = "meilisearch-retrieval-v1";

const CONTENT_ATTRIBUTES = [
  "sourceFileId",
  "sourceRevisionId",
  "logicalPath",
  "fileKind",
  "title",
  "headingPath",
  "body",
  "sourceUrl",
  "schemaVersion"
];

const GRAPH_ATTRIBUTES = [
  "sourceFileId",
  "sourceRevisionId",
  "logicalPath",
  "title",
  "sourceUrl",
  "schemaVersion"
];

export type SearchRetrievalCandidate = {
  sourceFileId: string;
  sourceRevisionId: string;
  logicalPath: string;
  title: string | null;
  summary: string | null;
  sourceUrl: string | null;
  exactPriority: number;
  fusedScore: number;
  families: readonly (RankedSearchFamily | "graph")[];
  relationshipReasons: readonly string[];
};

export type SearchRetrievalPage = {
  items: SearchRetrievalCandidate[];
  nextCursor: SearchFusionCursor | null;
};

export type GraphSeedCandidate = {
  sourceFileId: string;
  sourceRevisionId: string;
  familyRank: number;
};

export type SearchRetrieval = {
  searchContent(input: {
    knowledgeBaseId: string;
    activeEpoch: number;
    query: string;
    scope?: "all" | "path" | "metadata";
    fileKind?: string | null;
    limit: number;
    cursor: SearchFusionCursor | null;
  }): Promise<SearchRetrievalPage>;
  searchGraphSeeds(input: {
    knowledgeBaseId: string;
    activeEpoch: number;
    query: string;
    scope?: "all" | "path" | "metadata";
    fileKind?: string | null;
    limit: number;
    cursor: SearchFusionCursor | null;
  }): Promise<SearchRetrievalPage>;
};

export class SearchRetrievalInputError extends Error {
  public readonly code = "INVALID_SEARCH_QUERY";

  public constructor(message: string) {
    super(message);
    this.name = "SearchRetrievalInputError";
  }
}

export type SearchRetrievalSettings = {
  branchCandidateLimit: number;
  fusedCandidateLimit: number;
  cropLength: number;
};

export function createSearchRetrieval(input: {
  transport: SearchEngineTransport;
  indexPrefix: string;
  branchCandidateLimit?: number;
  fusedCandidateLimit?: number;
  cropLength?: number;
  getSettings?: () => Promise<SearchRetrievalSettings>;
}): SearchRetrieval {
  if (!input.getSettings) {
    validateSettings(readStaticSettings(input));
  }

  return {
    async searchContent(searchInput) {
      assertPositiveBound(searchInput.limit, "Search page limit");
      assertEpoch(searchInput.activeEpoch);
      const settings = await readSettings(input);
      const query = normalizePlainQuery(searchInput.query);
      const scope = searchInput.scope ?? "all";
      const indexUid = createStableSearchIndexUid({
        indexPrefix: input.indexPrefix,
        knowledgeBaseId: searchInput.knowledgeBaseId,
        kind: "content"
      });
      const filter = createVisibilityFilter({
        knowledgeBaseId: searchInput.knowledgeBaseId,
        activeEpoch: searchInput.activeEpoch,
        schemaVersion: SEARCH_CONTENT_SCHEMA_VERSION,
        ...(searchInput.fileKind === undefined
          ? {}
          : { fileKind: searchInput.fileKind })
      });
      const request = (
        matchingStrategy: "all" | "last",
        attributesToSearchOn?: string[]
      ): SearchEngineSearchRequest => ({
        indexUid,
        query,
        filter,
        limit: settings.branchCandidateLimit,
        ...(attributesToSearchOn ? { attributesToSearchOn } : {}),
        attributesToRetrieve: CONTENT_ATTRIBUTES,
        attributesToCrop: ["body"],
        cropLength: settings.cropLength,
        matchingStrategy,
        distinct: "sourceFileId"
      });

      const branches = contentBranches(scope, request);
      const branchResults = await Promise.all(
        branches.map((branch) => input.transport.search(branch.request))
      );
      const evidence = new Map<string, SearchHitEvidence>();
      const candidates = branchResults.flatMap((result, index) => {
        const branch = branches[index]!;
        return branch.family === "exact_title" || branch.family === "exact_path"
          ? mapExactHits(result, branch.family, query, evidence)
          : mapHits(result, branch.family, evidence);
      });
      const stronger = fuseSearchCandidates({
        candidates,
        limit: settings.fusedCandidateLimit,
        cursor: null
      });
      if (stronger.items.length < searchInput.limit) {
        const relaxed = await input.transport.search(
          request("last", attributesForScope(scope))
        );
        candidates.push(...mapHits(relaxed, "typo", evidence));
      }

      const fused = fuseSearchCandidates({
        candidates,
        limit: Math.min(searchInput.limit, settings.fusedCandidateLimit),
        cursor: searchInput.cursor
      });
      return {
        items: fused.items.flatMap((item) => {
          const hit = evidence.get(item.sourceFileId);
          return hit
            ? [{
                ...hit,
                exactPriority: item.exactPriority,
                fusedScore: item.fusedScore,
                families: item.families,
                relationshipReasons: item.relationshipReasons
              }]
            : [];
        }),
        nextCursor: fused.nextCursor
      };
    },

    async searchGraphSeeds(searchInput) {
      assertPositiveBound(searchInput.limit, "Graph seed limit");
      assertEpoch(searchInput.activeEpoch);
      const settings = await readSettings(input);
      const query = normalizePlainQuery(searchInput.query);
      if (
        searchInput.fileKind !== undefined
        && searchInput.fileKind !== null
        && searchInput.fileKind !== "page"
      ) {
        return { items: [], nextCursor: null };
      }
      const scope = searchInput.scope ?? "all";
      const result = await input.transport.search({
        indexUid: createStableSearchIndexUid({
          indexPrefix: input.indexPrefix,
          knowledgeBaseId: searchInput.knowledgeBaseId,
          kind: "graph"
        }),
        query,
        filter: createVisibilityFilter({
          knowledgeBaseId: searchInput.knowledgeBaseId,
          activeEpoch: searchInput.activeEpoch,
          schemaVersion: SEARCH_GRAPH_SEED_SCHEMA_VERSION
        }),
        limit: Math.min(searchInput.limit, settings.branchCandidateLimit),
        attributesToRetrieve: GRAPH_ATTRIBUTES,
        ...(graphAttributesForScope(scope)
          ? { attributesToSearchOn: graphAttributesForScope(scope)! }
          : {}),
        attributesToCrop: [],
        cropLength: 1,
        matchingStrategy: "all",
        distinct: "sourceFileId"
      });
      const evidence = new Map<string, SearchHitEvidence>();
      const candidates = result.hits.flatMap((hit, index) => {
        const sourceFileId = readString(hit, "sourceFileId");
        const sourceRevisionId = readString(hit, "sourceRevisionId");
        const logicalPath = readString(hit, "logicalPath");
        if (!sourceFileId || !sourceRevisionId || !logicalPath) return [];
        evidence.set(sourceFileId, {
          sourceFileId,
          sourceRevisionId,
          logicalPath,
          title: readNullableString(hit, "title"),
          summary: null,
          sourceUrl: readNullableString(hit, "sourceUrl")
        });
        return [{
          sourceFileId,
          family: "graph" as const,
          familyRank: index + 1,
          familyScore: 1
        }];
      });
      const fused = fuseSearchCandidates({
        candidates,
        limit: searchInput.limit,
        cursor: searchInput.cursor
      });
      return {
        items: fused.items.flatMap((item) => {
          const hit = evidence.get(item.sourceFileId);
          return hit
            ? [{
                ...hit,
                exactPriority: item.exactPriority,
                fusedScore: item.fusedScore,
                families: item.families,
                relationshipReasons: item.relationshipReasons
              }]
            : [];
        }),
        nextCursor: fused.nextCursor
      };
    }
  };
}

async function readSettings(input: {
  branchCandidateLimit?: number;
  fusedCandidateLimit?: number;
  cropLength?: number;
  getSettings?: () => Promise<SearchRetrievalSettings>;
}): Promise<SearchRetrievalSettings> {
  const settings = input.getSettings
    ? await input.getSettings()
    : readStaticSettings(input);
  validateSettings(settings);
  return settings;
}

function readStaticSettings(input: {
  branchCandidateLimit?: number;
  fusedCandidateLimit?: number;
  cropLength?: number;
}): SearchRetrievalSettings {
  return {
    branchCandidateLimit: input.branchCandidateLimit ?? 0,
    fusedCandidateLimit: input.fusedCandidateLimit ?? 0,
    cropLength: input.cropLength ?? 0
  };
}

function validateSettings(settings: SearchRetrievalSettings): void {
  assertPositiveBound(settings.branchCandidateLimit, "Search branch candidate limit");
  assertPositiveBound(settings.fusedCandidateLimit, "Search fused candidate limit");
  assertPositiveBound(settings.cropLength, "Search crop length");
}

type SearchHitEvidence = Pick<
  SearchRetrievalCandidate,
  | "sourceFileId"
  | "sourceRevisionId"
  | "logicalPath"
  | "title"
  | "summary"
  | "sourceUrl"
>;

function mapExactHits(
  result: SearchEngineSearchResult,
  family: "exact_title" | "exact_path",
  query: string,
  evidence: Map<string, SearchHitEvidence>
) {
  const field = family === "exact_title" ? "title" : "logicalPath";
  return mapHits(result, family, evidence, (hit) =>
    normalizeComparable(readString(hit, field) ?? "") === normalizeComparable(query)
  );
}

function mapHits(
  result: SearchEngineSearchResult,
  family: RankedSearchFamily,
  evidence: Map<string, SearchHitEvidence>,
  accept: (hit: Record<string, unknown>) => boolean = () => true
) {
  return result.hits.flatMap((hit, index) => {
    if (!accept(hit)) return [];
    const sourceFileId = readString(hit, "sourceFileId");
    const sourceRevisionId = readString(hit, "sourceRevisionId");
    const logicalPath = readString(hit, "logicalPath");
    if (!sourceFileId || !sourceRevisionId || !logicalPath) return [];
    if (!evidence.has(sourceFileId)) {
      evidence.set(sourceFileId, {
        sourceFileId,
        sourceRevisionId,
        logicalPath,
        title: readNullableString(hit, "title"),
        summary: readCroppedBody(hit),
        sourceUrl: readNullableString(hit, "sourceUrl")
      });
    }
    return [{
      sourceFileId,
      family,
      familyRank: index + 1,
      familyScore: 1
    }];
  });
}

function createVisibilityFilter(input: {
  knowledgeBaseId: string;
  activeEpoch: number;
  schemaVersion: string;
  fileKind?: string | null;
}): string {
  const clauses = [
    `knowledgeBaseId = ${quoteFilterValue(input.knowledgeBaseId)}`,
    `schemaVersion = ${quoteFilterValue(input.schemaVersion)}`,
    `visibleFromEpoch <= ${input.activeEpoch}`,
    `(visibleUntilEpoch IS NULL OR visibleUntilEpoch > ${input.activeEpoch})`
  ];
  if (input.fileKind) {
    clauses.push(`fileKind = ${quoteFilterValue(input.fileKind)}`);
  }
  return clauses.join(" AND ");
}

type ContentBranch = {
  family: "exact_title" | "exact_path" | "body";
  request: SearchEngineSearchRequest;
};

function contentBranches(
  scope: "all" | "path" | "metadata",
  request: (
    matchingStrategy: "all" | "last",
    attributesToSearchOn?: string[]
  ) => SearchEngineSearchRequest
): ContentBranch[] {
  if (scope === "path") {
    return [
      { family: "exact_path", request: request("all", ["logicalPath"]) },
      { family: "body", request: request("all", ["logicalPath"]) }
    ];
  }
  if (scope === "metadata") {
    return [
      { family: "exact_title", request: request("all", ["title"]) },
      {
        family: "body",
        request: request("all", attributesForScope("metadata"))
      }
    ];
  }
  return [
    { family: "exact_title", request: request("all", ["title"]) },
    { family: "exact_path", request: request("all", ["logicalPath"]) },
    { family: "body", request: request("all") }
  ];
}

function attributesForScope(
  scope: "all" | "path" | "metadata"
): string[] | undefined {
  if (scope === "path") return ["logicalPath"];
  if (scope === "metadata") return ["title", "headingPath", "metadataText"];
  return undefined;
}

function graphAttributesForScope(
  scope: "all" | "path" | "metadata"
): string[] | undefined {
  if (scope === "path") return ["logicalPath"];
  if (scope === "metadata") return ["title"];
  return undefined;
}

function quoteFilterValue(value: string): string {
  return JSON.stringify(value);
}

function normalizePlainQuery(value: string): string {
  if (Buffer.byteLength(value, "utf8") > MAX_QUERY_BYTES) {
    throw new SearchRetrievalInputError("Search query exceeds the byte limit");
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new SearchRetrievalInputError("Search query contains control characters");
  }
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized) {
    throw new SearchRetrievalInputError("Search query must contain visible text");
  }
  return normalized;
}

function normalizeComparable(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").trim();
}

function readString(value: Record<string, unknown>, key: string): string | null {
  const item = value[key];
  return typeof item === "string" && item ? item : null;
}

function readNullableString(
  value: Record<string, unknown>,
  key: string
): string | null {
  return readString(value, key);
}

function readCroppedBody(value: Record<string, unknown>): string | null {
  const formatted = value._formatted;
  if (formatted && typeof formatted === "object" && !Array.isArray(formatted)) {
    const body = (formatted as Record<string, unknown>).body;
    if (typeof body === "string" && body) return body;
  }
  return readNullableString(value, "body");
}

function assertPositiveBound(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_000) {
    throw new Error(`${label} must be between 1 and 2000`);
  }
}

function assertEpoch(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Active search epoch must be a positive integer");
  }
}

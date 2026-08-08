import { createHash } from "node:crypto";
import type {
  SearchFilterExpression,
  SearchProviderQueryResult,
  SearchProviderRuntime
} from "../../application/ports/search-provider-runtime.js";
import {
  SearchProviderError
} from "../../application/ports/search-provider-runtime.js";
import type { StorageVnextSearchQueryPort } from "./ports.js";
import type {
  StorageVnextActiveSearchProjectionRepository
} from "./active-projection-repository.js";
import type {
  StorageVnextSearchHydrationPort,
  StorageVnextSearchHydrationRecord
} from "./search-hydration.js";
import {
  STORAGE_VNEXT_CONTENT_SCHEMA_VERSION,
  STORAGE_VNEXT_GRAPH_SEED_SCHEMA_VERSION
} from "./documents.js";
import {
  createOkfSearchSignals,
  hasOkfSearchFilters,
  matchesOkfSearchFilters,
  normalizeOkfSearchFilterContract,
  type OkfSearchFilters
} from "./okf-signals.js";

const SEARCH_ATTRIBUTES = ["title", "logicalPath", "searchText", "rankingTerms"];
const RESULT_ATTRIBUTES = [
  "documentKind",
  "sourceFilePublicId",
  "sourceRevisionPublicId",
  "logicalPath",
  "title",
  "searchText",
  "okfSignals"
];
const MAX_QUERY_BYTES = 512;
const MAX_REFILL_PAGES = 10;

export class StorageVnextSearchUnavailableError extends SearchProviderError {
  public constructor() {
    super("SEARCH_ENGINE_UNAVAILABLE", true);
    this.name = "StorageVnextSearchUnavailableError";
  }
}

export class StorageVnextActiveSearchInputError extends Error {
  public constructor(
    public readonly code: "INVALID_SEARCH_INPUT" | "INVALID_SEARCH_CURSOR"
  ) {
    super(`Storage vNext active search input error: ${code}`);
    this.name = "StorageVnextActiveSearchInputError";
  }
}

type ActiveSearchConfig = {
  projections: StorageVnextActiveSearchProjectionRepository;
  provider: Pick<SearchProviderRuntime, "kind" | "query">;
  hydration: StorageVnextSearchHydrationPort;
  maxPageSize: number;
  overfetchFactor: number;
  cropLength: number;
  requestTimeoutMs: number;
  engineSearchCutoffMs?: number;
  resolveRuntimeSettings?: () => Promise<{
    overfetchFactor: number;
    cropLength: number;
    requestTimeoutMs: number;
    engineSearchCutoffMs?: number;
  }>;
};

type SearchCursor = {
  version: 2;
  scopeHash: string;
  providerContinuation: string | null;
};

type ParsedHit = {
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  logicalPath: string;
  snippet: string | null;
  kind: "file" | "graph";
  normalizedScore: number;
  continuationAfter: string;
};

export function createStorageVnextActiveSearch(
  config: ActiveSearchConfig
): StorageVnextSearchQueryPort {
  assertConfig(config);
  return {
    async search(input) {
      const normalized = normalizeInput(input, config.maxPageSize);
      const projection = await config.projections.getActiveProjection(
        input.knowledgeBaseId
      );
      if (!projection) {
        throw new StorageVnextSearchUnavailableError();
      }
      const scopeHash = createScopeHash({
        knowledgeBaseId: input.knowledgeBaseId,
        query: normalized.query,
        kinds: normalized.kinds,
        providerKind: config.provider.kind,
        projectionPublicId: projection.publicId,
        providerIndexUid: projection.providerIndexUid,
        okfFilters: normalized.okfFilters
      });
      const cursor = decodeCursor(input.cursor, scopeHash);
      if (
        projection.knowledgeBaseId !== input.knowledgeBaseId
        || projection.providerKind !== config.provider.kind
      ) {
        throw new StorageVnextSearchUnavailableError();
      }
      const runtimeSettings = config.resolveRuntimeSettings
        ? await config.resolveRuntimeSettings()
        : config;
      assertRuntimeSearchSettings(runtimeSettings);
      const providerLimit = Math.min(
        1_000,
        Math.max(input.limit + 1, input.limit * runtimeSettings.overfetchFactor + 1)
      );
      const visible: Array<{
        candidate: ParsedHit;
        source: StorageVnextSearchHydrationRecord;
      }> = [];
      const seenSources = new Set<string>();
      const startedAt = Date.now();
      let providerContinuation = cursor.providerContinuation;
      let nextProviderContinuation: string | null = null;
      for (let page = 0; page < MAX_REFILL_PAGES; page += 1) {
        const remainingMs = runtimeSettings.requestTimeoutMs
          - Math.max(0, Date.now() - startedAt);
        if (remainingMs < 100) {
          throw new SearchProviderError("SEARCH_ENGINE_TIMEOUT", true);
        }
        const result: SearchProviderQueryResult = await config.provider.query.query({
          indexUid: projection.providerIndexUid,
          query: normalized.query,
          evidenceFamilies: ["exact", "text", "phrase", "typo", "jieba", "graph"],
          filters: createFilter(
            input.knowledgeBaseId,
            normalized.kinds,
            normalized.okfFilters
          ),
          limit: providerLimit,
          continuation: providerContinuation,
          searchFields: SEARCH_ATTRIBUTES,
          returnFields: RESULT_ATTRIBUTES,
          cropLength: runtimeSettings.cropLength,
          deadlineMs: Math.min(
            remainingMs,
            runtimeSettings.engineSearchCutoffMs
              ?? remainingMs
          ),
          matchingStrategy: "all",
          distinctBy: "sourceFilePublicId"
        });
        const parsed = result.hits.flatMap((hit) => {
          const candidate = parseHit(hit);
          return candidate ? [candidate] : [];
        });
        const hydrated = await config.hydration.hydrateCurrentSources({
          knowledgeBaseId: input.knowledgeBaseId,
          sourceFilePublicIds: parsed.map((item) => item.sourceFilePublicId)
        });
        const current = new Map(
          hydrated.map((item) => [item.sourceFilePublicId, item])
        );
        for (const candidate of parsed) {
          const source = current.get(candidate.sourceFilePublicId);
          if (
            !seenSources.has(candidate.sourceFilePublicId)
            && isCurrent(candidate, source)
            && matchesHydratedOkfFilters(source, normalized.okfFilters)
          ) {
            seenSources.add(candidate.sourceFilePublicId);
            visible.push({ candidate, source });
          }
        }
        nextProviderContinuation = result.continuation;
        if (visible.length > input.limit || nextProviderContinuation === null) break;
        if (nextProviderContinuation === providerContinuation) {
          throw new SearchProviderError("SEARCH_ENGINE_REQUEST_FAILED", false);
        }
        providerContinuation = nextProviderContinuation;
      }
      const selected = visible.slice(0, input.limit);
      return {
        items: selected.map(({ candidate, source }) => ({
          publicId: source.sourceFilePublicId,
          sourceFilePublicId: source.sourceFilePublicId,
          logicalPath: source.logicalPath,
          title: source.title,
          snippet: candidate.snippet,
          score: candidate.normalizedScore,
          kind: candidate.kind,
          metadata: source.metadata
        })),
        nextCursor: createNextCursor({
          providerContinuation: nextProviderContinuation,
          visible,
          selectedCount: selected.length,
          pageLimit: input.limit,
          scopeHash
        })
      };
    }
  };
}

function normalizeInput(
  input: Parameters<StorageVnextSearchQueryPort["search"]>[0],
  maxPageSize: number
) {
  const query = input.query.trim().replace(/\s+/gu, " ");
  const kinds = [...new Set(input.kinds)].sort();
  if (
    !input.knowledgeBaseId
    || Buffer.byteLength(input.knowledgeBaseId) > 255
    || !query
    || Buffer.byteLength(query) > MAX_QUERY_BYTES
    || !Number.isSafeInteger(input.limit)
    || input.limit < 1
    || input.limit > maxPageSize
    || kinds.length < 1
    || kinds.some((kind) => kind !== "file" && kind !== "graph")
  ) throw new StorageVnextActiveSearchInputError("INVALID_SEARCH_INPUT");
  let okfFilters: OkfSearchFilters;
  try {
    okfFilters = normalizeOkfSearchFilterContract(input.okfFilters);
  } catch {
    throw new StorageVnextActiveSearchInputError("INVALID_SEARCH_INPUT");
  }
  return { query, kinds: kinds as Array<"file" | "graph">, okfFilters };
}

function createFilter(
  knowledgeBaseId: string,
  kinds: readonly ("file" | "graph")[],
  okfFilters: OkfSearchFilters
): SearchFilterExpression {
  const clauses = kinds.map((kind) => kind === "file"
    ? {
        kind: "and" as const,
        operands: [
          { kind: "equals" as const, field: "documentKind" as const, value: "content" },
          { kind: "equals" as const, field: "schemaVersion" as const, value: STORAGE_VNEXT_CONTENT_SCHEMA_VERSION }
        ]
      }
    : {
        kind: "and" as const,
        operands: [
          { kind: "equals" as const, field: "documentKind" as const, value: "graph_seed" },
          { kind: "equals" as const, field: "schemaVersion" as const, value: STORAGE_VNEXT_GRAPH_SEED_SCHEMA_VERSION }
        ]
      }
  );
  const filterClauses: SearchFilterExpression[] = [{
    kind: "equals",
    field: "knowledgeBaseId",
    value: knowledgeBaseId
  }, { kind: "or", operands: clauses }];
  if (okfFilters.status !== null) filterClauses.push({
    kind: "equals",
    field: "okfSignals.status",
    value: okfFilters.status
  });
  if (okfFilters.trustTier !== null) filterClauses.push({
    kind: "equals",
    field: "okfSignals.trustTier",
    value: okfFilters.trustTier
  });
  if (okfFilters.freshness !== null && okfFilters.requestEpochDay !== null) {
    filterClauses.push({
      kind: "range",
      field: "okfSignals.staleAfterEpochDay",
      operator: okfFilters.freshness === "stale" ? "lte" : "gt",
      value: okfFilters.requestEpochDay
    });
  }
  return {
    kind: "and",
    operands: filterClauses
  };
}

function parseHit(
  hit: SearchProviderQueryResult["hits"][number]
): ParsedHit | null {
  const sourceFilePublicId = hit.sourceFilePublicId;
  const sourceRevisionPublicId = hit.sourceRevisionPublicId;
  const logicalPath = hit.logicalPath;
  const documentKind = readString(hit.document, "documentKind");
  const kind = documentKind === "content" ? "file"
    : documentKind === "graph_seed" ? "graph"
      : null;
  if (!sourceFilePublicId || !sourceRevisionPublicId || !logicalPath || !kind) return null;
  return {
    sourceFilePublicId,
    sourceRevisionPublicId,
    logicalPath,
    snippet: hit.snippets[0] ?? null,
    kind,
    normalizedScore: hit.normalizedScore,
    continuationAfter: hit.continuationAfter
  };
}

function isCurrent(
  candidate: ParsedHit,
  source: StorageVnextSearchHydrationRecord | undefined
): source is StorageVnextSearchHydrationRecord {
  return Boolean(
    source
    && source.sourceRevisionPublicId === candidate.sourceRevisionPublicId
    && source.logicalPath === candidate.logicalPath
  );
}

function matchesHydratedOkfFilters(
  source: StorageVnextSearchHydrationRecord,
  filters: OkfSearchFilters
): boolean {
  return !hasOkfSearchFilters(filters)
    || matchesOkfSearchFilters(createOkfSearchSignals(source.metadata), filters);
}

function createNextCursor(input: {
  providerContinuation: string | null;
  visible: Array<{ candidate: ParsedHit }>;
  selectedCount: number;
  pageLimit: number;
  scopeHash: string;
}) {
  const hasVisibleLookahead = input.visible.length > input.pageLimit;
  const hasProviderMore = input.providerContinuation !== null;
  if (!hasVisibleLookahead && !hasProviderMore) return null;
  const providerContinuation = input.selectedCount > 0
    ? input.visible[input.selectedCount - 1]!.candidate.continuationAfter
    : input.providerContinuation;
  if (!providerContinuation) return null;
  return encodeCursor({
    version: 2,
    scopeHash: input.scopeHash,
    providerContinuation
  });
}

function createScopeHash(input: {
  knowledgeBaseId: string;
  query: string;
  kinds: readonly string[];
  providerKind: string;
  projectionPublicId: string;
  providerIndexUid: string;
  okfFilters: OkfSearchFilters;
}) {
  return createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
}

function encodeCursor(cursor: SearchCursor) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string | null, scopeHash: string): SearchCursor {
  if (!value) return { version: 2, scopeHash, providerContinuation: null };
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      version?: unknown;
      scopeHash?: unknown;
      providerContinuation?: unknown;
    };
    if (
      parsed.version !== 2
      || parsed.scopeHash !== scopeHash
      || typeof parsed.providerContinuation !== "string"
      || !parsed.providerContinuation
    ) throw new Error("invalid");
    return parsed as SearchCursor;
  } catch {
    throw new StorageVnextActiveSearchInputError("INVALID_SEARCH_CURSOR");
  }
}

function readString(value: Record<string, unknown>, key: string) {
  return typeof value[key] === "string" ? value[key] : null;
}

function assertConfig(config: ActiveSearchConfig) {
  if (
    !Number.isSafeInteger(config.maxPageSize)
    || config.maxPageSize < 1
    || config.maxPageSize > 1_000
  ) throw new Error("Storage vNext active search configuration is invalid");
  assertRuntimeSearchSettings(config);
}

function assertRuntimeSearchSettings(input: {
  overfetchFactor: number;
  cropLength: number;
  requestTimeoutMs: number;
  engineSearchCutoffMs?: number;
}) {
  if (
    !Number.isSafeInteger(input.overfetchFactor)
    || input.overfetchFactor < 1
    || input.overfetchFactor > 10
    || !Number.isSafeInteger(input.cropLength)
    || input.cropLength < 1
    || input.cropLength > 5_000
    || !Number.isSafeInteger(input.requestTimeoutMs)
    || input.requestTimeoutMs < 100
    || input.requestTimeoutMs > 120_000
    || (
      input.engineSearchCutoffMs !== undefined
      && (
        !Number.isSafeInteger(input.engineSearchCutoffMs)
        || input.engineSearchCutoffMs < 100
        || input.engineSearchCutoffMs > 120_000
      )
    )
  ) throw new Error("Storage vNext active search runtime settings are invalid");
}

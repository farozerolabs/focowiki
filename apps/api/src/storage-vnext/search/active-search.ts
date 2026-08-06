import { createHash } from "node:crypto";
import type {
  SearchEngineSearchResult,
  SearchEngineTransport
} from "../../application/ports/search-engine-transport.js";
import {
  SearchEngineTransportError
} from "../../application/ports/search-engine-transport.js";
import type { StorageVnextSearchQueryPort } from "./ports.js";
import type {
  StorageVnextActiveSearchProjectionRepository
} from "./active-projection-repository.js";
import type {
  StorageVnextSearchHydrationPort,
  StorageVnextSearchHydrationRecord
} from "./search-hydration.js";

const CONTENT_SCHEMA_VERSION = "storage-vnext-content-v1";
const GRAPH_SCHEMA_VERSION = "storage-vnext-graph-seed-v1";
const SEARCH_ATTRIBUTES = ["title", "logicalPath", "searchText", "rankingTerms"];
const RESULT_ATTRIBUTES = [
  "documentKind",
  "sourceFilePublicId",
  "sourceRevisionPublicId",
  "logicalPath",
  "title",
  "searchText"
];
const MAX_QUERY_BYTES = 512;

export class StorageVnextSearchUnavailableError extends SearchEngineTransportError {
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
  transport: Pick<SearchEngineTransport, "search">;
  hydration: StorageVnextSearchHydrationPort;
  maxPageSize: number;
  overfetchFactor: number;
  cropLength: number;
  resolveRuntimeSettings?: () => Promise<{
    overfetchFactor: number;
    cropLength: number;
  }>;
};

type SearchCursor = {
  version: 1;
  scopeHash: string;
  offset: number;
};

type ParsedHit = {
  hitIndex: number;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  logicalPath: string;
  snippet: string | null;
  kind: "file" | "graph";
};

export function createStorageVnextActiveSearch(
  config: ActiveSearchConfig
): StorageVnextSearchQueryPort {
  assertConfig(config);
  return {
    async search(input) {
      const normalized = normalizeInput(input, config.maxPageSize);
      const scopeHash = createScopeHash({
        knowledgeBaseId: input.knowledgeBaseId,
        query: normalized.query,
        kinds: normalized.kinds
      });
      const cursor = decodeCursor(input.cursor, scopeHash);
      const projection = await config.projections.getActiveProjection(
        input.knowledgeBaseId
      );
      if (!projection || projection.knowledgeBaseId !== input.knowledgeBaseId) {
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
      let result: SearchEngineSearchResult;
      try {
        result = await config.transport.search({
          indexUid: projection.providerIndexUid,
          query: normalized.query,
          filter: createFilter(input.knowledgeBaseId, normalized.kinds),
          limit: providerLimit,
          offset: cursor.offset,
          attributesToSearchOn: SEARCH_ATTRIBUTES,
          attributesToRetrieve: RESULT_ATTRIBUTES,
          attributesToCrop: ["searchText"],
          cropLength: runtimeSettings.cropLength,
          matchingStrategy: "all",
          distinct: "sourceFilePublicId"
        });
      } catch (error) {
        if (error instanceof SearchEngineTransportError) {
          throw new StorageVnextSearchUnavailableError();
        }
        throw error;
      }
      const parsed = result.hits.flatMap((hit, hitIndex) => {
        const candidate = parseHit(hit, hitIndex);
        return candidate ? [candidate] : [];
      });
      const hydrated = await config.hydration.hydrateCurrentSources({
        knowledgeBaseId: input.knowledgeBaseId,
        sourceFilePublicIds: parsed.map((item) => item.sourceFilePublicId)
      });
      const current = new Map(hydrated.map((item) => [item.sourceFilePublicId, item]));
      const visible = parsed.flatMap((candidate) => {
        const source = current.get(candidate.sourceFilePublicId);
        return isCurrent(candidate, source)
          ? [{ candidate, source }]
          : [];
      });
      const selected = visible.slice(0, input.limit);
      return {
        items: selected.map(({ candidate, source }) => ({
          publicId: source.sourceFilePublicId,
          sourceFilePublicId: source.sourceFilePublicId,
          logicalPath: source.logicalPath,
          title: source.title,
          snippet: candidate.snippet,
          score: 1 / (cursor.offset + candidate.hitIndex + 1),
          kind: candidate.kind
        })),
        nextCursor: createNextCursor({
          result,
          parsedHitCount: result.hits.length,
          visible,
          selectedCount: selected.length,
          pageLimit: input.limit,
          currentOffset: cursor.offset,
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
  return { query, kinds: kinds as Array<"file" | "graph"> };
}

function createFilter(knowledgeBaseId: string, kinds: readonly ("file" | "graph")[]) {
  const clauses = kinds.map((kind) => kind === "file"
    ? `(documentKind = "content" AND schemaVersion = "${CONTENT_SCHEMA_VERSION}")`
    : `(documentKind = "graph_seed" AND schemaVersion = "${GRAPH_SCHEMA_VERSION}")`
  );
  return `knowledgeBaseId = ${JSON.stringify(knowledgeBaseId)} AND (${clauses.join(" OR ")})`;
}

function parseHit(hit: Record<string, unknown>, hitIndex: number): ParsedHit | null {
  const sourceFilePublicId = readString(hit, "sourceFilePublicId");
  const sourceRevisionPublicId = readString(hit, "sourceRevisionPublicId");
  const logicalPath = readString(hit, "logicalPath");
  const documentKind = readString(hit, "documentKind");
  const kind = documentKind === "content" ? "file"
    : documentKind === "graph_seed" ? "graph"
      : null;
  if (!sourceFilePublicId || !sourceRevisionPublicId || !logicalPath || !kind) return null;
  return {
    hitIndex,
    sourceFilePublicId,
    sourceRevisionPublicId,
    logicalPath,
    snippet: readFormattedSearchText(hit),
    kind
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

function createNextCursor(input: {
  result: SearchEngineSearchResult;
  parsedHitCount: number;
  visible: Array<{ candidate: ParsedHit }>;
  selectedCount: number;
  pageLimit: number;
  currentOffset: number;
  scopeHash: string;
}) {
  const hasVisibleLookahead = input.visible.length > input.pageLimit;
  const hasProviderMore = input.currentOffset + input.parsedHitCount
    < input.result.estimatedTotalHits;
  if (!hasVisibleLookahead && !hasProviderMore) return null;
  let nextOffset: number;
  if (hasVisibleLookahead && input.selectedCount > 0) {
    nextOffset = input.currentOffset
      + input.visible[input.selectedCount - 1]!.candidate.hitIndex + 1;
  } else {
    nextOffset = input.currentOffset + input.parsedHitCount;
  }
  if (nextOffset <= input.currentOffset) return null;
  return encodeCursor({ version: 1, scopeHash: input.scopeHash, offset: nextOffset });
}

function createScopeHash(input: {
  knowledgeBaseId: string;
  query: string;
  kinds: readonly string[];
}) {
  return createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
}

function encodeCursor(cursor: SearchCursor) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string | null, scopeHash: string): SearchCursor {
  if (!value) return { version: 1, scopeHash, offset: 0 };
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      version?: unknown;
      scopeHash?: unknown;
      offset?: unknown;
    };
    if (
      parsed.version !== 1
      || parsed.scopeHash !== scopeHash
      || !Number.isSafeInteger(parsed.offset)
      || Number(parsed.offset) < 0
    ) throw new Error("invalid");
    return parsed as SearchCursor;
  } catch {
    throw new StorageVnextActiveSearchInputError("INVALID_SEARCH_CURSOR");
  }
}

function readFormattedSearchText(hit: Record<string, unknown>) {
  const formatted = hit._formatted;
  if (!formatted || typeof formatted !== "object" || Array.isArray(formatted)) return null;
  return readString(formatted as Record<string, unknown>, "searchText");
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
}) {
  if (
    !Number.isSafeInteger(input.overfetchFactor)
    || input.overfetchFactor < 1
    || input.overfetchFactor > 10
    || !Number.isSafeInteger(input.cropLength)
    || input.cropLength < 1
    || input.cropLength > 5_000
  ) throw new Error("Storage vNext active search runtime settings are invalid");
}

import type {
  MeilisearchClientPort,
  MeilisearchSettings,
  MeilisearchTask
} from "./meilisearch-client-port.js";
import { MeilisearchClientError } from "./meilisearch-client-port.js";
import type {
  SearchFilterExpression,
  SearchProviderHit,
  SearchProviderIndexDefinition,
  SearchProviderOperationReceipt,
  SearchProviderOperationStatus,
  SearchProviderRuntime
} from "../../application/ports/search-provider-runtime.js";
import { SearchProviderError } from
  "../../application/ports/search-provider-runtime.js";
import { createMeilisearchVectorPort } from "./meilisearch-vector-port.js";
import { createValidatedSearchProviderVectorPort } from
  "../../semantic/vector/provider-contract.js";
import type { LexicalTokenizer } from
  "../../application/ports/lexical-tokenizer.js";
import { normalizeMeilisearchQuery } from
  "./meilisearch-query-normalization.js";

const OPERATION_PREFIX = "meilisearch:";
const CONTINUATION_PREFIX = "meilisearch-offset:";
const INDEX_CONTINUATION_PREFIX = "meilisearch-index-offset:";
const TASK_CONTINUATION_PREFIX = "meilisearch-task-from:";

export function createMeilisearchProviderRuntime(
  transport: MeilisearchClientPort,
  tokenizer?: LexicalTokenizer
): SearchProviderRuntime {
  const runtime: SearchProviderRuntime = {
    kind: "meilisearch" as const,
    admin: {
      async health() {
        const result = await execute(() => transport.health());
        return {
          available: result.available,
          version: "version" in result && typeof result.version === "string"
            ? result.version
            : ""
        };
      },
      async createIndex(input) {
        assertIndexDefinition(input.definition);
        return pending(await execute(() => transport.createIndex({
          indexUid: input.indexUid,
          primaryKey: input.definition.primaryKey
        })));
      },
      async getIndex(input) {
        const index = await execute(() => transport.getIndex(input));
        return index ? { indexUid: index.uid, primaryKey: index.primaryKey } : null;
      },
      async getIndexDefinition(input) {
        const index = await execute(() => transport.getIndex(input));
        if (!index) return null;
        return fromMeilisearchSettings(await execute(
          () => transport.getSettings(input.indexUid)
        ));
      },
      async updateIndexDefinition(input) {
        assertIndexDefinition(input.definition);
        return pending(await execute(() => transport.updateSettings({
          indexUid: input.indexUid,
          settings: toMeilisearchSettings(input.definition)
        })));
      },
      async deleteIndex(input) {
        return pending(await execute(() => transport.deleteIndex(input.indexUid)));
      }
    },
    write: {
      async writeDocuments(input) {
        return pending(await execute(() => transport.addDocuments({
          indexUid: input.indexUid,
          primaryKey: "id",
          documents: [...input.documents],
          correlation: input.correlation
        })));
      },
      async deleteDocuments(input) {
        const hasIds = Boolean(input.documentIds?.length);
        const hasFilters = input.filters !== undefined;
        if (hasIds === hasFilters) throw requestError();
        return pending(await execute(() => transport.deleteDocuments({
          indexUid: input.indexUid,
          ...(hasIds ? { ids: [...input.documentIds!] } : {}),
          ...(hasFilters ? { filter: renderFilter(input.filters!) } : {}),
          correlation: input.correlation
        })));
      },
      async refreshIndex() {
        return undefined;
      }
    },
    query: {
      async query(input) {
        const offset = decodeContinuation(input.continuation);
        let execution: ReturnType<typeof normalizeMeilisearchQuery>;
        try {
          execution = normalizeMeilisearchQuery({
            request: input,
            ...(tokenizer ? { tokenizer } : {})
          });
        } catch {
          throw requestError();
        }
        const result = await execute(() => transport.search({
          indexUid: input.indexUid,
          query: execution.query,
          filter: renderFilter(input.filters),
          limit: input.limit,
          offset,
          attributesToSearchOn: [...input.searchFields],
          attributesToRetrieve: [...input.returnFields],
          attributesToCrop: input.cropLength > 0 ? ["searchText"] : [],
          cropLength: input.cropLength,
          showMatchesPosition: true,
          matchingStrategy: execution.matchingStrategy,
          ...(execution.matchingStrategy === "last"
            ? { rankingScoreThreshold: 0.05 }
            : {}),
          ...(input.distinctBy ? { distinct: input.distinctBy } : {})
        }));
        const hits = result.hits.map((hit, index) => normalizeHit(hit, offset + index));
        const consumed = hits.length;
        return {
          hits,
          continuation: offset + consumed < result.estimatedTotalHits && consumed > 0
            ? encodeContinuation(offset + consumed)
            : null,
          processingTimeMs: result.processingTimeMs
        };
      }
    },
    validation: {
      async countDocuments(input) {
        const getIndexStats = transport.getIndexStats;
        if (!getIndexStats) throw capabilityError();
        const stats = await execute(() => getIndexStats(input));
        return stats.numberOfDocuments;
      },
      async scanDocuments(input) {
        const listDocuments = transport.listDocuments;
        if (!listDocuments) throw capabilityError();
        const offset = decodeContinuation(input.continuation);
        const page = await execute(() => listDocuments({
          indexUid: input.indexUid,
          offset,
          limit: input.limit,
          fields: input.fields
        }));
        if (page.offset !== offset) throw requestError();
        return {
          documents: page.documents,
          continuation: offset + page.documents.length < page.total
            && page.documents.length > 0
            ? encodeContinuation(offset + page.documents.length)
            : null
        };
      }
    },
    operations: {
      async getOperation(input) {
        const task = await execute(() => transport.getTask(
          decodeOperationRef(input.operationRef)
        ));
        return operationStatus(task);
      },
      async findOperationByCorrelation(input) {
        const findTask = transport.findTaskByCorrelation;
        if (!findTask) throw capabilityError();
        const task = await execute(() => findTask(input));
        if (!task) return null;
        return task.status === "succeeded"
          ? { state: "completed" as const }
          : {
              state: "pending" as const,
              operationRef: encodeOperationRef(task.taskUid)
            };
      }
    },
    vector: createValidatedSearchProviderVectorPort(createMeilisearchVectorPort({
      transport
    })),
    maintenance: {
      async getPressure() {
        const pressure = await execute(() => transport.getPressure());
        return {
          queueLatencyMs: pressure.queueLatencyMs,
          residentMemoryBytes: pressure.residentMemoryBytes
        };
      },
      async listOwnedIndexes(input) {
        const listIndexes = transport.listIndexes;
        if (!listIndexes) throw capabilityError();
        const offset = decodeIntegerContinuation(
          input.continuation,
          INDEX_CONTINUATION_PREFIX
        );
        const page = await execute(() => listIndexes({
          offset,
          limit: input.limit
        }));
        if (page.offset !== offset) throw requestError();
        return {
          indexes: page.indexes
            .filter((index) => index.uid.startsWith(input.indexUidPrefix))
            .map((index) => ({
              indexUid: index.uid,
              updatedAt: index.updatedAt
            })),
          restartContinuation: encodeIntegerContinuation(
            0,
            INDEX_CONTINUATION_PREFIX
          ),
          continuation: offset + page.indexes.length < page.total
            ? encodeIntegerContinuation(
                offset + page.indexes.length,
                INDEX_CONTINUATION_PREFIX
              )
            : null
        };
      },
      async deleteOwnedFinishedOperations(input) {
        if (input.indexUidPrefixes.length < 1
          || new Set(input.indexUidPrefixes).size !== input.indexUidPrefixes.length
          || input.indexUidPrefixes.some((prefix) => !prefix)) {
          throw requestError();
        }
        const listFinishedTasks = transport.listFinishedTasks;
        const deleteFinishedTasks = transport.deleteFinishedTasks;
        if (!listFinishedTasks || !deleteFinishedTasks) throw capabilityError();
        const from = decodeNullableIntegerContinuation(
          input.continuation,
          TASK_CONTINUATION_PREFIX
        );
        const page = await execute(() => listFinishedTasks({
          statuses: ["succeeded", "failed", "canceled"],
          beforeFinishedAt: input.beforeFinishedAt,
          from,
          limit: input.limit
        }));
        const taskUids = page.tasks
          .filter((task) => task.indexUid
            && input.indexUidPrefixes.some((prefix) =>
              task.indexUid!.startsWith(prefix)))
          .map((task) => task.taskUid);
        return {
          deleted: taskUids.length,
          continuation: page.next === null
            ? null
            : encodeIntegerContinuation(page.next, TASK_CONTINUATION_PREFIX),
          operation: taskUids.length === 0
            ? { state: "completed" }
            : pending(await execute(() => deleteFinishedTasks({ taskUids })))
        };
      },
      async getStorageStats() {
        const getDatabaseStats = transport.getDatabaseStats;
        if (!getDatabaseStats) throw capabilityError();
        return execute(() => getDatabaseStats());
      },
      async compactIndex(input) {
        const compactIndex = transport.compactIndex;
        if (!compactIndex) throw capabilityError();
        return pending(await execute(() => compactIndex(input.indexUid)));
      }
    },
    async close() {
      return undefined;
    }
  };
  return Object.freeze(runtime);
}

export function toMeilisearchSettings(
  definition: SearchProviderIndexDefinition
): MeilisearchSettings {
  assertIndexDefinition(definition);
  return {
    searchableAttributes: [...definition.searchableAttributes],
    filterableAttributes: [{
      attributePatterns: [...definition.filterableAttributes],
      features: {
        facetSearch: false,
        filter: { equality: true, comparison: true }
      }
    }],
    displayedAttributes: [...definition.displayedAttributes],
    sortableAttributes: [],
    rankingRules: [...definition.rankingRules],
    distinctAttribute: definition.distinctAttribute,
    pagination: { maxTotalHits: definition.maximumTotalHits },
    searchCutoffMs: definition.searchCutoffMs,
    localizedAttributes: [],
    typoTolerance: {
      disableOnAttributes: [...definition.typoDisabledAttributes]
    }
  };
}

export function fromMeilisearchSettings(
  settings: MeilisearchSettings
): SearchProviderIndexDefinition {
  const filterableAttributes = settings.filterableAttributes.flatMap((value) =>
    typeof value === "string" ? [value] : value.attributePatterns
  );
  const definition: SearchProviderIndexDefinition = {
    primaryKey: "id",
    searchableAttributes: [...settings.searchableAttributes],
    filterableAttributes,
    displayedAttributes: [...settings.displayedAttributes],
    rankingRules: [...settings.rankingRules],
    distinctAttribute: "sourceFilePublicId",
    maximumTotalHits: settings.pagination.maxTotalHits,
    searchCutoffMs: settings.searchCutoffMs,
    typoDisabledAttributes: [...settings.typoTolerance.disableOnAttributes]
  };
  assertIndexDefinition(definition);
  return definition;
}

function renderFilter(filter: SearchFilterExpression): string {
  const rendered = renderFilterNode(filter);
  return filter.kind === "and" || filter.kind === "or"
    ? rendered.slice(1, -1)
    : rendered;
}

function renderFilterNode(filter: SearchFilterExpression): string {
  if (filter.kind === "equals") {
    return `${filter.field} = ${JSON.stringify(filter.value)}`;
  }
  if (filter.kind === "boolean") {
    return `${filter.field} = ${filter.value ? "true" : "false"}`;
  }
  if (filter.kind === "range") {
    if (!Number.isSafeInteger(filter.value)) throw requestError();
    return `${filter.field} ${filter.operator === "lte" ? "<=" : ">"} ${filter.value}`;
  }
  if (filter.operands.length === 0) throw requestError();
  const rendered = filter.operands.map((operand) => renderFilterNode(operand));
  return `(${rendered.join(filter.kind === "and" ? " AND " : " OR ")})`;
}

function normalizeHit(hit: Record<string, unknown>, ordinal: number): SearchProviderHit {
  const document = Object.fromEntries(
    Object.entries(hit).filter(([key]) => !key.startsWith("_"))
  );
  const documentId = stringValue(hit.id);
  return {
    documentId,
    sourceFilePublicId: stringValue(hit.sourceFilePublicId),
    sourceRevisionPublicId: stringValue(hit.sourceRevisionPublicId),
    logicalPath: stringValue(hit.logicalPath),
    title: stringValue(hit.title),
    normalizedScore: numberValue(hit._rankingScore) ?? 1 / (ordinal + 1),
    snippets: formattedSnippets(hit),
    matchedFields: matchedFields(hit._matchesPosition),
    sortKey: [ordinal, documentId],
    continuationAfter: encodeContinuation(ordinal + 1),
    document
  };
}

function matchedFields(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>)
    .filter(([, positions]) => Array.isArray(positions) && positions.length > 0)
    .map(([field]) => field)
    .sort((left, right) => left.localeCompare(right, "en"));
}

function formattedSnippets(hit: Record<string, unknown>): string[] {
  const formatted = hit._formatted;
  if (!formatted || typeof formatted !== "object" || Array.isArray(formatted)) return [];
  const searchText = (formatted as Record<string, unknown>).searchText;
  return typeof searchText === "string" && searchText ? [searchText] : [];
}

function pending(input: { taskUid: number }): SearchProviderOperationReceipt {
  return { state: "pending", operationRef: encodeOperationRef(input.taskUid) };
}

function operationStatus(task: MeilisearchTask): SearchProviderOperationStatus {
  if (task.status === "succeeded") return { state: "completed" };
  if (task.status === "failed" || task.status === "canceled" || task.status === "unknown") {
    return { state: "failed", errorCode: "SEARCH_ENGINE_REQUEST_FAILED" };
  }
  return { state: "pending" };
}

function encodeOperationRef(taskUid: number): string {
  if (!Number.isSafeInteger(taskUid) || taskUid < 0) throw requestError();
  return `${OPERATION_PREFIX}${taskUid}`;
}

function decodeOperationRef(value: string): number {
  const match = /^meilisearch:(\d+)$/u.exec(value);
  const taskUid = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(taskUid) || taskUid < 0) throw requestError();
  return taskUid;
}

function encodeContinuation(offset: number): string {
  return `${CONTINUATION_PREFIX}${Buffer.from(JSON.stringify({ offset }), "utf8")
    .toString("base64url")}`;
}

function decodeContinuation(value: string | null): number {
  if (value === null) return 0;
  if (!value.startsWith(CONTINUATION_PREFIX)) throw requestError();
  try {
    const decoded = JSON.parse(Buffer.from(
      value.slice(CONTINUATION_PREFIX.length),
      "base64url"
    ).toString("utf8")) as { offset?: unknown };
    if (!Number.isSafeInteger(decoded.offset) || Number(decoded.offset) < 0) {
      throw requestError();
    }
    return Number(decoded.offset);
  } catch (error) {
    if (error instanceof SearchProviderError) throw error;
    throw requestError();
  }
}

function encodeIntegerContinuation(value: number, prefix: string): string {
  if (!Number.isSafeInteger(value) || value < 0) throw requestError();
  return `${prefix}${value}`;
}

function decodeIntegerContinuation(value: string | null, prefix: string): number {
  if (value === null) return 0;
  const encoded = value.startsWith(prefix) ? value.slice(prefix.length) : "";
  const decoded = /^\d+$/u.test(encoded) ? Number(encoded) : Number.NaN;
  if (!Number.isSafeInteger(decoded) || decoded < 0) throw requestError();
  return decoded;
}

function decodeNullableIntegerContinuation(
  value: string | null,
  prefix: string
): number | null {
  return value === null ? null : decodeIntegerContinuation(value, prefix);
}

function assertIndexDefinition(value: SearchProviderIndexDefinition): void {
  if (
    value.primaryKey !== "id"
    || value.distinctAttribute !== "sourceFilePublicId"
    || !Number.isSafeInteger(value.maximumTotalHits)
    || value.maximumTotalHits < 1
    || !Number.isSafeInteger(value.searchCutoffMs)
    || value.searchCutoffMs < 1
  ) throw requestError();
}

async function execute<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof SearchProviderError) throw error;
    if (error instanceof MeilisearchClientError) {
      throw new SearchProviderError(error.code, error.retryable);
    }
    throw error;
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function capabilityError(): SearchProviderError {
  return new SearchProviderError("SEARCH_ENGINE_VERSION_INCOMPATIBLE", false);
}

function requestError(): SearchProviderError {
  return new SearchProviderError("SEARCH_ENGINE_REQUEST_FAILED", false);
}

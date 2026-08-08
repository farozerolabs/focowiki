import type { LexicalTokenizer } from
  "../../application/ports/lexical-tokenizer.js";
import type {
  SearchFilterExpression,
  SearchProviderIndexDefinition,
  SearchProviderQueryPort,
  SearchProviderRuntime
} from "../../application/ports/search-provider-runtime.js";
import { SearchProviderError } from
  "../../application/ports/search-provider-runtime.js";
import { assertOpenSearchReadiness } from "./opensearch-client.js";
import type { OpenSearchClientPort } from "./opensearch-client-port.js";
import { createOpenSearchBulkWriter } from "./opensearch-bulk-writer.js";
import {
  normalizeOpenSearchError,
  openSearchStatusCode
} from "./opensearch-errors.js";
import { createOpenSearchIndexBody } from "./opensearch-index-schema.js";

type BulkLimits = Parameters<typeof createOpenSearchBulkWriter>[0]["limits"];

const CONTINUATION_VERSION = 1;
const MAXIMUM_SCAN_PAGE_SIZE = 1_000;
const MAXIMUM_DELETE_IDS = 10_000;
const CANONICAL_FIELDS = new Set([
  "id", "schemaVersion", "documentKind", "contentKind", "knowledgeBaseId",
  "sourceFilePublicId", "sourceRevisionPublicId", "logicalPath", "fileKind",
  "title", "segmentOrdinal", "headingAncestors", "searchText", "rankingTerms",
  "okfSignals"
]);

export function createOpenSearchProviderRuntime(input: {
  client: OpenSearchClientPort;
  tokenizer: LexicalTokenizer;
  bulkLimits: BulkLimits;
  visibility: {
    pollIntervalMs: number;
    deadlineMs: number;
  };
  query: SearchProviderQueryPort;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}): SearchProviderRuntime {
  if (!input.tokenizer.contractVersion) throw mappingError();
  assertVisibility(input.visibility);
  const sleep = input.sleep ?? wait;
  const now = input.now ?? Date.now;
  const writeDocuments = createOpenSearchBulkWriter({
    client: input.client,
    tokenizer: input.tokenizer,
    limits: input.bulkLimits,
    ...(input.sleep ? { sleep: input.sleep } : {}),
    ...(input.now ? { now: input.now } : {}),
    ...(input.random ? { random: input.random } : {})
  });

  return Object.freeze<SearchProviderRuntime>({
    kind: "opensearch",
    admin: {
      async health() {
        return execute(() => assertOpenSearchReadiness(input.client));
      },
      async createIndex(request) {
        assertIndexUid(request.indexUid);
        const body = createOpenSearchIndexBody({
          definition: request.definition,
          tokenizerContractVersion: input.tokenizer.contractVersion
        });
        const response = await execute(() => input.client.indices.create({
          index: request.indexUid,
          body
        }));
        if (objectValue(response.body)?.acknowledged !== true) throw requestError();
        return { state: "completed" };
      },
      async getIndex(request) {
        assertIndexUid(request.indexUid);
        const exists = await execute(() => input.client.indices.exists({
          index: request.indexUid
        }));
        if (exists.body === false) return null;
        if (exists.body !== true) throw requestError();
        const definition = await readDefinition(request.indexUid);
        if (!definition) throw mappingError();
        return { indexUid: request.indexUid, primaryKey: definition.primaryKey };
      },
      getIndexDefinition(request) {
        assertIndexUid(request.indexUid);
        return readDefinition(request.indexUid);
      },
      async updateIndexDefinition(request) {
        assertIndexUid(request.indexUid);
        assertDefinition(request.definition);
        const current = await readDefinition(request.indexUid);
        if (!current || !sameDefinition(current, request.definition)) {
          throw mappingError();
        }
        return { state: "completed" };
      },
      async deleteIndex(request) {
        assertIndexUid(request.indexUid);
        try {
          const response = await input.client.indices.delete({
            index: request.indexUid
          });
          if (objectValue(response.body)?.acknowledged !== true) {
            throw requestError();
          }
        } catch (error) {
          if (openSearchStatusCode(error) !== 404) {
            throw normalizeOpenSearchError(error);
          }
        }
        return { state: "completed" };
      }
    },
    write: {
      writeDocuments,
      async deleteDocuments(request) {
        assertIndexUid(request.indexUid);
        assertCorrelation(request.correlation);
        const hasIds = request.documentIds !== undefined;
        const hasFilter = request.filters !== undefined;
        if (hasIds === hasFilter) throw requestError();
        const query = hasIds
          ? idsQuery(request.documentIds!)
          : renderFilter(request.filters!);
        const response = await execute(() => input.client.deleteByQuery({
          index: request.indexUid,
          body: { query },
          conflicts: "proceed",
          refresh: false
        }));
        const body = objectValue(response.body);
        if (
          !body
          || body.timed_out === true
          || !Array.isArray(body.failures)
            && body.deleted === undefined
        ) throw requestError();
        if (Array.isArray(body.failures) && body.failures.length > 0) {
          throw requestError();
        }
        return { state: "completed" };
      },
      async refreshIndex(request) {
        assertIndexUid(request.indexUid);
        await execute(() => input.client.indices.refresh({
          index: request.indexUid
        }));
        const startedAt = now();
        const maximumPolls = Math.ceil(
          input.visibility.deadlineMs / input.visibility.pollIntervalMs
        ) + 1;
        for (let poll = 1; poll <= maximumPolls; poll += 1) {
          const exists = await execute(() => input.client.indices.exists({
            index: request.indexUid
          }));
          if (exists.body === true) return;
          if (exists.body !== false) throw requestError();
          const elapsedMs = Math.max(0, now() - startedAt);
          if (poll === maximumPolls || elapsedMs >= input.visibility.deadlineMs) {
            throw timeoutError();
          }
          await sleep(Math.min(
            input.visibility.pollIntervalMs,
            input.visibility.deadlineMs - elapsedMs
          ));
        }
      }
    },
    query: input.query,
    validation: {
      async countDocuments(request) {
        assertIndexUid(request.indexUid);
        const response = await execute(() => input.client.count({
          index: request.indexUid,
          body: { query: { match_all: {} } }
        }));
        const count = objectValue(response.body)?.count;
        if (!Number.isSafeInteger(count) || Number(count) < 0) throw requestError();
        return Number(count);
      },
      async scanDocuments(request) {
        assertIndexUid(request.indexUid);
        assertScanRequest(request.limit, request.fields);
        const after = decodeContinuation(request.continuation, request.indexUid);
        const response = await execute(() => input.client.search({
          index: request.indexUid,
          body: {
            _source: [...request.fields],
            query: { match_all: {} },
            size: request.limit + 1,
            sort: [{ id: "asc" }],
            track_total_hits: false,
            ...(after ? { search_after: [after] } : {})
          }
        }));
        const hits = parseHits(response.body);
        const pageHits = hits.slice(0, request.limit);
        return {
          documents: pageHits.map((hit) => hit.source),
          continuation: hits.length > request.limit
            ? encodeContinuation(request.indexUid, pageHits.at(-1)!.id)
            : null
        };
      }
    },
    operations: {
      async getOperation() {
        throw requestError();
      },
      async findOperationByCorrelation(request) {
        assertIndexUid(request.indexUid);
        assertCorrelation(request.correlation);
        return null;
      }
    },
    close() {
      return execute(() => input.client.close());
    }
  });

  async function readDefinition(
    indexUid: string
  ): Promise<SearchProviderIndexDefinition | null> {
    let response: Awaited<ReturnType<OpenSearchClientPort["indices"]["getMapping"]>>;
    try {
      response = await input.client.indices.getMapping({ index: indexUid });
    } catch (error) {
      if (openSearchStatusCode(error) === 404) return null;
      throw normalizeOpenSearchError(error);
    }
    const index = objectValue(objectValue(response.body)?.[indexUid]);
    const mappings = objectValue(index?.mappings);
    const meta = objectValue(mappings?._meta);
    if (
      mappings?.dynamic !== "strict"
      || meta?.provider !== "opensearch"
      || meta?.tokenizerContractVersion !== input.tokenizer.contractVersion
    ) throw mappingError();
    return parseDefinition(meta.definition);
  }
}

function parseHits(value: unknown): Array<{
  id: string;
  source: Readonly<Record<string, unknown>>;
}> {
  const hits = objectValue(objectValue(value)?.hits)?.hits;
  if (!Array.isArray(hits)) throw requestError();
  return hits.map((value) => {
    const hit = objectValue(value);
    const source = objectValue(hit?._source);
    const sort = hit?.sort;
    if (
      !hit || !source
      || typeof hit._id !== "string" || !hit._id
      || source.id !== hit._id
      || !Array.isArray(sort) || sort.length !== 1 || sort[0] !== hit._id
    ) throw requestError();
    return { id: hit._id, source };
  });
}

function encodeContinuation(indexUid: string, after: string): string {
  return Buffer.from(JSON.stringify({
    v: CONTINUATION_VERSION,
    provider: "opensearch",
    indexUid,
    after
  }), "utf8").toString("base64url");
}

function decodeContinuation(value: string | null, indexUid: string): string | null {
  if (value === null) return null;
  if (!value || value.length > 4_096) throw requestError();
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    const record = objectValue(decoded);
    if (
      record?.v !== CONTINUATION_VERSION
      || record.provider !== "opensearch"
      || record.indexUid !== indexUid
      || typeof record.after !== "string" || !record.after
      || Object.keys(record).length !== 4
    ) throw requestError();
    return record.after;
  } catch (error) {
    if (error instanceof SearchProviderError) throw error;
    throw requestError();
  }
}

function idsQuery(ids: readonly string[]) {
  if (
    ids.length === 0 || ids.length > MAXIMUM_DELETE_IDS
    || ids.some((id) => !id || Buffer.byteLength(id, "utf8") > 512)
  ) throw requestError();
  return { ids: { values: [...new Set(ids)] } };
}

function renderFilter(filter: SearchFilterExpression): Record<string, unknown> {
  if (filter.kind === "equals" || filter.kind === "boolean") {
    return { term: { [filter.field]: filter.value } };
  }
  if (filter.kind === "range") {
    if (!Number.isSafeInteger(filter.value)) throw requestError();
    return { range: { [filter.field]: { [filter.operator]: filter.value } } };
  }
  if (filter.operands.length === 0 || filter.operands.length > 100) {
    throw requestError();
  }
  const rendered = filter.operands.map(renderFilter);
  return filter.kind === "and"
    ? { bool: { filter: rendered } }
    : { bool: { should: rendered, minimum_should_match: 1 } };
}

function assertScanRequest(limit: number, fields: readonly string[]) {
  if (
    !Number.isSafeInteger(limit) || limit < 1 || limit > MAXIMUM_SCAN_PAGE_SIZE
    || fields.length === 0 || fields.length > CANONICAL_FIELDS.size
    || fields.some((field) => !CANONICAL_FIELDS.has(field))
  ) throw requestError();
}

function parseDefinition(value: unknown): SearchProviderIndexDefinition {
  const record = objectValue(value);
  if (!record) throw mappingError();
  const definition = {
    primaryKey: record.primaryKey,
    searchableAttributes: stringArray(record.searchableAttributes),
    filterableAttributes: stringArray(record.filterableAttributes),
    displayedAttributes: stringArray(record.displayedAttributes),
    rankingRules: stringArray(record.rankingRules),
    distinctAttribute: record.distinctAttribute,
    maximumTotalHits: record.maximumTotalHits,
    searchCutoffMs: record.searchCutoffMs,
    typoDisabledAttributes: stringArray(record.typoDisabledAttributes)
  };
  if (Object.keys(record).length !== 9) throw mappingError();
  assertDefinition(definition);
  return definition;
}

function assertDefinition(
  value: Record<string, unknown>
): asserts value is SearchProviderIndexDefinition {
  if (
    value.primaryKey !== "id"
    || value.distinctAttribute !== "sourceFilePublicId"
    || !Number.isSafeInteger(value.maximumTotalHits)
    || Number(value.maximumTotalHits) < 1
    || !Number.isSafeInteger(value.searchCutoffMs)
    || Number(value.searchCutoffMs) < 1
    || Object.values(value).some((item) => item === null)
  ) throw mappingError();
}

function stringArray(value: unknown): string[] {
  if (
    !Array.isArray(value) || value.length > 100
    || value.some((item) => typeof item !== "string" || !item)
  ) throw mappingError();
  return [...value];
}

function sameDefinition(
  left: SearchProviderIndexDefinition,
  right: SearchProviderIndexDefinition
) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function execute<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw normalizeOpenSearchError(error);
  }
}

function assertIndexUid(value: string) {
  if (!/^[A-Za-z0-9_-]{1,255}$/u.test(value)) throw requestError();
}

function assertCorrelation(value: string) {
  if (!value || Buffer.byteLength(value, "utf8") > 512) throw requestError();
}

function assertVisibility(input: {
  pollIntervalMs: number;
  deadlineMs: number;
}) {
  if (
    !Number.isSafeInteger(input.pollIntervalMs) || input.pollIntervalMs < 1
    || !Number.isSafeInteger(input.deadlineMs) || input.deadlineMs < 1
    || input.pollIntervalMs > input.deadlineMs
  ) throw requestError();
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function mappingError() {
  return new SearchProviderError("SEARCH_ENGINE_MAPPING_INVALID", false);
}

function requestError() {
  return new SearchProviderError("SEARCH_ENGINE_REQUEST_FAILED", false);
}

function timeoutError() {
  return new SearchProviderError("SEARCH_ENGINE_TIMEOUT", true);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

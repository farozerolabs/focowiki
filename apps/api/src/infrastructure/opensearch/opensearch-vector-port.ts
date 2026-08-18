import type {
  SearchProviderVectorDocument,
  SearchProviderVectorFamily,
  SearchProviderVectorHit,
  SearchProviderVectorIndexDefinition,
  SearchProviderVectorPort
} from "../../application/ports/search-provider-runtime.js";
import {
  SEARCH_PROVIDER_MINIMUM_VECTOR_RELEVANCE_SCORE,
  SearchProviderError,
  sameSearchProviderVectorIndexDefinition
} from
  "../../application/ports/search-provider-runtime.js";
import type { OpenSearchClientPort } from "./opensearch-client-port.js";
import { normalizeOpenSearchError } from "./opensearch-errors.js";

const MAXIMUM_OPENSEARCH_VECTOR_DIMENSION = 16_000;

export function createOpenSearchVectorPort(input: {
  client: OpenSearchClientPort;
  maximumBulkBytes?: number;
  maximumAttempts?: number;
  retryDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}): SearchProviderVectorPort {
  const maximumBulkBytes = input.maximumBulkBytes ?? 32 * 1_024 * 1_024;
  const maximumAttempts = input.maximumAttempts ?? 3;
  const retryDelayMs = input.retryDelayMs ?? 100;
  const sleep = input.sleep ?? wait;
  if (!Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1
    || maximumAttempts > 20 || !Number.isSafeInteger(retryDelayMs)
    || retryDelayMs < 0 || retryDelayMs > 60_000) throw requestError();
  const port: SearchProviderVectorPort = {
    async createIndex(request) {
      assertOpenSearchDimension(request.definition.dimension);
      const response = await execute(() => input.client.indices.create({
        index: request.indexUid,
        body: createVectorIndexBody(request.definition)
      }));
      if (record(response.body)?.acknowledged !== true) throw requestError();
      return { state: "completed" };
    },
    async deleteIndex(request) {
      let response;
      try {
        response = await input.client.indices.delete({
          index: request.indexUid
        });
      } catch (error) {
        const status = record(error)?.statusCode
          ?? record(record(error)?.meta)?.statusCode;
        if (status === 404) return { state: "completed" };
        throw normalizeOpenSearchError(error);
      }
      if (record(response.body)?.acknowledged !== true) throw requestError();
      return { state: "completed" };
    },
    async getIndexDefinition(request) {
      let response;
      try {
        response = await input.client.indices.getMapping({ index: request.indexUid });
      } catch (error) {
        const status = record(error)?.statusCode ?? record(record(error)?.meta)?.statusCode;
        if (status === 404) return null;
        throw normalizeOpenSearchError(error);
      }
      const index = record(record(response.body)?.[request.indexUid]);
      const mappings = record(index?.mappings);
      const meta = record(mappings?._meta);
      const properties = record(mappings?.properties);
      const vector = record(properties?.vector);
      const definition = meta?.vectorDefinition;
      if (mappings?.dynamic !== "strict" || meta?.provider !== "opensearch"
        || !isDefinition(definition)
        || vector?.type !== "knn_vector"
        || vector.dimension !== definition.dimension) throw mappingError();
      return structuredClone(definition);
    },
    async writeDocuments(request) {
      const batches = splitBulkDocuments(
        request.indexUid,
        request.documents,
        maximumBulkBytes
      );
      for (const batch of batches) {
        await writeBatch(request.indexUid, batch);
      }
      return { state: "completed" };
    },
    async deleteDocuments(request) {
      const response = await execute(() => input.client.deleteByQuery({
        index: request.indexUid,
        conflicts: "proceed",
        refresh: false,
        body: {
          query: {
            bool: {
              filter: [
                { ids: { values: [...request.documentIds] } },
                { term: { knowledgeBaseId: request.knowledgeBaseId } },
                { term: {
                  semanticGenerationPublicId: request.semanticGenerationPublicId
                } }
              ]
            }
          }
        }
      }));
      const value = record(response.body);
      if (!value || value.timed_out === true
        || Array.isArray(value.failures) && value.failures.length > 0
        || !Number.isSafeInteger(value.deleted)) throw requestError();
      return { state: "completed" };
    },
    async query(request) {
      assertOpenSearchDimension(request.dimension);
      const minimumRelevance = request.minimumRelevance
        ?? SEARCH_PROVIDER_MINIMUM_VECTOR_RELEVANCE_SCORE;
      assertMinimumRelevance(minimumRelevance);
      const response = await execute(() => input.client.search({
        index: request.indexUid,
        body: {
          _source: { excludes: ["vector"] },
          size: request.limit,
          track_total_hits: false,
          query: {
            knn: {
              vector: {
                vector: [...request.vector],
                min_score: cosineSimilarityToOpenSearchScore(minimumRelevance),
                filter: {
                  bool: {
                    filter: scopeFilters(request)
                  }
                }
              }
            }
          }
        }
      }, { requestTimeout: request.deadlineMs }));
      const value = record(response.body);
      const hits = record(value?.hits)?.hits;
      if (!Array.isArray(hits)) throw requestError();
      return {
        hits: hits.map((hit, index) => parseHit(hit, index + 1)),
        processingTimeMs: Number.isFinite(value?.took) ? Number(value?.took) : 0
      };
    },
    async count(request) {
      const response = await execute(() => input.client.count({
        index: request.indexUid,
        body: {
          query: { bool: { filter: scopeFilters(request) } }
        }
      }));
      const count = record(response.body)?.count;
      if (!Number.isSafeInteger(count) || Number(count) < 0) throw requestError();
      return Number(count);
    },
    async scan(request) {
      const after = decodeContinuation(request.continuation, request.indexUid);
      const response = await execute(() => input.client.search({
        index: request.indexUid,
        body: {
          _source: { excludes: ["vector"] },
          query: { bool: { filter: scopeFilters(request) } },
          size: request.limit + 1,
          sort: [{ id: "asc" }],
          track_total_hits: false,
          ...(after ? { search_after: [after] } : {})
        }
      }));
      const hits = record(record(response.body)?.hits)?.hits;
      if (!Array.isArray(hits)) throw requestError();
      const page = hits.slice(0, request.limit).map(parseScanDocument);
      return {
        documents: page,
        continuation: hits.length > request.limit && page.length > 0
          ? encodeContinuation(request.indexUid, page.at(-1)!.id)
          : null
      };
    },
    async validate(request) {
      const [definition, response] = await Promise.all([
        port.getIndexDefinition({ indexUid: request.indexUid }),
        execute(() => input.client.count({
          index: request.indexUid,
          body: { query: { match_all: {} } }
        }))
      ]);
      const count = record(response.body)?.count;
      if (!Number.isSafeInteger(count) || Number(count) < 0) throw requestError();
      return {
        valid: definition !== null
          && sameSearchProviderVectorIndexDefinition(definition, request.definition)
          && Number(count) === request.expectedDocumentCount,
        documentCount: Number(count)
      };
    },
    async activateCandidate() {
      return { state: "completed" };
    },
    async getOperation() {
      return { state: "completed" };
    },
    async findOperationByCorrelation() {
      return null;
    }
  };
  return Object.freeze(port);

  async function writeBatch(
    indexUid: string,
    documents: readonly SearchProviderVectorDocument[]
  ): Promise<void> {
    let pending = [...documents];
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      const body = bulkBody(indexUid, pending);
      try {
        const response = await execute(() => input.client.bulk({ body }, {
          maxRetries: 0,
          requestTimeout: 30_000
        }));
        pending = retryableBulkDocuments(response.body, pending);
      } catch (error) {
        if (!(error instanceof SearchProviderError) || !error.retryable) throw error;
      }
      if (pending.length === 0) return;
      if (attempt === maximumAttempts) {
        throw new SearchProviderError("SEARCH_ENGINE_OVERLOADED", true);
      }
      await sleep(retryDelayMs * attempt);
    }
    throw requestError();
  }
}

function splitBulkDocuments(
  indexUid: string,
  documents: readonly SearchProviderVectorDocument[],
  maximumBulkBytes: number
): SearchProviderVectorDocument[][] {
  const batches: SearchProviderVectorDocument[][] = [];
  let batch: SearchProviderVectorDocument[] = [];
  let batchBytes = 2;
  for (const document of documents) {
    const pair = bulkBody(indexUid, [document]);
    const pairBytes = Buffer.byteLength(JSON.stringify(pair), "utf8");
    if (pairBytes > maximumBulkBytes) throw mappingError();
    const addedBytes = pairBytes - 2 + (batch.length === 0 ? 0 : 1);
    if (batch.length > 0 && batchBytes + addedBytes > maximumBulkBytes) {
      batches.push(batch);
      batch = [];
      batchBytes = 2;
    }
    batch.push(document);
    batchBytes += pairBytes - 2 + (batch.length === 1 ? 0 : 1);
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

function bulkBody(
  indexUid: string,
  documents: readonly SearchProviderVectorDocument[]
): unknown[] {
  return documents.flatMap((document) => [
    { index: { _index: indexUid, _id: document.id } },
    serializeDocument(document)
  ]);
}

function createVectorIndexBody(definition: SearchProviderVectorIndexDefinition) {
  return {
    settings: { index: { knn: true } },
    mappings: {
      dynamic: "strict",
      _meta: {
        provider: "opensearch",
        vectorDefinition: structuredClone(definition)
      },
      properties: {
        id: keyword(),
        knowledgeBaseId: keyword(),
        semanticGenerationPublicId: keyword(),
        ownerPublicId: keyword(),
        family: keyword(),
        sourceFilePublicId: keyword(),
        sourceRevisionPublicId: keyword(),
        embeddingConfigurationRevisionPublicId: keyword(),
        evidenceTargetPath: keyword(),
        sourceExcerpt: { type: "text", index: false },
        fileKind: keyword(),
        okfStatus: keyword(),
        okfTrustTier: keyword(),
        okfStaleAfterEpochDay: { type: "long" },
        vector: {
          type: "knn_vector",
          dimension: definition.dimension,
          space_type: "cosinesimil",
          method: {
            name: "hnsw",
            engine: "lucene",
            parameters: { ef_construction: 128, m: 16 }
          }
        }
      }
    }
  };
}

function serializeDocument(document: SearchProviderVectorDocument) {
  return {
    id: document.id,
    knowledgeBaseId: document.knowledgeBaseId,
    semanticGenerationPublicId: document.semanticGenerationPublicId,
    ownerPublicId: document.ownerPublicId,
    family: document.family,
    sourceFilePublicId: document.sourceFilePublicId,
    sourceRevisionPublicId: document.sourceRevisionPublicId,
    embeddingConfigurationRevisionPublicId:
      document.embeddingConfigurationRevisionPublicId,
    evidenceTargetPath: document.evidenceTargetPath,
    sourceExcerpt: document.sourceExcerpt ?? "",
    fileKind: document.fileKind ?? "page",
    okfStatus: document.okfStatus ?? null,
    okfTrustTier: document.okfTrustTier ?? null,
    okfStaleAfterEpochDay: document.okfStaleAfterEpochDay ?? null,
    vector: [...document.vector]
  };
}

function retryableBulkDocuments(
  value: unknown,
  documents: readonly SearchProviderVectorDocument[]
): SearchProviderVectorDocument[] {
  const items = record(value)?.items;
  if (!Array.isArray(items) || items.length !== documents.length) throw requestError();
  const retryable: SearchProviderVectorDocument[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const outcome = record(record(items[index])?.index);
    const status = Number(outcome?.status);
    if (outcome?._id !== documents[index]!.id || !Number.isSafeInteger(status)) {
      throw requestError();
    }
    if (status >= 200 && status < 300) continue;
    if ([408, 429, 502, 503, 504].includes(status)) {
      retryable.push(documents[index]!);
      continue;
    }
    throw requestError();
  }
  return retryable;
}

function parseHit(value: unknown, rank: number): SearchProviderVectorHit {
  const hit = record(value);
  const source = record(hit?._source);
  if (!hit || !source || hit._id !== source.id) throw requestError();
  return {
    documentId: string(source.id),
    sourceFilePublicId: string(source.sourceFilePublicId),
    sourceRevisionPublicId: string(source.sourceRevisionPublicId),
    ownerPublicId: string(source.ownerPublicId),
    family: family(source.family),
    evidenceTargetPath: string(source.evidenceTargetPath),
    sourceExcerpt: string(source.sourceExcerpt),
    rank
  };
}

function parseScanDocument(value: unknown) {
  const hit = record(value);
  const source = record(hit?._source);
  if (!hit || !source || hit._id !== source.id) throw requestError();
  return {
    id: string(source.id),
    knowledgeBaseId: string(source.knowledgeBaseId),
    semanticGenerationPublicId: string(source.semanticGenerationPublicId),
    ownerPublicId: string(source.ownerPublicId),
    family: family(source.family),
    sourceFilePublicId: string(source.sourceFilePublicId),
    sourceRevisionPublicId: string(source.sourceRevisionPublicId),
    embeddingConfigurationRevisionPublicId:
      string(source.embeddingConfigurationRevisionPublicId),
    evidenceTargetPath: string(source.evidenceTargetPath)
  };
}

function scopeFilters(input: {
  knowledgeBaseId: string;
  semanticGenerationPublicId: string;
  embeddingConfigurationRevisionPublicId?: string;
  family?: SearchProviderVectorFamily;
  fileKind?: string | null;
  okfFilters?: {
    status: string | null;
    trustTier: string | null;
    freshness: "fresh" | "stale" | null;
    requestEpochDay: number | null;
  };
}): Array<Record<string, unknown>> {
  return [
    { term: { knowledgeBaseId: input.knowledgeBaseId } },
    { term: { semanticGenerationPublicId: input.semanticGenerationPublicId } },
    ...(input.embeddingConfigurationRevisionPublicId
      ? [{ term: { embeddingConfigurationRevisionPublicId:
        input.embeddingConfigurationRevisionPublicId } }]
      : []),
    ...(input.family ? [{ term: { family: input.family } }] : []),
    ...(input.fileKind ? [{ term: { fileKind: input.fileKind } }] : []),
    ...(input.okfFilters?.status
      ? [{ term: { okfStatus: input.okfFilters.status } }] : []),
    ...(input.okfFilters?.trustTier
      ? [{ term: { okfTrustTier: input.okfFilters.trustTier } }] : []),
    ...(input.okfFilters?.freshness && input.okfFilters.requestEpochDay !== null
      ? [{ range: { okfStaleAfterEpochDay: {
          [input.okfFilters.freshness === "stale" ? "lte" : "gt"]:
            input.okfFilters.requestEpochDay
        } } }]
      : [])
  ];
}

function assertMinimumRelevance(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw requestError();
}

function cosineSimilarityToOpenSearchScore(similarity: number): number {
  return (1 + similarity) / 2;
}

function isDefinition(value: unknown): value is SearchProviderVectorIndexDefinition {
  const item = record(value);
  return Boolean(item && typeof item.schemaVersion === "string"
    && Number.isSafeInteger(item.dimension)
    && item.similarity === "cosine"
    && Array.isArray(item.families)
    && typeof item.mappingFingerprintSha256 === "string");
}

function encodeContinuation(indexUid: string, after: string): string {
  return Buffer.from(JSON.stringify({ provider: "opensearch", indexUid, after }))
    .toString("base64url");
}

function decodeContinuation(value: string | null, indexUid: string): string | null {
  if (value === null) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    const item = record(decoded);
    if (item?.provider !== "opensearch" || item.indexUid !== indexUid
      || typeof item.after !== "string" || !item.after) throw requestError();
    return item.after;
  } catch (error) {
    if (error instanceof SearchProviderError) throw error;
    throw requestError();
  }
}

function assertOpenSearchDimension(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1
    || value > MAXIMUM_OPENSEARCH_VECTOR_DIMENSION) throw mappingError();
}

function family(value: unknown): SearchProviderVectorFamily {
  if (!["content", "entity", "relationship", "community"].includes(String(value))) {
    throw requestError();
  }
  return value as SearchProviderVectorFamily;
}

function string(value: unknown): string {
  if (typeof value !== "string" || !value) throw requestError();
  return value;
}

function keyword() {
  return { type: "keyword" as const };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

async function execute<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof SearchProviderError) throw error;
    throw normalizeOpenSearchError(error);
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function mappingError(): SearchProviderError {
  return new SearchProviderError("SEARCH_ENGINE_MAPPING_INVALID", false);
}

function requestError(): SearchProviderError {
  return new SearchProviderError("SEARCH_ENGINE_REQUEST_FAILED", false);
}

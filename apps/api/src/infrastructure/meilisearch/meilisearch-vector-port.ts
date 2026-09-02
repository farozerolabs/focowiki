import type {
  SearchProviderOperationReceipt,
  SearchProviderOperationStatus,
  SearchProviderVectorDocument,
  SearchProviderVectorFamily,
  SearchProviderVectorHit,
  SearchProviderVectorIndexDefinition,
  SearchProviderVectorPort
} from "../../application/ports/search-provider-runtime.js";
import {
  SearchProviderError,
  sameSearchProviderVectorIndexDefinition
} from
  "../../application/ports/search-provider-runtime.js";
import type {
  MeilisearchClientPort,
  MeilisearchSettings,
  MeilisearchTask
} from "./meilisearch-client-port.js";
import { MeilisearchClientError } from "./meilisearch-client-port.js";

const OPERATION_PREFIX = "meilisearch:";
const CONTINUATION_PREFIX = "meilisearch-vector-offset:";
const EMBEDDER_PREFIX = "focowiki_";

export function createMeilisearchVectorPort(input: {
  transport: MeilisearchClientPort;
}): SearchProviderVectorPort {
  const port: SearchProviderVectorPort = {
    async createIndex(request) {
      await execute(() => input.transport.createIndex({
        indexUid: request.indexUid,
        primaryKey: "id"
      }));
      return pending(await execute(() => input.transport.updateSettings({
        indexUid: request.indexUid,
        settings: vectorSettings(request.definition)
      })));
    },
    async deleteIndex(request) {
      return pending(await execute(() => input.transport.deleteIndex(
        request.indexUid
      )));
    },
    async getIndexDefinition(request) {
      const index = await execute(() => input.transport.getIndex({
        indexUid: request.indexUid
      }));
      if (!index) return null;
      return definitionFromSettings(await execute(
        () => input.transport.getSettings(request.indexUid)
      ));
    },
    async writeDocuments(request) {
      const embedder = embedderName(request.definition);
      return pending(await execute(() => input.transport.addDocuments({
        indexUid: request.indexUid,
        primaryKey: "id",
        documents: request.documents.map((document) => ({
          ...withoutVector(document),
          _vectors: { [embedder]: [...document.vector] }
        })),
        correlation: request.correlation
      })));
    },
    async deleteDocuments(request) {
      return pending(await execute(() => input.transport.deleteDocuments({
        indexUid: request.indexUid,
        filter: [
          `knowledgeBaseId = ${JSON.stringify(request.knowledgeBaseId)}`,
          `semanticGenerationPublicId = ${JSON.stringify(
            request.semanticGenerationPublicId
          )}`,
          `id IN [${request.documentIds.map((id) => JSON.stringify(id)).join(",")}]`
        ].join(" AND "),
        correlation: request.correlation
      })));
    },
    async query(request) {
      const definition = await requireDefinition(port, request.indexUid);
      if (definition.dimension !== request.dimension) throw mappingError();
      if (request.minimumRelevance !== undefined) {
        assertMinimumRelevance(request.minimumRelevance);
      }
      const result = await execute(() => input.transport.search({
        indexUid: request.indexUid,
        query: "",
        filter: scopeFilter(request),
        limit: request.limit,
        attributesToRetrieve: displayedAttributes(),
        attributesToCrop: [],
        cropLength: 0,
        matchingStrategy: "all",
        vector: [...request.vector],
        hybrid: { embedder: embedderName(definition), semanticRatio: 1 },
        ...(request.minimumRelevance === undefined ? {} : {
          rankingScoreThreshold: cosineSimilarityToMeilisearchScore(
            request.minimumRelevance
          )
        })
      }));
      return {
        hits: result.hits.map((hit, index) => parseHit(hit, index + 1)),
        processingTimeMs: result.processingTimeMs
      };
    },
    async count(request) {
      const result = await execute(() => input.transport.search({
        indexUid: request.indexUid,
        query: "",
        filter: scopeFilter(request),
        limit: 0,
        attributesToRetrieve: ["id"],
        attributesToCrop: [],
        cropLength: 0,
        matchingStrategy: "all"
      }));
      return result.estimatedTotalHits;
    },
    async scan(request) {
      const offset = decodeContinuation(request.continuation);
      const result = await execute(() => input.transport.search({
        indexUid: request.indexUid,
        query: "",
        filter: scopeFilter(request),
        offset,
        limit: request.limit,
        attributesToRetrieve: displayedAttributes(),
        attributesToCrop: [],
        cropLength: 0,
        matchingStrategy: "all"
      }));
      const documents = result.hits.map(parseScanDocument);
      return {
        documents,
        continuation: offset + documents.length < result.estimatedTotalHits
          && documents.length > 0
          ? encodeContinuation(offset + documents.length)
          : null
      };
    },
    async validate(request) {
      const getStats = input.transport.getIndexStats;
      if (!getStats) throw capabilityError();
      const [definition, stats] = await Promise.all([
        port.getIndexDefinition({ indexUid: request.indexUid }),
        execute(() => getStats({ indexUid: request.indexUid }))
      ]);
      return {
        valid: definition !== null
          && sameSearchProviderVectorIndexDefinition(definition, request.definition)
          && stats.numberOfDocuments === request.expectedDocumentCount,
        documentCount: stats.numberOfDocuments
      };
    },
    async activateCandidate() {
      return { state: "completed" };
    },
    async getOperation(request) {
      return operationStatus(await execute(() => input.transport.getTask(
        decodeOperationRef(request.operationRef)
      )));
    },
    async findOperationByCorrelation(request) {
      const find = input.transport.findTaskByCorrelation;
      if (!find) throw capabilityError();
      const task = await execute(() => find(request));
      if (!task) return null;
      return task.status === "succeeded"
        ? { state: "completed" }
        : { state: "pending", operationRef: encodeOperationRef(task.taskUid) };
    }
  };
  return Object.freeze(port);
}

function vectorSettings(
  definition: SearchProviderVectorIndexDefinition
): MeilisearchSettings {
  return {
    searchableAttributes: [],
    filterableAttributes: [
      "id", "knowledgeBaseId", "semanticGenerationPublicId", "family",
      "embeddingConfigurationRevisionPublicId", "sourceFilePublicId",
      "sourceRevisionPublicId", "ownerPublicId", "fileKind", "okfStatus",
      "okfTrustTier", "okfStaleAfterEpochDay"
    ],
    displayedAttributes: displayedAttributes(),
    sortableAttributes: [],
    rankingRules: ["sort", "words", "typo", "proximity", "attribute", "exactness"],
    distinctAttribute: null,
    pagination: { maxTotalHits: 1_000 },
    searchCutoffMs: 1_000,
    localizedAttributes: [],
    typoTolerance: { disableOnAttributes: [] },
    embedders: {
      [embedderName(definition)]: {
        source: "userProvided",
        dimensions: definition.dimension
      }
    }
  };
}

function definitionFromSettings(
  settings: MeilisearchSettings
): SearchProviderVectorIndexDefinition {
  const entries = Object.entries(settings.embedders ?? {})
    .filter(([name, value]) => name.startsWith(EMBEDDER_PREFIX)
      && value.source === "userProvided");
  if (entries.length !== 1) throw mappingError();
  const [name, embedder] = entries[0]!;
  const fingerprint = name.slice(EMBEDDER_PREFIX.length);
  if (!/^[0-9a-f]{64}$/u.test(fingerprint)
    || !Number.isSafeInteger(embedder.dimensions) || embedder.dimensions < 1) {
    throw mappingError();
  }
  return {
    schemaVersion: "focowiki-semantic-vector-v1",
    dimension: embedder.dimensions,
    similarity: "cosine",
    families: ["content", "entity", "relationship", "community"],
    mappingFingerprintSha256: fingerprint
  };
}

async function requireDefinition(
  port: SearchProviderVectorPort,
  indexUid: string
): Promise<SearchProviderVectorIndexDefinition> {
  const value = await port.getIndexDefinition({ indexUid });
  if (!value) throw mappingError();
  return value;
}

function withoutVector(document: SearchProviderVectorDocument) {
  const { vector: _vector, ...safe } = document;
  return safe;
}

function parseHit(value: Record<string, unknown>, rank: number): SearchProviderVectorHit {
  return {
    documentId: string(value.id),
    sourceFilePublicId: string(value.sourceFilePublicId),
    sourceRevisionPublicId: string(value.sourceRevisionPublicId),
    ownerPublicId: string(value.ownerPublicId),
    family: family(value.family),
    evidenceTargetPath: string(value.evidenceTargetPath),
    sourceExcerpt: string(value.sourceExcerpt),
    rank
  };
}

function parseScanDocument(value: Record<string, unknown>) {
  return {
    id: string(value.id),
    knowledgeBaseId: string(value.knowledgeBaseId),
    semanticGenerationPublicId: string(value.semanticGenerationPublicId),
    ownerPublicId: string(value.ownerPublicId),
    family: family(value.family),
    sourceFilePublicId: string(value.sourceFilePublicId),
    sourceRevisionPublicId: string(value.sourceRevisionPublicId),
    embeddingConfigurationRevisionPublicId:
      string(value.embeddingConfigurationRevisionPublicId),
    evidenceTargetPath: string(value.evidenceTargetPath)
  };
}

function scopeFilter(input: {
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
}): string {
  return [
    `knowledgeBaseId = ${JSON.stringify(input.knowledgeBaseId)}`,
    `semanticGenerationPublicId = ${JSON.stringify(
      input.semanticGenerationPublicId
    )}`,
    ...(input.embeddingConfigurationRevisionPublicId
      ? [`embeddingConfigurationRevisionPublicId = ${JSON.stringify(
        input.embeddingConfigurationRevisionPublicId
      )}`] : []),
    ...(input.family ? [`family = ${JSON.stringify(input.family)}`] : []),
    ...(input.fileKind ? [`fileKind = ${JSON.stringify(input.fileKind)}`] : []),
    ...(input.okfFilters?.status
      ? [`okfStatus = ${JSON.stringify(input.okfFilters.status)}`] : []),
    ...(input.okfFilters?.trustTier
      ? [`okfTrustTier = ${JSON.stringify(input.okfFilters.trustTier)}`] : []),
    ...(input.okfFilters?.freshness && input.okfFilters.requestEpochDay !== null
      ? [`okfStaleAfterEpochDay ${input.okfFilters.freshness === "stale" ? "<=" : ">"} ${
          input.okfFilters.requestEpochDay
        }`]
      : [])
  ].join(" AND ");
}

function displayedAttributes(): string[] {
  return [
    "id", "knowledgeBaseId", "semanticGenerationPublicId", "ownerPublicId",
    "family", "sourceFilePublicId", "sourceRevisionPublicId",
    "embeddingConfigurationRevisionPublicId", "evidenceTargetPath",
    "sourceExcerpt", "fileKind", "okfStatus", "okfTrustTier",
    "okfStaleAfterEpochDay"
  ];
}

function assertMinimumRelevance(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw requestError();
}

function cosineSimilarityToMeilisearchScore(value: number): number {
  return (value + 1) / 2;
}

function embedderName(definition: SearchProviderVectorIndexDefinition): string {
  return `${EMBEDDER_PREFIX}${definition.mappingFingerprintSha256}`;
}

function pending(value: { taskUid: number }): SearchProviderOperationReceipt {
  return { state: "pending", operationRef: encodeOperationRef(value.taskUid) };
}

function operationStatus(task: MeilisearchTask): SearchProviderOperationStatus {
  if (task.status === "succeeded") return { state: "completed" };
  if (["failed", "canceled", "unknown"].includes(task.status)) {
    return { state: "failed", errorCode: "SEARCH_ENGINE_REQUEST_FAILED" };
  }
  return { state: "pending" };
}

function encodeOperationRef(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw requestError();
  return `${OPERATION_PREFIX}${value}`;
}

function decodeOperationRef(value: string): number {
  const match = /^meilisearch:(\d+)$/u.exec(value);
  const number = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(number) || number < 0) throw requestError();
  return number;
}

function encodeContinuation(offset: number): string {
  return `${CONTINUATION_PREFIX}${offset}`;
}

function decodeContinuation(value: string | null): number {
  if (value === null) return 0;
  const encoded = value.startsWith(CONTINUATION_PREFIX)
    ? value.slice(CONTINUATION_PREFIX.length) : "";
  const offset = /^\d+$/u.test(encoded) ? Number(encoded) : Number.NaN;
  if (!Number.isSafeInteger(offset) || offset < 0) throw requestError();
  return offset;
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

function capabilityError(): SearchProviderError {
  return new SearchProviderError("SEARCH_ENGINE_VERSION_INCOMPATIBLE", false);
}

function mappingError(): SearchProviderError {
  return new SearchProviderError("SEARCH_ENGINE_MAPPING_INVALID", false);
}

function requestError(): SearchProviderError {
  return new SearchProviderError("SEARCH_ENGINE_REQUEST_FAILED", false);
}

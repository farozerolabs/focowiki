import {
  SearchProviderError,
  type SearchProviderOperationReceipt,
  type SearchProviderVectorDocument,
  type SearchProviderVectorFamily,
  type SearchProviderVectorHit,
  type SearchProviderVectorIndexDefinition,
  type SearchProviderVectorPort
} from "../../application/ports/search-provider-runtime.js";

const FAMILIES: readonly SearchProviderVectorFamily[] = [
  "content", "entity", "relationship", "community"
];
const MAXIMUM_VECTOR_DIMENSION = 65_536;
const MAXIMUM_DOCUMENT_BATCH = 1_000;
const MAXIMUM_DELETE_BATCH = 10_000;
const MAXIMUM_QUERY_LIMIT = 1_000;

export function createValidatedSearchProviderVectorPort(
  raw: SearchProviderVectorPort
): SearchProviderVectorPort {
  const port: SearchProviderVectorPort = {
    async createIndex(input) {
      assertIndexUid(input.indexUid);
      assertDefinition(input.definition);
      return receipt(await raw.createIndex(input));
    },
    async deleteIndex(input) {
      assertIndexUid(input.indexUid);
      assertCorrelation(input.correlation);
      return receipt(await raw.deleteIndex(input));
    },
    async getIndexDefinition(input) {
      assertIndexUid(input.indexUid);
      const value = await raw.getIndexDefinition(input);
      if (value === null) return null;
      assertDefinition(value);
      return structuredClone(value);
    },
    async writeDocuments(input) {
      assertIndexUid(input.indexUid);
      assertDefinition(input.definition);
      assertCorrelation(input.correlation);
      if (input.documents.length === 0
        || input.documents.length > MAXIMUM_DOCUMENT_BATCH) throw mappingError();
      const ids = new Set<string>();
      for (const document of input.documents) {
        assertDocument(document, input.definition);
        if (ids.has(document.id)) throw mappingError();
        ids.add(document.id);
      }
      return receipt(await raw.writeDocuments(input));
    },
    async deleteDocuments(input) {
      assertIndexUid(input.indexUid);
      assertIdentity(input.knowledgeBaseId);
      assertIdentity(input.semanticGenerationPublicId);
      assertCorrelation(input.correlation);
      if (input.documentIds.length === 0
        || input.documentIds.length > MAXIMUM_DELETE_BATCH
        || new Set(input.documentIds).size !== input.documentIds.length) {
        throw requestError();
      }
      input.documentIds.forEach(assertIdentity);
      return receipt(await raw.deleteDocuments(input));
    },
    async query(input) {
      assertIndexUid(input.indexUid);
      assertIdentity(input.knowledgeBaseId);
      assertIdentity(input.semanticGenerationPublicId);
      assertIdentity(input.embeddingConfigurationRevisionPublicId);
      assertFamily(input.family);
      assertDimension(input.dimension);
      assertVector(input.vector, input.dimension);
      if (!Number.isSafeInteger(input.limit) || input.limit < 1
        || input.limit > MAXIMUM_QUERY_LIMIT
        || !Number.isSafeInteger(input.deadlineMs) || input.deadlineMs < 1
        || input.deadlineMs > 30_000) throw requestError();
      const result = await raw.query(input);
      if (!Number.isFinite(result.processingTimeMs) || result.processingTimeMs < 0
        || result.hits.length > input.limit) throw requestError();
      const hits = result.hits.map((hit, index) => {
        assertHit(hit, input.family, index + 1);
        return structuredClone(hit);
      });
      return { hits, processingTimeMs: result.processingTimeMs };
    },
    async count(input) {
      assertIndexUid(input.indexUid);
      assertIdentity(input.knowledgeBaseId);
      assertIdentity(input.semanticGenerationPublicId);
      if (input.family) assertFamily(input.family);
      const value = await raw.count(input);
      if (!Number.isSafeInteger(value) || value < 0) throw requestError();
      return value;
    },
    async scan(input) {
      assertIndexUid(input.indexUid);
      assertIdentity(input.knowledgeBaseId);
      assertIdentity(input.semanticGenerationPublicId);
      if (!Number.isSafeInteger(input.limit) || input.limit < 1
        || input.limit > MAXIMUM_QUERY_LIMIT
        || input.continuation !== null
          && (!input.continuation || input.continuation.length > 4_096)) {
        throw requestError();
      }
      const page = await raw.scan(input);
      if (page.documents.length > input.limit
        || page.continuation !== null
          && (!page.continuation || page.continuation.length > 4_096)) {
        throw requestError();
      }
      for (const document of page.documents) {
        assertDocumentWithoutVector(document, input);
      }
      return structuredClone(page);
    },
    async validate(input) {
      assertIndexUid(input.indexUid);
      assertDefinition(input.definition);
      if (!Number.isSafeInteger(input.expectedDocumentCount)
        || input.expectedDocumentCount < 0) throw requestError();
      const result = await raw.validate(input);
      if (typeof result.valid !== "boolean"
        || !Number.isSafeInteger(result.documentCount)
        || result.documentCount < 0
        || result.valid && result.documentCount !== input.expectedDocumentCount) {
        throw requestError();
      }
      return result;
    },
    async activateCandidate(input) {
      assertIdentity(input.knowledgeBaseId);
      assertIndexUid(input.candidateIndexUid);
      if (input.expectedActiveIndexUid !== null) {
        assertIndexUid(input.expectedActiveIndexUid);
        if (input.expectedActiveIndexUid === input.candidateIndexUid) throw requestError();
      }
      assertCorrelation(input.correlation);
      return receipt(await raw.activateCandidate(input));
    },
    async getOperation(input) {
      if (!input.operationRef || Buffer.byteLength(input.operationRef) > 4_096) {
        throw requestError();
      }
      const value = await raw.getOperation(input);
      if (value.state === "failed" && !value.errorCode) throw requestError();
      return value;
    },
    async findOperationByCorrelation(input) {
      assertIndexUid(input.indexUid);
      assertCorrelation(input.correlation);
      const value = await raw.findOperationByCorrelation(input);
      return value === null ? null : receipt(value);
    }
  };
  return Object.freeze(port);
}

export function assertSearchProviderVectorDefinition(
  value: SearchProviderVectorIndexDefinition
): void {
  assertDefinition(value);
}

function assertDefinition(value: SearchProviderVectorIndexDefinition): void {
  assertDimension(value.dimension);
  if (!value.schemaVersion || Buffer.byteLength(value.schemaVersion) > 128
    || value.similarity !== "cosine"
    || !/^[0-9a-f]{64}$/u.test(value.mappingFingerprintSha256)
    || value.families.length === 0 || value.families.length > FAMILIES.length
    || new Set(value.families).size !== value.families.length) throw mappingError();
  value.families.forEach(assertFamily);
}

function assertDocument(
  value: SearchProviderVectorDocument,
  definition: SearchProviderVectorIndexDefinition
): void {
  for (const identity of [
    value.id, value.knowledgeBaseId, value.semanticGenerationPublicId,
    value.ownerPublicId, value.sourceFilePublicId, value.sourceRevisionPublicId,
    value.embeddingConfigurationRevisionPublicId
  ]) assertIdentity(identity);
  assertFamily(value.family);
  if (!definition.families.includes(value.family)) throw mappingError();
  assertEvidencePath(value.evidenceTargetPath);
  assertVector(value.vector, definition.dimension);
}

function assertDocumentWithoutVector(
  value: Omit<SearchProviderVectorDocument, "vector">,
  scope: { knowledgeBaseId: string; semanticGenerationPublicId: string }
): void {
  for (const identity of [
    value.id, value.knowledgeBaseId, value.semanticGenerationPublicId,
    value.ownerPublicId, value.sourceFilePublicId, value.sourceRevisionPublicId,
    value.embeddingConfigurationRevisionPublicId
  ]) assertIdentity(identity);
  assertFamily(value.family);
  assertEvidencePath(value.evidenceTargetPath);
  if (value.knowledgeBaseId !== scope.knowledgeBaseId
    || value.semanticGenerationPublicId !== scope.semanticGenerationPublicId) {
    throw requestError();
  }
}

function assertHit(
  hit: SearchProviderVectorHit,
  family: SearchProviderVectorFamily,
  expectedRank: number
): void {
  for (const identity of [
    hit.documentId, hit.sourceFilePublicId,
    hit.sourceRevisionPublicId, hit.ownerPublicId
  ]) assertIdentity(identity);
  assertFamily(hit.family);
  assertEvidencePath(hit.evidenceTargetPath);
  if (hit.family !== family || hit.rank !== expectedRank) throw requestError();
}

function assertVector(value: readonly number[], dimension: number): void {
  if (value.length !== dimension || value.some((item) => !Number.isFinite(item))) {
    throw mappingError();
  }
  const magnitude = value.reduce((sum, item) => sum + item * item, 0);
  if (!Number.isFinite(magnitude) || magnitude === 0) throw mappingError();
}

function assertDimension(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAXIMUM_VECTOR_DIMENSION) {
    throw mappingError();
  }
}

function assertFamily(value: SearchProviderVectorFamily): void {
  if (!FAMILIES.includes(value)) throw mappingError();
}

function assertEvidencePath(value: string): void {
  const segments = value.split("/");
  if (!value || Buffer.byteLength(value) > 4_096 || value.startsWith("/")
    || value.includes("\\") || value.includes("\0")
    || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw mappingError();
  }
}

function assertIndexUid(value: string): void {
  if (!value || Buffer.byteLength(value) > 255 || !/^[a-z0-9][a-z0-9._-]*$/u.test(value)) {
    throw requestError();
  }
}

function assertIdentity(value: string): void {
  if (!value || Buffer.byteLength(value) > 1_024) throw requestError();
}

function assertCorrelation(value: string): void {
  if (!value || Buffer.byteLength(value) > 512) throw requestError();
}

function receipt(value: SearchProviderOperationReceipt): SearchProviderOperationReceipt {
  if (value.state === "completed") return value;
  if (!value.operationRef || Buffer.byteLength(value.operationRef) > 4_096) {
    throw requestError();
  }
  return value;
}

function mappingError(): SearchProviderError {
  return new SearchProviderError("SEARCH_ENGINE_MAPPING_INVALID", false);
}

function requestError(): SearchProviderError {
  return new SearchProviderError("SEARCH_ENGINE_REQUEST_FAILED", false);
}

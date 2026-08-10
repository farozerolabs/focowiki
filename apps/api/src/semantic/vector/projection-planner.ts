import { createHash } from "node:crypto";
import type {
  SearchProviderVectorDocument,
  SearchProviderVectorFamily,
  SearchProviderVectorIndexDefinition
} from "../../application/ports/search-provider-runtime.js";

type VectorUpsert = {
  publicId: string;
  ownerPublicId: string;
  family: SearchProviderVectorFamily;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  artifactPublicId: string;
  evidenceTargetPath: string;
  sourceExcerpt: string;
  fileKind: string;
  okfStatus: "draft" | "stable" | "deprecated" | null;
  okfTrustTier: "unverified" | "machine-confirmed" | "human-reviewed" | null;
  okfStaleAfterEpochDay: number | null;
  vector: readonly number[];
};

export type SemanticVectorProjectionPlan = {
  operationPublicId: string | null;
  knowledgeBaseId: string;
  semanticGenerationPublicId: string;
  projectionContractPublicId: string;
  embeddingConfigurationRevisionPublicId: string;
  candidateIndexUid: string;
  definition: SearchProviderVectorIndexDefinition;
  providerDocuments: readonly SearchProviderVectorDocument[];
  providerDeleteDocumentIds: readonly string[];
  desiredDocuments: readonly {
    publicId: string;
    projectionContractPublicId: string;
    artifactPublicId: string;
    ownerPublicId: string;
    family: SearchProviderVectorFamily;
    sourceFilePublicId: string;
    sourceRevisionPublicId: string;
    evidenceTargetPath: string;
    providerDocumentId: string;
  }[];
  counters: { upserted: number; deleted: number; enumeratedCorpus: 0 };
  fullCorpusRewriteAllowed: false;
};

export function planSemanticVectorProjection(input: {
  operationPublicId?: string | null;
  indexPrefix: string;
  knowledgeBaseId: string;
  semanticGenerationPublicId: string;
  projectionContractPublicId: string;
  embeddingConfigurationRevisionPublicId: string;
  dimension: number;
  mappingFingerprintSha256: string;
  upserts: readonly VectorUpsert[];
  deletes: readonly { publicId: string; ownerPublicId: string }[];
  enumeratedCorpusCount?: number;
}): SemanticVectorProjectionPlan {
  assertIdentity(input.knowledgeBaseId);
  assertIdentity(input.semanticGenerationPublicId);
  assertIdentity(input.projectionContractPublicId);
  assertIdentity(input.embeddingConfigurationRevisionPublicId);
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(input.indexPrefix)) {
    throw planError("invalid index prefix");
  }
  if (!Number.isSafeInteger(input.dimension) || input.dimension < 1
    || input.dimension > 65_536) throw planError("invalid dimension");
  if (!/^[0-9a-f]{64}$/u.test(input.mappingFingerprintSha256)) {
    throw planError("invalid mapping fingerprint");
  }
  if ((input.enumeratedCorpusCount ?? 0) !== 0) {
    throw planError("full corpus enumeration is prohibited");
  }
  if (input.upserts.length > 1_000 || input.deletes.length > 10_000) {
    throw planError("impact batch exceeds bound");
  }
  const ownerKeys = new Set<string>();
  const publicIds = new Set<string>();
  const upserts = [...input.upserts].sort(compareUpserts);
  for (const item of upserts) {
    for (const value of [
      item.publicId, item.ownerPublicId, item.sourceFilePublicId,
      item.sourceRevisionPublicId, item.artifactPublicId
    ]) assertIdentity(value);
    const ownerKey = `${item.family}\0${item.ownerPublicId}`;
    if (ownerKeys.has(ownerKey)) throw planError("duplicate owner");
    if (publicIds.has(item.publicId)) throw planError("duplicate document");
    ownerKeys.add(ownerKey);
    publicIds.add(item.publicId);
    if (item.vector.length !== input.dimension
      || item.vector.some((value) => !Number.isFinite(value))) {
      throw planError("vector dimension or value is invalid");
    }
    if (!item.sourceExcerpt
      || [...item.sourceExcerpt].length > 1_200
      || Buffer.byteLength(item.sourceExcerpt, "utf8") > 4_096
      || !item.fileKind
      || Buffer.byteLength(item.fileKind, "utf8") > 128) {
      throw planError("source projection fields are invalid");
    }
  }
  const deletes = [...input.deletes].sort((left, right) =>
    left.publicId.localeCompare(right.publicId, "en"));
  const deleteIds = new Set<string>();
  for (const item of deletes) {
    assertIdentity(item.publicId);
    assertIdentity(item.ownerPublicId);
    if (deleteIds.has(item.publicId) || publicIds.has(item.publicId)) {
      throw planError("conflicting vector impact");
    }
    deleteIds.add(item.publicId);
  }
  const definition: SearchProviderVectorIndexDefinition = {
    schemaVersion: "focowiki-semantic-vector-v1",
    dimension: input.dimension,
    similarity: "cosine",
    families: ["content", "entity", "relationship", "community"],
    mappingFingerprintSha256: input.mappingFingerprintSha256
  };
  const candidateIndexUid = semanticVectorIndexUid(input);
  return {
    operationPublicId: input.operationPublicId ?? null,
    knowledgeBaseId: input.knowledgeBaseId,
    semanticGenerationPublicId: input.semanticGenerationPublicId,
    projectionContractPublicId: input.projectionContractPublicId,
    embeddingConfigurationRevisionPublicId:
      input.embeddingConfigurationRevisionPublicId,
    candidateIndexUid,
    definition,
    providerDocuments: upserts.map((item) => ({
      id: item.publicId,
      knowledgeBaseId: input.knowledgeBaseId,
      semanticGenerationPublicId: input.semanticGenerationPublicId,
      ownerPublicId: item.ownerPublicId,
      family: item.family,
      sourceFilePublicId: item.sourceFilePublicId,
      sourceRevisionPublicId: item.sourceRevisionPublicId,
      embeddingConfigurationRevisionPublicId:
        input.embeddingConfigurationRevisionPublicId,
      evidenceTargetPath: item.evidenceTargetPath,
      sourceExcerpt: item.sourceExcerpt,
      fileKind: item.fileKind,
      okfStatus: item.okfStatus,
      okfTrustTier: item.okfTrustTier,
      okfStaleAfterEpochDay: item.okfStaleAfterEpochDay,
      vector: [...item.vector]
    })),
    providerDeleteDocumentIds: deletes.map((item) => item.publicId),
    desiredDocuments: upserts.map((item) => ({
      publicId: item.publicId,
      projectionContractPublicId: input.projectionContractPublicId,
      artifactPublicId: item.artifactPublicId,
      ownerPublicId: item.ownerPublicId,
      family: item.family,
      sourceFilePublicId: item.sourceFilePublicId,
      sourceRevisionPublicId: item.sourceRevisionPublicId,
      evidenceTargetPath: item.evidenceTargetPath,
      providerDocumentId: item.publicId
    })),
    counters: {
      upserted: upserts.length,
      deleted: deletes.length,
      enumeratedCorpus: 0
    },
    fullCorpusRewriteAllowed: false
  };
}

export function semanticVectorIndexUid(input: {
  indexPrefix: string;
  knowledgeBaseId: string;
  semanticGenerationPublicId: string;
  mappingFingerprintSha256: string;
}): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(input.indexPrefix)
    || !input.knowledgeBaseId || !input.semanticGenerationPublicId
    || !/^[0-9a-f]{64}$/u.test(input.mappingFingerprintSha256)) {
    throw planError("invalid index identity");
  }
  return `${input.indexPrefix}-semantic-${hash(
    input.knowledgeBaseId,
    input.semanticGenerationPublicId,
    input.mappingFingerprintSha256
  ).slice(0, 48)}`;
}

function compareUpserts(left: VectorUpsert, right: VectorUpsert): number {
  return left.family.localeCompare(right.family, "en")
    || left.ownerPublicId.localeCompare(right.ownerPublicId, "en")
    || left.publicId.localeCompare(right.publicId, "en");
}

function assertIdentity(value: string): void {
  if (!value || Buffer.byteLength(value) > 1_024) throw planError("invalid identity");
}

function hash(...values: string[]): string {
  return createHash("sha256").update(values.join("\u001f")).digest("hex");
}

function planError(message: string): Error {
  return new Error(`Semantic vector projection plan failed: ${message}`);
}

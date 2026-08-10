import type {
  EmbeddingArtifactIdentity,
  SemanticAffectedClosure,
  SemanticDesiredFactSet,
  SemanticMaintenanceTarget,
  SemanticSourceExtractionManifest
} from "./contracts.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_FACTS_PER_REPLACEMENT = 1_000;
const MAX_CLOSURE_ITEMS = 10_000;

export function assertSemanticDesiredFactSet(input: SemanticDesiredFactSet): void {
  assertIdentity(input.knowledgeBaseId);
  assertIdentity(input.semanticGenerationPublicId);
  assertIdentity(input.sourceFilePublicId);
  assertIdentity(input.sourceRevisionPublicId);
  const collections = [
    input.entities,
    input.evidence,
    input.mentions,
    input.relationships,
    input.communities,
    input.communityReports
  ];
  if (collections.some((items) => items.length > MAX_FACTS_PER_REPLACEMENT)) {
    throw new Error("Semantic desired fact set exceeds the bounded replacement size");
  }
  assertUnique(input.entities.map((item) => item.publicId));
  assertUnique(input.evidence.map((item) => item.publicId));
  assertUnique(input.mentions.map((item) => item.publicId));
  assertUnique(input.relationships.map((item) => item.publicId));
  for (const evidence of input.evidence) {
    if (
      evidence.sourceFilePublicId !== input.sourceFilePublicId
      || evidence.sourceRevisionPublicId !== input.sourceRevisionPublicId
      || evidence.startOffset < 0
      || evidence.endOffset < evidence.startOffset
      || !SHA256_PATTERN.test(evidence.excerptChecksumSha256)
    ) throw new Error("Semantic evidence ownership is invalid");
  }
  for (const entity of input.entities) assertConfidence(entity.confidence);
  for (const mention of input.mentions) assertConfidence(mention.confidence);
  for (const relationship of input.relationships) {
    assertConfidence(relationship.confidence);
    if (relationship.fromEntityPublicId === relationship.toEntityPublicId) {
      throw new Error("Semantic relationship endpoints must differ");
    }
  }
}

export function assertSemanticSourceExtractionManifest(
  input: SemanticSourceExtractionManifest
): void {
  assertIdentity(input.extractionContractVersion);
  assertIdentity(input.skeletonPolicyVersion);
  if (!SHA256_PATTERN.test(input.canonicalInputSha256)
    || !SHA256_PATTERN.test(input.selectionDecisionSha256)
    || !Number.isSafeInteger(input.sourceChunkCount)
    || input.sourceChunkCount < 1
    || input.sourceChunkCount > 32
    || !Number.isSafeInteger(input.selectedChunkCount)
    || input.selectedChunkCount < 0
    || input.selectedChunkCount > Math.min(8, input.sourceChunkCount)
    || input.skeletonSelected !== (input.selectedChunkCount > 0)
    || input.selectionReasons.length > 8
    || new Set(input.selectionReasons).size !== input.selectionReasons.length) {
    throw new Error("Semantic source extraction manifest is invalid");
  }
  for (const reason of input.selectionReasons) assertIdentity(reason);
}

export function assertSemanticAffectedClosure(input: SemanticAffectedClosure): void {
  assertIdentity(input.knowledgeBaseId);
  for (const items of Object.values(input)) {
    if (Array.isArray(items) && items.length > MAX_CLOSURE_ITEMS) {
      throw new Error("Semantic affected closure exceeds the bounded item count");
    }
  }
}

export function assertEmbeddingArtifactIdentity(input: EmbeddingArtifactIdentity): void {
  assertIdentity(input.knowledgeBaseId);
  assertIdentity(input.ownerPublicId);
  assertIdentity(input.embeddingConfigurationRevisionPublicId);
  if (!SHA256_PATTERN.test(input.canonicalInputSha256)) {
    throw new Error("Embedding canonical input checksum is invalid");
  }
  if (!Number.isSafeInteger(input.dimension) || input.dimension < 1 || input.dimension > 65_536) {
    throw new Error("Embedding dimension is invalid");
  }
  if (input.ownerKind !== input.inputKind) {
    throw new Error("Embedding owner and input kinds must match");
  }
}

export function assertSemanticMaintenanceTarget(input: SemanticMaintenanceTarget): void {
  assertIdentity(input.knowledgeBaseId);
  assertIdentity(input.generationModelConfigurationPublicId);
  assertIdentity(input.embeddingConfigurationRevisionPublicId);
  assertIdentity(input.embeddingQueryPolicyRevisionPublicId);
  if (!Number.isSafeInteger(input.generationModelConfigurationRevision)
    || input.generationModelConfigurationRevision < 0) {
    throw new Error("Semantic generation model revision is invalid");
  }
  if (!Number.isSafeInteger(input.resolvedDimension) || input.resolvedDimension < 1) {
    throw new Error("Semantic maintenance dimension is invalid");
  }
  if (!Number.isFinite(input.minimumVectorRelevance)
    || input.minimumVectorRelevance < 0
    || input.minimumVectorRelevance > 1) {
    throw new Error("Semantic minimum vector relevance is invalid");
  }
  if (!SHA256_PATTERN.test(input.mappingFingerprintSha256)) {
    throw new Error("Semantic mapping fingerprint is invalid");
  }
}

function assertIdentity(value: string): void {
  if (!value || Buffer.byteLength(value) > 255) {
    throw new Error("Semantic identity is invalid");
  }
}

function assertUnique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) {
    throw new Error("Semantic desired facts contain duplicate identities");
  }
}

function assertConfidence(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("Semantic confidence is invalid");
  }
}

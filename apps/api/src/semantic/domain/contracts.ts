export const SEMANTIC_EXTRACTION_CONTRACT_VERSION = "semantic-skeleton-v2";
export const SEMANTIC_GRAPH_SCHEMA_VERSION = "focowiki-semantic-graph-v1";
export const SEMANTIC_VECTOR_ARTIFACT_SCHEMA_VERSION = "focowiki-vector-artifact-v1";
export const SEMANTIC_PROMPT_CONTRACT_VERSION = "general-purpose-graph-v3";
export const SEMANTIC_VECTOR_SCHEMA_VERSION = "focowiki-semantic-vector-v1";

export type SemanticPublicId = string;
export type SemanticKnowledgeBaseId = string;
export type SemanticChecksum = string;

export type SemanticEvidence = {
  publicId: SemanticPublicId;
  sourceFilePublicId: SemanticPublicId;
  sourceRevisionPublicId: SemanticPublicId;
  logicalPath: string;
  startOffset: number;
  endOffset: number;
  excerptChecksumSha256: SemanticChecksum;
  extractionContractVersion: string;
};

export type SemanticEntity = {
  publicId: SemanticPublicId;
  canonicalKey: string;
  kind: string;
  label: string;
  description: string | null;
  aliases: readonly string[];
  extractionContractVersion: string;
  confidence: number;
  provenance: "deterministic" | "model";
  revision: number;
};

export type SemanticMention = {
  publicId: SemanticPublicId;
  entityPublicId: SemanticPublicId;
  evidencePublicId: SemanticPublicId;
  sourceFilePublicId: SemanticPublicId;
  sourceRevisionPublicId: SemanticPublicId;
  text: string;
  confidence: number;
};

export type SemanticRelationship = {
  publicId: SemanticPublicId;
  fromEntityPublicId: SemanticPublicId;
  toEntityPublicId: SemanticPublicId;
  kind: string;
  description: string | null;
  evidencePublicIds: readonly SemanticPublicId[];
  confidence: number;
  provenance: "deterministic" | "model";
  revision: number;
};

export type SemanticCommunity = {
  publicId: SemanticPublicId;
  sourcePartitionKey: string;
  partitionKey: string;
  level: number;
  title: string | null;
  entityPublicIds: readonly SemanticPublicId[];
  revision: number;
};

export type SemanticCommunityReport = {
  publicId: SemanticPublicId;
  communityPublicId: SemanticPublicId;
  inputGraphVersion: string;
  boundaryVersion: string;
  summary: string;
  checksumSha256: SemanticChecksum;
};

export type SemanticDesiredFactSet = {
  knowledgeBaseId: SemanticKnowledgeBaseId;
  semanticGenerationPublicId: SemanticPublicId;
  sourceFilePublicId: SemanticPublicId;
  sourceRevisionPublicId: SemanticPublicId;
  entities: readonly SemanticEntity[];
  evidence: readonly SemanticEvidence[];
  mentions: readonly SemanticMention[];
  relationships: readonly SemanticRelationship[];
  communities: readonly SemanticCommunity[];
  communityReports: readonly SemanticCommunityReport[];
};

export type SemanticSourceExtractionManifest = {
  extractionContractVersion: string;
  canonicalInputSha256: SemanticChecksum;
  skeletonPolicyVersion: string;
  skeletonSelected: boolean;
  sourceChunkCount: number;
  selectedChunkCount: number;
  selectionReasons: readonly string[];
  selectionDecisionSha256: SemanticChecksum;
};

export type SemanticAffectedClosure = {
  knowledgeBaseId: SemanticKnowledgeBaseId;
  sourceFilePublicIds: readonly SemanticPublicId[];
  sourceRevisionPublicIds: readonly SemanticPublicId[];
  entityPublicIds: readonly SemanticPublicId[];
  relationshipPublicIds: readonly SemanticPublicId[];
  evidencePublicIds: readonly SemanticPublicId[];
  reverseReferencePublicIds: readonly SemanticPublicId[];
  vectorOwnerPublicIds: readonly SemanticPublicId[];
  dirtyPartitionKeys: readonly string[];
  affectedFileNeighborPublicIds: readonly SemanticPublicId[];
  generatedLogicalPaths: readonly string[];
  graphShardPublicIds: readonly SemanticPublicId[];
  searchShardPublicIds: readonly SemanticPublicId[];
};

export type EmbeddingInputKind = "content" | "entity" | "relationship" | "community";
export type EmbeddingNormalization = "none" | "l2";

export type EmbeddingArtifactIdentity = {
  knowledgeBaseId: SemanticKnowledgeBaseId;
  ownerKind: EmbeddingInputKind;
  ownerPublicId: SemanticPublicId;
  sourceRevisionPublicId: SemanticPublicId | null;
  canonicalInputSha256: SemanticChecksum;
  embeddingConfigurationRevisionPublicId: SemanticPublicId;
  normalization: EmbeddingNormalization;
  dimension: number;
  inputKind: EmbeddingInputKind;
  artifactSchemaVersion: string;
};

export type SemanticVectorFamily = EmbeddingInputKind;

export type SemanticVectorDocument = {
  publicId: SemanticPublicId;
  knowledgeBaseId: SemanticKnowledgeBaseId;
  semanticGenerationPublicId: SemanticPublicId;
  ownerPublicId: SemanticPublicId;
  family: SemanticVectorFamily;
  sourceFilePublicId: SemanticPublicId;
  sourceRevisionPublicId: SemanticPublicId;
  embeddingConfigurationRevisionPublicId: SemanticPublicId;
  dimension: number;
  artifactPublicId: SemanticPublicId;
  evidenceTargetPath: string;
};

export type SemanticStatus = {
  state: "disabled" | "pending" | "ready" | "degraded" | "failed";
  activeGenerationPublicId: SemanticPublicId | null;
  embeddingConfigurationRevisionPublicId: SemanticPublicId | null;
  safeCode: string | null;
};

export type SemanticMaintenanceTarget = {
  knowledgeBaseId: SemanticKnowledgeBaseId;
  generationModelConfigurationPublicId: SemanticPublicId;
  generationModelConfigurationRevision: number;
  extractionContractVersion: string;
  graphSchemaVersion: string;
  promptContractVersion: string;
  embeddingConfigurationRevisionPublicId: SemanticPublicId;
  embeddingQueryPolicyRevisionPublicId: SemanticPublicId;
  minimumVectorRelevance: number;
  resolvedDimension: number;
  normalization: EmbeddingNormalization;
  artifactSchemaVersion: string;
  vectorSchemaVersion: string;
  searchProviderKind: "meilisearch" | "opensearch";
  mappingFingerprintSha256: SemanticChecksum;
};

export type SemanticSourceInput = {
  knowledgeBaseId: SemanticKnowledgeBaseId;
  sourceFilePublicId: SemanticPublicId;
  sourceRevisionPublicId: SemanticPublicId;
  logicalPath: string;
  contentChecksumSha256: SemanticChecksum;
  markdown: string;
};

export type NormalizedGraphRagOutput = {
  schemaVersion: string;
  sourceRevisionPublicId: SemanticPublicId;
  entities: readonly SemanticEntity[];
  evidence: readonly SemanticEvidence[];
  mentions: readonly SemanticMention[];
  relationships: readonly SemanticRelationship[];
  communities: readonly SemanticCommunity[];
  communityReports: readonly SemanticCommunityReport[];
  usage: { inputTokens: number; outputTokens: number };
  diagnostics: readonly { code: string; severity: "warning" | "error" }[];
};

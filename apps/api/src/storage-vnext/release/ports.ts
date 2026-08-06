import type {
  StorageVnextChecksum,
  StorageVnextIdempotency,
  StorageVnextKnowledgeBaseId,
  StorageVnextOpaqueCursor,
  StorageVnextPage,
  StorageVnextPublicId,
  StorageVnextRevision,
  StorageVnextTimestamp
} from "../shared/types.js";
import type { StorageVnextActiveSnapshot } from "../transactions/ports.js";

export const MAX_STORAGE_VNEXT_CANDIDATE_CHANGED_FACTS = 100_000;
export const MAX_STORAGE_VNEXT_CANDIDATE_DEPENDENCIES = 250_000;
export const MAX_STORAGE_VNEXT_CANDIDATE_SHARDS = 50_000;
export const MAX_STORAGE_VNEXT_RELEASE_WRITE_BATCH = 1_000;
export const MAX_STORAGE_VNEXT_RELEASE_PAGE_SIZE = 1_000;

export type StorageVnextReleaseRootRole = "active" | "candidate" | "rollback";
export type StorageVnextCandidateState = "building" | "validating" | "ready";
export type StorageVnextCandidateTerminalOutcome =
  | "failed" | "cancelled" | "superseded" | "timed_out";

export type StorageVnextReleaseRoot = {
  publicId: StorageVnextPublicId;
  knowledgeBaseId: StorageVnextKnowledgeBaseId;
  role: StorageVnextReleaseRootRole;
  manifestChecksum: StorageVnextChecksum | null;
  revision: StorageVnextRevision;
  createdAt: StorageVnextTimestamp;
  expiresAt: StorageVnextTimestamp | null;
};

export type StorageVnextCandidateChangedFact = {
  kind: "knowledge_base" | "directory" | "source_file" | "source_revision" | "graph_node" | "graph_edge";
  publicId: StorageVnextPublicId;
  change: "created" | "updated" | "deleted";
};

export type StorageVnextCandidateDependency = {
  kind: "path" | "ancestor" | "link" | "search" | "graph" | "index" | "schema" | "log" | "scope";
  publicId: StorageVnextPublicId;
  reasonCode: string;
};

export type StorageVnextCandidateDelta = {
  publicId: StorageVnextPublicId;
  knowledgeBaseId: StorageVnextKnowledgeBaseId;
  operationPublicId: StorageVnextPublicId;
  candidateRootPublicId: StorageVnextPublicId;
  expectedActiveRootPublicId: StorageVnextPublicId | null;
  expectedActiveRevision: StorageVnextRevision;
  state: StorageVnextCandidateState;
  changedFactCount: number;
  affectedDependencyCount: number;
  manifestChecksum: StorageVnextChecksum | null;
  createdAt: StorageVnextTimestamp;
  updatedAt: StorageVnextTimestamp;
};

export type StorageVnextShardDescriptor = {
  publicId: StorageVnextPublicId;
  logicalKind: string;
  firstLogicalPath: string;
  lastLogicalPath: string;
  recordCount: number;
  byteCount: number;
  checksum: StorageVnextChecksum;
  objectId: string;
  ordinal: number;
};

export type StorageVnextShardAttachmentResult = {
  createdDescriptorCount: number;
  reusedDescriptorCount: number;
  attachedCount: number;
};

export type StorageVnextReleaseCatalogEntry = {
  logicalPath: string;
  kind: "source" | "index" | "directory" | "schema" | "log" | "graph";
  sourceFilePublicId: StorageVnextPublicId | null;
  checksum: StorageVnextChecksum;
  objectId: string;
  byteCount: number;
  ordinal: number;
};

export type StorageVnextDirectorySummary = {
  directoryPublicId: StorageVnextPublicId | null;
  logicalPath: string;
  firstLeafPath: string | null;
  directFileCount: number;
  descendantFileCount: number;
  ordinal: number;
};

export type StorageVnextKnowledgeBaseSummary = {
  sourceFileCount: number;
  directoryCount: number;
  generatedEntryCount: number;
  graphNodeCount: number;
  graphEdgeCount: number;
  generatedByteCount: number;
};

export type StorageVnextCandidateValidationReceipt = {
  candidatePublicId: StorageVnextPublicId;
  manifestChecksum: StorageVnextChecksum;
  searchProjectionPublicId: StorageVnextPublicId;
  objectOwnerCount: number;
  searchDocumentCount: number;
  graphNodeCount: number;
  graphEdgeCount: number;
  linkCount: number;
  generatedEntryCount: number;
  objectValidationPassed: boolean;
  searchValidationPassed: boolean;
  graphValidationPassed: boolean;
  linkValidationPassed: boolean;
  countValidationPassed: boolean;
  pathValidationPassed: boolean;
  validatedAt: StorageVnextTimestamp;
};

export type StorageVnextCandidateActivationResult =
  | { outcome: "activated"; snapshot: StorageVnextActiveSnapshot; rollbackRootPublicId: StorageVnextPublicId | null }
  | { outcome: "stale"; activeRootPublicId: StorageVnextPublicId | null; activeRevision: StorageVnextRevision }
  | { outcome: "rollback_pending"; rollbackRootPublicId: StorageVnextPublicId; expiresAt: StorageVnextTimestamp }
  | { outcome: "not_ready" };

export type StorageVnextReleaseEventSummary = {
  publicId: StorageVnextPublicId;
  knowledgeBaseId: StorageVnextKnowledgeBaseId;
  operationPublicId: StorageVnextPublicId;
  candidatePublicId: StorageVnextPublicId;
  releaseRootPublicId: StorageVnextPublicId | null;
  outcome: "activated" | StorageVnextCandidateTerminalOutcome | "rollback_expired";
  resultCode: string;
  safeMessage: string | null;
  revision: StorageVnextRevision;
  createdAt: StorageVnextTimestamp;
  expiresAt: StorageVnextTimestamp;
};

export type StorageVnextReleaseReadPort = {
  getActiveRoot(knowledgeBaseId: StorageVnextKnowledgeBaseId): Promise<StorageVnextReleaseRoot | null>;
  getLiveCandidate(knowledgeBaseId: StorageVnextKnowledgeBaseId): Promise<StorageVnextCandidateDelta | null>;
  getRollbackRoot(knowledgeBaseId: StorageVnextKnowledgeBaseId): Promise<StorageVnextReleaseRoot | null>;
  listCandidateChangedFacts(input: {
    candidatePublicId: StorageVnextPublicId;
    limit: number;
    cursor: StorageVnextOpaqueCursor | null;
  }): Promise<StorageVnextPage<StorageVnextCandidateChangedFact>>;
  listCandidateDependencies(input: {
    candidatePublicId: StorageVnextPublicId;
    limit: number;
    cursor: StorageVnextOpaqueCursor | null;
  }): Promise<StorageVnextPage<StorageVnextCandidateDependency>>;
  listCandidateShards(input: {
    candidatePublicId: StorageVnextPublicId;
    limit: number;
    cursor: StorageVnextOpaqueCursor | null;
  }): Promise<StorageVnextPage<StorageVnextShardDescriptor>>;
  listRootCatalogEntries(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    releaseRootPublicId: StorageVnextPublicId;
    parentPath?: string;
    entryType?: "file" | "directory" | null;
    query?: string | null;
    limit: number;
    cursor: StorageVnextOpaqueCursor | null;
  }): Promise<StorageVnextPage<StorageVnextReleaseCatalogEntry>>;
  listDirectorySummaries(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    releaseRootPublicId: StorageVnextPublicId;
    limit: number;
    cursor: StorageVnextOpaqueCursor | null;
  }): Promise<StorageVnextPage<StorageVnextDirectorySummary>>;
  getKnowledgeBaseSummary(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    releaseRootPublicId: StorageVnextPublicId;
  }): Promise<StorageVnextKnowledgeBaseSummary | null>;
  hasCandidateCatalogEntries(candidatePublicId: StorageVnextPublicId): Promise<boolean>;
  countCandidateOwnedObjects(candidatePublicId: StorageVnextPublicId): Promise<number>;
  listReleaseEvents(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    limit: number;
    cursor: StorageVnextOpaqueCursor | null;
  }): Promise<StorageVnextPage<StorageVnextReleaseEventSummary>>;
};

export type StorageVnextReleaseWritePort = {
  createCandidate(input: {
    publicId: StorageVnextPublicId;
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    operationPublicId: StorageVnextPublicId;
    candidateRootPublicId: StorageVnextPublicId;
    expectedActiveRootPublicId: StorageVnextPublicId | null;
    expectedActiveRevision: StorageVnextRevision;
    changedFacts: readonly StorageVnextCandidateChangedFact[];
    dependencies: readonly StorageVnextCandidateDependency[];
    idempotency: StorageVnextIdempotency;
    createdAt: StorageVnextTimestamp;
  }): Promise<StorageVnextCandidateDelta>;
  addCandidateFacts(input: { candidatePublicId: StorageVnextPublicId; changedFacts: readonly StorageVnextCandidateChangedFact[]; dependencies: readonly StorageVnextCandidateDependency[] }): Promise<StorageVnextCandidateDelta>;
  addCandidateShards(input: { candidatePublicId: StorageVnextPublicId; shards: readonly StorageVnextShardDescriptor[] }): Promise<StorageVnextShardAttachmentResult>;
  addCandidateCatalogEntries(input: { candidatePublicId: StorageVnextPublicId; entries: readonly StorageVnextReleaseCatalogEntry[] }): Promise<void>;
  addCandidateCatalogTombstones(input: { candidatePublicId: StorageVnextPublicId; logicalPaths: readonly string[] }): Promise<void>;
  replaceCandidateSummaries(input: { candidatePublicId: StorageVnextPublicId; directories: readonly StorageVnextDirectorySummary[]; knowledgeBase: StorageVnextKnowledgeBaseSummary }): Promise<void>;
  markCandidateValidating(input: { candidatePublicId: StorageVnextPublicId }): Promise<boolean>;
  recordCandidateValidation(input: StorageVnextCandidateValidationReceipt): Promise<boolean>;
  markCandidateReady(input: { candidatePublicId: StorageVnextPublicId; manifestChecksum: StorageVnextChecksum }): Promise<boolean>;
  activateCandidate(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    candidatePublicId: StorageVnextPublicId;
    expectedActiveRootPublicId: StorageVnextPublicId | null;
    expectedActiveRevision: StorageVnextRevision;
    searchProjectionPublicId: StorageVnextPublicId;
    rollbackExpiresAt: StorageVnextTimestamp | null;
    eventPublicId: StorageVnextPublicId;
    eventExpiresAt: StorageVnextTimestamp;
    activatedAt: StorageVnextTimestamp;
  }): Promise<StorageVnextCandidateActivationResult>;
  terminateCandidate(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    candidatePublicId: StorageVnextPublicId;
    outcome: "failed" | "cancelled" | "superseded" | "timed_out";
    reasonCode: string;
    safeMessage: string | null;
    eventPublicId: StorageVnextPublicId;
    eventExpiresAt: StorageVnextTimestamp;
    terminatedAt: StorageVnextTimestamp;
  }): Promise<boolean>;
  expireRollbackRoot(input: { knowledgeBaseId: StorageVnextKnowledgeBaseId; expiredBefore: StorageVnextTimestamp; eventPublicId: StorageVnextPublicId; eventExpiresAt: StorageVnextTimestamp }): Promise<StorageVnextPublicId | null>;
  deleteExpiredReleaseEvents(input: { expiredBefore: StorageVnextTimestamp; limit: number }): Promise<number>;
};

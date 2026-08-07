import type {
  StorageVnextBoundedMetadata,
  StorageVnextChecksum,
  StorageVnextIdempotency,
  StorageVnextKnowledgeBaseId,
  StorageVnextOpaqueCursor,
  StorageVnextPage,
  StorageVnextPublicId,
  StorageVnextRevision,
  StorageVnextTimestamp
} from "../shared/types.js";

export type StorageVnextCrossStorePhase =
  | "accepted"
  | "body_verified"
  | "candidate_registered"
  | "search_validated"
  | "ready_to_activate"
  | "active"
  | "cleanup_pending"
  | "terminal";

export type StorageVnextOperationIdentity = {
  operationPublicId: StorageVnextPublicId;
  knowledgeBaseId: StorageVnextKnowledgeBaseId;
  operationKind: string;
  operationRevision: StorageVnextRevision;
  idempotency: StorageVnextIdempotency;
};

export type StorageVnextCrossStoreCheckpoint = {
  identity: StorageVnextOperationIdentity;
  phase: StorageVnextCrossStorePhase;
  expectedActiveRevision: StorageVnextRevision;
  candidatePublicId: StorageVnextPublicId | null;
  releaseRootPublicId: StorageVnextPublicId | null;
  searchProjectionPublicId: StorageVnextPublicId | null;
  verifiedObjectIds: readonly string[];
  checkpoint: StorageVnextBoundedMetadata;
  updatedAt: StorageVnextTimestamp;
};

export type StorageVnextActiveSnapshot = {
  knowledgeBaseId: StorageVnextKnowledgeBaseId;
  revision: StorageVnextRevision;
  releaseRootPublicId: StorageVnextPublicId;
  searchProjectionPublicId: StorageVnextPublicId;
  manifestChecksum: StorageVnextChecksum;
  navigationProfileVersion: number;
  activatedByOperationPublicId: StorageVnextPublicId;
  publiclyVisibleAt: StorageVnextTimestamp;
};

export type StorageVnextCrossStoreTransactionPort = {
  accept(identity: StorageVnextOperationIdentity): Promise<StorageVnextCrossStoreCheckpoint>;
  getCheckpoint(
    operationPublicId: StorageVnextPublicId
  ): Promise<StorageVnextCrossStoreCheckpoint | null>;
  advance(input: {
    operationPublicId: StorageVnextPublicId;
    expectedPhase: StorageVnextCrossStorePhase;
    checkpoint: StorageVnextCrossStoreCheckpoint;
  }): Promise<StorageVnextCrossStoreCheckpoint>;
  markTerminal(input: {
    operationPublicId: StorageVnextPublicId;
    expectedPhase: StorageVnextCrossStorePhase;
    resultCode: string;
    completedAt: StorageVnextTimestamp;
  }): Promise<void>;
};

export type StorageVnextPublicVisibilityPort = {
  getActiveSnapshot(
    knowledgeBaseId: StorageVnextKnowledgeBaseId
  ): Promise<StorageVnextActiveSnapshot | null>;
  compareAndSwapActiveSnapshot(input: {
    identity: StorageVnextOperationIdentity;
    candidatePublicId: StorageVnextPublicId;
    expectedActiveRevision: StorageVnextRevision;
    releaseRootPublicId: StorageVnextPublicId;
    searchProjectionPublicId: StorageVnextPublicId;
    manifestChecksum: StorageVnextChecksum;
    publiclyVisibleAt: StorageVnextTimestamp;
  }): Promise<StorageVnextActiveSnapshot>;
};

export type StorageVnextCompensationAction =
  | "release_candidate_owner"
  | "delete_unowned_body"
  | "delete_search_candidate"
  | "remove_coordination"
  | "reconcile_unresolved";

export type StorageVnextCompensationItem = {
  publicId: StorageVnextPublicId;
  operationPublicId: StorageVnextPublicId;
  knowledgeBaseId: StorageVnextKnowledgeBaseId;
  action: StorageVnextCompensationAction;
  resourcePublicId: StorageVnextPublicId;
  idempotency: StorageVnextIdempotency;
  checkpoint: StorageVnextBoundedMetadata;
  notBefore: StorageVnextTimestamp;
  attempt: number;
};

export type StorageVnextCompensationPort = {
  enqueue(item: StorageVnextCompensationItem): Promise<void>;
  listEligible(input: {
    before: StorageVnextTimestamp;
    limit: number;
    cursor: StorageVnextOpaqueCursor | null;
  }): Promise<StorageVnextPage<StorageVnextCompensationItem>>;
  complete(input: {
    publicId: StorageVnextPublicId;
    result: "completed" | "blocked" | "retry";
    checkpoint: StorageVnextBoundedMetadata;
  }): Promise<void>;
};

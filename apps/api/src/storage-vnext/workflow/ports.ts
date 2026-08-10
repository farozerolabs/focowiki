import type { SearchProviderKind } from
  "../../application/ports/search-provider-runtime.js";
import type {
  StorageVnextBoundedMetadata,
  StorageVnextIdempotency,
  StorageVnextKnowledgeBaseId,
  StorageVnextOpaqueCursor,
  StorageVnextPage,
  StorageVnextPublicId,
  StorageVnextTimestamp
} from "../shared/types.js";

export type StorageVnextWorkKind =
  | "upload"
  | "source"
  | "graph"
  | "publication"
  | "search"
  | "mutation"
  | "deletion"
  | "maintenance"
  | "reconciliation"
  | "webhook";

export type StorageVnextWorkState =
  | "queued"
  | "running"
  | "retry"
  | "completed"
  | "failed"
  | "cancelled"
  | "superseded"
  | "timed_out"
  | "deleted";

export type StorageVnextLiveWork = {
  publicId: StorageVnextPublicId;
  knowledgeBaseId: StorageVnextKnowledgeBaseId;
  kind: StorageVnextWorkKind;
  searchProviderKind: SearchProviderKind | null;
  state: "queued" | "running" | "retry";
  operationRevision: number;
  settingsRevisionPublicId: StorageVnextPublicId;
  attempt: number;
  leaseOwner: string | null;
  leaseExpiresAt: StorageVnextTimestamp | null;
  nextAttemptAt: StorageVnextTimestamp | null;
  safeErrorCode: string | null;
  checkpoint: StorageVnextBoundedMetadata;
  idempotency: StorageVnextIdempotency & {
    expiresAt: StorageVnextTimestamp;
  };
};

export type StorageVnextBoundedResult = {
  publicId: StorageVnextPublicId;
  knowledgeBaseId: StorageVnextKnowledgeBaseId;
  kind: StorageVnextWorkKind;
  state: Exclude<StorageVnextWorkState, "queued" | "running" | "retry">;
  resultCode: string;
  safeMessage: string | null;
  summary: StorageVnextBoundedMetadata;
  correlationPublicId: StorageVnextPublicId | null;
  completedAt: StorageVnextTimestamp;
  expiresAt: StorageVnextTimestamp;
};

export type StorageVnextWorkflowOutcome =
  | { type: "live"; work: StorageVnextLiveWork }
  | { type: "result"; result: StorageVnextBoundedResult };

export type StorageVnextWorkflowClaimPort = {
  claim(input: {
    kinds: readonly StorageVnextWorkKind[];
    owner: string;
    limit: number;
    leaseExpiresAt: StorageVnextTimestamp;
  }): Promise<readonly StorageVnextLiveWork[]>;
  recoverStale(input: {
    kinds: readonly StorageVnextWorkKind[];
    expiredBefore: StorageVnextTimestamp;
    retryAt: StorageVnextTimestamp;
    reasonCode: string;
    limit: number;
  }): Promise<number>;
  renew(input: {
    publicId: StorageVnextPublicId;
    owner: string;
    leaseExpiresAt: StorageVnextTimestamp;
  }): Promise<boolean>;
};

export type StorageVnextWorkflowWritePort = {
  findIdempotent(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    key: string;
    requestHash: string;
  }): Promise<StorageVnextWorkflowOutcome | null>;
  enqueue(work: StorageVnextLiveWork): Promise<StorageVnextWorkflowOutcome>;
  rescheduleQueued(input: {
    publicId: StorageVnextPublicId;
    nextAttemptAt: StorageVnextTimestamp;
  }): Promise<boolean>;
  saveCheckpoint(input: {
    publicId: StorageVnextPublicId;
    owner: string;
    checkpoint: StorageVnextBoundedMetadata;
  }): Promise<void>;
  complete(input: {
    publicId: StorageVnextPublicId;
    owner: string;
    result: StorageVnextBoundedResult;
  }): Promise<void>;
  releaseForRetry(input: {
    publicId: StorageVnextPublicId;
    owner: string;
    nextAttemptAt: StorageVnextTimestamp;
    reasonCode: string;
  }): Promise<void>;
  releaseForContinuation(input: {
    publicId: StorageVnextPublicId;
    owner: string;
    nextAttemptAt: StorageVnextTimestamp;
  }): Promise<void>;
  listResults(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    limit: number;
    cursor: StorageVnextOpaqueCursor | null;
  }): Promise<StorageVnextPage<StorageVnextBoundedResult>>;
};

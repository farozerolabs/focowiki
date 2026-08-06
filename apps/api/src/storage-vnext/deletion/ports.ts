import type {
  StorageVnextKnowledgeBaseId,
  StorageVnextPublicId,
  StorageVnextTimestamp
} from "../shared/types.js";

export type StorageVnextDeletionKind =
  | "source_file"
  | "source_directory"
  | "knowledge_base";

export type StorageVnextDeletionRequest = {
  kind: StorageVnextDeletionKind;
  knowledgeBaseId: StorageVnextKnowledgeBaseId;
  operationPublicId: StorageVnextPublicId;
  targetPublicId: StorageVnextPublicId;
  expectedResourceRevision: number;
  idempotencyKey: string;
  settingsRevisionPublicId: StorageVnextPublicId;
  requestedAt: StorageVnextTimestamp;
  expiresAt: StorageVnextTimestamp;
};

export type StorageVnextNormalizedDeletionRequest = StorageVnextDeletionRequest & {
  targetKind: StorageVnextDeletionKind;
  requestHash: string;
};

export type StorageVnextDeletionAcceptance = {
  outcome: "queued" | "replayed";
  operationPublicId: StorageVnextPublicId;
  state: "queued";
  visibilityCommitted: true;
};

export type StorageVnextSourceTaskDeletionSkippedReason =
  | "missing"
  | "wrong_knowledge_base"
  | "already_removed"
  | "running"
  | "job_already_claimed";

export type StorageVnextSourceTaskDeletionResult =
  | {
      sourceFilePublicId: StorageVnextPublicId;
      outcome: "deleted";
    }
  | {
      sourceFilePublicId: StorageVnextPublicId;
      outcome: "hidden";
      generatedFilePublicId?: StorageVnextPublicId;
      generatedFilePath?: string;
    }
  | {
      sourceFilePublicId: StorageVnextPublicId;
      outcome: "skipped";
      reason: StorageVnextSourceTaskDeletionSkippedReason;
    };

export type StorageVnextSourceTaskDeletionInput = {
  knowledgeBaseId: StorageVnextKnowledgeBaseId;
  sourceFilePublicIds: readonly StorageVnextPublicId[];
  deletedAt: StorageVnextTimestamp;
  settingsRevisionPublicId: StorageVnextPublicId;
  resultExpiresAt: StorageVnextTimestamp;
};

export type StorageVnextDeletionRepository = {
  acceptDeletion(
    request: StorageVnextNormalizedDeletionRequest
  ): Promise<StorageVnextDeletionAcceptance>;
  deleteSourceTasks(
    input: StorageVnextSourceTaskDeletionInput
  ): Promise<readonly StorageVnextSourceTaskDeletionResult[]>;
};

export type StorageVnextDeletionVisibilityCache = {
  invalidateKnowledgeBase(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
  }): Promise<void>;
};

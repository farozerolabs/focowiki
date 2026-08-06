import type {
  StorageVnextKnowledgeBaseId,
  StorageVnextPublicId,
  StorageVnextStructuredMetadata,
  StorageVnextTimestamp
} from "../shared/types.js";

export type StorageVnextMutationKind =
  | "knowledge_base_metadata"
  | "source_file_metadata"
  | "source_file_move"
  | "source_directory_move"
  | "source_replace";

export type StorageVnextMutationTargetKind =
  | "knowledge_base"
  | "source_file"
  | "source_directory";

type StorageVnextMutationRequestBase = {
  knowledgeBaseId: StorageVnextKnowledgeBaseId;
  operationPublicId: StorageVnextPublicId;
  targetPublicId: StorageVnextPublicId;
  expectedResourceRevision: number;
  idempotencyKey: string;
  settingsRevisionPublicId: StorageVnextPublicId;
  createdAt: StorageVnextTimestamp;
  expiresAt: StorageVnextTimestamp;
};

export type StorageVnextKnowledgeBaseMetadataMutationRequest =
  & StorageVnextMutationRequestBase
  & {
    kind: "knowledge_base_metadata";
    name?: string;
    description?: string | null;
  };

export type StorageVnextSourceFileMetadataMutationRequest =
  & StorageVnextMutationRequestBase
  & {
    kind: "source_file_metadata";
    title?: string;
    metadata: StorageVnextStructuredMetadata;
  };

export type StorageVnextSourceFileMoveMutationRequest =
  & StorageVnextMutationRequestBase
  & {
    kind: "source_file_move";
    destinationDirectoryPublicId: StorageVnextPublicId | null;
    destinationLogicalPath: string;
  };

export type StorageVnextSourceDirectoryMoveMutationRequest =
  & StorageVnextMutationRequestBase
  & {
    kind: "source_directory_move";
    destinationParentPublicId: StorageVnextPublicId | null;
    destinationLogicalPath: string;
  };

export type StorageVnextSourceReplaceMutationRequest =
  & StorageVnextMutationRequestBase
  & {
    kind: "source_replace";
    candidateRevisionPublicId: StorageVnextPublicId;
    objectId: string;
    checksumSha256: string;
    byteCount: number;
    contentType: "text/markdown; charset=utf-8";
    destinationDirectoryPublicId?: StorageVnextPublicId | null;
    destinationLogicalPath?: string;
  };

export type StorageVnextMutationRequest =
  | StorageVnextKnowledgeBaseMetadataMutationRequest
  | StorageVnextSourceFileMetadataMutationRequest
  | StorageVnextSourceFileMoveMutationRequest
  | StorageVnextSourceDirectoryMoveMutationRequest
  | StorageVnextSourceReplaceMutationRequest;

type NormalizeMutationRequest<T extends StorageVnextMutationRequest> =
  T extends StorageVnextMutationRequest
    ? Omit<T, "destinationLogicalPath"> & {
    targetKind: StorageVnextMutationTargetKind;
    requestHash: string;
    candidateLogicalPath?: string;
    normalizedCandidatePath?: string;
    }
    : never;

export type StorageVnextNormalizedMutationRequest =
  NormalizeMutationRequest<StorageVnextMutationRequest>;

export type StorageVnextMutationAcceptance = {
  outcome: "queued" | "replayed";
  operationPublicId: StorageVnextPublicId;
  state: "queued";
};

export type StorageVnextMutationRepository = {
  acceptMutation(
    request: StorageVnextNormalizedMutationRequest
  ): Promise<StorageVnextMutationAcceptance>;
};

export type StorageVnextMutationTerminalOutcome =
  | "failed"
  | "cancelled"
  | "superseded"
  | "timed_out";

export type StorageVnextMutationTerminalRepository = {
  terminateMutation(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    operationPublicId: StorageVnextPublicId;
    outcome: StorageVnextMutationTerminalOutcome;
    resultCode: string;
    successorOperationPublicId: StorageVnextPublicId | null;
    completedAt: StorageVnextTimestamp;
    resultExpiresAt: StorageVnextTimestamp;
  }): Promise<boolean>;
};

import type {
  ResourceOperationKind,
  ResourceOperationRecord,
  SourceDirectoryRecord,
  SourceResourceFileFilters,
  SourceResourceFileRecord
} from "../../domain/source-resource.js";

export type SourceResourcePage<T> = {
  items: T[];
  nextCursor: string | null;
};

export type ResourceOperationFailureResult = {
  operation: ResourceOperationRecord | null;
  objectKeys: string[];
};

export type PendingSourceMutation = {
  sourceFileId: string;
  sourceRevisionId: string;
  kind: "source_moved" | "source_deleted";
  previousPath: string;
  path: string | null;
  resourceRevision: number;
};

export type SourceResourceRepository = {
  updateKnowledgeBase: (input: {
    knowledgeBaseId: string;
    expectedResourceRevision: number;
    name?: string;
    description?: string | null;
  }) => Promise<{
    id: string;
    name: string;
    description: string | null;
    activeGenerationId: string | null;
    resourceRevision: number;
    catalogGeneration: number;
    createdAt: string;
    updatedAt: string;
  } | null>;
  listDirectories: (input: {
    knowledgeBaseId: string;
    parentDirectoryId: string | null;
    limit: number;
    cursor: string | null;
  }) => Promise<SourceResourcePage<SourceDirectoryRecord>>;
  getDirectory: (input: {
    knowledgeBaseId: string;
    directoryId: string;
  }) => Promise<SourceDirectoryRecord | null>;
  listSourceFiles: (input: {
    knowledgeBaseId: string;
    directoryId: string | null | undefined;
    filters: SourceResourceFileFilters;
    limit: number;
    cursor: string | null;
  }) => Promise<SourceResourcePage<SourceResourceFileRecord>>;
  getSourceFile: (input: {
    knowledgeBaseId: string;
    sourceFileId: string;
  }) => Promise<SourceResourceFileRecord | null>;
  getSourceFileContentDescriptor: (input: {
    knowledgeBaseId: string;
    sourceFileId: string;
  }) => Promise<{
    objectKey: string;
    contentType: string;
    sizeBytes: number;
    checksumSha256: string;
    resourceRevision: number;
    contentRevision: number;
  } | null>;
  createOperation: (input: {
    operationId: string;
    knowledgeBaseId: string;
    kind: ResourceOperationKind;
    idempotencyKey: string;
    requestFingerprint: string;
    expectedResourceRevision: number | null;
    targetKind: "source_file" | "source_directory" | "knowledge_base";
    targetId: string;
    request: Record<string, unknown>;
  }) => Promise<{ operation: ResourceOperationRecord; replayed: boolean }>;
  prepareOperation: (input: {
    knowledgeBaseId: string;
    operationId: string;
    now: string;
    batchSize: number;
  }) => Promise<{
    operation: ResourceOperationRecord;
    sourceFileId: string | null;
    sourceMutation?: {
      sourceFileId: string;
      sourceRevisionId: string;
      kind: "source_replaced" | "source_moved";
      previousPath: string;
      path: string;
      resourceRevision: number;
    } | null;
    directoryMutation?: {
      kind: "directory_moved" | "directory_deleted";
      previousPath: string;
      path: string | null;
      resourceRevision: number;
      deletionIntentId: string | null;
    } | null;
    requiresSourceProcessing: boolean;
    requiresPublication: boolean;
    requiresContinuation: boolean;
    directoryDeletion: {
      deletionIntentId: string;
      directoryId: string;
    } | null;
  }>;
  listPendingOperationSourceMutations?: (input: {
    knowledgeBaseId: string;
    operationId: string;
    deletionIntentId: string | null;
    limit: number;
  }) => Promise<{
    items: PendingSourceMutation[];
    hasMore: boolean;
  }>;
  failOperation: (input: {
    knowledgeBaseId: string;
    operationId: string;
    errorCode: string;
    failedAt: string;
  }) => Promise<ResourceOperationFailureResult>;
  failSourceFileCandidateOperation: (input: {
    knowledgeBaseId: string;
    sourceFileId: string;
    errorCode: string;
    failedAt: string;
  }) => Promise<ResourceOperationFailureResult>;
  getOperation: (input: {
    knowledgeBaseId: string;
    operationId: string;
  }) => Promise<ResourceOperationRecord | null>;
  listOperations: (input: {
    knowledgeBaseId: string;
    states?: ResourceOperationRecord["state"][];
    limit: number;
    cursor: string | null;
  }) => Promise<SourceResourcePage<ResourceOperationRecord>>;
  acceptDirectoryDeletion: (input: {
    operationId: string;
    deletionIntentId: string;
    knowledgeBaseId: string;
    directoryId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    expectedResourceRevision: number;
    deletedAt: string;
  }) => Promise<{
    operation: ResourceOperationRecord;
    replayed: boolean;
    deletionIntentId: string;
    effectiveDirectoryId: string;
    affectedDirectoryCount: number;
    affectedFileCount: number;
  }>;
  acceptSourceFileDeletion: (input: {
    operationId: string;
    deletionIntentId: string;
    knowledgeBaseId: string;
    sourceFileId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    expectedResourceRevision: number;
    deletedAt: string;
  }) => Promise<{
    operation: ResourceOperationRecord;
    replayed: boolean;
    deletionIntentId: string;
    sourceFileId: string;
    sourceMutation?: PendingSourceMutation | null;
  }>;
  acceptKnowledgeBaseDeletion: (input: {
    operationId: string;
    deletionIntentId: string;
    knowledgeBaseId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    expectedResourceRevision: number;
    deletedAt: string;
  }) => Promise<{
    operation: ResourceOperationRecord;
    replayed: boolean;
    deletionIntentId: string;
    affectedDirectoryCount: number;
    affectedFileCount: number;
  }>;
};

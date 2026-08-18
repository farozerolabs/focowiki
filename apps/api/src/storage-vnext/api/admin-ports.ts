import type {
  StorageVnextBoundedMetadata,
  StorageVnextKnowledgeBaseId,
  StorageVnextOpaqueCursor,
  StorageVnextPage,
  StorageVnextPublicDocument,
  StorageVnextPublicId,
  StorageVnextRevision,
  StorageVnextStructuredMetadata,
  StorageVnextTimestamp
} from "../shared/types.js";

export type StorageVnextAdminKnowledgeBase = {
  id: StorageVnextKnowledgeBaseId;
  name: string;
  description: string | null;
  activeVersionId: StorageVnextPublicId | null;
  resourceRevision?: StorageVnextRevision;
  catalogVersion: number;
  createdAt: StorageVnextTimestamp;
  updatedAt: StorageVnextTimestamp;
};

export type StorageVnextAdminTreeEntry = {
  id: StorageVnextPublicId;
  parentPath: string;
  name: string;
  logicalPath: string;
  sortKey: string;
  entryType: "file" | "directory";
  generatedFileId: StorageVnextPublicId | null;
  sourceFileId: StorageVnextPublicId | null;
  sourceDirectoryId: StorageVnextPublicId | null;
  fileKind: string | null;
  directEntryCount: number;
  directDirectoryCount: number;
  directFileCount: number;
  descendantFileCount: number;
  resourceRevision: number | null;
  deletable: boolean;
};

export type StorageVnextAdminTreeSearchItem = {
  entry: StorageVnextAdminTreeEntry;
  ancestors: StorageVnextAdminTreeEntry[];
};

export type StorageVnextAdminApplicationErrorCode =
  "DATABASE_REPOSITORY_UNAVAILABLE" | "INVALID_PAGINATION" | "NOT_FOUND";

export type StorageVnextAdminApplicationResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: StorageVnextAdminApplicationErrorCode };

export type StorageVnextAdminFile = {
  publicId: StorageVnextPublicId;
  knowledgeBaseId: StorageVnextKnowledgeBaseId;
  logicalPath: string;
  title: string;
  metadata: StorageVnextStructuredMetadata;
  status: string;
  revision: StorageVnextRevision;
};

export type StorageVnextAdminFilePage = StorageVnextPage<StorageVnextAdminFile> & {
  refreshAfterMs?: number;
};

export type StorageVnextAdminOperationState =
  "accepted" | "validating" | "processing" |
  "completed" | "failed" | "cancelled" | "superseded";

export type StorageVnextAdminOperation = {
  publicId: StorageVnextPublicId;
  knowledgeBaseId: StorageVnextKnowledgeBaseId;
  kind: string;
  state: StorageVnextAdminOperationState;
  expectedResourceRevision: StorageVnextRevision | null;
  targetKind: "source_file" | "source_directory" | "knowledge_base" | null;
  targetPublicId: StorageVnextPublicId | null;
  candidateRelativePath: string | null;
  result: StorageVnextBoundedMetadata | null;
  errorCode: string | null;
  createdAt: StorageVnextTimestamp;
  updatedAt: StorageVnextTimestamp;
  completedAt: StorageVnextTimestamp | null;
};

export type StorageVnextAdminBackendAdapter = {
  listKnowledgeBases(input: {
    limit: number;
    cursor: StorageVnextOpaqueCursor | null;
    query: string | null;
  }): Promise<StorageVnextAdminApplicationResult<StorageVnextPage<StorageVnextAdminKnowledgeBase>>>;
  getKnowledgeBase(input: { knowledgeBaseId: StorageVnextKnowledgeBaseId }): Promise<StorageVnextAdminApplicationResult<StorageVnextAdminKnowledgeBase | null>>;
  createKnowledgeBase(input: { name: string; description: string | null }): Promise<StorageVnextAdminApplicationResult<StorageVnextAdminKnowledgeBase>>;
  updateKnowledgeBase(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    expectedRevision: StorageVnextRevision;
    name?: string;
    description?: string | null;
  }): Promise<StorageVnextAdminApplicationResult<StorageVnextPublicDocument>>;
  deleteKnowledgeBase(input: { knowledgeBaseId: StorageVnextKnowledgeBaseId }): Promise<StorageVnextAdminApplicationResult<StorageVnextPublicDocument>>;
  listDirectories(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    parentPublicId: StorageVnextPublicId | null;
    limit: number;
    cursor: StorageVnextOpaqueCursor | null;
  }): Promise<StorageVnextAdminApplicationResult<StorageVnextPage<StorageVnextPublicDocument>>>;
  getDirectory(input: { knowledgeBaseId: StorageVnextKnowledgeBaseId; publicId: StorageVnextPublicId }): Promise<StorageVnextAdminApplicationResult<StorageVnextPublicDocument | null>>;
  listTree(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    parentPath: string;
    entryType: "file" | "directory" | null;
    query?: string | null;
    limit: number;
    cursor: StorageVnextOpaqueCursor | null;
  }): Promise<StorageVnextAdminApplicationResult<StorageVnextPage<StorageVnextAdminTreeEntry>>>;
  searchFiles(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    query: string;
    limit: number;
    cursor: StorageVnextOpaqueCursor | null;
  }): Promise<StorageVnextAdminApplicationResult<StorageVnextPage<StorageVnextAdminTreeSearchItem>>>;
  listFiles(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    parentPublicId: StorageVnextPublicId | null;
    limit: number;
    cursor: StorageVnextOpaqueCursor | null;
  }): Promise<StorageVnextAdminFilePage>;
  getFile(input: { knowledgeBaseId: StorageVnextKnowledgeBaseId; publicId: StorageVnextPublicId }): Promise<StorageVnextAdminFile | null>;
  readSourceContent(input: { knowledgeBaseId: StorageVnextKnowledgeBaseId; publicId: StorageVnextPublicId }): Promise<Uint8Array | null>;
  listSourceEvents(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    publicId: StorageVnextPublicId;
    limit: number;
    cursor: StorageVnextOpaqueCursor | null;
  }): Promise<StorageVnextPage<StorageVnextPublicDocument>>;
  retrySourceFile(input: { knowledgeBaseId: StorageVnextKnowledgeBaseId; publicId: StorageVnextPublicId }): Promise<StorageVnextAdminApplicationResult<StorageVnextPublicDocument>>;
  createUploadSession(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    idempotencyKey: string;
    declaredFileCount: number;
    declaredByteCount: number;
  }): Promise<StorageVnextPublicDocument>;
  addUploadEntries(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    sessionPublicId: StorageVnextPublicId;
    entries: readonly StorageVnextPublicDocument[];
  }): Promise<StorageVnextPublicDocument>;
  sealUploadSession(input: { knowledgeBaseId: StorageVnextKnowledgeBaseId; sessionPublicId: StorageVnextPublicId }): Promise<StorageVnextPublicDocument>;
  writeUploadContent(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    sessionPublicId: StorageVnextPublicId;
    entryPublicId: StorageVnextPublicId;
    body: ReadableStream<Uint8Array>;
  }): Promise<StorageVnextPublicDocument>;
  getUploadSession(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    sessionPublicId: StorageVnextPublicId;
    limit: number;
    cursor: StorageVnextOpaqueCursor | null;
  }): Promise<StorageVnextPublicDocument>;
  reconcileUploadSession(input: { knowledgeBaseId: StorageVnextKnowledgeBaseId; sessionPublicId: StorageVnextPublicId }): Promise<StorageVnextPublicDocument>;
  finalizeUploadSession(input: { knowledgeBaseId: StorageVnextKnowledgeBaseId; sessionPublicId: StorageVnextPublicId }): Promise<StorageVnextPublicDocument>;
  cancelUploadSession(input: { knowledgeBaseId: StorageVnextKnowledgeBaseId; sessionPublicId: StorageVnextPublicId }): Promise<StorageVnextPublicDocument>;
  moveSourceFile(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    publicId: StorageVnextPublicId;
    relativePath: string;
    expectedRevision: StorageVnextRevision;
    idempotencyKey: string;
  }): Promise<StorageVnextAdminOperation>;
  moveSourceDirectory(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    publicId: StorageVnextPublicId;
    relativePath: string;
    expectedRevision: StorageVnextRevision;
    idempotencyKey: string;
  }): Promise<StorageVnextAdminOperation>;
  replaceSourceFileContent(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    publicId: StorageVnextPublicId;
    bytes: Uint8Array;
    expectedRevision: StorageVnextRevision;
    idempotencyKey: string;
  }): Promise<StorageVnextAdminOperation>;
  deleteSourceFile(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    publicId: StorageVnextPublicId;
    expectedRevision?: StorageVnextRevision;
    idempotencyKey?: string;
  }): Promise<StorageVnextPublicDocument>;
  deleteSourceDirectory(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    publicId: StorageVnextPublicId;
    expectedRevision: StorageVnextRevision;
    idempotencyKey: string;
  }): Promise<StorageVnextPublicDocument>;
  listOperations(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    states: readonly StorageVnextAdminOperationState[];
    limit: number;
    cursor: StorageVnextOpaqueCursor | null;
  }): Promise<StorageVnextPage<StorageVnextAdminOperation>>;
  getOperation(input: { knowledgeBaseId: StorageVnextKnowledgeBaseId; publicId: StorageVnextPublicId }): Promise<StorageVnextAdminOperation | null>;
  readGeneratedContent(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    logicalPath: string;
  }): Promise<StorageVnextPublicDocument | null>;
  expandGraph(input: StorageVnextPublicDocument): Promise<StorageVnextPublicDocument>;
  getGraphOverview(input: { knowledgeBaseId: StorageVnextKnowledgeBaseId }): Promise<StorageVnextPublicDocument>;
  listRelatedFiles(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    publicId: StorageVnextPublicId;
    limit: number;
    cursor: StorageVnextOpaqueCursor | null;
  }): Promise<StorageVnextPage<StorageVnextPublicDocument>>;
  requestMaintenance(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    idempotencyKey: string;
  }): Promise<StorageVnextPublicDocument>;
  getMaintenanceStatus(input: { knowledgeBaseId: StorageVnextKnowledgeBaseId }): Promise<StorageVnextPublicDocument>;
  getRuntimeSettings(): Promise<StorageVnextPublicDocument>;
  updateRuntimeSettings(input: {
    section: string;
    value: StorageVnextPublicDocument;
  }): Promise<StorageVnextPublicDocument>;
};

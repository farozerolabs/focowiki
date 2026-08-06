import type {
  StorageVnextBoundedMetadata,
  StorageVnextKnowledgeBaseId,
  StorageVnextOpaqueCursor,
  StorageVnextPage,
  StorageVnextPublicDocument,
  StorageVnextPublicId,
  StorageVnextRevision,
  StorageVnextTimestamp
} from "../shared/types.js";

export type StorageVnextOpenApiFile = {
  publicId: StorageVnextPublicId;
  knowledgeBaseId: StorageVnextKnowledgeBaseId;
  logicalPath: string;
  title: string;
  status: string;
};

export type StorageVnextOpenApiSearchResult = {
  publicId: StorageVnextPublicId;
  sourceFilePublicId: StorageVnextPublicId;
  logicalPath: string;
  title: string;
  snippet: string | null;
};

export type StorageVnextOpenApiOperationState =
  | "accepted"
  | "validating"
  | "processing"
  | "publishing"
  | "completed"
  | "failed"
  | "cancelled"
  | "superseded";

export type StorageVnextOpenApiOperation = {
  publicId: StorageVnextPublicId;
  knowledgeBaseId: StorageVnextKnowledgeBaseId;
  kind: string;
  state: StorageVnextOpenApiOperationState;
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

export type StorageVnextOpenApiBackendAdapter = {
  listKnowledgeBases(input: {
    limit: number;
    cursor: StorageVnextOpaqueCursor | null;
  }): Promise<StorageVnextPage<StorageVnextPublicDocument>>;
  getKnowledgeBase(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
  }): Promise<StorageVnextPublicDocument | null>;
  createKnowledgeBase(input: {
    name: string;
    description: string | null;
  }): Promise<StorageVnextPublicDocument>;
  updateKnowledgeBase(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    expectedRevision: StorageVnextRevision;
    name?: string;
    description?: string | null;
  }): Promise<StorageVnextPublicDocument>;
  deleteKnowledgeBase(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    expectedRevision: StorageVnextRevision;
    idempotencyKey: string;
  }): Promise<StorageVnextPublicDocument>;
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
  sealUploadSession(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    sessionPublicId: StorageVnextPublicId;
  }): Promise<StorageVnextPublicDocument>;
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
  reconcileUploadSession(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    sessionPublicId: StorageVnextPublicId;
  }): Promise<StorageVnextPublicDocument>;
  finalizeUploadSession(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    sessionPublicId: StorageVnextPublicId;
  }): Promise<StorageVnextPublicDocument>;
  cancelUploadSession(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    sessionPublicId: StorageVnextPublicId;
  }): Promise<StorageVnextPublicDocument>;
  listSourceFiles(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    directoryPublicId?: StorageVnextPublicId | null;
    limit: number;
    cursor: StorageVnextOpaqueCursor | null;
  }): Promise<StorageVnextPage<StorageVnextPublicDocument>>;
  getSourceFile(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    publicId: StorageVnextPublicId;
  }): Promise<StorageVnextPublicDocument | null>;
  readSourceContent(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    publicId: StorageVnextPublicId;
  }): Promise<Uint8Array | null>;
  listDirectories(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    parentPublicId: StorageVnextPublicId | null;
    limit: number;
    cursor: StorageVnextOpaqueCursor | null;
  }): Promise<StorageVnextPage<StorageVnextPublicDocument>>;
  getDirectory(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    publicId: StorageVnextPublicId;
  }): Promise<StorageVnextPublicDocument | null>;
  moveSourceFile(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    publicId: StorageVnextPublicId;
    relativePath: string;
    expectedRevision: StorageVnextRevision;
    idempotencyKey: string;
  }): Promise<StorageVnextOpenApiOperation>;
  moveSourceDirectory(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    publicId: StorageVnextPublicId;
    relativePath: string;
    expectedRevision: StorageVnextRevision;
    idempotencyKey: string;
  }): Promise<StorageVnextOpenApiOperation>;
  replaceSourceFileContent(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    publicId: StorageVnextPublicId;
    bytes: Uint8Array;
    expectedRevision: StorageVnextRevision;
    idempotencyKey: string;
  }): Promise<StorageVnextOpenApiOperation>;
  deleteSourceFile(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    publicId: StorageVnextPublicId;
    expectedRevision: StorageVnextRevision;
    idempotencyKey: string;
  }): Promise<StorageVnextPublicDocument>;
  deleteSourceDirectory(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    publicId: StorageVnextPublicId;
    expectedRevision: StorageVnextRevision;
    idempotencyKey: string;
  }): Promise<StorageVnextPublicDocument>;
  listFiles(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    parentPublicId: StorageVnextPublicId | null;
    limit: number;
    cursor: StorageVnextOpaqueCursor | null;
  }): Promise<StorageVnextPage<StorageVnextOpenApiFile>>;
  readFile(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    publicId: StorageVnextPublicId;
  }): Promise<StorageVnextOpenApiFile | null>;
  search(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    query: string;
    limit: number;
    cursor: StorageVnextOpaqueCursor | null;
  }): Promise<StorageVnextPage<StorageVnextOpenApiSearchResult>>;
  listOperations(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    states: readonly StorageVnextOpenApiOperationState[];
    limit: number;
    cursor: StorageVnextOpaqueCursor | null;
  }): Promise<StorageVnextPage<StorageVnextOpenApiOperation>>;
  getOperation(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    publicId: StorageVnextPublicId;
  }): Promise<StorageVnextOpenApiOperation | null>;
  listSourceEvents(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    publicId: StorageVnextPublicId;
    limit: number;
    cursor: StorageVnextOpaqueCursor | null;
  }): Promise<StorageVnextPage<StorageVnextPublicDocument>>;
  retrySourceFile(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    publicId: StorageVnextPublicId;
  }): Promise<StorageVnextPublicDocument>;
  expandGraph(input: StorageVnextPublicDocument): Promise<StorageVnextPublicDocument>;
  getGraphOverview(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
  }): Promise<StorageVnextPublicDocument>;
  listRelatedFiles(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    publicId: StorageVnextPublicId;
    limit: number;
    cursor: StorageVnextOpaqueCursor | null;
  }): Promise<StorageVnextPage<StorageVnextPublicDocument>>;
  createWebhook(input: StorageVnextPublicDocument): Promise<StorageVnextPublicDocument>;
  listWebhooks(input: {
    limit: number;
    cursor: StorageVnextOpaqueCursor | null;
  }): Promise<StorageVnextPage<StorageVnextPublicDocument>>;
  deleteWebhook(input: { publicId: StorageVnextPublicId }): Promise<StorageVnextPublicDocument>;
  listWebhookDeliveries(input: {
    limit: number;
    cursor: StorageVnextOpaqueCursor | null;
  }): Promise<StorageVnextPage<StorageVnextPublicDocument>>;
  redeliverWebhook(input: { publicId: StorageVnextPublicId }): Promise<StorageVnextPublicDocument>;
};

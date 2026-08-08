import type {
  StorageVnextByteCount,
  StorageVnextChecksum,
  StorageVnextKnowledgeBaseId,
  StorageVnextOpaqueCursor,
  StorageVnextPage,
  StorageVnextPublicId,
  StorageVnextRevision,
  StorageVnextRevisionCheck,
  StorageVnextStructuredMetadata,
  StorageVnextTimestamp
} from "../shared/types.js";

export type StorageVnextCatalogVisibility = "current" | "deleted";
export type StorageVnextCatalogReadVisibility = StorageVnextCatalogVisibility | "all";
export type StorageVnextSourceFileStatus = "pending" | "processing" | "ready" | "failed";

export type StorageVnextModelInvocationFact = {
  sourceRevisionPublicId: StorageVnextPublicId;
  status: "running" | "completed" | "failed" | "skipped";
  modelName: string | null;
  startedAt: StorageVnextTimestamp | null;
  endedAt: StorageVnextTimestamp | null;
  warningCount: number;
  errorCode: string | null;
};

export type StorageVnextKnowledgeBaseFact = {
  publicId: StorageVnextKnowledgeBaseId;
  name: string;
  description: string | null;
  revision: StorageVnextRevision;
  visibility: StorageVnextCatalogVisibility;
  createdAt: StorageVnextTimestamp;
  updatedAt: StorageVnextTimestamp;
};

export type StorageVnextDirectoryFact = {
  publicId: StorageVnextPublicId;
  knowledgeBaseId: StorageVnextKnowledgeBaseId;
  parentPublicId: StorageVnextPublicId | null;
  logicalPath: string;
  normalizedPath: string;
  title: string;
  revision: StorageVnextRevision;
  visibility: StorageVnextCatalogVisibility;
};

export type StorageVnextSourceFileFact = {
  publicId: StorageVnextPublicId;
  knowledgeBaseId: StorageVnextKnowledgeBaseId;
  directoryPublicId: StorageVnextPublicId | null;
  logicalPath: string;
  normalizedPath: string;
  title: string;
  metadata: StorageVnextStructuredMetadata;
  currentRevisionPublicId: StorageVnextPublicId | null;
  status: StorageVnextSourceFileStatus;
  safeErrorCode: string | null;
  safeErrorMessage: string | null;
  modelInvocation?: StorageVnextModelInvocationFact | null;
  revision: StorageVnextRevision;
  visibility: StorageVnextCatalogVisibility;
};

export type StorageVnextSourceRevisionFact = {
  publicId: StorageVnextPublicId;
  sourceFilePublicId: StorageVnextPublicId;
  knowledgeBaseId: StorageVnextKnowledgeBaseId;
  objectId: string;
  checksum: StorageVnextChecksum;
  byteCount: StorageVnextByteCount;
  contentType: string;
  createdAt: StorageVnextTimestamp;
};

export type StorageVnextCurrentSourceFact = {
  sourceFile: StorageVnextSourceFileFact;
  sourceRevision: StorageVnextSourceRevisionFact;
};

export type StorageVnextCatalogReadPort = {
  getKnowledgeBase(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    visibility?: StorageVnextCatalogReadVisibility;
  }): Promise<StorageVnextKnowledgeBaseFact | null>;
  listKnowledgeBases(input: {
    visibility?: StorageVnextCatalogReadVisibility;
    query?: string | null;
    limit: number;
    cursor: StorageVnextOpaqueCursor | null;
  }): Promise<StorageVnextPage<StorageVnextKnowledgeBaseFact>>;
  getDirectory(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    publicId: StorageVnextPublicId;
    visibility?: StorageVnextCatalogReadVisibility;
  }): Promise<StorageVnextDirectoryFact | null>;
  getSourceFile(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    publicId: StorageVnextPublicId;
    visibility?: StorageVnextCatalogReadVisibility;
  }): Promise<StorageVnextSourceFileFact | null>;
  getSourceRevision(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    publicId: StorageVnextPublicId;
  }): Promise<StorageVnextSourceRevisionFact | null>;
  getCurrentSourceRevision(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    sourceFilePublicId: StorageVnextPublicId;
  }): Promise<StorageVnextSourceRevisionFact | null>;
  listDirectories(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    parentPublicId: StorageVnextPublicId | null | undefined;
    visibility?: StorageVnextCatalogReadVisibility;
    limit: number;
    cursor: StorageVnextOpaqueCursor | null;
  }): Promise<StorageVnextPage<StorageVnextDirectoryFact>>;
  listDirectoriesByPublicIds(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    publicIds: readonly StorageVnextPublicId[];
    limit: number;
  }): Promise<readonly StorageVnextDirectoryFact[]>;
  listSourceFiles(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    directoryPublicId: StorageVnextPublicId | null | undefined;
    visibility?: StorageVnextCatalogReadVisibility;
    limit: number;
    cursor: StorageVnextOpaqueCursor | null;
  }): Promise<StorageVnextPage<StorageVnextSourceFileFact>>;
  listSourceFilesByPublicIds(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    publicIds: readonly StorageVnextPublicId[];
    limit: number;
  }): Promise<readonly StorageVnextSourceFileFact[]>;
  listCurrentSources(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    limit: number;
    cursor: StorageVnextOpaqueCursor | null;
  }): Promise<StorageVnextPage<StorageVnextCurrentSourceFact>>;
  listSourceRevisions(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    limit: number;
    cursor: StorageVnextOpaqueCursor | null;
  }): Promise<StorageVnextPage<StorageVnextSourceRevisionFact>>;
};

export type StorageVnextCatalogWritePort = {
  createKnowledgeBase(input: {
    publicId: StorageVnextKnowledgeBaseId;
    name: string;
    description: string | null;
  }): Promise<StorageVnextKnowledgeBaseFact>;
  updateKnowledgeBase(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    name?: string;
    description?: string | null;
    revisionCheck: StorageVnextRevisionCheck;
  }): Promise<StorageVnextKnowledgeBaseFact>;
  createDirectory(input: {
    publicId: StorageVnextPublicId;
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    parentPublicId: StorageVnextPublicId | null;
    logicalPath: string;
    title: string;
  }): Promise<StorageVnextDirectoryFact>;
  createSourceFile(input: {
    publicId: StorageVnextPublicId;
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    directoryPublicId: StorageVnextPublicId | null;
    logicalPath: string;
    title: string;
    metadata: StorageVnextStructuredMetadata;
    status: StorageVnextSourceFileStatus;
    safeErrorCode?: string | null;
    safeErrorMessage?: string | null;
  }): Promise<StorageVnextSourceFileFact>;
  createImmutableRevision(
    revision: StorageVnextSourceRevisionFact
  ): Promise<StorageVnextSourceRevisionFact>;
  compareAndSetCurrentRevision(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    sourceFilePublicId: StorageVnextPublicId;
    revisionPublicId: StorageVnextPublicId;
    revisionCheck: StorageVnextRevisionCheck;
  }): Promise<StorageVnextSourceFileFact>;
  updateSourceFileState(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    publicId: StorageVnextPublicId;
    metadata: StorageVnextStructuredMetadata;
    status: StorageVnextSourceFileStatus;
    safeErrorCode: string | null;
    safeErrorMessage: string | null;
    modelInvocation?: StorageVnextModelInvocationFact | null;
    revisionCheck: StorageVnextRevisionCheck;
  }): Promise<StorageVnextSourceFileFact>;
  updateLogicalPath(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    publicId: StorageVnextPublicId;
    logicalPath: string;
    revisionCheck: StorageVnextRevisionCheck;
  }): Promise<StorageVnextSourceFileFact>;
  moveSourceFile(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    publicId: StorageVnextPublicId;
    directoryPublicId: StorageVnextPublicId | null;
    logicalPath: string;
    revisionCheck: StorageVnextRevisionCheck;
  }): Promise<StorageVnextSourceFileFact>;
  markSourceFileDeleted(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    publicId: StorageVnextPublicId;
    revisionCheck: StorageVnextRevisionCheck;
    deletedAt: StorageVnextTimestamp;
  }): Promise<void>;
  markDirectoryDeleted(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    publicId: StorageVnextPublicId;
    revisionCheck: StorageVnextRevisionCheck;
    deletedAt: StorageVnextTimestamp;
  }): Promise<void>;
  markKnowledgeBaseDeleted(input: {
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
    revisionCheck: StorageVnextRevisionCheck;
    deletedAt: StorageVnextTimestamp;
  }): Promise<void>;
};

export type StorageVnextCatalogRepository =
  & StorageVnextCatalogReadPort
  & StorageVnextCatalogWritePort;

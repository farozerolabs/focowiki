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
};

export type StorageVnextCatalogRepository =
  & StorageVnextCatalogReadPort
  & StorageVnextCatalogWritePort;

import type {
  ResourceOperationRecord,
  SourceDirectoryRecord,
  SourceResourceFileFilters,
  SourceResourceFileRecord
} from "../../domain/source-resource.js";

export type StorageVnextKnowledgeBaseRecord = {
  id: string;
  name: string;
  description: string | null;
  activeContentRevision: number;
  resourceRevision?: number;
  createdAt: string;
  updatedAt: string;
};

type ResourcePage<T> = { items: T[]; nextCursor: string | null };
type OperationResult = { operation: ResourceOperationRecord };

export type StorageVnextAdminMutationApplication = {
  available(): boolean;
  updateKnowledgeBase(request: {
    knowledgeBaseId: string;
    expectedResourceRevision: number;
    name?: string;
    description?: string | null;
    idempotencyKey?: string;
  }): Promise<{
    knowledgeBase: StorageVnextKnowledgeBaseRecord | null;
  }>;
  deleteKnowledgeBase(request: {
    knowledgeBaseId: string;
    idempotencyKey: string;
    expectedResourceRevision: number;
  }): Promise<OperationResult & { affectedDirectoryCount: number; affectedFileCount: number }>;
  getKnowledgeBase(request: {
    knowledgeBaseId: string;
  }): Promise<StorageVnextKnowledgeBaseRecord | null>;
  listDirectories(request: {
    knowledgeBaseId: string;
    parentDirectoryId: string | null;
    limit: number;
    cursor: string | null;
  }): Promise<ResourcePage<SourceDirectoryRecord>>;
  getDirectory(request: {
    knowledgeBaseId: string;
    directoryId: string;
  }): Promise<SourceDirectoryRecord | null>;
  listSourceFiles(request: {
    knowledgeBaseId: string;
    directoryId: string | null | undefined;
    filters: SourceResourceFileFilters;
    limit: number;
    cursor: string | null;
  }): Promise<ResourcePage<SourceResourceFileRecord>>;
  getSourceFile(request: {
    knowledgeBaseId: string;
    sourceFileId: string;
  }): Promise<SourceResourceFileRecord | null>;
  moveSourceDirectory(request: {
    knowledgeBaseId: string;
    idempotencyKey: string;
    expectedResourceRevision: number;
    targetId: string;
    relativePath: string;
  }): Promise<OperationResult>;
  deleteSourceDirectory(request: {
    knowledgeBaseId: string;
    directoryId: string;
    idempotencyKey: string | null;
    expectedResourceRevision: number;
  }): Promise<OperationResult & {
    effectiveDirectoryId: string;
    affectedDirectoryCount: number;
    affectedFileCount: number;
  }>;
  readSourceContent(request: {
    knowledgeBaseId: string;
    sourceFileId: string;
  }): Promise<{
    content: BodyInit;
    contentType: string;
    resourceRevision: number;
    contentRevision: number;
  } | null>;
  moveSourceFile(request: {
    knowledgeBaseId: string;
    idempotencyKey: string;
    expectedResourceRevision: number;
    targetId: string;
    relativePath: string;
  }): Promise<OperationResult>;
  replaceSourceFileContent(request: {
    knowledgeBaseId: string;
    sourceFileId: string;
    expectedResourceRevision: number;
    idempotencyKey: string;
    bytes: Uint8Array;
    relativePath?: string;
  }): Promise<OperationResult>;
  deleteSourceFile(request: {
    knowledgeBaseId: string;
    sourceFileId: string;
    idempotencyKey: string;
    expectedResourceRevision: number;
  }): Promise<OperationResult>;
  listOperations(request: {
    knowledgeBaseId: string;
    states?: ResourceOperationRecord["state"][];
    limit: number;
    cursor: string | null;
  }): Promise<ResourcePage<ResourceOperationRecord>>;
  getOperation(request: {
    knowledgeBaseId: string;
    operationId: string;
  }): Promise<ResourceOperationRecord | null>;
};

export function createStorageVnextAdminMutationApplication(input: {
  backend: StorageVnextAdminMutationApplication | null;
  onDocumentWorkAccepted?: () => Promise<void>;
  onDeletionWorkAccepted?: () => Promise<void>;
}): StorageVnextAdminMutationApplication {
  if (!input.backend) return unavailableApplication();
  const backend = input.backend;
  return {
    ...backend,
    async deleteKnowledgeBase(request) {
      const result = await backend.deleteKnowledgeBase(request);
      await input.onDeletionWorkAccepted?.();
      return result;
    },
    async moveSourceDirectory(request) {
      const result = await backend.moveSourceDirectory(request);
      await input.onDocumentWorkAccepted?.();
      return result;
    },
    async deleteSourceDirectory(request) {
      const result = await backend.deleteSourceDirectory(request);
      await input.onDeletionWorkAccepted?.();
      return result;
    },
    async moveSourceFile(request) {
      const result = await backend.moveSourceFile(request);
      await input.onDocumentWorkAccepted?.();
      return result;
    },
    async replaceSourceFileContent(request) {
      const result = await backend.replaceSourceFileContent(request);
      await input.onDocumentWorkAccepted?.();
      return result;
    },
    async deleteSourceFile(request) {
      const result = await backend.deleteSourceFile(request);
      await input.onDeletionWorkAccepted?.();
      return result;
    }
  };
}

function unavailableApplication(): StorageVnextAdminMutationApplication {
  const unavailable = async (): Promise<never> => {
    throw new StorageVnextAdminMutationApplicationError();
  };
  return {
    available: () => false,
    updateKnowledgeBase: unavailable,
    deleteKnowledgeBase: unavailable,
    getKnowledgeBase: unavailable,
    listDirectories: unavailable,
    getDirectory: unavailable,
    listSourceFiles: unavailable,
    getSourceFile: unavailable,
    moveSourceDirectory: unavailable,
    deleteSourceDirectory: unavailable,
    readSourceContent: unavailable,
    moveSourceFile: unavailable,
    replaceSourceFileContent: unavailable,
    deleteSourceFile: unavailable,
    listOperations: unavailable,
    getOperation: unavailable
  };
}

export class StorageVnextAdminMutationApplicationError extends Error {
  constructor() {
    super("DATABASE_REPOSITORY_UNAVAILABLE");
    this.name = "StorageVnextAdminMutationApplicationError";
  }
}

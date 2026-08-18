import type {
  SourceFileGeneratedOutputStatus,
  SourceFileLifecycleState,
  SourceFileWorkKind
} from "../../domain/source-file-lifecycle.js";

export type StorageVnextAdminSourceFileFilters = {
  fileNameQuery?: string | null;
  fileIdQuery?: string | null;
  state?: SourceFileLifecycleState | null;
  currentStage?: SourceFileWorkKind | SourceFileLifecycleState | null;
  modelInvocationStatus?:
    "not_required" | "running" | "completed" | "failed" | "not_recorded" | null;
  generatedOutputStatus?: SourceFileGeneratedOutputStatus | null;
  startedFrom?: string | null;
  startedTo?: string | null;
  endedFrom?: string | null;
  endedTo?: string | null;
  errorState?: "with_error" | "without_error" | null;
  errorCodeQuery?: string | null;
  actionState?:
    | "openable"
    | "retryable"
    | "correctable"
    | "details_only"
    | "none"
    | null;
};

export type StorageVnextAdminCoreErrorCode =
  | "DATABASE_REPOSITORY_UNAVAILABLE"
  | "INVALID_PAGINATION"
  | "NOT_FOUND"
  | "FILE_NOT_DELETABLE";

export type StorageVnextAdminCoreResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: StorageVnextAdminCoreErrorCode };

export type StorageVnextAdminCoreApplication = {
  createKnowledgeBase(request: {
    name: string;
    description: string | null;
  }): Promise<StorageVnextAdminCoreResult<Record<string, unknown>>>;
  getKnowledgeBase(request: {
    knowledgeBaseId: string;
  }): Promise<StorageVnextAdminCoreResult<Record<string, unknown>>>;
  deleteKnowledgeBase(request: {
    knowledgeBaseId: string;
  }): Promise<StorageVnextAdminCoreResult<Record<string, unknown>>>;
  readGeneratedContent(request: {
    knowledgeBaseId: string;
    logicalPath: string;
    includeRelationships: boolean;
  }): Promise<StorageVnextAdminCoreResult<Response | Record<string, unknown>>>;
  deleteSourceFile(request: {
    knowledgeBaseId: string;
    logicalPath: string;
  }): Promise<StorageVnextAdminCoreResult<Record<string, unknown>>>;
  listFiles(request: {
    knowledgeBaseId: string;
    limit: number;
    cursor: string | null;
    filters: StorageVnextAdminSourceFileFilters;
  }): Promise<StorageVnextAdminCoreResult<Record<string, unknown>>>;
  getFile(request: {
    knowledgeBaseId: string;
    sourceFileId: string;
    limit: number;
    cursor: string | null;
  }): Promise<StorageVnextAdminCoreResult<Record<string, unknown>>>;
};

export function createStorageVnextAdminCoreApplication(input: {
  backend: StorageVnextAdminCoreApplication | null;
}): StorageVnextAdminCoreApplication {
  return input.backend ?? unavailableApplication();
}

function unavailableApplication(): StorageVnextAdminCoreApplication {
  const unavailable = async (): Promise<StorageVnextAdminCoreResult<never>> => ({
    ok: false,
    code: "DATABASE_REPOSITORY_UNAVAILABLE"
  });
  return {
    createKnowledgeBase: unavailable,
    getKnowledgeBase: unavailable,
    deleteKnowledgeBase: unavailable,
    readGeneratedContent: unavailable,
    deleteSourceFile: unavailable,
    listFiles: unavailable,
    getFile: unavailable
  };
}

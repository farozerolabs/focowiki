export type StorageVnextAdminSourceErrorCode =
  | "DATABASE_REPOSITORY_UNAVAILABLE"
  | "NOT_FOUND"
  | "SOURCE_FILE_RETRY_ALREADY_RUNNING"
  | "SOURCE_FILE_RETRY_NOT_ALLOWED"
  | "SOURCE_FILE_RETRY_RESOURCE_CONFLICT";

export type StorageVnextAdminSourceResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: StorageVnextAdminSourceErrorCode };

export type StorageVnextAdminSourceApplication = {
  retrySourceFile(request: {
    knowledgeBaseId: string;
    sourceFileId: string;
  }): Promise<StorageVnextAdminSourceResult<{
    file: Record<string, unknown> & { id: string };
    retry: { kind: string; scope: string; coalesced: boolean };
  }>>;
  deleteSourceFileTasks(request: {
    knowledgeBaseId: string;
    sourceFileIds: string[];
  }): Promise<StorageVnextAdminSourceResult<Record<string, unknown>>>;
};

export function createStorageVnextAdminSourceApplication(input: {
  backend: StorageVnextAdminSourceApplication | null;
  onDocumentWorkAccepted?: () => Promise<void>;
  onDeletionWorkAccepted?: () => Promise<void>;
}): StorageVnextAdminSourceApplication {
  if (input.backend) return {
    async retrySourceFile(request) {
      const result = await input.backend!.retrySourceFile(request);
      if (result.ok) await input.onDocumentWorkAccepted?.();
      return result;
    },
    async deleteSourceFileTasks(request) {
      const result = await input.backend!.deleteSourceFileTasks(request);
      if (result.ok) await input.onDeletionWorkAccepted?.();
      return result;
    }
  };
  return {
    async retrySourceFile() {
      return { ok: false, code: "DATABASE_REPOSITORY_UNAVAILABLE" };
    },
    async deleteSourceFileTasks() {
      return { ok: false, code: "DATABASE_REPOSITORY_UNAVAILABLE" };
    }
  };
}

import type { StorageVnextAdminApplicationResult } from "./admin-ports.js";

export type StorageVnextAdminProcessingSummary = {
  activeVersionId: string | null;
  pendingDispatch: Record<string, unknown>;
  sourceFileJobs: Record<string, unknown>;
  publicationJobs: Record<string, unknown>;
  publicationProgress: Record<string, unknown>;
  maintenanceProgress: Record<string, unknown>;
  indexMaintenance: Record<string, unknown>;
  dirtySourceFiles: Record<string, unknown>;
};

export type StorageVnextAdminProcessingApplication = {
  getProcessingSummary(request: {
    knowledgeBaseId: string;
  }): Promise<StorageVnextAdminApplicationResult<StorageVnextAdminProcessingSummary>>;
};

export function createStorageVnextAdminProcessingApplication(input: {
  backend: StorageVnextAdminProcessingApplication | null;
}): StorageVnextAdminProcessingApplication {
  return input.backend ?? {
    async getProcessingSummary() {
      return { ok: false, code: "DATABASE_REPOSITORY_UNAVAILABLE" };
    }
  };
}

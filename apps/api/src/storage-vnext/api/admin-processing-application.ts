import type { StorageVnextAdminApplicationResult } from "./admin-ports.js";

export type StorageVnextAdminProcessingSummary = {
  waitingCount: number;
  processingCount: number;
  availableCount: number;
  errorCount: number;
  oldestWaitingAt: string | null;
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

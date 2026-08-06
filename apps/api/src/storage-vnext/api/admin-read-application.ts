import type {
  StorageVnextAdminApplicationResult,
  StorageVnextAdminBackendAdapter
} from "./admin-ports.js";

export type StorageVnextAdminReadApplication = Pick<
  StorageVnextAdminBackendAdapter,
  "getKnowledgeBase" | "listKnowledgeBases" | "listTree" | "searchFiles"
>;

export function createStorageVnextAdminReadApplication(input: {
  backend: StorageVnextAdminReadApplication | null;
}): StorageVnextAdminReadApplication {
  return input.backend ?? {
    async listKnowledgeBases() {
      return unavailable();
    },
    async getKnowledgeBase() {
      return unavailable();
    },
    async listTree() {
      return unavailable();
    },
    async searchFiles() {
      return unavailable();
    }
  };
}

function unavailable(): StorageVnextAdminApplicationResult<never> {
  return { ok: false, code: "DATABASE_REPOSITORY_UNAVAILABLE" };
}

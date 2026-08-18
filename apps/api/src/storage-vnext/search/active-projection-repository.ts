import type { SearchProviderKind } from
  "../../application/ports/search-provider-runtime.js";

export type StorageVnextActiveSearchProjection = {
  publicId: string;
  knowledgeBaseId: string;
  providerKind: SearchProviderKind;
  providerIndexUid: string;
  schemaChecksum: string;
  settingsChecksum: string;
  activeContractRevision?: number;
  documentChecksum: string;
  documentCount: number;
};

export interface StorageVnextActiveSearchProjectionRepository {
  getActiveProjection(
    knowledgeBaseId: string
  ): Promise<StorageVnextActiveSearchProjection | null>;
}

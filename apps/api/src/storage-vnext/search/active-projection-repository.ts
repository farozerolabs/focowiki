export type StorageVnextActiveSearchProjection = {
  publicId: string;
  knowledgeBaseId: string;
  providerIndexUid: string;
  schemaChecksum: string;
  settingsChecksum: string;
  documentChecksum: string;
  documentCount: number;
};

export interface StorageVnextActiveSearchProjectionRepository {
  getActiveProjection(
    knowledgeBaseId: string
  ): Promise<StorageVnextActiveSearchProjection | null>;
}

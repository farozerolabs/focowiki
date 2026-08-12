import type {
  StorageVnextChecksum,
  StorageVnextKnowledgeBaseId,
  StorageVnextPublicId,
  StorageVnextRevision,
  StorageVnextTimestamp
} from "../shared/types.js";

export type StorageVnextActiveSnapshot = {
  knowledgeBaseId: StorageVnextKnowledgeBaseId;
  revision: StorageVnextRevision;
  releaseRootPublicId: StorageVnextPublicId;
  searchProjectionPublicId: StorageVnextPublicId;
  manifestChecksum: StorageVnextChecksum;
  navigationProfileVersion: number;
  activatedByOperationPublicId: StorageVnextPublicId;
  publiclyVisibleAt: StorageVnextTimestamp;
};

import type {
  StorageVnextBoundedMetadata,
  StorageVnextChecksum,
  StorageVnextKnowledgeBaseId,
  StorageVnextOpaqueCursor,
  StorageVnextPage,
  StorageVnextPublicId,
  StorageVnextTimestamp
} from "../shared/types.js";

export type StorageVnextOwnedScopeProof = {
  runId: string;
  nonceHash: StorageVnextChecksum;
  ownerMarker: string;
  postgresScope: string;
  objectScope: string;
  searchScope: string;
  coordinationScope: string;
  filesystemScope: string;
  createdAt: StorageVnextTimestamp;
  proofChecksum: StorageVnextChecksum;
};

export type StorageVnextDeploymentPhase =
  | "empty"
  | "bootstrapped"
  | "rebuilding"
  | "validated"
  | "active"
  | "rollback_window"
  | "retirement_ready"
  | "retired";

export type StorageVnextDeploymentState = {
  publicId: StorageVnextPublicId;
  phase: StorageVnextDeploymentPhase;
  scopeProofChecksum: StorageVnextChecksum;
  schemaVersion: string;
  activeSnapshotPublicId: StorageVnextPublicId | null;
  updatedAt: StorageVnextTimestamp;
};

export type StorageVnextRebuildCheckpoint = {
  publicId: StorageVnextPublicId;
  deploymentPublicId: StorageVnextPublicId;
  knowledgeBaseId: StorageVnextKnowledgeBaseId;
  sourceCursor: StorageVnextOpaqueCursor | null;
  completedFileCount: number;
  completedByteCount: number;
  checkpoint: StorageVnextBoundedMetadata;
  updatedAt: StorageVnextTimestamp;
};

export type StorageVnextValidationEvidence = {
  publicId: StorageVnextPublicId;
  deploymentPublicId: StorageVnextPublicId;
  manifestChecksum: StorageVnextChecksum;
  sourceCount: number;
  logicalPathCount: number;
  objectCount: number;
  searchDocumentCount: number;
  graphNodeCount: number;
  graphEdgeCount: number;
  ownerClosurePassed: boolean;
  generatedStructurePassed: boolean;
  adminContractPassed: boolean;
  openApiContractPassed: boolean;
  resourceBudgetPassed: boolean;
  restorePassed: boolean;
  validatedAt: StorageVnextTimestamp;
};

export type StorageVnextRollbackEvidence = {
  publicId: StorageVnextPublicId;
  deploymentPublicId: StorageVnextPublicId;
  restorableBackupPublicId: StorageVnextPublicId;
  acceptedWriteExportPublicId: StorageVnextPublicId | null;
  preCutoverDrillPassed: boolean;
  postCutoverDrillPassed: boolean;
  verifiedAt: StorageVnextTimestamp;
};

export type StorageVnextRetirementEvidence = {
  publicId: StorageVnextPublicId;
  deploymentPublicId: StorageVnextPublicId;
  restorableBackupPublicId: StorageVnextPublicId;
  legacyInventoryChecksum: StorageVnextChecksum;
  rollbackExpiredAt: StorageVnextTimestamp;
  productParityPassed: boolean;
  cleanupClosurePassed: boolean;
  capacityPassed: boolean;
  approvedAt: StorageVnextTimestamp;
};

export type StorageVnextBootstrapPort = {
  refuseUnownedScope(proof: StorageVnextOwnedScopeProof | null): Promise<void>;
  initializeClean(input: {
    deploymentPublicId: StorageVnextPublicId;
    scopeProof: StorageVnextOwnedScopeProof;
    schemaVersion: string;
  }): Promise<StorageVnextDeploymentState>;
};

export type StorageVnextRebuildPort = {
  start(input: {
    deploymentPublicId: StorageVnextPublicId;
    knowledgeBaseId: StorageVnextKnowledgeBaseId;
  }): Promise<StorageVnextRebuildCheckpoint>;
  resume(checkpoint: StorageVnextRebuildCheckpoint): Promise<StorageVnextRebuildCheckpoint>;
  listCheckpoints(input: {
    deploymentPublicId: StorageVnextPublicId;
    limit: number;
    cursor: StorageVnextOpaqueCursor | null;
  }): Promise<StorageVnextPage<StorageVnextRebuildCheckpoint>>;
};

export type StorageVnextValidationPort = {
  validate(input: {
    deploymentPublicId: StorageVnextPublicId;
    scopeProof: StorageVnextOwnedScopeProof;
  }): Promise<StorageVnextValidationEvidence>;
};

export type StorageVnextCutoverPort = {
  activateValidated(input: {
    deploymentPublicId: StorageVnextPublicId;
    validationPublicId: StorageVnextPublicId;
    expectedPhase: "validated";
  }): Promise<StorageVnextDeploymentState>;
  rollbackToLegacyBackup(input: {
    deploymentPublicId: StorageVnextPublicId;
    rollbackEvidence: StorageVnextRollbackEvidence;
    expectedPhase: "active" | "rollback_window";
  }): Promise<void>;
};

export type StorageVnextRetirementPort = {
  markRetirementReady(input: {
    deploymentPublicId: StorageVnextPublicId;
    evidence: StorageVnextRetirementEvidence;
    expectedPhase: "rollback_window";
  }): Promise<StorageVnextDeploymentState>;
  retireLegacyStorage(input: {
    deploymentPublicId: StorageVnextPublicId;
    evidence: StorageVnextRetirementEvidence;
    expectedPhase: "retirement_ready";
  }): Promise<StorageVnextDeploymentState>;
};

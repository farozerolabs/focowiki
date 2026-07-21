export type OptimizationMigrationPhase =
  | "source_terms"
  | "projection_segments"
  | "object_validation"
  | "verifying";

export type OptimizationMigrationClaim = {
  knowledgeBaseId: string;
  state: "backfilling" | "verifying";
  phase: OptimizationMigrationPhase;
  highWaterSourceFileId: string | null;
  highWaterProjectionRecordId: string | null;
  highWaterObjectIdentity: string | null;
  priorActiveGenerationId: string | null;
  leaseOwner: string;
  leaseToken: string;
};

export type OptimizationMigrationSource = {
  sourceFileId: string;
  sourceRevisionId: string;
  objectKey: string;
  title: string;
  headings: string[];
  phrases: string[];
  entities: string[];
  explicitReferences: string[];
  supplementalTerms: string[];
};

export type LegacyProjectionSegment = {
  shardId: string;
  knowledgeBaseId: string;
  generationId: string;
  projectionKind: string;
  logicalPartition: string;
  formatVersion: number;
  checksumSha256: string;
  objectKey: string;
  logicalPath: string;
  entryCount: number;
  encodedBytes: number;
};

export type ReferencedMigrationObject = {
  identity: string;
  checksumSha256: string;
  formatVersion: number;
  objectKey: string;
  objectPresent: boolean;
};

type OwnedMigrationInput = {
  knowledgeBaseId: string;
  workerId: string;
  leaseToken: string;
};

export type OptimizationMigrationRepository = {
  claimNext: (input: {
    workerId: string;
    leaseToken: string;
    now: string;
    leaseExpiresAt: string;
  }) => Promise<OptimizationMigrationClaim | null>;
  listSourceBatch: (input: {
    knowledgeBaseId: string;
    afterSourceFileId: string | null;
    limit: number;
  }) => Promise<OptimizationMigrationSource[]>;
  recordSourceProgress: (input: OwnedMigrationInput & {
    highWaterSourceFileId: string;
    updatedAt: string;
  }) => Promise<void>;
  listLegacyProjectionBatch: (input: {
    knowledgeBaseId: string;
    generationId: string | null;
    afterProjectionRecordId: string | null;
    limit: number;
  }) => Promise<LegacyProjectionSegment[]>;
  registerLegacyBaseSegments: (input: OwnedMigrationInput & {
    items: LegacyProjectionSegment[];
    updatedAt: string;
  }) => Promise<void>;
  recordProjectionProgress: (input: OwnedMigrationInput & {
    highWaterProjectionRecordId: string;
    updatedAt: string;
  }) => Promise<void>;
  listReferencedObjectBatch: (input: {
    knowledgeBaseId: string;
    afterObjectIdentity: string | null;
    limit: number;
  }) => Promise<ReferencedMigrationObject[]>;
  recordObjectProgress: (input: OwnedMigrationInput & {
    highWaterObjectIdentity: string;
    updatedAt: string;
  }) => Promise<void>;
  advancePhase: (input: OwnedMigrationInput & {
    phase: OptimizationMigrationPhase;
    updatedAt: string;
  }) => Promise<void>;
  rebaseIfActiveGenerationChanged: (input: OwnedMigrationInput & {
    updatedAt: string;
  }) => Promise<boolean>;
  reconcileStats: (input: OwnedMigrationInput & { updatedAt: string }) => Promise<void>;
  verifyParity: (input: OwnedMigrationInput) => Promise<{
    passed: boolean;
    evidence: Record<string, unknown>;
  }>;
  activate: (input: OwnedMigrationInput & {
    parityEvidence: Record<string, unknown>;
    activatedAt: string;
  }) => Promise<"activated" | "rebased">;
  fail: (input: OwnedMigrationInput & {
    errorCode: string;
    errorMessage: string;
    failedAt: string;
  }) => Promise<void>;
};

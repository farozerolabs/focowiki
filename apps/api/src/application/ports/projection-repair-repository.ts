import type { ProjectionRecord } from "./projection-record-repository.js";

export type ProjectionRepairCheckpoint = {
  treeCursor: string | null;
  treeComplete: boolean;
};

export type ProjectionRepairJob = {
  knowledgeBaseId: string;
  repairVersion: number;
  baseGenerationId: string;
  targetGenerationId: string;
  checkpoint: ProjectionRepairCheckpoint;
  attemptCount: number;
  descriptor: {
    id: string;
    name: string;
    description: string | null;
    sourceFileCount: number;
    graphEdgeCount: number;
    rootEntryCount: number;
  };
};

export type ProjectionRepairRepository = {
  bootstrap: (input: { repairVersion: number; bootstrappedAt: string }) => Promise<number>;
  claim: (input: {
    repairVersion: number;
    leaseToken: string;
    leaseExpiresAt: string;
    targetGenerationId: string;
    claimedAt: string;
  }) => Promise<ProjectionRepairJob | null>;
  listTreePage: (input: {
    job: ProjectionRepairJob;
    leaseToken: string;
    limit: number;
  }) => Promise<ProjectionRecord[]>;
  advanceTreeCheckpoint: (input: {
    job: ProjectionRepairJob;
    leaseToken: string;
    treeCursor: string | null;
    treeComplete: boolean;
    updatedAt: string;
  }) => Promise<boolean>;
  complete: (input: {
    job: ProjectionRepairJob;
    leaseToken: string;
    completedAt: string;
  }) => Promise<boolean>;
  retryFromLatest: (input: {
    job: ProjectionRepairJob;
    leaseToken: string;
    errorCode: string;
    retryAt: string;
    failedAt: string;
    maxAttempts: number;
  }) => Promise<void>;
};

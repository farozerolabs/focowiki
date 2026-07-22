import type { ProjectionRecord } from "./projection-record-repository.js";
import type { OrderedDirectoryEntry } from "../../publication/ordered-directory-leaves.js";

export type ProjectionRepairNavigationCursor = {
  sortKey: string;
  recordId: string;
};

export type ProjectionRepairGraphCursor = {
  projectionKind: "graph_node" | "graph_edge";
  recordId: string;
};

export type ProjectionRepairCheckpoint = {
  treeCursor: string | null;
  treeComplete: boolean;
  navigationDirectoryCursor: string | null;
  navigationEntryCursor: ProjectionRepairNavigationCursor | null;
  navigationPhase: "entries" | "stale";
  navigationComplete: boolean;
  graphCursor: ProjectionRepairGraphCursor | null;
  graphNodeCount: number;
  graphEdgeCount: number;
  graphComplete: boolean;
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
  listNextNavigationDirectory: (input: {
    job: ProjectionRepairJob;
    leaseToken: string;
  }) => Promise<{ recordId: string; path: string } | null>;
  listNavigationEntryPage: (input: {
    job: ProjectionRepairJob;
    leaseToken: string;
    directoryPath: string;
    limit: number;
  }) => Promise<{
    entries: Array<{ entryId: string; desiredEntry: OrderedDirectoryEntry }>;
    nextCursor: ProjectionRepairNavigationCursor | null;
  }>;
  listStaleNavigationEntryPage: (input: {
    job: ProjectionRepairJob;
    leaseToken: string;
    directoryPath: string;
    limit: number;
  }) => Promise<{
    entries: Array<{ entryId: string; desiredEntry: null }>;
    nextCursor: ProjectionRepairNavigationCursor | null;
  }>;
  advanceNavigationCheckpoint: (input: {
    job: ProjectionRepairJob;
    leaseToken: string;
    navigationDirectoryCursor: string | null;
    navigationEntryCursor: ProjectionRepairNavigationCursor | null;
    navigationPhase: "entries" | "stale";
    navigationComplete: boolean;
    updatedAt: string;
  }) => Promise<boolean>;
  listGraphPage: (input: {
    job: ProjectionRepairJob;
    leaseToken: string;
    limit: number;
  }) => Promise<{
    records: Array<{ projectionKind: "graph_node" | "graph_edge"; recordId: string }>;
    nextCursor: ProjectionRepairGraphCursor | null;
  }>;
  stageGraphSummary: (input: {
    job: ProjectionRepairJob;
    leaseToken: string;
    nodeCount: number;
    edgeCount: number;
    updatedAt: string;
  }) => Promise<boolean>;
  advanceGraphCheckpoint: (input: {
    job: ProjectionRepairJob;
    leaseToken: string;
    graphCursor: ProjectionRepairGraphCursor | null;
    graphNodeCount: number;
    graphEdgeCount: number;
    graphComplete: boolean;
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

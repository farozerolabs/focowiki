import type { SerializableJson } from "./source-dispatch-repository.js";
import type {
  OrderedDirectoryEntry
} from "../../publication/ordered-directory-leaves.js";
import type {
  PersistentDirectoryLeaf
} from "./directory-navigation-repository.js";
import type {
  ProjectionRepairSettingsSnapshot
} from "../../maintenance/projection-repair-plan.js";
import type { ProjectionRecord } from "./projection-record-repository.js";

export type ProjectionRepairTaskKind =
  | "tree_partition"
  | "directory"
  | "graph_partition"
  | "graph_finalize"
  | "tree_rebase"
  | "directory_rebase"
  | "graph_rebase"
  | "graph_rebase_finalize"
  | "finalize";

export type ProjectionRepairWorkItem = {
  id: string;
  knowledgeBaseId: string;
  repairVersion: number;
  targetGenerationId: string;
  baseGenerationId: string;
  kind: ProjectionRepairTaskKind;
  partitionKey: string;
  phaseOrder: number;
  sourceWatermark: number;
  settingsRevision: number;
  settings: ProjectionRepairSettingsSnapshot;
  expectedRecordCount: number;
  processedRecordCount: number;
  attemptCount: number;
  maxAttempts: number;
  leaseOwner: string;
  leaseToken: string;
  checkpoint: SerializableJson;
};

export type ProjectionRepairWorkRepository = {
  bootstrap: (input: {
    repairVersion: number;
    plannerVersion: number;
    settingsRevision: number;
    settings: ProjectionRepairSettingsSnapshot;
    maxAttempts: number;
    now: string;
    knowledgeBaseIds?: string[] | undefined;
    requireActiveMaintenanceRequest?: boolean | undefined;
  }) => Promise<number>;
  planNext: (input: {
    repairVersion: number;
    plannerVersion: number;
    targetGenerationId: string;
    settingsRevision: number;
    settings: ProjectionRepairSettingsSnapshot;
    maxAttempts: number;
    now: string;
  }) => Promise<{ knowledgeBaseId: string; taskCount: number } | null>;
  claimBatch: (input: {
    repairVersion: number;
    workerId: string;
    leaseTokenPrefix: string;
    limit: number;
    now: string;
    leaseExpiresAt: string;
  }) => Promise<ProjectionRepairWorkItem[]>;
  heartbeat: (input: {
    task: ProjectionRepairWorkItem;
    leaseExpiresAt: string;
    heartbeatAt: string;
  }) => Promise<boolean>;
  checkpointTask: (input: {
    task: ProjectionRepairWorkItem;
    checkpoint: SerializableJson;
    processedRecordCount: number;
    batchDurationMs: number;
    checkpointedAt: string;
  }) => Promise<boolean>;
  completeTask: (input: {
    task: ProjectionRepairWorkItem;
    processedRecordCount: number;
    objectWriteCount: number;
    objectReuseCount: number;
    durationMs: number;
    completedAt: string;
  }) => Promise<boolean>;
  retryTask: (input: {
    task: ProjectionRepairWorkItem;
    errorCode: string;
    errorMessage: string | null;
    retryable: boolean;
    retryAt: string;
    failedAt: string;
  }) => Promise<"retry" | "failed" | "lost">;
  completeRepair: (input: {
    task: ProjectionRepairWorkItem;
    activeGenerationId: string;
    completedAt: string;
  }) => Promise<boolean>;
  scheduleCatchUp: (input: {
    task: ProjectionRepairWorkItem;
    scheduledAt: string;
  }) => Promise<"ready" | "scheduled" | "lost">;
};

export type ProjectionRepairDirectoryCursor = {
  sortKey: string;
  recordId: string;
};

export type ProjectionRepairStagedChange = {
  recordId: string;
  record: SerializableJson | null;
};

export type ProjectionRepairBuildRepository = {
  stageTreeBatch: (input: {
    task: ProjectionRepairWorkItem;
    cursor: string | null;
    limit: number;
  }) => Promise<{
    processedRecordCount: number;
    nextCursor: string | null;
    complete: boolean;
  }>;
  listStagedTreePartition: (input: {
    task: ProjectionRepairWorkItem;
    limit: number;
  }) => Promise<ProjectionRecord[]>;
  stageTreeRebaseBatch: (input: {
    task: ProjectionRepairWorkItem;
    cursor: string | null;
    limit: number;
  }) => Promise<{
    processedRecordCount: number;
    nextCursor: string | null;
    complete: boolean;
  }>;
  listStagedTreeRebaseChanges: (input: {
    task: ProjectionRepairWorkItem;
    limit: number;
  }) => Promise<ProjectionRepairStagedChange[]>;
  listDirectoryEntryPage: (input: {
    task: ProjectionRepairWorkItem;
    cursor: ProjectionRepairDirectoryCursor | null;
    limit: number;
  }) => Promise<{
    entries: OrderedDirectoryEntry[];
      nextCursor: ProjectionRepairDirectoryCursor | null;
  }>;
  listActiveDirectoryReferences: (input: {
    task: ProjectionRepairWorkItem;
  }) => Promise<Array<{
    refKind: "directory_root" | "directory_leaf";
    refKey: string;
    logicalPath: string;
  }>>;
  directoryExists: (input: {
    task: ProjectionRepairWorkItem;
  }) => Promise<boolean>;
  resetDirectorySnapshot: (input: {
    task: ProjectionRepairWorkItem;
  }) => Promise<void>;
  upsertDirectoryLeaf: (input: {
    task: ProjectionRepairWorkItem;
    leaf: PersistentDirectoryLeaf;
  }) => Promise<void>;
  completeDirectorySnapshot: (input: {
    task: ProjectionRepairWorkItem;
    entryCount: number;
    firstLeafId: string | null;
  }) => Promise<void>;
  aggregateGraph: (input: {
    task: ProjectionRepairWorkItem;
    updatedAt: string;
  }) => Promise<{ nodeCount: number; edgeCount: number }>;
  stageGraphBatch: (input: {
    task: ProjectionRepairWorkItem;
    projectionKind: "graph_node" | "graph_edge";
    shardKey: string;
    cursor: string | null;
    limit: number;
  }) => Promise<{
    processedRecordCount: number;
    nextCursor: string | null;
    complete: boolean;
  }>;
  listStagedGraphPartition: (input: {
    task: ProjectionRepairWorkItem;
    projectionKind: "graph_node" | "graph_edge";
    shardKey: string;
    limit: number;
  }) => Promise<ProjectionRecord[]>;
  stageGraphRebaseBatch: (input: {
    task: ProjectionRepairWorkItem;
    projectionKind: "graph_node" | "graph_edge";
    shardKey: string;
    cursor: string | null;
    limit: number;
  }) => Promise<{
    processedRecordCount: number;
    nextCursor: string | null;
    complete: boolean;
  }>;
  listStagedGraphRebaseChanges: (input: {
    task: ProjectionRepairWorkItem;
    projectionKind: "graph_node" | "graph_edge";
    shardKey: string;
    limit: number;
  }) => Promise<ProjectionRepairStagedChange[]>;
  inheritSearchProjectionReferences: (input: {
    task: ProjectionRepairWorkItem;
  }) => Promise<number>;
  readRepairDescriptor: (input: {
    task: ProjectionRepairWorkItem;
  }) => Promise<{
    id: string;
    name: string;
    description: string | null;
    sourceFileCount: number;
    graphEdgeCount: number;
    rootEntryCount: number;
    activeGenerationId: string;
    resourceRevision: number;
  } | null>;
};

export function readProjectionRepairSettingsSnapshot(
  value: SerializableJson
): ProjectionRepairSettingsSnapshot {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error("Projection repair settings snapshot is invalid");
  }
  const record = value as Record<string, SerializableJson>;
  const settings = {
    concurrency: Number(record.concurrency),
    databaseBatchSize: Number(record.databaseBatchSize),
    objectWriteConcurrency: Number(record.objectWriteConcurrency)
  };
  if (
    !Number.isSafeInteger(settings.concurrency)
    || settings.concurrency < 1
    || !Number.isSafeInteger(settings.databaseBatchSize)
    || settings.databaseBatchSize < 1
    || !Number.isSafeInteger(settings.objectWriteConcurrency)
    || settings.objectWriteConcurrency < 1
  ) {
    throw new Error("Projection repair settings snapshot is invalid");
  }
  return settings;
}

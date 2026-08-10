import {
  validateRuntimeSettingsResourceCapacity,
  type RuntimeSettingsResourceCapacity
} from "./resource-capacity-validation.js";
import type { RuntimeSettingsValidationIssue } from "./types.js";

const REMOVED_FIELDS = {
  worker: [
    "generationBatchSize",
    "hardDeleteVersionPurgeEnabled",
    "graphQueryConcurrency",
    "databaseMutationConcurrency",
    "sourceQueueHardDepth",
    "sourceQueueResumeDepth",
    "sourceQueueHardAgeSeconds",
    "sourceQueueResumeAgeSeconds",
    "shutdownGraceMs",
    "failedJobRetentionDays",
    "deadLetterJobRetentionDays",
    "retentionCleanupBatchSize",
    "hardDeleteFailedRetentionDays"
  ],
  publication: [
    "generationAssemblyConcurrency",
    "generationRetentionDays",
    "batchSize",
    "impactBatchSize",
    "impactConcurrency",
    "projectionPartitionConcurrency",
    "directoryMaterializationConcurrency",
    "dirtyFileHardCount",
    "dirtyFileResumeCount",
    "dirtyAgeHardSeconds",
    "dirtyAgeResumeSeconds",
    "pendingImpactHardCount",
    "pendingImpactResumeCount",
    "indexShardSize",
    "linkIndexShardSize",
    "manifestShardSize",
    "graphEdgeShardSize",
    "graphCandidateLimit",
    "graphMaintenanceBatchSize",
    "rootSummaryLimit",
    "okfLogMaxEntries",
    "okfLogMaxBytes"
  ],
  graph: ["publicationShardSize", "cacheTtlSeconds"],
  maintenance: [
    "migrationBackfillConcurrency",
    "lexicalRebuildDatabaseWriteConcurrency",
    "lexicalRebuildClaimBatchSize",
    "lexicalRebuildDatabaseBatchSize",
    "scanIntervalSeconds",
    "confirmationPasses",
    "compactionConcurrency"
  ],
  search: [
    "branchCandidateLimit",
    "fusedCandidateLimit",
    "graphSeedLimit",
    "graphNeighborLimit",
    "cacheTtlSeconds",
    "engineQueueLatencyLimitMs",
    "engineResidentMemoryLimitBytes",
    "engineDatabaseSizeLimitBytes",
    "engineTaskQueueSizeLimitBytes"
  ]
} as const;

const DEFAULT_MAXIMUM_CLEANUP_LAG_SECONDS = 86_400;
const DEFAULT_MAXIMUM_ACTIVE_OBJECTS_PER_SOURCE_FILE = 5;
const DEFAULT_MAXIMUM_CANDIDATE_OBJECT_RATIO_PERMILLE = 200;
const DEFAULT_MAXIMUM_INTERNAL_SHARD_RECORDS = 1_000;
const DEFAULT_MAXIMUM_INTERNAL_SHARD_BYTES = 8 * 1_024 * 1_024;

export type StorageVnextRuntimeSettingsBackendLimits = {
  maximumCleanupLagSeconds: number;
  maximumActiveObjectsPerSourceFile: number;
  maximumCandidateObjectRatioPermille: number;
  maximumInternalShardRecords: number;
  maximumInternalShardBytes: number;
};

export function createStorageVnextRuntimeSettingsBackendLimits():
StorageVnextRuntimeSettingsBackendLimits {
  return {
    maximumCleanupLagSeconds: DEFAULT_MAXIMUM_CLEANUP_LAG_SECONDS,
    maximumActiveObjectsPerSourceFile:
      DEFAULT_MAXIMUM_ACTIVE_OBJECTS_PER_SOURCE_FILE,
    maximumCandidateObjectRatioPermille:
      DEFAULT_MAXIMUM_CANDIDATE_OBJECT_RATIO_PERMILLE,
    maximumInternalShardRecords: DEFAULT_MAXIMUM_INTERNAL_SHARD_RECORDS,
    maximumInternalShardBytes: DEFAULT_MAXIMUM_INTERNAL_SHARD_BYTES
  };
}

export function validateStorageVnextRuntimeSettingsCandidate(input: {
  value: unknown;
  capacity: RuntimeSettingsResourceCapacity;
  backendLimits: StorageVnextRuntimeSettingsBackendLimits;
}): RuntimeSettingsValidationIssue[] {
  if (!isRecord(input.value)) return [issue("settings", "Settings must be an object")];
  const worker = section(input.value, "worker");
  const publication = section(input.value, "publication");
  const graph = section(input.value, "graph");
  const maintenance = section(input.value, "maintenance");
  const semantic = section(input.value, "semantic");
  const search = section(input.value, "search");
  const activeModel = input.value.activeModel;
  if (!worker || !publication || !graph || !maintenance || !semantic || !search) {
    return [issue("settings", "Settings sections are incomplete")];
  }

  const issues: RuntimeSettingsValidationIssue[] = [];
  rejectRemovedFields(worker, "worker", REMOVED_FIELDS.worker, issues);
  rejectRemovedFields(
    publication,
    "publication",
    REMOVED_FIELDS.publication,
    issues
  );
  rejectRemovedFields(graph, "graph", REMOVED_FIELDS.graph, issues);
  rejectRemovedFields(
    maintenance,
    "maintenance",
    REMOVED_FIELDS.maintenance,
    issues
  );
  rejectRemovedFields(search, "search", REMOVED_FIELDS.search, issues);

  integerRange(search, "taskPollIntervalMs", 100, 30_000, "search", issues);
  integerRange(search, "taskTimeoutMs", 10_000, 3_600_000, "search", issues);
  integerRange(search, "indexBatchDocumentCount", 1, 10_000, "search", issues);
  integerRange(
    search,
    "indexBatchCompressedBytes",
    65_536,
    33_554_432,
    "search",
    issues
  );
  integerRange(search, "maxInFlightTasks", 1, 32, "search", issues);
  integerRange(search, "cleanupBatchSize", 1, 5_000, "search", issues);
  integerRange(search, "stagingRetentionHours", 1, 720, "search", issues);
  integerRange(
    semantic,
    "searchLaneCutoffMs",
    50,
    numberValue(search.requestTimeoutMs),
    "semantic",
    issues
  );
  integerRange(
    semantic,
    "queryEmbeddingConcurrency",
    1,
    32,
    "semantic",
    issues
  );

  positiveInteger(
    worker,
    "completedJobRetentionDays",
    "worker",
    issues
  );
  positiveInteger(maintenance, "scanBatchSize", "maintenance", issues);
  positiveInteger(maintenance, "deletionBatchSize", "maintenance", issues);
  integerRange(
    maintenance,
    "projectionRepairConcurrency",
    1,
    16,
    "maintenance",
    issues
  );
  integerRange(
    maintenance,
    "projectionRepairDatabaseBatchSize",
    100,
    10_000,
    "maintenance",
    issues
  );
  integerRange(
    maintenance,
    "projectionRepairObjectWriteConcurrency",
    1,
    32,
    "maintenance",
    issues
  );
  integerRange(
    maintenance,
    "lexicalRebuildConcurrency",
    1,
    16,
    "maintenance",
    issues
  );
  integerRange(
    maintenance,
    "lexicalRebuildSourceReadConcurrency",
    1,
    32,
    "maintenance",
    issues
  );
  integerRange(
    maintenance,
    "lexicalRebuildMaxInFlightSourceBytes",
    1_048_576,
    536_870_912,
    "maintenance",
    issues
  );
  validateBackendLimits(input.backendLimits, issues);
  if (issues.some((item) => item.field === "settings")) return issues;

  const capacityIssues = validateRuntimeSettingsResourceCapacity({
    snapshot: {
      worker: numericWorker(worker),
      publication: numericPublication(publication),
      maintenance: numericMaintenance(maintenance),
      search: numericSearch(search),
      activeModel: isRecord(activeModel)
        ? { suggestionConcurrency: numberValue(activeModel.suggestionConcurrency) } as never
        : null
    },
    capacity: input.capacity
  });
  issues.push(...capacityIssues);
  return issues;
}

function numericWorker(value: Record<string, unknown>) {
  return {
    sourceFileConcurrency: numberValue(value.sourceFileConcurrency),
    sourceObjectReadConcurrency: numberValue(value.sourceObjectReadConcurrency),
    hardDeleteConcurrency: numberValue(value.hardDeleteConcurrency)
  };
}

function numericPublication(value: Record<string, unknown>) {
  return {
    roleConcurrency: numberValue(value.roleConcurrency),
    generatedObjectWriteConcurrency: numberValue(value.generatedObjectWriteConcurrency)
  };
}

function numericMaintenance(value: Record<string, unknown>) {
  return {
    knowledgeBaseMaintenanceConcurrency: numberValue(
      value.knowledgeBaseMaintenanceConcurrency
    ),
    projectionRepairConcurrency: numberValue(value.projectionRepairConcurrency),
    projectionRepairObjectWriteConcurrency: numberValue(
      value.projectionRepairObjectWriteConcurrency
    ),
    lexicalRebuildConcurrency: numberValue(value.lexicalRebuildConcurrency),
    lexicalRebuildSourceReadConcurrency: numberValue(
      value.lexicalRebuildSourceReadConcurrency
    ),
    lexicalRebuildMaxInFlightSourceBytes: numberValue(
      value.lexicalRebuildMaxInFlightSourceBytes
    )
  };
}

function numericSearch(value: Record<string, unknown>) {
  return {
    maxInFlightTasks: numberValue(value.maxInFlightTasks),
    indexBatchCompressedBytes: numberValue(value.indexBatchCompressedBytes)
  };
}

function validateBackendLimits(
  limits: StorageVnextRuntimeSettingsBackendLimits,
  issues: RuntimeSettingsValidationIssue[]
): void {
  for (const field of [
    "maximumCleanupLagSeconds",
    "maximumActiveObjectsPerSourceFile",
    "maximumCandidateObjectRatioPermille",
    "maximumInternalShardRecords",
    "maximumInternalShardBytes"
  ] as const) {
    if (!safePositiveInteger(limits[field])) {
      issues.push(issue(field, `${field} must be a positive integer`));
    }
  }
  if (limits.maximumActiveObjectsPerSourceFile > 5) {
    issues.push(issue(
      "maximumActiveObjectsPerSourceFile",
      "Active generated-object fan-out exceeds the investigated budget"
    ));
  }
  if (limits.maximumCandidateObjectRatioPermille > 200) {
    issues.push(issue(
      "maximumCandidateObjectRatioPermille",
      "Candidate generated-object overhead exceeds the investigated budget"
    ));
  }
}

function rejectRemovedFields(
  value: Record<string, unknown>,
  sectionName: string,
  fields: readonly string[],
  issues: RuntimeSettingsValidationIssue[]
): void {
  for (const field of fields) {
    if (Object.hasOwn(value, field)) {
      issues.push(issue(
        `${sectionName}.${field}`,
        `${field} is not a storage vNext setting`
      ));
    }
  }
}

function integerRange(
  value: Record<string, unknown>,
  field: string,
  minimum: number,
  maximum: number,
  sectionName: string,
  issues: RuntimeSettingsValidationIssue[]
): void {
  if (
    !safeInteger(value[field])
    || value[field] < minimum
    || value[field] > maximum
  ) {
    issues.push(issue(
      `${sectionName}.${field}`,
      `${field} must be between ${minimum} and ${maximum}`
    ));
  }
}

function positiveInteger(
  value: Record<string, unknown>,
  field: string,
  sectionName: string,
  issues: RuntimeSettingsValidationIssue[]
): void {
  if (!safePositiveInteger(value[field])) {
    issues.push(issue(
      `${sectionName}.${field}`,
      `${field} must be a positive integer`
    ));
  }
}

function section(
  value: Record<string, unknown>,
  key: string
): Record<string, unknown> | null {
  return isRecord(value[key]) ? value[key] : null;
}

function numberValue(value: unknown): number {
  return typeof value === "number" ? value : Number.NaN;
}

function safeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

function safePositiveInteger(value: unknown): value is number {
  return safeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issue(field: string, message: string): RuntimeSettingsValidationIssue {
  return { field, message };
}

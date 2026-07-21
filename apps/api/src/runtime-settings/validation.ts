import {
  resolveSecurityConfig,
  resolveGraphConfig,
  resolvePublicationConfig,
  resolveWorkerConfig,
  type RuntimeConfig
} from "../config.js";
import {
  modelApiModeValues,
  publicationModeValues,
  rateLimitKeys,
  type RuntimeGraphSettings,
  type RuntimeMaintenanceSettings,
  type RuntimeModelConfigDraft,
  type RuntimePublicationSettings,
  type RuntimeRateLimitSettings,
  type RuntimeSettingsDefaults,
  type RuntimeSettingsValidationIssue,
  type RuntimeWorkerSettings
} from "./types.js";

const DEFAULT_OKF_LOG_MAX_ENTRIES = 100;
const DEFAULT_OKF_LOG_MAX_BYTES = 65_536;
const MAX_WORKER_RESOURCE_CONCURRENCY = 32;
const MAX_PUBLICATION_RESOURCE_CONCURRENCY = 32;
const MAX_MAINTENANCE_RESOURCE_CONCURRENCY = 16;

export const DEFAULT_MAINTENANCE_SETTINGS: RuntimeMaintenanceSettings = {
  reconciliationEnabled: true,
  scanIntervalSeconds: 21_600,
  scanBatchSize: 500,
  deletionBatchSize: 100,
  quarantineGracePeriodSeconds: 86_400,
  confirmationPasses: 2,
  maxAttempts: 5,
  retryDelayMs: 30_000,
  migrationBackfillConcurrency: 2,
  compactionConcurrency: 1
};

export function createRuntimeSettingsDefaults(config: RuntimeConfig): RuntimeSettingsDefaults {
  return {
    rateLimits: resolveSecurityConfig(config).rateLimits,
    worker: sanitizeWorkerSettings({
      ...resolveWorkerConfig(config),
      sourceObjectReadConcurrency: resolveWorkerConfig(config).sourceFileConcurrency,
      graphQueryConcurrency: resolveWorkerConfig(config).sourceFileConcurrency,
      databaseMutationConcurrency: Math.min(
        4,
        resolveWorkerConfig(config).sourceFileConcurrency
      )
    }),
    publication: {
      ...resolvePublicationConfig(config),
      okfLogMaxEntries: config.okf?.log.maxEntries ?? DEFAULT_OKF_LOG_MAX_ENTRIES,
      okfLogMaxBytes: config.okf?.log.maxBytes ?? DEFAULT_OKF_LOG_MAX_BYTES,
      generationAssemblyConcurrency: resolvePublicationConfig(config).roleConcurrency,
      projectionPartitionConcurrency: resolvePublicationConfig(config).impactConcurrency,
      generatedObjectWriteConcurrency: resolvePublicationConfig(config).impactConcurrency,
      directoryMaterializationConcurrency: Math.min(
        4,
        resolvePublicationConfig(config).impactConcurrency
      )
    },
    graph: sanitizeGraphSettings(resolveGraphConfig(config)),
    maintenance: { ...DEFAULT_MAINTENANCE_SETTINGS },
    model: config.model.enabled
        ? {
          displayName: config.model.modelName,
          apiMode: "responses",
          baseUrl: config.model.baseUrl,
          apiKey: config.model.apiKey,
          modelName: config.model.modelName,
          contextWindowTokens: config.model.contextWindowTokens,
          requestMaxTimeoutMs: config.model.requestMaxTimeoutMs,
          requestIdleTimeoutMs: config.model.requestIdleTimeoutMs,
          suggestionConcurrency: config.model.suggestionConcurrency,
          transientRetryDelayMs: config.model.transientRetryDelayMs,
          requestMinIntervalMs: config.model.requestMinIntervalMs,
          isActive: true
        }
      : null
  };
}

export function validateRateLimitSettings(input: unknown): RuntimeSettingsValidationIssue[] {
  const issues: RuntimeSettingsValidationIssue[] = [];
  const value = objectValue(input);

  for (const key of rateLimitKeys()) {
    const item = objectValue(value[key]);
    requirePositiveInteger(item.max, `${key}.max`, issues);
    requirePositiveInteger(item.windowSeconds, `${key}.windowSeconds`, issues);
  }

  return issues;
}

export function sanitizeRateLimitSettings(input: RuntimeRateLimitSettings): RuntimeRateLimitSettings {
  return {
    adminLogin: sanitizeLimit(input.adminLogin),
    adminApi: sanitizeLimit(input.adminApi),
    publicOpenApi: sanitizeLimit(input.publicOpenApi)
  };
}

export function validateWorkerSettings(input: unknown): RuntimeSettingsValidationIssue[] {
  const issues: RuntimeSettingsValidationIssue[] = [];
  const value = objectValue(input);

  [
    "sourceFileConcurrency",
    "sourceObjectReadConcurrency",
    "graphQueryConcurrency",
    "databaseMutationConcurrency",
    "claimBatchSize",
    "generationBatchSize",
    "pollIntervalMs",
    "lockTtlSeconds",
    "heartbeatIntervalMs",
    "jobMaxAttempts",
    "jobRetryDelayMs",
    "sourceQueueHardDepth",
    "sourceQueueResumeDepth",
    "sourceQueueHardAgeSeconds",
    "sourceQueueResumeAgeSeconds",
    "shutdownGraceMs",
    "completedJobRetentionDays",
    "failedJobRetentionDays",
    "deadLetterJobRetentionDays",
    "retentionCleanupBatchSize",
    "hardDeleteConcurrency",
    "hardDeleteDatabaseBatchSize",
    "hardDeleteObjectBatchSize",
    "hardDeleteMaxAttempts",
    "hardDeleteRetryDelayMs",
    "hardDeleteFailedRetentionDays"
  ].forEach((field) => requirePositiveInteger(value[field], field, issues));

  if (
    Number.isInteger(value.sourceFileConcurrency)
    && Number(value.sourceFileConcurrency) > MAX_WORKER_RESOURCE_CONCURRENCY
  ) {
    issues.push({
      field: "sourceFileConcurrency",
      message: `sourceFileConcurrency must be less than or equal to ${MAX_WORKER_RESOURCE_CONCURRENCY}`
    });
  }

  if (
    Number.isInteger(value.claimBatchSize)
    && Number.isInteger(value.sourceFileConcurrency)
    && Number(value.claimBatchSize) < Number(value.sourceFileConcurrency)
  ) {
    issues.push({
      field: "claimBatchSize",
      message: "claimBatchSize must be greater than or equal to sourceFileConcurrency"
    });
  }

  for (const field of [
    "sourceObjectReadConcurrency",
    "graphQueryConcurrency",
    "databaseMutationConcurrency"
  ] as const) {
    if (Number.isInteger(value[field]) && Number(value[field]) > MAX_WORKER_RESOURCE_CONCURRENCY) {
      issues.push({
        field,
        message: `${field} must be less than or equal to ${MAX_WORKER_RESOURCE_CONCURRENCY}`
      });
    }
    if (
      Number.isInteger(value[field])
      && Number.isInteger(value.sourceFileConcurrency)
      && Number(value[field]) > Number(value.sourceFileConcurrency)
    ) {
      issues.push({
        field,
        message: `${field} must be less than or equal to sourceFileConcurrency`
      });
    }
  }

  if (value.hardDeleteObjectBatchSize && Number(value.hardDeleteObjectBatchSize) > 1_000) {
    issues.push({
      field: "hardDeleteObjectBatchSize",
      message: "hardDeleteObjectBatchSize must be less than or equal to 1000"
    });
  }

  validateResumeBelowHard(value, "sourceQueueResumeDepth", "sourceQueueHardDepth", issues);
  validateResumeBelowHard(
    value,
    "sourceQueueResumeAgeSeconds",
    "sourceQueueHardAgeSeconds",
    issues
  );

  if (typeof value.hardDeleteVersionPurgeEnabled !== "boolean") {
    issues.push({
      field: "hardDeleteVersionPurgeEnabled",
      message: "hardDeleteVersionPurgeEnabled must be true or false"
    });
  }

  return issues;
}

export function sanitizeWorkerSettings(input: RuntimeWorkerSettings): RuntimeWorkerSettings {
  return {
    sourceFileConcurrency: input.sourceFileConcurrency,
    sourceObjectReadConcurrency: input.sourceObjectReadConcurrency,
    graphQueryConcurrency: input.graphQueryConcurrency,
    databaseMutationConcurrency: input.databaseMutationConcurrency,
    claimBatchSize: input.claimBatchSize,
    generationBatchSize: input.generationBatchSize,
    pollIntervalMs: input.pollIntervalMs,
    lockTtlSeconds: input.lockTtlSeconds,
    heartbeatIntervalMs: input.heartbeatIntervalMs!,
    jobMaxAttempts: input.jobMaxAttempts,
    jobRetryDelayMs: input.jobRetryDelayMs,
    sourceQueueHardDepth: input.sourceQueueHardDepth,
    sourceQueueResumeDepth: input.sourceQueueResumeDepth,
    sourceQueueHardAgeSeconds: input.sourceQueueHardAgeSeconds,
    sourceQueueResumeAgeSeconds: input.sourceQueueResumeAgeSeconds,
    shutdownGraceMs: input.shutdownGraceMs,
    completedJobRetentionDays: input.completedJobRetentionDays!,
    failedJobRetentionDays: input.failedJobRetentionDays!,
    deadLetterJobRetentionDays: input.deadLetterJobRetentionDays!,
    retentionCleanupBatchSize: input.retentionCleanupBatchSize!,
    hardDeleteConcurrency: input.hardDeleteConcurrency!,
    hardDeleteDatabaseBatchSize: input.hardDeleteDatabaseBatchSize!,
    hardDeleteObjectBatchSize: Math.min(input.hardDeleteObjectBatchSize!, 1_000),
    hardDeleteMaxAttempts: input.hardDeleteMaxAttempts!,
    hardDeleteRetryDelayMs: input.hardDeleteRetryDelayMs!,
    hardDeleteFailedRetentionDays: input.hardDeleteFailedRetentionDays!,
    hardDeleteVersionPurgeEnabled: input.hardDeleteVersionPurgeEnabled!
  };
}

export function validatePublicationSettings(input: unknown): RuntimeSettingsValidationIssue[] {
  const issues: RuntimeSettingsValidationIssue[] = [];
  const value = objectValue(input);

  if (!publicationModeValues().includes(value.mode as never)) {
    issues.push({
      field: "mode",
      message: "mode must be batch, manual, or per_file"
    });
  }

  [
    "batchSize",
    "intervalSeconds",
    "roleConcurrency",
    "claimBatchSize",
    "impactBatchSize",
    "impactConcurrency",
    "dirtyFileHardCount",
    "dirtyFileResumeCount",
    "dirtyAgeHardSeconds",
    "dirtyAgeResumeSeconds",
    "pendingImpactHardCount",
    "pendingImpactResumeCount",
    "generationRetentionDays",
    "indexShardSize",
    "linkIndexShardSize",
    "manifestShardSize",
    "graphMaintenanceBatchSize",
    "rootSummaryLimit",
    "directoryIndexMaxEntries",
    "directoryIndexMaxBytes",
    "okfLogMaxEntries",
    "okfLogMaxBytes",
    "generationAssemblyConcurrency",
    "projectionPartitionConcurrency",
    "generatedObjectWriteConcurrency",
    "directoryMaterializationConcurrency"
  ].forEach((field) => requirePositiveInteger(value[field], field, issues));

  for (const field of [
    "generationAssemblyConcurrency",
    "projectionPartitionConcurrency",
    "generatedObjectWriteConcurrency",
    "directoryMaterializationConcurrency"
  ] as const) {
    if (
      Number.isInteger(value[field])
      && Number(value[field]) > MAX_PUBLICATION_RESOURCE_CONCURRENCY
    ) {
      issues.push({
        field,
        message: `${field} must be less than or equal to ${MAX_PUBLICATION_RESOURCE_CONCURRENCY}`
      });
    }
  }
  validateAtMost(value, "generationAssemblyConcurrency", "roleConcurrency", issues);
  validateAtMost(value, "projectionPartitionConcurrency", "impactConcurrency", issues);
  validateAtMost(
    value,
    "generatedObjectWriteConcurrency",
    "projectionPartitionConcurrency",
    issues
  );
  validateAtMost(
    value,
    "directoryMaterializationConcurrency",
    "projectionPartitionConcurrency",
    issues
  );

  if (Number.isInteger(value.impactConcurrency) && Number(value.impactConcurrency) > 32) {
    issues.push({
      field: "impactConcurrency",
      message: "impactConcurrency must be less than or equal to 32"
    });
  }

  validateResumeBelowHard(value, "dirtyFileResumeCount", "dirtyFileHardCount", issues);
  validateResumeBelowHard(value, "dirtyAgeResumeSeconds", "dirtyAgeHardSeconds", issues);
  validateResumeBelowHard(
    value,
    "pendingImpactResumeCount",
    "pendingImpactHardCount",
    issues
  );

  return issues;
}

export function validateGraphSettings(input: unknown): RuntimeSettingsValidationIssue[] {
  const issues: RuntimeSettingsValidationIssue[] = [];
  const value = objectValue(input);

  [
    "candidateLimit",
    "acceptedEdgeLimit",
    "searchDefaultFanout",
    "searchMaxFanout",
    "publicationShardSize",
    "cacheTtlSeconds",
    "genericPhraseThreshold"
  ].forEach((field) => requirePositiveInteger(value[field], field, issues));

  requireGraphDepth(value.searchDefaultDepth, "searchDefaultDepth", issues);
  requireGraphDepth(value.searchMaxDepth, "searchMaxDepth", issues);

  if (
    Number.isInteger(value.searchDefaultDepth) &&
    Number.isInteger(value.searchMaxDepth) &&
    Number(value.searchDefaultDepth) > Number(value.searchMaxDepth)
  ) {
    issues.push({
      field: "searchDefaultDepth",
      message: "searchDefaultDepth must be less than or equal to searchMaxDepth"
    });
  }

  if (
    Number.isInteger(value.searchDefaultFanout) &&
    Number.isInteger(value.searchMaxFanout) &&
    Number(value.searchDefaultFanout) > Number(value.searchMaxFanout)
  ) {
    issues.push({
      field: "searchDefaultFanout",
      message: "searchDefaultFanout must be less than or equal to searchMaxFanout"
    });
  }

  if (typeof value.modelReviewEnabled !== "boolean") {
    issues.push({
      field: "modelReviewEnabled",
      message: "modelReviewEnabled must be true or false"
    });
  }

  return issues;
}

export function validateModelDraft(input: RuntimeModelConfigDraft): RuntimeSettingsValidationIssue[] {
  const issues: RuntimeSettingsValidationIssue[] = [];

  requireNonEmptyString(input.displayName, "displayName", issues);
  if (input.apiMode && !modelApiModeValues().includes(input.apiMode)) {
    issues.push({ field: "apiMode", message: "apiMode must be responses or chat_completions" });
  }
  requireUrl(input.baseUrl, "baseUrl", issues);
  requireNonEmptyString(input.apiKey, "apiKey", issues);
  requireNonEmptyString(input.modelName, "modelName", issues);
  requirePositiveInteger(input.contextWindowTokens, "contextWindowTokens", issues);
  requirePositiveInteger(input.requestMaxTimeoutMs, "requestMaxTimeoutMs", issues);
  requirePositiveInteger(input.requestIdleTimeoutMs, "requestIdleTimeoutMs", issues);
  requirePositiveInteger(input.suggestionConcurrency, "suggestionConcurrency", issues);
  requirePositiveInteger(input.transientRetryDelayMs, "transientRetryDelayMs", issues);
  requireNonNegativeInteger(input.requestMinIntervalMs, "requestMinIntervalMs", issues);

  return issues;
}

export function validateMaintenanceSettings(input: unknown): RuntimeSettingsValidationIssue[] {
  const issues: RuntimeSettingsValidationIssue[] = [];
  const value = objectValue(input);

  if (typeof value.reconciliationEnabled !== "boolean") {
    issues.push({
      field: "reconciliationEnabled",
      message: "reconciliationEnabled must be true or false"
    });
  }

  [
    "scanIntervalSeconds",
    "scanBatchSize",
    "deletionBatchSize",
    "quarantineGracePeriodSeconds",
    "confirmationPasses",
    "maxAttempts",
    "retryDelayMs",
    "migrationBackfillConcurrency",
    "compactionConcurrency"
  ].forEach((field) => requirePositiveInteger(value[field], field, issues));

  for (const field of ["migrationBackfillConcurrency", "compactionConcurrency"] as const) {
    if (
      Number.isInteger(value[field])
      && Number(value[field]) > MAX_MAINTENANCE_RESOURCE_CONCURRENCY
    ) {
      issues.push({
        field,
        message: `${field} must be less than or equal to ${MAX_MAINTENANCE_RESOURCE_CONCURRENCY}`
      });
    }
  }

  for (const field of ["scanBatchSize", "deletionBatchSize"] as const) {
    if (Number.isInteger(value[field]) && Number(value[field]) > 1_000) {
      issues.push({
        field,
        message: `${field} must be less than or equal to 1000`
      });
    }
  }

  if (Number.isInteger(value.confirmationPasses) && Number(value.confirmationPasses) < 2) {
    issues.push({
      field: "confirmationPasses",
      message: "confirmationPasses must be greater than or equal to 2"
    });
  }

  return issues;
}

export function sanitizeMaintenanceSettings(
  input: RuntimeMaintenanceSettings
): RuntimeMaintenanceSettings {
  return {
    reconciliationEnabled: input.reconciliationEnabled,
    scanIntervalSeconds: input.scanIntervalSeconds,
    scanBatchSize: Math.min(input.scanBatchSize, 1_000),
    deletionBatchSize: Math.min(input.deletionBatchSize, 1_000),
    quarantineGracePeriodSeconds: input.quarantineGracePeriodSeconds,
    confirmationPasses: input.confirmationPasses,
    maxAttempts: input.maxAttempts,
    retryDelayMs: input.retryDelayMs,
    migrationBackfillConcurrency: input.migrationBackfillConcurrency,
    compactionConcurrency: input.compactionConcurrency
  };
}

export function sanitizePublicationSettings(
  input: RuntimePublicationSettings
): RuntimePublicationSettings {
  return {
    mode: input.mode,
    batchSize: input.batchSize,
    intervalSeconds: input.intervalSeconds,
    roleConcurrency: input.roleConcurrency,
    claimBatchSize: input.claimBatchSize,
    impactBatchSize: input.impactBatchSize,
    impactConcurrency: input.impactConcurrency,
    dirtyFileHardCount: input.dirtyFileHardCount,
    dirtyFileResumeCount: input.dirtyFileResumeCount,
    dirtyAgeHardSeconds: input.dirtyAgeHardSeconds,
    dirtyAgeResumeSeconds: input.dirtyAgeResumeSeconds,
    pendingImpactHardCount: input.pendingImpactHardCount,
    pendingImpactResumeCount: input.pendingImpactResumeCount,
    generationRetentionDays: input.generationRetentionDays,
    indexShardSize: input.indexShardSize,
    linkIndexShardSize: input.linkIndexShardSize,
    manifestShardSize: input.manifestShardSize,
    graphEdgeShardSize: input.graphEdgeShardSize,
    graphCandidateLimit: input.graphCandidateLimit,
    graphMaintenanceBatchSize: input.graphMaintenanceBatchSize,
    rootSummaryLimit: input.rootSummaryLimit,
    directoryIndexMaxEntries: input.directoryIndexMaxEntries,
    directoryIndexMaxBytes: input.directoryIndexMaxBytes,
    okfLogMaxEntries: input.okfLogMaxEntries,
    okfLogMaxBytes: input.okfLogMaxBytes,
    generationAssemblyConcurrency: input.generationAssemblyConcurrency,
    projectionPartitionConcurrency: input.projectionPartitionConcurrency,
    generatedObjectWriteConcurrency: input.generatedObjectWriteConcurrency,
    directoryMaterializationConcurrency: input.directoryMaterializationConcurrency
  };
}

export function sanitizeGraphSettings(input: RuntimeGraphSettings): RuntimeGraphSettings {
  return {
    candidateLimit: input.candidateLimit,
    acceptedEdgeLimit: input.acceptedEdgeLimit,
    searchDefaultDepth: input.searchDefaultDepth,
    searchMaxDepth: input.searchMaxDepth,
    searchDefaultFanout: input.searchDefaultFanout,
    searchMaxFanout: input.searchMaxFanout,
    modelReviewEnabled: input.modelReviewEnabled,
    publicationShardSize: input.publicationShardSize,
    cacheTtlSeconds: input.cacheTtlSeconds,
    genericPhraseThreshold: input.genericPhraseThreshold
  };
}

function sanitizeLimit(input: { max: number; windowSeconds: number }) {
  return {
    max: input.max,
    windowSeconds: input.windowSeconds
  };
}

function objectValue(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

function requireNonEmptyString(
  value: unknown,
  field: string,
  issues: RuntimeSettingsValidationIssue[]
) {
  if (typeof value !== "string" || !value.trim()) {
    issues.push({ field, message: `${field} is required` });
  }
}

function requireGraphDepth(
  value: unknown,
  field: string,
  issues: RuntimeSettingsValidationIssue[]
) {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 2) {
    issues.push({ field, message: `${field} must be 0, 1, or 2` });
  }
}

function validateAtMost(
  value: Record<string, unknown>,
  field: string,
  maximumField: string,
  issues: RuntimeSettingsValidationIssue[]
): void {
  if (
    Number.isInteger(value[field])
    && Number.isInteger(value[maximumField])
    && Number(value[field]) > Number(value[maximumField])
  ) {
    issues.push({
      field,
      message: `${field} must be less than or equal to ${maximumField}`
    });
  }
}

function requireUrl(value: unknown, field: string, issues: RuntimeSettingsValidationIssue[]) {
  if (typeof value !== "string") {
    issues.push({ field, message: `${field} must be a URL` });
    return;
  }

  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      issues.push({ field, message: `${field} must be an HTTP URL` });
    }
  } catch {
    issues.push({ field, message: `${field} must be a URL` });
  }
}

function requirePositiveInteger(
  value: unknown,
  field: string,
  issues: RuntimeSettingsValidationIssue[]
) {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    issues.push({ field, message: `${field} must be a positive integer` });
  }
}

function validateResumeBelowHard(
  value: Record<string, unknown>,
  resumeField: string,
  hardField: string,
  issues: RuntimeSettingsValidationIssue[]
): void {
  if (
    Number.isSafeInteger(value[resumeField]) &&
    Number.isSafeInteger(value[hardField]) &&
    Number(value[resumeField]) >= Number(value[hardField])
  ) {
    issues.push({
      field: resumeField,
      message: `${resumeField} must be less than ${hardField}`
    });
  }
}

function requireNonNegativeInteger(
  value: unknown,
  field: string,
  issues: RuntimeSettingsValidationIssue[]
) {
  if (!Number.isInteger(value) || Number(value) < 0) {
    issues.push({ field, message: `${field} must be a non-negative integer` });
  }
}

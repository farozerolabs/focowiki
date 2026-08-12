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
  type RuntimeSemanticSettings,
  type RuntimeSearchSettings,
  type RuntimeSettingsDefaults,
  type RuntimeSettingsValidationIssue,
  type RuntimeWorkerSettings
} from "./types.js";

const MAX_WORKER_RESOURCE_CONCURRENCY = 32;
const MAX_PUBLICATION_RESOURCE_CONCURRENCY = 32;
const MAX_MAINTENANCE_RESOURCE_CONCURRENCY = 16;
const DEFAULT_GENERATED_OBJECT_WRITE_CONCURRENCY = 8;

export const DEFAULT_MAINTENANCE_SETTINGS: RuntimeMaintenanceSettings = {
  reconciliationEnabled: true,
  knowledgeBaseMaintenanceMode: "manual",
  knowledgeBaseMaintenanceScanIntervalSeconds: 21_600,
  knowledgeBaseMaintenanceConcurrency: 1,
  scanBatchSize: 500,
  deletionBatchSize: 100,
  quarantineGracePeriodSeconds: 86_400,
  maxAttempts: 5,
  retryDelayMs: 30_000,
  projectionRepairConcurrency: 4,
  projectionRepairDatabaseBatchSize: 2_000,
  projectionRepairObjectWriteConcurrency: 4,
  lexicalRebuildConcurrency: 4,
  lexicalRebuildSourceReadConcurrency: 2,
  lexicalRebuildMaxInFlightSourceBytes: 67_108_864
};

export const DEFAULT_SEARCH_SETTINGS: RuntimeSearchSettings = {
  requestTimeoutMs: 3_000,
  engineSearchCutoffMs: 1_000,
  overfetchFactor: 3,
  indexBatchDocumentCount: 10_000,
  indexBatchCompressedBytes: 8 * 1_024 * 1_024,
  maxInFlightTasks: 8,
  taskPollIntervalMs: 500,
  taskTimeoutMs: 600_000,
  maxAttempts: 5,
  retryDelayMs: 2_000,
  cleanupBatchSize: 1_000,
  stagingRetentionHours: 24,
  cropLength: 1_200
};

export const DEFAULT_SEMANTIC_SETTINGS: RuntimeSemanticSettings = {
  maximumChunkCharacters: 8_000,
  maximumChunks: 32,
  maximumEvidenceTargets: 64,
  maximumCommunityPartitions: 256,
  maximumCommunityEntities: 10_000,
  maximumCommunityRelationships: 20_000,
  maximumCommunityBoundaryRelationships: 10_000,
  maximumCommunitySummaryCharacters: 8_000,
  communityAdapterTimeoutMs: 30_000,
  searchLaneCutoffMs: 2_500,
  queryEmbeddingConcurrency: 4,
  queryEmbeddingCacheEntries: 1_000
};

export function createRuntimeSettingsDefaults(config: RuntimeConfig): RuntimeSettingsDefaults {
  const worker = resolveWorkerConfig(config);
  const publication = resolvePublicationConfig(config);
  return {
    rateLimits: resolveSecurityConfig(config).rateLimits,
    worker: sanitizeWorkerSettings({
      ...worker,
      sourceObjectReadConcurrency: worker.sourceFileConcurrency
    }),
    publication: sanitizePublicationSettings({
      mode: publication.mode,
      intervalSeconds: publication.intervalSeconds,
      roleConcurrency: publication.roleConcurrency,
      claimBatchSize: publication.claimBatchSize,
      generatedObjectWriteConcurrency: DEFAULT_GENERATED_OBJECT_WRITE_CONCURRENCY,
      directoryIndexMaxEntries: publication.directoryIndexMaxEntries,
      directoryIndexMaxBytes: publication.directoryIndexMaxBytes
    }),
    graph: sanitizeGraphSettings(resolveGraphConfig(config)),
    maintenance: { ...DEFAULT_MAINTENANCE_SETTINGS },
    semantic: { ...DEFAULT_SEMANTIC_SETTINGS },
    search: { ...DEFAULT_SEARCH_SETTINGS },
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

export function validateSemanticSettings(
  input: unknown
): RuntimeSettingsValidationIssue[] {
  const issues: RuntimeSettingsValidationIssue[] = [];
  const value = objectValue(input);
  for (const field of Object.keys(DEFAULT_SEMANTIC_SETTINGS)) {
    requireInteger(value[field], field, issues);
  }
  validateIntegerRange(value, "maximumChunkCharacters", 1, 64_000, issues);
  validateIntegerRange(value, "maximumChunks", 1, 32, issues);
  validateIntegerRange(value, "maximumEvidenceTargets", 1, 256, issues);
  validateIntegerRange(value, "maximumCommunityPartitions", 1, 256, issues);
  validateIntegerRange(value, "maximumCommunityEntities", 1, 10_000, issues);
  validateIntegerRange(value, "maximumCommunityRelationships", 0, 20_000, issues);
  validateIntegerRange(
    value,
    "maximumCommunityBoundaryRelationships",
    0,
    10_000,
    issues
  );
  validateIntegerRange(
    value,
    "maximumCommunitySummaryCharacters",
    256,
    65_536,
    issues
  );
  validateIntegerRange(value, "communityAdapterTimeoutMs", 100, 300_000, issues);
  validateIntegerRange(value, "searchLaneCutoffMs", 50, 3_000, issues);
  validateIntegerRange(value, "queryEmbeddingConcurrency", 1, 32, issues);
  validateIntegerRange(value, "queryEmbeddingCacheEntries", 1, 10_000, issues);
  return issues;
}

export function sanitizeSemanticSettings(
  input: RuntimeSemanticSettings
): RuntimeSemanticSettings {
  return {
    maximumChunkCharacters: input.maximumChunkCharacters,
    maximumChunks: input.maximumChunks,
    maximumEvidenceTargets: input.maximumEvidenceTargets,
    maximumCommunityPartitions: input.maximumCommunityPartitions,
    maximumCommunityEntities: input.maximumCommunityEntities,
    maximumCommunityRelationships: input.maximumCommunityRelationships,
    maximumCommunityBoundaryRelationships:
      input.maximumCommunityBoundaryRelationships,
    maximumCommunitySummaryCharacters: input.maximumCommunitySummaryCharacters,
    communityAdapterTimeoutMs: input.communityAdapterTimeoutMs,
    searchLaneCutoffMs: input.searchLaneCutoffMs,
    queryEmbeddingConcurrency: input.queryEmbeddingConcurrency,
    queryEmbeddingCacheEntries: input.queryEmbeddingCacheEntries
  };
}

export function validateSearchSettings(input: unknown): RuntimeSettingsValidationIssue[] {
  const issues: RuntimeSettingsValidationIssue[] = [];
  const value = objectValue(input);
  for (const field of Object.keys(DEFAULT_SEARCH_SETTINGS)) {
    requirePositiveInteger(value[field], field, issues);
  }
  validateIntegerRange(value, "requestTimeoutMs", 100, 30_000, issues);
  validateIntegerRange(value, "engineSearchCutoffMs", 50, 10_000, issues);
  validateIntegerRange(value, "overfetchFactor", 1, 10, issues);
  validateIntegerRange(value, "indexBatchDocumentCount", 1, 10_000, issues);
  validateIntegerRange(
    value,
    "indexBatchCompressedBytes",
    65_536,
    33_554_432,
    issues
  );
  validateIntegerRange(value, "maxInFlightTasks", 1, 32, issues);
  validateIntegerRange(value, "taskPollIntervalMs", 100, 30_000, issues);
  validateIntegerRange(value, "taskTimeoutMs", 10_000, 3_600_000, issues);
  validateIntegerRange(value, "maxAttempts", 1, 20, issues);
  validateIntegerRange(value, "retryDelayMs", 100, 300_000, issues);
  validateIntegerRange(value, "cleanupBatchSize", 1, 5_000, issues);
  validateIntegerRange(value, "stagingRetentionHours", 1, 720, issues);
  validateIntegerRange(value, "cropLength", 50, 5_000, issues);
  validateAtMost(
    value,
    "engineSearchCutoffMs",
    "requestTimeoutMs",
    issues
  );
  return issues;
}

export function sanitizeSearchSettings(
  input: RuntimeSearchSettings
): RuntimeSearchSettings {
  return {
    requestTimeoutMs: input.requestTimeoutMs,
    engineSearchCutoffMs: input.engineSearchCutoffMs,
    overfetchFactor: input.overfetchFactor,
    indexBatchDocumentCount: input.indexBatchDocumentCount,
    indexBatchCompressedBytes: input.indexBatchCompressedBytes,
    maxInFlightTasks: input.maxInFlightTasks,
    taskPollIntervalMs: input.taskPollIntervalMs,
    taskTimeoutMs: input.taskTimeoutMs,
    maxAttempts: input.maxAttempts,
    retryDelayMs: input.retryDelayMs,
    cleanupBatchSize: input.cleanupBatchSize,
    stagingRetentionHours: input.stagingRetentionHours,
    cropLength: input.cropLength
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
    "claimBatchSize",
    "pollIntervalMs",
    "lockTtlSeconds",
    "heartbeatIntervalMs",
    "jobMaxAttempts",
    "jobRetryDelayMs",
    "completedJobRetentionDays",
    "hardDeleteConcurrency",
    "hardDeleteDatabaseBatchSize",
    "hardDeleteObjectBatchSize",
    "hardDeleteMaxAttempts",
    "hardDeleteRetryDelayMs"
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

  for (const field of ["sourceObjectReadConcurrency"] as const) {
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

  return issues;
}

export function sanitizeWorkerSettings(input: RuntimeWorkerSettings): RuntimeWorkerSettings {
  return {
    sourceFileConcurrency: input.sourceFileConcurrency,
    sourceObjectReadConcurrency: input.sourceObjectReadConcurrency,
    claimBatchSize: input.claimBatchSize,
    pollIntervalMs: input.pollIntervalMs,
    lockTtlSeconds: input.lockTtlSeconds,
    heartbeatIntervalMs: input.heartbeatIntervalMs!,
    jobMaxAttempts: input.jobMaxAttempts,
    jobRetryDelayMs: input.jobRetryDelayMs,
    completedJobRetentionDays: input.completedJobRetentionDays,
    hardDeleteConcurrency: input.hardDeleteConcurrency,
    hardDeleteDatabaseBatchSize: input.hardDeleteDatabaseBatchSize,
    hardDeleteObjectBatchSize: Math.min(input.hardDeleteObjectBatchSize, 1_000),
    hardDeleteMaxAttempts: input.hardDeleteMaxAttempts,
    hardDeleteRetryDelayMs: input.hardDeleteRetryDelayMs
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
    "intervalSeconds",
    "roleConcurrency",
    "claimBatchSize",
    "directoryIndexMaxEntries",
    "directoryIndexMaxBytes",
    "generatedObjectWriteConcurrency"
  ].forEach((field) => requirePositiveInteger(value[field], field, issues));

  if (
    Number.isInteger(value.generatedObjectWriteConcurrency)
    && Number(value.generatedObjectWriteConcurrency) > MAX_PUBLICATION_RESOURCE_CONCURRENCY
  ) {
    issues.push({
      field: "generatedObjectWriteConcurrency",
      message: `generatedObjectWriteConcurrency must be less than or equal to ${MAX_PUBLICATION_RESOURCE_CONCURRENCY}`
    });
  }
  validateAtMost(value, "roleConcurrency", "claimBatchSize", issues);

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
  if (input.apiMode !== undefined && !modelApiModeValues().includes(input.apiMode)) {
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
  if (typeof input.isActive !== "boolean") {
    issues.push({ field: "isActive", message: "isActive must be true or false" });
  }

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
  if (!["manual", "automatic"].includes(String(value.knowledgeBaseMaintenanceMode))) {
    issues.push({
      field: "knowledgeBaseMaintenanceMode",
      message: "knowledgeBaseMaintenanceMode must be manual or automatic"
    });
  }

  [
    "knowledgeBaseMaintenanceScanIntervalSeconds",
    "knowledgeBaseMaintenanceConcurrency",
    "scanBatchSize",
    "deletionBatchSize",
    "quarantineGracePeriodSeconds",
    "maxAttempts",
    "retryDelayMs",
    "projectionRepairConcurrency",
    "projectionRepairDatabaseBatchSize",
    "projectionRepairObjectWriteConcurrency",
    "lexicalRebuildConcurrency",
    "lexicalRebuildSourceReadConcurrency",
    "lexicalRebuildMaxInFlightSourceBytes"
  ].forEach((field) => requirePositiveInteger(value[field], field, issues));

  validateIntegerRange(
    value,
    "knowledgeBaseMaintenanceScanIntervalSeconds",
    60,
    2_592_000,
    issues
  );
  validateIntegerRange(value, "knowledgeBaseMaintenanceConcurrency", 1, 16, issues);

  for (const field of [
    "projectionRepairConcurrency",
    "lexicalRebuildConcurrency"
  ] as const) {
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

  validateIntegerRange(value, "projectionRepairDatabaseBatchSize", 100, 10_000, issues);
  validateIntegerRange(value, "projectionRepairObjectWriteConcurrency", 1, 32, issues);
  validateIntegerRange(value, "lexicalRebuildSourceReadConcurrency", 1, 32, issues);
  validateIntegerRange(
    value,
    "lexicalRebuildMaxInFlightSourceBytes",
    1_048_576,
    536_870_912,
    issues
  );

  for (const field of ["scanBatchSize", "deletionBatchSize"] as const) {
    if (Number.isInteger(value[field]) && Number(value[field]) > 1_000) {
      issues.push({
        field,
        message: `${field} must be less than or equal to 1000`
      });
    }
  }

  return issues;
}

export function sanitizeMaintenanceSettings(
  input: RuntimeMaintenanceSettings
): RuntimeMaintenanceSettings {
  return {
    reconciliationEnabled: input.reconciliationEnabled,
    knowledgeBaseMaintenanceMode: input.knowledgeBaseMaintenanceMode,
    knowledgeBaseMaintenanceScanIntervalSeconds:
      input.knowledgeBaseMaintenanceScanIntervalSeconds,
    knowledgeBaseMaintenanceConcurrency: input.knowledgeBaseMaintenanceConcurrency,
    scanBatchSize: Math.min(input.scanBatchSize, 1_000),
    deletionBatchSize: Math.min(input.deletionBatchSize, 1_000),
    quarantineGracePeriodSeconds: input.quarantineGracePeriodSeconds,
    maxAttempts: input.maxAttempts,
    retryDelayMs: input.retryDelayMs,
    projectionRepairConcurrency: input.projectionRepairConcurrency,
    projectionRepairDatabaseBatchSize: input.projectionRepairDatabaseBatchSize,
    projectionRepairObjectWriteConcurrency: input.projectionRepairObjectWriteConcurrency,
    lexicalRebuildConcurrency: input.lexicalRebuildConcurrency,
    lexicalRebuildSourceReadConcurrency: input.lexicalRebuildSourceReadConcurrency,
    lexicalRebuildMaxInFlightSourceBytes: input.lexicalRebuildMaxInFlightSourceBytes
  };
}

export function sanitizePublicationSettings(
  input: RuntimePublicationSettings
): RuntimePublicationSettings {
  return {
    mode: input.mode,
    intervalSeconds: input.intervalSeconds,
    roleConcurrency: input.roleConcurrency,
    claimBatchSize: input.claimBatchSize,
    directoryIndexMaxEntries: input.directoryIndexMaxEntries,
    directoryIndexMaxBytes: input.directoryIndexMaxBytes,
    generatedObjectWriteConcurrency: input.generatedObjectWriteConcurrency
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

function validateIntegerRange(
  value: Record<string, unknown>,
  field: string,
  minimum: number,
  maximum: number,
  issues: RuntimeSettingsValidationIssue[]
): void {
  if (
    Number.isInteger(value[field])
    && (Number(value[field]) < minimum || Number(value[field]) > maximum)
  ) {
    issues.push({
      field,
      message: `${field} must be between ${minimum} and ${maximum}`
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

function requireNonNegativeInteger(
  value: unknown,
  field: string,
  issues: RuntimeSettingsValidationIssue[]
) {
  if (!Number.isInteger(value) || Number(value) < 0) {
    issues.push({ field, message: `${field} must be a non-negative integer` });
  }
}

function requireInteger(
  value: unknown,
  field: string,
  issues: RuntimeSettingsValidationIssue[]
) {
  if (!Number.isInteger(value)) {
    issues.push({ field, message: `${field} must be an integer` });
  }
}

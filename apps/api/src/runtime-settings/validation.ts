import {
  resolveSecurityConfig,
  resolveGraphConfig,
  resolveGeneratedKnowledgeBaseConfig,
  resolveWorkerConfig,
  type RuntimeConfig
} from "../config.js";
import {
  DEFAULT_WORKER_S3_CONCURRENCY,
  modelApiModeValues,
  rateLimitKeys,
  type RuntimeGeneratedSettings,
  type RuntimeGraphSettings,
  type RuntimeMaintenanceSettings,
  type RuntimeModelConfigDraft,
  type RuntimeRateLimitSettings,
  type RuntimeSemanticSettings,
  type RuntimeSearchSettings,
  type RuntimeSettingsDefaults,
  type RuntimeSettingsValidationIssue,
  type RuntimeWorkerSettings
} from "./types.js";

const MAX_WORKER_RESOURCE_CONCURRENCY = 32;
export const MAX_WORKER_S3_CONCURRENCY = 48;

export const DEFAULT_MAINTENANCE_SETTINGS: RuntimeMaintenanceSettings = {
  reconciliationEnabled: true,
  scanBatchSize: 500,
  maxAttempts: 5,
  retryDelayMs: 30_000,
  hardDeleteConcurrency: 1,
  hardDeleteDatabaseBatchSize: 1_000,
  hardDeleteObjectBatchSize: 1_000,
  hardDeleteMaxAttempts: 3,
  hardDeleteRetryDelayMs: 60_000,
  hardDeleteFailedRetentionDays: 30
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
  cropLength: 1_200
};

export const DEFAULT_SEMANTIC_SETTINGS: RuntimeSemanticSettings = {
  maximumChunkCharacters: 8_000,
  maximumChunks: 32,
  maximumEvidenceTargets: 64,
  graphRagAdapterTimeoutMs: 30_000,
  searchLaneCutoffMs: 2_500,
  queryEmbeddingConcurrency: 4,
  queryEmbeddingCacheEntries: 1_000
};

export function createRuntimeSettingsDefaults(config: RuntimeConfig): RuntimeSettingsDefaults {
  const worker = resolveWorkerConfig(config);
  const generated = resolveGeneratedKnowledgeBaseConfig(config);
  return {
    rateLimits: resolveSecurityConfig(config).rateLimits,
    worker: sanitizeWorkerSettings({
      ...worker,
      sourceObjectReadConcurrency: DEFAULT_WORKER_S3_CONCURRENCY
    }),
    generated: sanitizeGeneratedSettings({
      directoryIndexMaxEntries: generated.directoryIndexMaxEntries,
      directoryIndexMaxBytes: generated.directoryIndexMaxBytes,
      rootSummaryLimit: generated.rootSummaryLimit,
      okfLogMaxEntries: generated.okfLogMaxEntries,
      okfLogMaxBytes: generated.okfLogMaxBytes
    }),
    graph: sanitizeGraphSettings(resolveGraphConfig(config)),
    maintenance: {
      ...DEFAULT_MAINTENANCE_SETTINGS,
      hardDeleteConcurrency: worker.hardDeleteConcurrency,
      hardDeleteDatabaseBatchSize: worker.hardDeleteDatabaseBatchSize,
      hardDeleteObjectBatchSize: worker.hardDeleteObjectBatchSize,
      hardDeleteMaxAttempts: worker.hardDeleteMaxAttempts,
      hardDeleteRetryDelayMs: worker.hardDeleteRetryDelayMs,
      hardDeleteFailedRetentionDays: worker.hardDeleteFailedRetentionDays
    },
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
  rejectUnknownFields(value, DEFAULT_SEMANTIC_SETTINGS, issues);
  for (const field of Object.keys(DEFAULT_SEMANTIC_SETTINGS)) {
    requireInteger(value[field], field, issues);
  }
  validateIntegerRange(value, "maximumChunkCharacters", 1, 64_000, issues);
  validateIntegerRange(value, "maximumChunks", 1, 32, issues);
  validateIntegerRange(value, "maximumEvidenceTargets", 1, 256, issues);
  validateIntegerRange(value, "graphRagAdapterTimeoutMs", 100, 300_000, issues);
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
    graphRagAdapterTimeoutMs: input.graphRagAdapterTimeoutMs,
    searchLaneCutoffMs: input.searchLaneCutoffMs,
    queryEmbeddingConcurrency: input.queryEmbeddingConcurrency,
    queryEmbeddingCacheEntries: input.queryEmbeddingCacheEntries
  };
}

export function validateSearchSettings(input: unknown): RuntimeSettingsValidationIssue[] {
  const issues: RuntimeSettingsValidationIssue[] = [];
  const value = objectValue(input);
  rejectUnknownFields(value, DEFAULT_SEARCH_SETTINGS, issues);
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
  validateIntegerRange(value, "taskPollIntervalMs", 100, 30_000, issues);
  validateIntegerRange(value, "taskTimeoutMs", 10_000, 3_600_000, issues);
  validateIntegerRange(value, "maxAttempts", 1, 20, issues);
  validateIntegerRange(value, "retryDelayMs", 100, 300_000, issues);
  validateIntegerRange(value, "cleanupBatchSize", 1, 5_000, issues);
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
    "completedJobRetentionDays"
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

  if (
    Number.isInteger(value.sourceObjectReadConcurrency)
    && Number(value.sourceObjectReadConcurrency) > MAX_WORKER_S3_CONCURRENCY
  ) {
    issues.push({
      field: "sourceObjectReadConcurrency",
      message: `sourceObjectReadConcurrency must be less than or equal to ${MAX_WORKER_S3_CONCURRENCY}`
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
    completedJobRetentionDays: input.completedJobRetentionDays
  };
}

export function validateGeneratedSettings(input: unknown): RuntimeSettingsValidationIssue[] {
  const issues: RuntimeSettingsValidationIssue[] = [];
  const value = objectValue(input);
  [
    "directoryIndexMaxEntries",
    "directoryIndexMaxBytes",
    "rootSummaryLimit",
    "okfLogMaxEntries",
    "okfLogMaxBytes"
  ]
    .forEach((field) => requirePositiveInteger(value[field], field, issues));

  validateIntegerRange(value, "directoryIndexMaxEntries", 2, 10_000, issues);
  validateIntegerRange(value, "directoryIndexMaxBytes", 1_024, 10_485_760, issues);

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
    "shardSize",
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
  rejectUnknownFields(value, DEFAULT_MAINTENANCE_SETTINGS, issues);

  if (typeof value.reconciliationEnabled !== "boolean") {
    issues.push({
      field: "reconciliationEnabled",
      message: "reconciliationEnabled must be true or false"
    });
  }
  [
    "scanBatchSize",
    "maxAttempts",
    "retryDelayMs",
    "hardDeleteConcurrency",
    "hardDeleteDatabaseBatchSize",
    "hardDeleteObjectBatchSize",
    "hardDeleteMaxAttempts",
    "hardDeleteRetryDelayMs",
    "hardDeleteFailedRetentionDays"
  ].forEach((field) => requirePositiveInteger(value[field], field, issues));

  validateIntegerRange(value, "hardDeleteConcurrency", 1, 16, issues);
  validateIntegerRange(value, "hardDeleteDatabaseBatchSize", 1, 10_000, issues);
  validateIntegerRange(value, "hardDeleteObjectBatchSize", 1, 1_000, issues);
  validateIntegerRange(value, "hardDeleteMaxAttempts", 1, 20, issues);
  validateIntegerRange(value, "hardDeleteRetryDelayMs", 100, 300_000, issues);
  validateIntegerRange(value, "hardDeleteFailedRetentionDays", 1, 365, issues);
  if (Number.isInteger(value.scanBatchSize) && Number(value.scanBatchSize) > 1_000) {
    issues.push({
      field: "scanBatchSize",
      message: "scanBatchSize must be less than or equal to 1000"
    });
  }

  return issues;
}

export function sanitizeMaintenanceSettings(
  input: RuntimeMaintenanceSettings
): RuntimeMaintenanceSettings {
  return {
    reconciliationEnabled: input.reconciliationEnabled,
    scanBatchSize: Math.min(input.scanBatchSize, 1_000),
    maxAttempts: input.maxAttempts,
    retryDelayMs: input.retryDelayMs,
    hardDeleteConcurrency: input.hardDeleteConcurrency,
    hardDeleteDatabaseBatchSize: input.hardDeleteDatabaseBatchSize,
    hardDeleteObjectBatchSize: Math.min(input.hardDeleteObjectBatchSize, 1_000),
    hardDeleteMaxAttempts: input.hardDeleteMaxAttempts,
    hardDeleteRetryDelayMs: input.hardDeleteRetryDelayMs,
    hardDeleteFailedRetentionDays: input.hardDeleteFailedRetentionDays
  };
}

export function sanitizeGeneratedSettings(
  input: RuntimeGeneratedSettings
): RuntimeGeneratedSettings {
  return {
    directoryIndexMaxEntries: input.directoryIndexMaxEntries,
    directoryIndexMaxBytes: input.directoryIndexMaxBytes,
    rootSummaryLimit: input.rootSummaryLimit,
    okfLogMaxEntries: input.okfLogMaxEntries,
    okfLogMaxBytes: input.okfLogMaxBytes
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
    shardSize: input.shardSize,
    genericPhraseThreshold: input.genericPhraseThreshold
  };
}

function sanitizeLimit(input: { max: number; windowSeconds: number }) {
  return {
    max: input.max,
    windowSeconds: input.windowSeconds
  };
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  expected: Readonly<Record<string, unknown>>,
  issues: RuntimeSettingsValidationIssue[]
): void {
  for (const field of Object.keys(value)) {
    if (!Object.hasOwn(expected, field)) {
      issues.push({ field, message: `${field} is no longer supported` });
    }
  }
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
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    issues.push({ field, message: `${field} must be a positive integer` });
  }
}

function requireNonNegativeInteger(
  value: unknown,
  field: string,
  issues: RuntimeSettingsValidationIssue[]
) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    issues.push({ field, message: `${field} must be a non-negative integer` });
  }
}

function requireInteger(
  value: unknown,
  field: string,
  issues: RuntimeSettingsValidationIssue[]
) {
  if (!Number.isSafeInteger(value)) {
    issues.push({ field, message: `${field} must be an integer` });
  }
}

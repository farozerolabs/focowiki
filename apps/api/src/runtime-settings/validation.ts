import {
  resolveSecurityConfig,
  resolveWorkerConfig,
  type RuntimeConfig,
  type WorkerRuntimeConfig
} from "../config.js";
import {
  modelApiModeValues,
  publicationModeValues,
  rateLimitKeys,
  type RuntimeModelConfigDraft,
  type RuntimePublicationSettings,
  type RuntimeRateLimitSettings,
  type RuntimeSettingsDefaults,
  type RuntimeSettingsValidationIssue,
  type RuntimeUploadGenerationSettings,
  type RuntimeWorkerSettings
} from "./types.js";

const DEFAULT_OKF_LOG_MAX_ENTRIES = 100;
const DEFAULT_OKF_LOG_MAX_BYTES = 65_536;

export function createRuntimeSettingsDefaults(config: RuntimeConfig): RuntimeSettingsDefaults {
  return {
    rateLimits: resolveSecurityConfig(config).rateLimits,
    worker: sanitizeWorkerSettings(resolveWorkerConfig(config)),
    publication: {
      ...config.publication,
      okfLogMaxEntries: config.okf?.log.maxEntries ?? DEFAULT_OKF_LOG_MAX_ENTRIES,
      okfLogMaxBytes: config.okf?.log.maxBytes ?? DEFAULT_OKF_LOG_MAX_BYTES
    },
    uploadGeneration: sanitizeUploadGenerationSettings(config.upload),
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
    upload: sanitizeLimit(input.upload),
    publicOpenApi: sanitizeLimit(input.publicOpenApi)
  };
}

export function validateWorkerSettings(input: unknown): RuntimeSettingsValidationIssue[] {
  const issues: RuntimeSettingsValidationIssue[] = [];
  const value = objectValue(input);

  [
    "sourceFileConcurrency",
    "claimBatchSize",
    "pollIntervalMs",
    "lockTtlSeconds",
    "heartbeatIntervalMs",
    "jobMaxAttempts",
    "jobRetryDelayMs",
    "queueBackpressureLimit",
    "queueBackpressureKnowledgeBaseLimit",
    "queueBackpressureMaxAgeSeconds",
    "queueBackpressureRetryAfterSeconds",
    "shutdownGraceMs",
    "completedJobRetentionDays",
    "failedJobRetentionDays",
    "deadLetterJobRetentionDays",
    "retentionCleanupBatchSize"
  ].forEach((field) => requirePositiveInteger(value[field], field, issues));

  return issues;
}

export function sanitizeWorkerSettings(input: WorkerRuntimeConfig): RuntimeWorkerSettings {
  return {
    sourceFileConcurrency: input.sourceFileConcurrency,
    claimBatchSize: input.claimBatchSize,
    pollIntervalMs: input.pollIntervalMs,
    lockTtlSeconds: input.lockTtlSeconds,
    heartbeatIntervalMs: input.heartbeatIntervalMs!,
    jobMaxAttempts: input.jobMaxAttempts,
    jobRetryDelayMs: input.jobRetryDelayMs,
    queueBackpressureLimit: input.queueBackpressureLimit,
    queueBackpressureKnowledgeBaseLimit: input.queueBackpressureKnowledgeBaseLimit!,
    queueBackpressureMaxAgeSeconds: input.queueBackpressureMaxAgeSeconds!,
    queueBackpressureRetryAfterSeconds: input.queueBackpressureRetryAfterSeconds!,
    shutdownGraceMs: input.shutdownGraceMs,
    completedJobRetentionDays: input.completedJobRetentionDays!,
    failedJobRetentionDays: input.failedJobRetentionDays!,
    deadLetterJobRetentionDays: input.deadLetterJobRetentionDays!,
    retentionCleanupBatchSize: input.retentionCleanupBatchSize!
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
    "indexShardSize",
    "linkIndexShardSize",
    "manifestShardSize",
    "graphEdgeShardSize",
    "graphCandidateLimit",
    "graphMaintenanceBatchSize",
    "rootSummaryLimit",
    "okfLogMaxEntries",
    "okfLogMaxBytes"
  ].forEach((field) => requirePositiveInteger(value[field], field, issues));

  return issues;
}

export function validateUploadGenerationSettings(
  input: unknown
): RuntimeSettingsValidationIssue[] {
  const issues: RuntimeSettingsValidationIssue[] = [];
  const value = objectValue(input);

  [
    "maxBytes",
    "maxFiles",
    "generationBatchSize",
    "fileProcessingConcurrency",
    "storageConcurrency"
  ].forEach((field) => requirePositiveInteger(value[field], field, issues));

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

export function sanitizePublicationSettings(
  input: RuntimePublicationSettings
): RuntimePublicationSettings {
  return {
    mode: input.mode,
    batchSize: input.batchSize,
    intervalSeconds: input.intervalSeconds,
    indexShardSize: input.indexShardSize,
    linkIndexShardSize: input.linkIndexShardSize,
    manifestShardSize: input.manifestShardSize,
    graphEdgeShardSize: input.graphEdgeShardSize,
    graphCandidateLimit: input.graphCandidateLimit,
    graphMaintenanceBatchSize: input.graphMaintenanceBatchSize,
    rootSummaryLimit: input.rootSummaryLimit,
    okfLogMaxEntries: input.okfLogMaxEntries,
    okfLogMaxBytes: input.okfLogMaxBytes
  };
}

export function sanitizeUploadGenerationSettings(
  input: RuntimeUploadGenerationSettings
): RuntimeUploadGenerationSettings {
  return {
    maxBytes: input.maxBytes,
    maxFiles: input.maxFiles,
    generationBatchSize: input.generationBatchSize,
    fileProcessingConcurrency: input.fileProcessingConcurrency,
    storageConcurrency: input.storageConcurrency
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

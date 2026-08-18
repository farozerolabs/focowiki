import type { RateLimitConfig, RuntimeSecurityConfig } from "../config.js";

export type RuntimeSettingKey =
  | "rate_limits"
  | "worker"
  | "generated"
  | "graph"
  | "maintenance"
  | "semantic"
  | "search";
export type ModelConfigStatus = "active" | "paused" | "deleted";
export type ModelApiMode = "responses" | "chat_completions";

export type RuntimeRateLimitSettings = RuntimeSecurityConfig["rateLimits"];
export type RuntimeWorkerPublicSettings = {
  sourceFileConcurrency: number;
  jobMaxAttempts: number;
  jobRetryDelayMs: number;
  completedJobRetentionDays: number;
};

export type RuntimeWorkerSettings = RuntimeWorkerPublicSettings & {
  sourceObjectReadConcurrency: number;
  claimBatchSize: number;
  pollIntervalMs: number;
  lockTtlSeconds: number;
  heartbeatIntervalMs: number;
};

export type RuntimeGeneratedSettings = {
  directoryIndexMaxEntries: number;
  directoryIndexMaxBytes: number;
  rootSummaryLimit: number;
  okfLogMaxEntries: number;
  okfLogMaxBytes: number;
};
export type RuntimeGraphSettings = {
  candidateLimit: number;
  acceptedEdgeLimit: number;
  searchDefaultDepth: 0 | 1 | 2;
  searchMaxDepth: 0 | 1 | 2;
  searchDefaultFanout: number;
  searchMaxFanout: number;
  shardSize: number;
  genericPhraseThreshold: number;
};
export type RuntimeMaintenanceSettings = {
  reconciliationEnabled: boolean;
  scanBatchSize: number;
  maxAttempts: number;
  retryDelayMs: number;
  hardDeleteConcurrency: number;
  hardDeleteDatabaseBatchSize: number;
  hardDeleteObjectBatchSize: number;
  hardDeleteMaxAttempts: number;
  hardDeleteRetryDelayMs: number;
  hardDeleteFailedRetentionDays: number;
};

export type RuntimeSearchSettings = {
  requestTimeoutMs: number;
  engineSearchCutoffMs: number;
  overfetchFactor: number;
  indexBatchDocumentCount: number;
  indexBatchCompressedBytes: number;
  maxInFlightTasks: number;
  taskPollIntervalMs: number;
  taskTimeoutMs: number;
  maxAttempts: number;
  retryDelayMs: number;
  cleanupBatchSize: number;
  cropLength: number;
};

export type RuntimeSemanticSettings = {
  maximumChunkCharacters: number;
  maximumChunks: number;
  maximumEvidenceTargets: number;
  graphRagAdapterTimeoutMs: number;
  searchLaneCutoffMs: number;
  queryEmbeddingConcurrency: number;
  queryEmbeddingCacheEntries: number;
};

export type RuntimeSettingsSnapshot = {
  rateLimits: RuntimeRateLimitSettings;
  worker: RuntimeWorkerSettings;
  generated: RuntimeGeneratedSettings;
  graph: RuntimeGraphSettings;
  maintenance: RuntimeMaintenanceSettings;
  semantic: RuntimeSemanticSettings;
  search: RuntimeSearchSettings;
  activeModel: RuntimeModelConfigPrivate | null;
};

export type RuntimeSettingRecord<TValue = unknown> = {
  key: RuntimeSettingKey;
  value: TValue;
  version: number;
  source: "bootstrap" | "admin";
  createdAt: string;
  updatedAt: string;
};

export type RuntimeModelConfigPublic = {
  id: string;
  displayName: string;
  apiMode: ModelApiMode;
  baseUrl: string;
  apiKeyFingerprint: string;
  modelName: string;
  contextWindowTokens: number;
  requestMaxTimeoutMs: number;
  requestIdleTimeoutMs: number;
  suggestionConcurrency: number;
  transientRetryDelayMs: number;
  requestMinIntervalMs: number;
  status: ModelConfigStatus;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type RuntimeModelConfigPrivate = RuntimeModelConfigPublic & {
  apiKey: string;
  configurationRevision?: number;
};

export type RuntimeModelConfigDraft = {
  displayName: string;
  apiMode?: ModelApiMode | undefined;
  baseUrl: string;
  apiKey: string;
  modelName: string;
  contextWindowTokens: number;
  requestMaxTimeoutMs: number;
  requestIdleTimeoutMs: number;
  suggestionConcurrency: number;
  transientRetryDelayMs: number;
  requestMinIntervalMs: number;
  isActive: boolean;
};

export type RuntimeModelConfigUpdate = Partial<
  Pick<
    RuntimeModelConfigDraft,
    | "displayName"
    | "apiMode"
    | "baseUrl"
    | "apiKey"
    | "modelName"
    | "contextWindowTokens"
    | "requestMaxTimeoutMs"
    | "requestIdleTimeoutMs"
    | "suggestionConcurrency"
    | "transientRetryDelayMs"
    | "requestMinIntervalMs"
  >
>;

export type RuntimeSettingsDefaults = {
  rateLimits: RuntimeRateLimitSettings;
  worker: RuntimeWorkerSettings;
  generated: RuntimeGeneratedSettings;
  graph: RuntimeGraphSettings;
  maintenance: RuntimeMaintenanceSettings;
  semantic: RuntimeSemanticSettings;
  search: RuntimeSearchSettings;
  model: RuntimeModelConfigDraft | null;
};

export type RuntimeSettingsValidationIssue = {
  field: string;
  message: string;
};

export class RuntimeSettingsValidationError extends Error {
  public readonly code = "RUNTIME_SETTINGS_VALIDATION_FAILED";
  public readonly issues: RuntimeSettingsValidationIssue[];

  public constructor(issues: RuntimeSettingsValidationIssue[]) {
    super("Runtime settings validation failed.");
    this.name = "RuntimeSettingsValidationError";
    this.issues = issues;
  }
}

export function serializePublicModel(
  model: RuntimeModelConfigPrivate | RuntimeModelConfigPublic
): RuntimeModelConfigPublic {
  return {
    id: model.id,
    displayName: model.displayName,
    apiMode: model.apiMode,
    baseUrl: model.baseUrl,
    apiKeyFingerprint: model.apiKeyFingerprint,
    modelName: model.modelName,
    contextWindowTokens: model.contextWindowTokens,
    requestMaxTimeoutMs: model.requestMaxTimeoutMs,
    requestIdleTimeoutMs: model.requestIdleTimeoutMs,
    suggestionConcurrency: model.suggestionConcurrency,
    transientRetryDelayMs: model.transientRetryDelayMs,
    requestMinIntervalMs: model.requestMinIntervalMs,
    status: model.status,
    isActive: model.isActive,
    createdAt: model.createdAt,
    updatedAt: model.updatedAt,
    deletedAt: model.deletedAt
  };
}

export function modelApiModeValues(): ModelApiMode[] {
  return ["responses", "chat_completions"];
}

export function rateLimitKeys(): Array<keyof RuntimeRateLimitSettings> {
  return ["adminLogin", "adminApi", "publicOpenApi"];
}

export function normalizeRateLimit(input: RateLimitConfig): RateLimitConfig {
  return {
    max: input.max,
    windowSeconds: input.windowSeconds
  };
}

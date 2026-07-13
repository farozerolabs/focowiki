import type {
  PublicationMode,
  RateLimitConfig,
  RuntimeConfig,
  RuntimeSecurityConfig,
  WorkerRuntimeConfig
} from "../config.js";

export type RuntimeSettingKey = "rate_limits" | "worker" | "publication" | "upload_generation" | "graph";
export type ModelConfigStatus = "active" | "paused" | "deleted";
export type ModelApiMode = "responses" | "chat_completions";

export type RuntimeRateLimitSettings = RuntimeSecurityConfig["rateLimits"];
export type RuntimeWorkerSettings = Required<Omit<WorkerRuntimeConfig, "databasePoolMax">>;

export type RuntimePublicationSettings = Omit<
  RuntimeConfig["publication"],
  "directoryIndexMaxEntries" | "directoryIndexMaxBytes"
> & {
  directoryIndexMaxEntries: number;
  directoryIndexMaxBytes: number;
  okfLogMaxEntries: number;
  okfLogMaxBytes: number;
};
export type RuntimeUploadGenerationSettings = Required<RuntimeConfig["upload"]>;
export type RuntimeGraphSettings = Required<NonNullable<RuntimeConfig["graph"]>>;

export type RuntimeSettingsSnapshot = {
  rateLimits: RuntimeRateLimitSettings;
  worker: RuntimeWorkerSettings;
  publication: RuntimePublicationSettings;
  uploadGeneration: RuntimeUploadGenerationSettings;
  graph: RuntimeGraphSettings;
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
  publication: RuntimePublicationSettings;
  uploadGeneration: RuntimeUploadGenerationSettings;
  graph: RuntimeGraphSettings;
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

export function publicationModeValues(): PublicationMode[] {
  return ["batch", "manual", "per_file"];
}

export function rateLimitKeys(): Array<keyof RuntimeRateLimitSettings> {
  return ["adminLogin", "adminApi", "upload", "publicOpenApi"];
}

export function normalizeRateLimit(input: RateLimitConfig): RateLimitConfig {
  return {
    max: input.max,
    windowSeconds: input.windowSeconds
  };
}

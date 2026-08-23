import { randomUUID } from "node:crypto";
import { resolveSecurityConfig, type RuntimeConfig } from "../config.js";
import type { RedisCoordinator } from "../redis/coordination.js";
import { loadDeploymentSecret } from "../security/runtime-secrets.js";
import {
  decryptRuntimeSecret,
  encryptRuntimeSecret,
  fingerprintRuntimeSecret
} from "./encryption.js";
import type {
  RuntimeSettingsRepository,
  RuntimeSettingsRevisionIdentity
} from "./repository.js";
import {
  createStorageVnextRuntimeSettingsBackendLimits,
  validateStorageVnextRuntimeSettingsCandidate,
  type StorageVnextRuntimeSettingsBackendLimits
} from "./candidate-validation.js";
import {
  createRuntimeSettingsResourceCapacity,
  validateRuntimeSettingsResourceCapacity,
  type RuntimeSettingsResourceCapacity
} from "./resource-capacity-validation.js";
import {
  modelApiModeValues,
  RuntimeSettingsValidationError,
  serializePublicModel,
  type ModelApiMode,
  type RuntimeGraphSettings,
  type RuntimeGeneratedSettings,
  type RuntimeMaintenanceSettings,
  type RuntimeModelConfigDraft,
  type RuntimeModelConfigPrivate,
  type RuntimeModelConfigPublic,
  type RuntimeModelConfigUpdate,
  type RuntimeRateLimitSettings,
  type RuntimeSemanticSettings,
  type RuntimeSearchSettings,
  type RuntimeSettingKey,
  type RuntimeSettingsSnapshot,
  type RuntimeWorkerPublicSettings
} from "./types.js";
import {
  createRuntimeSettingsDefaults,
  sanitizeGraphSettings,
  sanitizeMaintenanceSettings,
  sanitizeGeneratedSettings,
  sanitizeRateLimitSettings,
  sanitizeSemanticSettings,
  sanitizeSearchSettings,
  sanitizeWorkerSettings,
  validateGraphSettings,
  validateMaintenanceSettings,
  validateModelDraft,
  validateGeneratedSettings,
  validateRateLimitSettings,
  validateSemanticSettings,
  validateSearchSettings,
  validateWorkerSettings
} from "./validation.js";

type RuntimeSettingsCache = {
  version: string;
  snapshot: RuntimeSettingsSnapshot;
  cachedAtMs: number;
};

const LOCAL_CACHE_TTL_MS = 1_000;

export type RuntimeSettingsService = {
  ensureBootstrapped: () => Promise<void>;
  getSnapshot: () => Promise<RuntimeSettingsSnapshot>;
  getCurrentRevision: () => Promise<RuntimeSettingsRevisionIdentity>;
  getMaintenanceRevision: () => Promise<number>;
  getPublicSnapshot: () => Promise<{
    rateLimits: RuntimeRateLimitSettings;
    worker: RuntimeWorkerPublicSettings;
    generated: RuntimeGeneratedSettings;
    graph: RuntimeGraphSettings;
    maintenance: RuntimeMaintenanceSettings;
    semantic: RuntimeSemanticSettings;
    search: RuntimeSearchSettings;
    activeModel: RuntimeModelConfigPublic | null;
  }>;
  updateRateLimits: (input: {
    value: RuntimeRateLimitSettings;
    actor?: string | null | undefined;
  }) => Promise<RuntimeSettingsSnapshot>;
  updateWorker: (input: {
    value: RuntimeSettingsSnapshot["worker"];
    actor?: string | null | undefined;
  }) => Promise<RuntimeSettingsSnapshot>;
  updateGenerated: (input: {
    value: RuntimeGeneratedSettings;
    actor?: string | null | undefined;
  }) => Promise<RuntimeSettingsSnapshot>;
  updateGraph: (input: {
    value: RuntimeGraphSettings;
    actor?: string | null | undefined;
  }) => Promise<RuntimeSettingsSnapshot>;
  updateMaintenance: (input: {
    value: RuntimeMaintenanceSettings;
    actor?: string | null | undefined;
  }) => Promise<RuntimeSettingsSnapshot>;
  updateSearch: (input: {
    value: RuntimeSearchSettings;
    actor?: string | null | undefined;
  }) => Promise<RuntimeSettingsSnapshot>;
  updateSemantic: (input: {
    value: RuntimeSemanticSettings;
    actor?: string | null | undefined;
  }) => Promise<RuntimeSettingsSnapshot>;
  listModels: () => Promise<RuntimeModelConfigPublic[]>;
  createModel: (input: RuntimeModelConfigDraft & { actor?: string | null | undefined }) => Promise<RuntimeModelConfigPublic>;
  updateModel: (input: {
    id: string;
    value: RuntimeModelConfigUpdate;
    actor?: string | null | undefined;
  }) => Promise<RuntimeModelConfigPublic | null>;
  activateModel: (input: { id: string; actor?: string | null | undefined }) => Promise<RuntimeModelConfigPublic | null>;
  pauseModel: (input: { id: string; actor?: string | null | undefined }) => Promise<RuntimeModelConfigPublic | null>;
  resumeModel: (input: { id: string; actor?: string | null | undefined }) => Promise<RuntimeModelConfigPublic | null>;
  deleteModel: (input: { id: string; actor?: string | null | undefined }) => Promise<RuntimeModelConfigPublic | null>;
};

export function createRuntimeSettingsService(input: {
  config: RuntimeConfig;
  repository: RuntimeSettingsRepository;
  redis?: RedisCoordinator | null;
  deploymentSecretDirectory?: string | undefined;
  resourceCapacity?: RuntimeSettingsResourceCapacity | undefined;
  backendLimits?: StorageVnextRuntimeSettingsBackendLimits | undefined;
}): RuntimeSettingsService {
  const defaults = createRuntimeSettingsDefaults(input.config);
  const resourceCapacity = input.resourceCapacity
    ?? createRuntimeSettingsResourceCapacity({ config: input.config, defaults });
  const backendLimits = input.backendLimits
    ?? createStorageVnextRuntimeSettingsBackendLimits();
  const auditRetentionDays = resolveSecurityConfig(input.config).audit.retentionDays;
  const deploymentSecret = loadDeploymentSecret({
    directory: input.deploymentSecretDirectory
  });
  let bootstrapPromise: Promise<void> | null = null;
  let cache: RuntimeSettingsCache | null = null;

  async function ensureBootstrapped(): Promise<void> {
    bootstrapPromise ??= bootstrap();
    await bootstrapPromise;
  }

  async function bootstrap(): Promise<void> {
    const rows = await input.repository.listSettings();
    const existingKeys = new Set(rows.map((row) => row.key));

    if (!existingKeys.has("rate_limits")) {
      await input.repository.upsertSetting({
        key: "rate_limits",
        value: defaults.rateLimits,
        source: "bootstrap"
      });
    }
    if (!existingKeys.has("worker")) {
      await input.repository.upsertSetting({
        key: "worker",
        value: defaults.worker,
        source: "bootstrap"
      });
    }
    if (!existingKeys.has("generated")) {
      await input.repository.upsertSetting({
        key: "generated",
        value: defaults.generated,
        source: "bootstrap"
      });
    }
    if (!existingKeys.has("graph")) {
      await input.repository.upsertSetting({
        key: "graph",
        value: defaults.graph,
        source: "bootstrap"
      });
    }
    if (!existingKeys.has("maintenance")) {
      await input.repository.upsertSetting({
        key: "maintenance",
        value: defaults.maintenance,
        source: "bootstrap"
      });
    }
    if (!existingKeys.has("search")) {
      await input.repository.upsertSetting({
        key: "search",
        value: defaults.search,
        source: "bootstrap"
      });
    }
    if (!existingKeys.has("semantic")) {
      await input.repository.upsertSetting({
        key: "semantic",
        value: defaults.semantic,
        source: "bootstrap"
      });
    }

    const models = await input.repository.listModels();
    if (models.length === 0 && defaults.model) {
      await createModelInternal(defaults.model, "bootstrap");
    }
    await validateModelKeyProtection();

    await bumpVersion();
  }

  async function getSnapshot(): Promise<RuntimeSettingsSnapshot> {
    await ensureBootstrapped();
    const version = await readVersion();

    if (cache && cache.version === version && Date.now() - cache.cachedAtMs < LOCAL_CACHE_TTL_MS) {
      return cache.snapshot;
    }

    const [
      rateLimitsRecord,
      workerRecord,
      generatedRecord,
      graphRecord,
      maintenanceRecord,
      semanticRecord,
      searchRecord,
      model
    ] = await Promise.all([
      input.repository.getSetting("rate_limits"),
      input.repository.getSetting("worker"),
      input.repository.getSetting("generated"),
      input.repository.getSetting("graph"),
      input.repository.getSetting("maintenance"),
      input.repository.getSetting("semantic"),
      input.repository.getSetting("search"),
      input.repository.getActiveModel()
    ]);
    const snapshot: RuntimeSettingsSnapshot = {
      rateLimits: sanitizeRateLimitSettings(
        (rateLimitsRecord?.value ?? defaults.rateLimits) as RuntimeRateLimitSettings
      ),
      worker: sanitizeWorkerSettings(
        {
          ...defaults.worker,
          ...(workerRecord?.value ?? {})
        } as RuntimeSettingsSnapshot["worker"]
      ),
      generated: sanitizeGeneratedSettings(
        {
          ...defaults.generated,
          ...(generatedRecord?.value ?? {})
        } as RuntimeGeneratedSettings
      ),
      graph: sanitizeGraphSettings(
        {
          ...defaults.graph,
          ...(graphRecord?.value ?? {})
        } as RuntimeGraphSettings
      ),
      maintenance: sanitizeMaintenanceSettings(
        {
          ...defaults.maintenance,
          ...(maintenanceRecord?.value ?? {})
        } as RuntimeMaintenanceSettings
      ),
      semantic: sanitizeSemanticSettings(
        {
          ...defaults.semantic,
          ...(semanticRecord?.value ?? {})
        } as RuntimeSemanticSettings
      ),
      search: sanitizeSearchSettings(
        {
          ...defaults.search,
          ...(searchRecord?.value ?? {})
        } as RuntimeSearchSettings
      ),
      activeModel: model ? tryDecryptModel(model) : null
    };
    const capacityIssues = validateRuntimeSettingsResourceCapacity({
      snapshot,
      capacity: resourceCapacity
    });
    if (capacityIssues.length > 0) {
      throw new RuntimeSettingsValidationError(capacityIssues);
    }

    cache = {
      version,
      snapshot,
      cachedAtMs: Date.now()
    };

    return snapshot;
  }

  async function updateSetting<TValue>(
    key: RuntimeSettingKey,
    value: TValue,
    actor: string | null | undefined,
    candidateValue: unknown = value
  ): Promise<RuntimeSettingsSnapshot> {
    await ensureBootstrapped();
    const current = await getSnapshot();
    const candidate = withUpdatedSetting(current, key, candidateValue);
    const candidateIssues = validateStorageVnextRuntimeSettingsCandidate({
      value: candidate,
      capacity: resourceCapacity,
      backendLimits
    });
    if (candidateIssues.length > 0) {
      throw new RuntimeSettingsValidationError(candidateIssues);
    }
    await input.repository.upsertSetting({
      key,
      value,
      source: "admin"
    });
    await writeAuditLog({
      settingKey: key,
      action: "update",
      actor,
      value: redactSettingValue(value)
    });
    await bumpVersion();
    cache = null;
    return getSnapshot();
  }

  async function validateActiveModelCapacity(suggestionConcurrency: number): Promise<void> {
    const current = await getSnapshot();
    const capacityIssues = validateRuntimeSettingsResourceCapacity({
      snapshot: {
        ...current,
        activeModel: { suggestionConcurrency } as RuntimeModelConfigPrivate
      },
      capacity: resourceCapacity
    });
    if (capacityIssues.length > 0) {
      throw new RuntimeSettingsValidationError(capacityIssues);
    }
  }

  async function writeAuditLog(audit: {
    settingKey: string;
    action: string;
    actor?: string | null | undefined;
    value: unknown;
  }): Promise<void> {
    const expiresAt = new Date(
      Date.now() + auditRetentionDays * 24 * 60 * 60 * 1_000
    ).toISOString();
    await input.repository.createAuditLog({ ...audit, expiresAt });
  }

  async function createModelInternal(
    draft: RuntimeModelConfigDraft,
    actor?: string | null | undefined
  ): Promise<RuntimeModelConfigPrivate> {
    const issues = validateModelDraft(draft);

    if (issues.length > 0) {
      throw new RuntimeSettingsValidationError(issues);
    }

    const model = await input.repository.createModel({
      displayName: draft.displayName.trim(),
      apiMode: normalizeModelApiMode(draft.apiMode),
      baseUrl: draft.baseUrl.trim(),
      encryptedApiKey: encryptRuntimeSecret({
        value: draft.apiKey,
        secret: deploymentSecret
      }),
      apiKeyFingerprint: fingerprintRuntimeSecret(draft.apiKey),
      modelName: draft.modelName.trim(),
      contextWindowTokens: draft.contextWindowTokens,
      requestMaxTimeoutMs: draft.requestMaxTimeoutMs,
      requestIdleTimeoutMs: draft.requestIdleTimeoutMs,
      suggestionConcurrency: draft.suggestionConcurrency,
      transientRetryDelayMs: draft.transientRetryDelayMs,
      requestMinIntervalMs: draft.requestMinIntervalMs,
      isActive: draft.isActive
    });

    await writeAuditLog({
      settingKey: "model_configs",
      action: "create",
      actor,
      value: serializePublicModel(model)
    });
    await bumpVersion();
    cache = null;
    return model;
  }

  async function setModelStatus(inputValue: {
    id: string;
    status: "active" | "paused";
    isActive?: boolean | undefined;
    actor?: string | null | undefined;
    action: string;
  }): Promise<RuntimeModelConfigPublic | null> {
    await ensureBootstrapped();
    if (inputValue.status === "active") {
      const existing = await input.repository.getModel(inputValue.id);
      if (!existing) {
        return null;
      }
      assertModelKeyRecoverable(existing);
    }
    const model = await input.repository.setModelStatus({
      id: inputValue.id,
      status: inputValue.status,
      isActive: inputValue.isActive
    });

    if (!model) {
      return null;
    }

    await writeAuditLog({
      settingKey: "model_configs",
      action: inputValue.action,
      actor: inputValue.actor,
      value: serializePublicModel(model)
    });
    await bumpVersion();
    cache = null;
    return serializePublicModel(model);
  }

  return {
    ensureBootstrapped,
    getSnapshot,
    async getCurrentRevision() {
      await ensureBootstrapped();
      const revision = await input.repository.getCurrentRevision();
      if (!revision) throw new Error("Runtime settings revision is unavailable");
      return revision;
    },
    async getMaintenanceRevision() {
      await ensureBootstrapped();
      return (await input.repository.getCurrentRevision())?.version ?? 0;
    },
    async getPublicSnapshot() {
      const snapshot = await getSnapshot();
      return {
        rateLimits: snapshot.rateLimits,
        worker: {
          sourceFileConcurrency: snapshot.worker.sourceFileConcurrency,
          s3Concurrency: snapshot.worker.sourceObjectReadConcurrency,
          jobMaxAttempts: snapshot.worker.jobMaxAttempts,
          jobRetryDelayMs: snapshot.worker.jobRetryDelayMs,
          completedJobRetentionDays: snapshot.worker.completedJobRetentionDays
        },
        generated: {
          directoryIndexMaxEntries: snapshot.generated.directoryIndexMaxEntries,
          directoryIndexMaxBytes: snapshot.generated.directoryIndexMaxBytes,
          rootSummaryLimit: snapshot.generated.rootSummaryLimit,
          okfLogMaxEntries: snapshot.generated.okfLogMaxEntries,
          okfLogMaxBytes: snapshot.generated.okfLogMaxBytes
        },
        graph: snapshot.graph,
        maintenance: snapshot.maintenance,
        semantic: snapshot.semantic,
        search: snapshot.search,
        activeModel: snapshot.activeModel ? serializePublicModel(snapshot.activeModel) : null
      };
    },
    async updateRateLimits({ value, actor }) {
      const issues = validateRateLimitSettings(value);
      if (issues.length > 0) {
        throw new RuntimeSettingsValidationError(issues);
      }
      return updateSetting(
        "rate_limits",
        sanitizeRateLimitSettings(value),
        actor,
        value
      );
    },
    async updateWorker({ value, actor }) {
      const issues = validateWorkerSettings(value);
      if (issues.length > 0) {
        throw new RuntimeSettingsValidationError(issues);
      }
      return updateSetting("worker", sanitizeWorkerSettings(value), actor, value);
    },
    async updateGenerated({ value, actor }) {
      const issues = validateGeneratedSettings(value);
      if (issues.length > 0) {
        throw new RuntimeSettingsValidationError(issues);
      }
      return updateSetting(
        "generated",
        sanitizeGeneratedSettings(value),
        actor,
        value
      );
    },
    async updateGraph({ value, actor }) {
      const issues = validateGraphSettings(value);
      if (issues.length > 0) {
        throw new RuntimeSettingsValidationError(issues);
      }
      return updateSetting("graph", sanitizeGraphSettings(value), actor, value);
    },
    async updateMaintenance({ value, actor }) {
      const issues = validateMaintenanceSettings(value);
      if (issues.length > 0) {
        throw new RuntimeSettingsValidationError(issues);
      }
      return updateSetting(
        "maintenance",
        sanitizeMaintenanceSettings(value),
        actor,
        value
      );
    },
    async updateSearch({ value, actor }) {
      const issues = validateSearchSettings(value);
      if (issues.length > 0) {
        throw new RuntimeSettingsValidationError(issues);
      }
      return updateSetting("search", sanitizeSearchSettings(value), actor, value);
    },
    async updateSemantic({ value, actor }) {
      const issues = validateSemanticSettings(value);
      if (issues.length > 0) {
        throw new RuntimeSettingsValidationError(issues);
      }
      return updateSetting(
        "semantic",
        sanitizeSemanticSettings(value),
        actor,
        value
      );
    },
    async listModels() {
      await ensureBootstrapped();
      const models = await input.repository.listModels();
      return models.map(serializePublicModel);
    },
    async createModel(modelInput) {
      await ensureBootstrapped();
      if (modelInput.isActive) {
        await validateActiveModelCapacity(modelInput.suggestionConcurrency);
      }
      const model = await createModelInternal(modelInput, modelInput.actor);
      return serializePublicModel(model);
    },
    async updateModel({ id, value, actor }) {
      await ensureBootstrapped();
      const existing = await input.repository.getModel(id);
      if (!existing || existing.status === "deleted") return null;
      const existingApiKey = tryDecryptRuntimeModel(existing, deploymentSecret);
      if (!existingApiKey) {
        throw new RuntimeSettingsValidationError([{
          field: "model",
          message: "model api key is unrecoverable"
        }]);
      }
      if (
        value.apiKey !== undefined
        && value.apiKey !== null
        && typeof value.apiKey !== "string"
      ) {
        throw new RuntimeSettingsValidationError([{
          field: "apiKey",
          message: "apiKey is required"
        }]);
      }
      const replacementApiKey = typeof value.apiKey === "string"
        ? value.apiKey.trim() || null
        : null;
      const draft: RuntimeModelConfigDraft = {
        displayName: value.displayName === undefined ? existing.displayName : value.displayName,
        apiMode: value.apiMode === undefined ? existing.apiMode : value.apiMode,
        baseUrl: value.baseUrl === undefined ? existing.baseUrl : value.baseUrl,
        apiKey: replacementApiKey ?? existingApiKey,
        modelName: value.modelName === undefined ? existing.modelName : value.modelName,
        contextWindowTokens: value.contextWindowTokens === undefined
          ? existing.contextWindowTokens
          : value.contextWindowTokens,
        requestMaxTimeoutMs: value.requestMaxTimeoutMs === undefined
          ? existing.requestMaxTimeoutMs
          : value.requestMaxTimeoutMs,
        requestIdleTimeoutMs: value.requestIdleTimeoutMs === undefined
          ? existing.requestIdleTimeoutMs
          : value.requestIdleTimeoutMs,
        suggestionConcurrency: value.suggestionConcurrency === undefined
          ? existing.suggestionConcurrency
          : value.suggestionConcurrency,
        transientRetryDelayMs:
          value.transientRetryDelayMs === undefined
            ? existing.transientRetryDelayMs
            : value.transientRetryDelayMs,
        requestMinIntervalMs: value.requestMinIntervalMs === undefined
          ? existing.requestMinIntervalMs
          : value.requestMinIntervalMs,
        isActive: existing.isActive
      };
      const issues = validateModelDraft(draft);
      if (issues.length > 0) throw new RuntimeSettingsValidationError(issues);
      if (existing.isActive) {
        await validateActiveModelCapacity(draft.suggestionConcurrency);
      }
      const updated = await input.repository.updateModel({
        id,
        displayName: draft.displayName.trim(),
        apiMode: normalizeModelApiMode(draft.apiMode),
        baseUrl: draft.baseUrl.trim(),
        encryptedApiKey: replacementApiKey
          ? encryptRuntimeSecret({ value: replacementApiKey, secret: deploymentSecret })
          : existing.apiKey,
        apiKeyFingerprint: replacementApiKey
          ? fingerprintRuntimeSecret(replacementApiKey)
          : existing.apiKeyFingerprint,
        modelName: draft.modelName.trim(),
        contextWindowTokens: draft.contextWindowTokens,
        requestMaxTimeoutMs: draft.requestMaxTimeoutMs,
        requestIdleTimeoutMs: draft.requestIdleTimeoutMs,
        suggestionConcurrency: draft.suggestionConcurrency,
        transientRetryDelayMs: draft.transientRetryDelayMs,
        requestMinIntervalMs: draft.requestMinIntervalMs
      });
      if (!updated) return null;
      await writeAuditLog({
        settingKey: "model_configs",
        action: "update",
        actor,
        value: serializePublicModel(updated)
      });
      await bumpVersion();
      cache = null;
      return serializePublicModel(updated);
    },
    async activateModel({ id, actor }) {
      await ensureBootstrapped();
      const existing = await input.repository.getModel(id);
      if (!existing) {
        return null;
      }
      assertModelKeyRecoverable(existing);
      await validateActiveModelCapacity(existing.suggestionConcurrency);
      const model = await input.repository.setActiveModel(id);
      if (!model) {
        return null;
      }
      await writeAuditLog({
        settingKey: "model_configs",
        action: "activate",
        actor,
        value: serializePublicModel(model)
      });
      await bumpVersion();
      cache = null;
      return serializePublicModel(model);
    },
    async pauseModel({ id, actor }) {
      await ensureBootstrapped();
      const existing = await input.repository.getModel(id);
      if (!existing) return null;
      return setModelStatus({ id, status: "paused", isActive: false, actor, action: "pause" });
    },
    async resumeModel({ id, actor }) {
      return setModelStatus({ id, status: "active", isActive: false, actor, action: "resume" });
    },
    async deleteModel({ id, actor }) {
      await ensureBootstrapped();
      const existing = await input.repository.getModel(id);

      if (!existing) {
        return null;
      }

      const runningCount = await input.repository.countRunningModelInvocations(id);
      if (runningCount > 0) {
        throw new RuntimeSettingsValidationError([
          {
            field: "model",
            message: "model has running work"
          }
        ]);
      }

      const model = await input.repository.softDeleteModel(id);

      if (!model) {
        return null;
      }

      await writeAuditLog({
        settingKey: "model_configs",
        action: "delete",
        actor,
        value: serializePublicModel(model)
      });
      await bumpVersion();
      cache = null;
      return serializePublicModel(model);
    }
  };

  async function readVersion(): Promise<string> {
    return (await input.redis?.getRuntimeSettingsVersion?.()) ?? "local";
  }

  async function bumpVersion(): Promise<void> {
    await input.redis?.setRuntimeSettingsVersion?.(`${Date.now()}-${randomUUID()}`);
  }

  async function validateModelKeyProtection(): Promise<void> {
    const models = await input.repository.listModels();

    for (const model of models) {
      const current = tryDecryptRuntimeModel(model, deploymentSecret);
      if (current) {
        continue;
      }

      if (model.status === "active" || model.isActive) {
        await input.repository.setModelStatus({
          id: model.id,
          status: "paused",
          isActive: false
        });
        await writeAuditLog({
          settingKey: "model_configs",
          action: "pause_unrecoverable_key",
          actor: "bootstrap",
          value: serializePublicModel({
            ...model,
            status: "paused",
            isActive: false
          })
        });
      }
    }
  }

  function tryDecryptModel(model: RuntimeModelConfigPrivate): RuntimeModelConfigPrivate | null {
    const apiKey = tryDecryptRuntimeModel(model, deploymentSecret);

    if (!apiKey) {
      return null;
    }

    return {
      ...model,
      apiKey
    };
  }

  function assertModelKeyRecoverable(model: RuntimeModelConfigPrivate): void {
    if (tryDecryptModel(model)) {
      return;
    }

    throw new RuntimeSettingsValidationError([
      {
        field: "model",
        message: "model api key is unrecoverable"
      }
    ]);
  }
}

function withUpdatedSetting<TValue>(
  snapshot: RuntimeSettingsSnapshot,
  key: RuntimeSettingKey,
  value: TValue
): RuntimeSettingsSnapshot {
  if (key === "rate_limits") return { ...snapshot, rateLimits: value as never };
  return { ...snapshot, [key]: value } as RuntimeSettingsSnapshot;
}

function normalizeModelApiMode(value: ModelApiMode | undefined): ModelApiMode {
  return modelApiModeValues().includes(value as never) ? (value as ModelApiMode) : "responses";
}

function tryDecryptRuntimeModel(model: RuntimeModelConfigPrivate, secret: string): string | null {
  try {
    return decryptRuntimeSecret({
      value: model.apiKey,
      secret
    });
  } catch {
    return null;
  }
}

function redactSettingValue(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }

  if ("apiKey" in value) {
    return {
      ...value,
      apiKey: "<redacted>"
    };
  }

  return value;
}

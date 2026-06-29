import type { RuntimeConfig } from "../config.js";
import type { RedisCoordinator } from "../redis/coordination.js";
import { loadDeploymentSecret, readLegacyRuntimeSecret } from "../security/runtime-secrets.js";
import {
  decryptRuntimeSecret,
  encryptRuntimeSecret,
  fingerprintRuntimeSecret
} from "./encryption.js";
import type { RuntimeSettingsRepository } from "./repository.js";
import {
  modelApiModeValues,
  RuntimeSettingsValidationError,
  serializePublicModel,
  type ModelApiMode,
  type RuntimeModelConfigDraft,
  type RuntimeModelConfigPrivate,
  type RuntimeModelConfigPublic,
  type RuntimePublicationSettings,
  type RuntimeRateLimitSettings,
  type RuntimeSettingKey,
  type RuntimeSettingsSnapshot,
  type RuntimeUploadGenerationSettings
} from "./types.js";
import {
  createRuntimeSettingsDefaults,
  sanitizePublicationSettings,
  sanitizeRateLimitSettings,
  sanitizeUploadGenerationSettings,
  sanitizeWorkerSettings,
  validateModelDraft,
  validatePublicationSettings,
  validateRateLimitSettings,
  validateUploadGenerationSettings,
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
  getPublicSnapshot: () => Promise<{
    rateLimits: RuntimeRateLimitSettings;
    worker: RuntimeSettingsSnapshot["worker"];
    publication: RuntimePublicationSettings;
    uploadGeneration: RuntimeUploadGenerationSettings;
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
  updatePublication: (input: {
    value: RuntimePublicationSettings;
    actor?: string | null | undefined;
  }) => Promise<RuntimeSettingsSnapshot>;
  updateUploadGeneration: (input: {
    value: RuntimeUploadGenerationSettings;
    actor?: string | null | undefined;
  }) => Promise<RuntimeSettingsSnapshot>;
  listModels: () => Promise<RuntimeModelConfigPublic[]>;
  createModel: (input: RuntimeModelConfigDraft & { actor?: string | null | undefined }) => Promise<RuntimeModelConfigPublic>;
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
}): RuntimeSettingsService {
  const defaults = createRuntimeSettingsDefaults(input.config);
  const deploymentSecret = loadDeploymentSecret({
    directory: input.deploymentSecretDirectory
  });
  const legacySecret = readLegacyRuntimeSecret();
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
    if (!existingKeys.has("publication")) {
      await input.repository.upsertSetting({
        key: "publication",
        value: defaults.publication,
        source: "bootstrap"
      });
    }
    if (!existingKeys.has("upload_generation")) {
      await input.repository.upsertSetting({
        key: "upload_generation",
        value: defaults.uploadGeneration,
        source: "bootstrap"
      });
    }

    const models = await input.repository.listModels();
    if (models.length === 0 && defaults.model) {
      await createModelInternal(defaults.model, "bootstrap");
    }
    await migrateModelKeyProtection();

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
      publicationRecord,
      uploadGenerationRecord,
      model
    ] = await Promise.all([
      input.repository.getSetting("rate_limits"),
      input.repository.getSetting("worker"),
      input.repository.getSetting("publication"),
      input.repository.getSetting("upload_generation"),
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
      publication: sanitizePublicationSettings(
        (publicationRecord?.value ?? defaults.publication) as RuntimePublicationSettings
      ),
      uploadGeneration: sanitizeUploadGenerationSettings(
        {
          ...defaults.uploadGeneration,
          ...(uploadGenerationRecord?.value ?? {})
        } as RuntimeUploadGenerationSettings
      ),
      activeModel: model ? tryDecryptModel(model) : null
    };

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
    actor: string | null | undefined
  ): Promise<RuntimeSettingsSnapshot> {
    await ensureBootstrapped();
    await input.repository.upsertSetting({
      key,
      value,
      source: "admin"
    });
    await input.repository.createAuditLog({
      settingKey: key,
      action: "update",
      actor,
      value: redactSettingValue(value)
    });
    await bumpVersion();
    cache = null;
    return getSnapshot();
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

    await input.repository.createAuditLog({
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

    await input.repository.createAuditLog({
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
    async getPublicSnapshot() {
      const snapshot = await getSnapshot();
      return {
        rateLimits: snapshot.rateLimits,
        worker: snapshot.worker,
        publication: snapshot.publication,
        uploadGeneration: snapshot.uploadGeneration,
        activeModel: snapshot.activeModel ? serializePublicModel(snapshot.activeModel) : null
      };
    },
    async updateRateLimits({ value, actor }) {
      const issues = validateRateLimitSettings(value);
      if (issues.length > 0) {
        throw new RuntimeSettingsValidationError(issues);
      }
      return updateSetting("rate_limits", sanitizeRateLimitSettings(value), actor);
    },
    async updateWorker({ value, actor }) {
      const issues = validateWorkerSettings(value);
      if (issues.length > 0) {
        throw new RuntimeSettingsValidationError(issues);
      }
      return updateSetting("worker", sanitizeWorkerSettings(value), actor);
    },
    async updatePublication({ value, actor }) {
      const issues = validatePublicationSettings(value);
      if (issues.length > 0) {
        throw new RuntimeSettingsValidationError(issues);
      }
      return updateSetting("publication", sanitizePublicationSettings(value), actor);
    },
    async updateUploadGeneration({ value, actor }) {
      const issues = validateUploadGenerationSettings(value);
      if (issues.length > 0) {
        throw new RuntimeSettingsValidationError(issues);
      }
      return updateSetting("upload_generation", sanitizeUploadGenerationSettings(value), actor);
    },
    async listModels() {
      await ensureBootstrapped();
      const models = await input.repository.listModels();
      return models.map(serializePublicModel);
    },
    async createModel(modelInput) {
      const model = await createModelInternal(modelInput, modelInput.actor);
      return serializePublicModel(model);
    },
    async activateModel({ id, actor }) {
      await ensureBootstrapped();
      const existing = await input.repository.getModel(id);
      if (!existing) {
        return null;
      }
      assertModelKeyRecoverable(existing);
      const model = await input.repository.setActiveModel(id);
      if (!model) {
        return null;
      }
      await input.repository.createAuditLog({
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
      const runningSourceFileJobCount = existing.isActive
        ? await input.repository.countRunningSourceFileJobs()
        : 0;

      if (runningCount > 0 || runningSourceFileJobCount > 0) {
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

      await input.repository.createAuditLog({
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
    await input.redis?.setRuntimeSettingsVersion?.(`${Date.now()}`);
  }

  async function migrateModelKeyProtection(): Promise<void> {
    const models = await input.repository.listModels();

    for (const model of models) {
      const current = tryDecryptRuntimeModel(model, deploymentSecret);
      if (current) {
        continue;
      }

      const legacy = legacySecret ? tryDecryptRuntimeModel(model, legacySecret) : null;
      if (!legacy) {
        if (model.status === "active" || model.isActive) {
          await input.repository.setModelStatus({
            id: model.id,
            status: "paused",
            isActive: false
          });
          await input.repository.createAuditLog({
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
        continue;
      }

      await input.repository.updateModelApiKeyProtection({
        id: model.id,
        encryptedApiKey: encryptRuntimeSecret({
          value: legacy,
          secret: deploymentSecret
        }),
        apiKeyFingerprint: fingerprintRuntimeSecret(legacy)
      });
    }
  }

  function tryDecryptModel(model: RuntimeModelConfigPrivate): RuntimeModelConfigPrivate | null {
    const apiKey =
      tryDecryptRuntimeModel(model, deploymentSecret) ??
      (legacySecret ? tryDecryptRuntimeModel(model, legacySecret) : null);

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

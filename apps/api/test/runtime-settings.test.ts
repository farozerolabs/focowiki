import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig } from "../src/config.js";
import { createApiApp } from "../src/server.js";
import type { RuntimeSettingsRepository } from "../src/runtime-settings/repository.js";
import { createRuntimeSettingsService } from "../src/runtime-settings/service.js";
import type {
  ModelConfigStatus,
  RuntimeModelConfigPrivate,
  RuntimeSettingKey,
  RuntimeSettingRecord,
  RuntimeSettingsSnapshot
} from "../src/runtime-settings/types.js";
import {
  createTestRedisCoordinator,
  loginAndReadSessionCookie,
  withTrustedAdminOrigin
} from "./support/session.js";
import {
  encryptRuntimeSecret,
  fingerprintRuntimeSecret
} from "../src/runtime-settings/encryption.js";

describe("runtime settings service", () => {
  it("bootstraps settings and keeps model assistance optional", async () => {
    const service = createRuntimeSettingsService({
      config: createConfig({ modelEnabled: false }),
      repository: new MemoryRuntimeSettingsRepository(),
      redis: createTestRedisCoordinator(),
      deploymentSecretDirectory: createRuntimeSecretDirectory()
    });

    const snapshot = await service.getSnapshot();

    expect(snapshot.worker.sourceFileConcurrency).toBe(2);
    expect(snapshot.worker.hardDeleteConcurrency).toBe(1);
    expect(snapshot.worker.hardDeleteObjectBatchSize).toBe(1_000);
    expect(snapshot.worker.hardDeleteVersionPurgeEnabled).toBe(false);
    expect(snapshot.worker).not.toHaveProperty("databasePoolMax");
    expect(snapshot.rateLimits.publicOpenApi.max).toBe(1_200);
    expect(snapshot.uploadGeneration).toEqual({
      maxBytes: 1_048_576,
      sessionTtlSeconds: 86_400,
      manifestPageSize: 500,
      contentBatchMaxFiles: 24,
      contentBatchMaxBytes: 16_777_216,
      generationBatchSize: 50,
      fileProcessingConcurrency: 1
    });
    expect(snapshot.activeModel).toBeNull();
  });

  it("keeps saved upload-generation settings ahead of stale env defaults", async () => {
    const repository = new MemoryRuntimeSettingsRepository();
    await repository.upsertSetting({
      key: "upload_generation",
      value: {
        maxBytes: 512,
        generationBatchSize: 3,
        fileProcessingConcurrency: 1
      },
      source: "admin"
    });
    const service = createRuntimeSettingsService({
      config: createConfig({
        modelEnabled: false,
        upload: {
          maxBytes: 9_999,
          generationBatchSize: 88,
          fileProcessingConcurrency: 7
        }
      }),
      repository,
      redis: createTestRedisCoordinator(),
      deploymentSecretDirectory: createRuntimeSecretDirectory()
    });

    const snapshot = await service.getSnapshot();

    expect(snapshot.uploadGeneration).toEqual({
      maxBytes: 512,
      sessionTtlSeconds: 86_400,
      manifestPageSize: 500,
      contentBatchMaxFiles: 24,
      contentBatchMaxBytes: 16_777_216,
      generationBatchSize: 3,
      fileProcessingConcurrency: 1
    });
  });

  it("creates a model without exposing the raw key and blocks deleting a running model", async () => {
    const repository = new MemoryRuntimeSettingsRepository();
    repository.runningSourceFileJobCount = 1;
    const service = createRuntimeSettingsService({
      config: createConfig({ modelEnabled: false }),
      repository,
      redis: createTestRedisCoordinator(),
      deploymentSecretDirectory: createRuntimeSecretDirectory()
    });

    const model = await service.createModel({
      displayName: "OpenAI production",
      apiMode: "chat_completions",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test-secret",
      modelName: "gpt-test",
      contextWindowTokens: 200_000,
      requestMaxTimeoutMs: 600_000,
      requestIdleTimeoutMs: 120_000,
      suggestionConcurrency: 2,
      transientRetryDelayMs: 60_000,
      requestMinIntervalMs: 2_000,
      isActive: true
    });

    expect(JSON.stringify(model)).not.toContain("sk-test-secret");
    expect(model.apiMode).toBe("chat_completions");
    await expect(service.deleteModel({ id: model.id })).rejects.toMatchObject({
      code: "RUNTIME_SETTINGS_VALIDATION_FAILED"
    });
    repository.runningSourceFileJobCount = 0;
    repository.runningModelInvocationCount = 1;
    await expect(service.deleteModel({ id: model.id })).rejects.toMatchObject({
      code: "RUNTIME_SETTINGS_VALIDATION_FAILED"
    });
    repository.runningModelInvocationCount = 0;
    await expect(service.deleteModel({ id: model.id })).resolves.toMatchObject({
      id: model.id,
      status: "deleted"
    });
  });

  it("keeps saved model keys usable after service recreation", async () => {
    const runtimeSecretDirectory = join(
      tmpdir(),
      "focowiki-runtime-settings-test",
      randomUUID()
    );
    const repository = new MemoryRuntimeSettingsRepository();
    const config = createConfig({ modelEnabled: false });
    const firstService = createRuntimeSettingsService({
      config,
      repository,
      redis: createTestRedisCoordinator(),
      deploymentSecretDirectory: runtimeSecretDirectory
    });
    await firstService.createModel({
      displayName: "OpenAI production",
      apiMode: "responses",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-restart-secret",
      modelName: "gpt-test",
      contextWindowTokens: 200_000,
      requestMaxTimeoutMs: 600_000,
      requestIdleTimeoutMs: 120_000,
      suggestionConcurrency: 2,
      transientRetryDelayMs: 60_000,
      requestMinIntervalMs: 2_000,
      isActive: true
    });

    const secondService = createRuntimeSettingsService({
      config,
      repository,
      redis: createTestRedisCoordinator(),
      deploymentSecretDirectory: runtimeSecretDirectory
    });
    const snapshot = await secondService.getSnapshot();

    expect(snapshot.activeModel?.apiKey).toBe("sk-restart-secret");
  });

  it("rejects activating or resuming models whose key cannot be recovered", async () => {
    const repository = new MemoryRuntimeSettingsRepository();
    const now = new Date().toISOString();
    repository.models.set("model-unrecoverable", {
      id: "model-unrecoverable",
      displayName: "Unrecoverable model",
      apiMode: "responses",
      baseUrl: "https://api.openai.com/v1",
      apiKey: encryptRuntimeSecret({
        value: "sk-lost-secret",
        secret: "different-deployment-secret"
      }),
      apiKeyFingerprint: fingerprintRuntimeSecret("sk-lost-secret"),
      modelName: "gpt-test",
      contextWindowTokens: 200_000,
      requestMaxTimeoutMs: 600_000,
      requestIdleTimeoutMs: 120_000,
      suggestionConcurrency: 2,
      transientRetryDelayMs: 60_000,
      requestMinIntervalMs: 2_000,
      status: "paused",
      isActive: false,
      createdAt: now,
      updatedAt: now,
      deletedAt: null
    });
    const service = createRuntimeSettingsService({
      config: createConfig({ modelEnabled: false }),
      repository,
      redis: createTestRedisCoordinator(),
      deploymentSecretDirectory: createRuntimeSecretDirectory()
    });

    await expect(service.resumeModel({ id: "model-unrecoverable" })).rejects.toMatchObject({
      code: "RUNTIME_SETTINGS_VALIDATION_FAILED",
      issues: [
        {
          field: "model",
          message: "model api key is unrecoverable"
        }
      ]
    });
    await expect(service.activateModel({ id: "model-unrecoverable" })).rejects.toMatchObject({
      code: "RUNTIME_SETTINGS_VALIDATION_FAILED"
    });
    expect(repository.models.get("model-unrecoverable")).toMatchObject({
      status: "paused",
      isActive: false
    });
  });

  it("serves runtime settings through authenticated Admin API routes", async () => {
    const runtimeSettings = new MemoryRuntimeSettingsRepository();
    const redis = createTestRedisCoordinator();
    const config = createConfig({ modelEnabled: false });
    const app = createApiApp({
      config,
      redis,
      runtimeSettings: createRuntimeSettingsService({
        config,
        repository: runtimeSettings,
        redis,
        deploymentSecretDirectory: createRuntimeSecretDirectory()
      }),
      repositories: {
        runtimeSettings,
        knowledgeBases: {
          async listKnowledgeBases() {
            return { items: [], nextCursor: null };
          },
          async createKnowledgeBase() {
            throw new Error("Not used by runtime settings tests");
          },
          async getKnowledgeBase() {
            return null;
          }
        }
      }
    });
    const cookie = await loginAndReadSessionCookie(app);
    const initial = await app.request("/admin/api/settings/runtime", {
      headers: { cookie }
    });
    const invalid = await app.request("/admin/api/settings/worker", {
      method: "PUT",
      headers: withTrustedAdminOrigin({
        cookie,
        "content-type": "application/json"
      }),
      body: JSON.stringify({
        sourceFileConcurrency: 0
      })
    });

    expect(initial.status).toBe(200);
    const initialBody = (await initial.json()) as {
      settings: RuntimeSettingsSnapshot;
      models: unknown[];
    };
    expect(initialBody).toMatchObject({
      settings: {
        activeModel: null,
        uploadGeneration: {
          maxBytes: 1_048_576,
          generationBatchSize: 50,
          fileProcessingConcurrency: 1
        }
      },
      models: []
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({
      error: {
        code: "RUNTIME_SETTINGS_VALIDATION_FAILED",
        messageKey: "errors.runtimeSettingsValidationFailed"
      }
    });

    const invalidHardDeleteBatch = await app.request("/admin/api/settings/worker", {
      method: "PUT",
      headers: withTrustedAdminOrigin({
        cookie,
        "content-type": "application/json"
      }),
      body: JSON.stringify({
        sourceFileConcurrency: 2,
        claimBatchSize: 10,
        pollIntervalMs: 1_000,
        lockTtlSeconds: 900,
        heartbeatIntervalMs: 15_000,
        jobMaxAttempts: 3,
        jobRetryDelayMs: 30_000,
        queueBackpressureLimit: 5_000,
        queueBackpressureKnowledgeBaseLimit: 2_000,
        queueBackpressureMaxAgeSeconds: 3_600,
        queueBackpressureRetryAfterSeconds: 60,
        shutdownGraceMs: 30_000,
        completedJobRetentionDays: 7,
        failedJobRetentionDays: 30,
        deadLetterJobRetentionDays: 90,
        retentionCleanupBatchSize: 1_000,
        hardDeleteConcurrency: 1,
        hardDeleteDatabaseBatchSize: 1_000,
        hardDeleteObjectBatchSize: 1_001,
        hardDeleteMaxAttempts: 3,
        hardDeleteRetryDelayMs: 60_000,
        hardDeleteFailedRetentionDays: 30,
        hardDeleteVersionPurgeEnabled: false
      })
    });
    expect(invalidHardDeleteBatch.status).toBe(400);
    await expect(invalidHardDeleteBatch.json()).resolves.toMatchObject({
      error: {
        code: "RUNTIME_SETTINGS_VALIDATION_FAILED",
        messageKey: "errors.runtimeSettingsValidationFailed"
      }
    });

    const invalidUploadGeneration = await app.request("/admin/api/settings/upload-generation", {
      method: "PUT",
      headers: withTrustedAdminOrigin({
        cookie,
        "content-type": "application/json"
      }),
      body: JSON.stringify({
        maxBytes: 0,
        sessionTtlSeconds: 86_400,
        manifestPageSize: 500,
        contentBatchMaxFiles: 24,
        contentBatchMaxBytes: 16_777_216,
        generationBatchSize: 3,
        fileProcessingConcurrency: 1
      })
    });
    expect(invalidUploadGeneration.status).toBe(400);
    await expect(invalidUploadGeneration.json()).resolves.toMatchObject({
      error: {
        code: "RUNTIME_SETTINGS_VALIDATION_FAILED",
        messageKey: "errors.runtimeSettingsValidationFailed"
      }
    });

    const validUploadGeneration = await app.request("/admin/api/settings/upload-generation", {
      method: "PUT",
      headers: withTrustedAdminOrigin({
        cookie,
        "content-type": "application/json"
      }),
      body: JSON.stringify({
        maxBytes: 2_097_152,
        sessionTtlSeconds: 86_400,
        manifestPageSize: 500,
        contentBatchMaxFiles: 12,
        contentBatchMaxBytes: 16_777_216,
        generationBatchSize: 80,
        fileProcessingConcurrency: 1
      })
    });
    expect(validUploadGeneration.status).toBe(200);
    await expect(validUploadGeneration.json()).resolves.toMatchObject({
      settings: {
        uploadGeneration: {
          maxBytes: 2_097_152,
          sessionTtlSeconds: 86_400,
          manifestPageSize: 500,
          contentBatchMaxFiles: 12,
          contentBatchMaxBytes: 16_777_216,
          generationBatchSize: 80,
          fileProcessingConcurrency: 1
        }
      }
    });

    const validGraph = await app.request("/admin/api/settings/graph", {
      method: "PUT",
      headers: withTrustedAdminOrigin({
        cookie,
        "content-type": "application/json"
      }),
      body: JSON.stringify(initialBody.settings.graph)
    });

    expect(validGraph.status).toBe(200);
    await expect(validGraph.json()).resolves.toMatchObject({
      settings: {
        graph: initialBody.settings.graph
      }
    });
  });
});

function createConfig(input: {
  modelEnabled: boolean;
  upload?: RuntimeConfig["upload"];
}): RuntimeConfig {
  return {
    admin: {
      username: "admin",
      password: "admin-secret",
    },
    database: {
      url: "postgres://focowiki:focowiki@127.0.0.1:5432/focowiki"
    },
    redis: {
      url: "redis://127.0.0.1:6379/0"
    },
    ports: {
      adminApi: 43_000,
      adminUi: 43_100,
      publicOpenApi: 43_200
    },
    publicApi: {
      baseUrl: "https://kb.example.com"
    },
    storage: {
      endpoint: "https://s3.example.com",
      region: "us-east-1",
      bucket: "focowiki",
      accessKeyId: "s3-access",
      secretAccessKey: "s3-secret",
      prefix: "tenant/demo",
      forcePathStyle: true
    },
    upload: input.upload ?? {
      maxBytes: 1_048_576,
      generationBatchSize: 50,
      fileProcessingConcurrency: 1
    },
    publication: {
      mode: "batch",
      batchSize: 300,
      intervalSeconds: 300,
      indexShardSize: 1_000,
      linkIndexShardSize: 1_000,
      manifestShardSize: 1_000,
      graphEdgeShardSize: 5_000,
      graphCandidateLimit: 200,
      graphMaintenanceBatchSize: 500,
      rootSummaryLimit: 500
    },
    pagination: {
      defaultPageSize: 50,
      maxPageSize: 200,
      treeDefaultPageSize: 100,
      treeMaxPageSize: 500,
      cursorTtlSeconds: 900,
      generatedContentMaxBytes: 10_485_760
    },
    worker: {
      sourceFileConcurrency: 2,
      claimBatchSize: 10,
      pollIntervalMs: 1_000,
      lockTtlSeconds: 900,
      jobMaxAttempts: 3,
      jobRetryDelayMs: 30_000,
      queueBackpressureLimit: 5_000,
      shutdownGraceMs: 30_000,
      hardDeleteConcurrency: 1,
      hardDeleteDatabaseBatchSize: 1_000,
      hardDeleteObjectBatchSize: 1_000,
      hardDeleteMaxAttempts: 3,
      hardDeleteRetryDelayMs: 60_000,
      hardDeleteFailedRetentionDays: 30,
      hardDeleteVersionPurgeEnabled: false
    },
    model: input.modelEnabled
      ? {
          enabled: true,
          apiKey: "sk-env-secret",
          modelName: "gpt-env",
          baseUrl: "https://api.openai.com/v1",
          contextWindowTokens: 200_000,
          requestMaxTimeoutMs: 600_000,
          requestIdleTimeoutMs: 120_000,
          suggestionConcurrency: 2,
          transientRetryDelayMs: 60_000,
          requestMinIntervalMs: 2_000
        }
      : {
          enabled: false
        },
    corsOrigins: []
  };
}

function createRuntimeSecretDirectory(): string {
  return join(tmpdir(), "focowiki-runtime-settings-test", randomUUID());
}

class MemoryRuntimeSettingsRepository implements RuntimeSettingsRepository {
  public readonly settings = new Map<RuntimeSettingKey, RuntimeSettingRecord>();
  public readonly models = new Map<string, RuntimeModelConfigPrivate>();
  public runningModelInvocationCount = 0;
  public runningSourceFileJobCount = 0;

  public async listSettings() {
    return [...this.settings.values()];
  }

  public async getSetting(key: RuntimeSettingKey) {
    return this.settings.get(key) ?? null;
  }

  public async upsertSetting(input: {
    key: RuntimeSettingKey;
    value: unknown;
    source: "bootstrap" | "admin";
  }) {
    const now = new Date().toISOString();
    const existing = this.settings.get(input.key);
    const record: RuntimeSettingRecord = {
      key: input.key,
      value: input.value,
      source: input.source,
      version: (existing?.version ?? 0) + 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    this.settings.set(input.key, record);
    return record;
  }

  public async createAuditLog() {
    return;
  }

  public async listModels() {
    return [...this.models.values()].filter((model) => model.status !== "deleted");
  }

  public async getModel(id: string) {
    return this.models.get(id) ?? null;
  }

  public async getActiveModel() {
    return (
      [...this.models.values()].find(
        (model) => model.isActive && model.status === "active" && !model.deletedAt
      ) ?? null
    );
  }

  public async createModel(input: {
    displayName: string;
    apiMode: RuntimeModelConfigPrivate["apiMode"];
    baseUrl: string;
    encryptedApiKey: string;
    apiKeyFingerprint: string;
    modelName: string;
    contextWindowTokens: number;
    requestMaxTimeoutMs: number;
    requestIdleTimeoutMs: number;
    suggestionConcurrency: number;
    transientRetryDelayMs: number;
    requestMinIntervalMs: number;
    isActive: boolean;
  }) {
    const now = new Date().toISOString();
    const model: RuntimeModelConfigPrivate = {
      id: `model-${this.models.size + 1}`,
      displayName: input.displayName,
      apiMode: input.apiMode,
      baseUrl: input.baseUrl,
      apiKey: input.encryptedApiKey,
      apiKeyFingerprint: input.apiKeyFingerprint,
      modelName: input.modelName,
      contextWindowTokens: input.contextWindowTokens,
      requestMaxTimeoutMs: input.requestMaxTimeoutMs,
      requestIdleTimeoutMs: input.requestIdleTimeoutMs,
      suggestionConcurrency: input.suggestionConcurrency,
      transientRetryDelayMs: input.transientRetryDelayMs,
      requestMinIntervalMs: input.requestMinIntervalMs,
      status: "active",
      isActive: input.isActive,
      createdAt: now,
      updatedAt: now,
      deletedAt: null
    };
    this.models.set(model.id, model);
    return model;
  }

  public async setModelStatus(input: {
    id: string;
    status: Exclude<ModelConfigStatus, "deleted">;
    isActive?: boolean | undefined;
  }) {
    const model = this.models.get(input.id);
    if (!model) {
      return null;
    }
    model.status = input.status;
    model.isActive = input.isActive ?? false;
    return model;
  }

  public async setActiveModel(id: string) {
    const model = this.models.get(id);
    if (!model) {
      return null;
    }
    for (const current of this.models.values()) {
      current.isActive = false;
    }
    model.isActive = true;
    model.status = "active";
    return model;
  }

  public async softDeleteModel(id: string) {
    const model = this.models.get(id);
    if (!model) {
      return null;
    }
    model.status = "deleted";
    model.isActive = false;
    model.deletedAt = new Date().toISOString();
    return model;
  }

  public async countRunningModelInvocations() {
    return this.runningModelInvocationCount;
  }

  public async countRunningSourceFileJobs() {
    return this.runningSourceFileJobCount;
  }
}

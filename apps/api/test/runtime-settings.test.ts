import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig } from "../src/config.js";
import { createApiApp } from "../src/server.js";
import type { RuntimeSettingsRepository } from "../src/runtime-settings/repository.js";
import {
  createRuntimeSettingsService,
  type RuntimeSettingsService
} from "../src/runtime-settings/service.js";
import type {
  ModelConfigStatus,
  RuntimeModelConfigDraft,
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
import { validateModelDraft } from "../src/runtime-settings/validation.js";

function generationModelDraft(): RuntimeModelConfigDraft {
  return {
    displayName: "Generation model",
    apiMode: "responses",
    baseUrl: "https://generation.example/v1",
    apiKey: "generation-secret",
    modelName: "generation-model",
    contextWindowTokens: 128_000,
    requestMaxTimeoutMs: 300_000,
    requestIdleTimeoutMs: 60_000,
    suggestionConcurrency: 2,
    transientRetryDelayMs: 1_000,
    requestMinIntervalMs: 0,
    isActive: true
  };
}

describe("generation model configuration field contract", () => {
  it("accepts supported API modes, URLs, boolean states, and numeric minima", () => {
    expect(validateModelDraft(generationModelDraft())).toEqual([]);
    expect(validateModelDraft({
      ...generationModelDraft(), apiMode: undefined, isActive: false
    })).toEqual([]);
    expect(validateModelDraft({
      ...generationModelDraft(), apiMode: "chat_completions", baseUrl: "http://127.0.0.1:11434/v1"
    })).toEqual([]);
  });

  it.each([
    ["contextWindowTokens", 1, 0],
    ["requestMaxTimeoutMs", 1, 0],
    ["requestIdleTimeoutMs", 1, 0],
    ["suggestionConcurrency", 1, 0],
    ["transientRetryDelayMs", 1, 0],
    ["requestMinIntervalMs", 0, -1]
  ] as const)("validates every %s numeric boundary", (field, minimum, below) => {
    expect(validateModelDraft({
      ...generationModelDraft(), [field]: minimum
    })).toEqual([]);
    expect(validateModelDraft({
      ...generationModelDraft(), [field]: Number.MAX_SAFE_INTEGER
    })).toEqual([]);
    for (const value of [below, 1.5, "1", null, undefined]) {
      expect(validateModelDraft({
        ...generationModelDraft(), [field]: value
      } as unknown as RuntimeModelConfigDraft)).toContainEqual(
        expect.objectContaining({ field })
      );
    }
  });

  it("returns stable issues for every required text, URL, mode, and active field", () => {
    for (const field of ["displayName", "baseUrl", "apiKey", "modelName"] as const) {
      for (const value of [undefined, null, "", "   ", 42, {}]) {
        expect(validateModelDraft({
          ...generationModelDraft(), [field]: value
        } as unknown as RuntimeModelConfigDraft)).toContainEqual(
          expect.objectContaining({ field })
        );
      }
    }
    for (const value of [null, "completions", 42, {}]) {
      expect(validateModelDraft({
        ...generationModelDraft(), apiMode: value
      } as unknown as RuntimeModelConfigDraft)).toContainEqual(
        expect.objectContaining({ field: "apiMode" })
      );
    }
    for (const value of [undefined, null, "true", 1, {}]) {
      expect(validateModelDraft({
        ...generationModelDraft(), isActive: value
      } as unknown as RuntimeModelConfigDraft)).toContainEqual(
        expect.objectContaining({ field: "isActive" })
      );
    }
    for (const value of ["not-a-url", "ftp://example.com/model", 42, null]) {
      expect(validateModelDraft({
        ...generationModelDraft(), baseUrl: value
      } as unknown as RuntimeModelConfigDraft)).toContainEqual(
        expect.objectContaining({ field: "baseUrl" })
      );
    }
  });
});

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
    expect(snapshot.maintenance.hardDeleteConcurrency).toBe(1);
    expect(snapshot.maintenance.hardDeleteObjectBatchSize).toBe(1_000);
    expect(snapshot.worker).not.toHaveProperty("hardDeleteVersionPurgeEnabled");
    expect(snapshot.worker).not.toHaveProperty("databasePoolMax");
    expect(snapshot.rateLimits.publicOpenApi.max).toBe(1_200);
    expect(snapshot.rateLimits).not.toHaveProperty("upload");
    expect(snapshot).not.toHaveProperty("uploadGeneration");
    expect(snapshot.worker).toMatchObject({
      sourceFileConcurrency: 2,
      sourceObjectReadConcurrency: 40
    });
    await expect(service.getPublicSnapshot()).resolves.toMatchObject({
      worker: {
        sourceFileConcurrency: 2,
        s3Concurrency: 40
      }
    });
    expect(snapshot.generated).toMatchObject({
      directoryIndexMaxEntries: 200,
      directoryIndexMaxBytes: 65_536,
      rootSummaryLimit: 500,
      okfLogMaxEntries: 100,
      okfLogMaxBytes: 65_536
    });
    expect(snapshot.maintenance).toEqual({
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
    });
    expect(snapshot.search).toEqual({
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
    });
    expect(snapshot.semantic).toEqual({
      maximumChunkCharacters: 8_000,
      maximumChunks: 32,
      maximumEvidenceTargets: 64,
      graphRagAdapterTimeoutMs: 30_000,
      searchLaneCutoffMs: 2_500,
      queryEmbeddingConcurrency: 4,
      queryEmbeddingCacheEntries: 1_000
    });
    expect(snapshot.activeModel).toBeNull();
  });

  it("validates and hot-reloads every semantic settings field as one revision", async () => {
    const repository = new MemoryRuntimeSettingsRepository();
    const service = createRuntimeSettingsService({
      config: createConfig({ modelEnabled: false }),
      repository,
      redis: createTestRedisCoordinator(),
      deploymentSecretDirectory: createRuntimeSecretDirectory()
    });
    const initial = await service.getSnapshot();
    const updated = await service.updateSemantic({
      actor: "admin",
      value: {
        ...initial.semantic,
        maximumChunkCharacters: 12_000,
        graphRagAdapterTimeoutMs: 25_000,
        queryEmbeddingConcurrency: 2,
        searchLaneCutoffMs: 900
      }
    });
    expect(updated.semantic).toMatchObject({
      maximumChunkCharacters: 12_000,
      graphRagAdapterTimeoutMs: 25_000,
      queryEmbeddingConcurrency: 2,
      searchLaneCutoffMs: 900
    });
    await expect(service.updateSemantic({
      actor: "admin",
      value: { ...updated.semantic, graphRagAdapterTimeoutMs: 300_001 }
    })).rejects.toMatchObject({
      code: "RUNTIME_SETTINGS_VALIDATION_FAILED"
    });
    expect((await service.getSnapshot()).semantic).toEqual(updated.semantic);
  });

  it("rejects missing and non-integer values for every semantic settings field", async () => {
    const service = createRuntimeSettingsService({
      config: createConfig({ modelEnabled: false }),
      repository: new MemoryRuntimeSettingsRepository(),
      redis: createTestRedisCoordinator(),
      deploymentSecretDirectory: createRuntimeSecretDirectory()
    });
    const initial = await service.getSnapshot();

    for (const field of Object.keys(initial.semantic)) {
      const missing = structuredClone(initial.semantic) as Record<string, unknown>;
      delete missing[field];
      await expect(service.updateSemantic({
        actor: "admin",
        value: missing as RuntimeSettingsSnapshot["semantic"]
      }), `${field} missing`).rejects.toMatchObject({
        code: "RUNTIME_SETTINGS_VALIDATION_FAILED"
      });

      const wrongType = {
        ...initial.semantic,
        [field]: String(initial.semantic[field as keyof typeof initial.semantic])
      } as RuntimeSettingsSnapshot["semantic"];
      await expect(service.updateSemantic({
        actor: "admin",
        value: wrongType
      }), `${field} wrong type`).rejects.toMatchObject({
        code: "RUNTIME_SETTINGS_VALIDATION_FAILED"
      });
    }
  });

  it("validates and persists configurable search concurrency", async () => {
    const repository = new MemoryRuntimeSettingsRepository();
    const service = createRuntimeSettingsService({
      config: createConfig({ modelEnabled: false }),
      repository,
      redis: createTestRedisCoordinator(),
      deploymentSecretDirectory: createRuntimeSecretDirectory()
    });
    const initial = await service.getSnapshot();

    const updated = await service.updateSearch({
      actor: "admin",
      value: {
        ...initial.search,
        overfetchFactor: 4,
        cropLength: 1_500,
        maxInFlightTasks: 7,
      }
    });

    expect(updated.search).toMatchObject({
      overfetchFactor: 4,
      cropLength: 1_500,
      maxInFlightTasks: 7,
    });
    const expanded = await service.updateSearch({
      actor: "admin",
      value: { ...updated.search, maxInFlightTasks: 128 }
    });
    expect(expanded.search.maxInFlightTasks).toBe(128);
    await expect(service.updateSearch({
      actor: "admin",
      value: {
        ...expanded.search,
        maxInFlightTasks: Number.MAX_SAFE_INTEGER + 1
      }
    })).rejects.toMatchObject({
      code: "RUNTIME_SETTINGS_VALIDATION_FAILED",
    });
    await expect(service.updateSearch({
      actor: "admin",
      value: {
        ...updated.search,
        overfetchFactor: 11
      }
    })).rejects.toMatchObject({
      code: "RUNTIME_SETTINGS_VALIDATION_FAILED"
    });
  });

  it("rejects stale or unsafe complete candidates without writing settings or audit", async () => {
    const repository = new MemoryRuntimeSettingsRepository();
    const service = createRuntimeSettingsService({
      config: createConfig({ modelEnabled: false }),
      repository,
      redis: createTestRedisCoordinator(),
      deploymentSecretDirectory: createRuntimeSecretDirectory()
    });
    const initial = await service.getSnapshot();
    const initialWorker = await repository.getSetting("worker");
    const initialMaintenance = await repository.getSetting("maintenance");

    await expect(service.updateWorker({
      value: {
        ...initial.worker,
        generationBatchSize: 50
      } as never
    })).rejects.toMatchObject({
      code: "RUNTIME_SETTINGS_VALIDATION_FAILED",
      issues: expect.arrayContaining([
        expect.objectContaining({ field: "worker.generationBatchSize" })
      ])
    });
    await expect(service.updateMaintenance({
      value: {
        ...initial.maintenance,
        scanIntervalSeconds: 86_401
      } as never
    })).rejects.toMatchObject({
      code: "RUNTIME_SETTINGS_VALIDATION_FAILED",
      issues: expect.arrayContaining([
        expect.objectContaining({ field: "scanIntervalSeconds" })
      ])
    });

    expect(await repository.getSetting("worker")).toEqual(initialWorker);
    expect(await repository.getSetting("maintenance")).toEqual(initialMaintenance);
    expect(repository.auditLogs).toEqual([]);
  });

  it("drops removed persisted fields and adds retained defaults without rewriting history", async () => {
    const repository = new MemoryRuntimeSettingsRepository();
    const config = createConfig({ modelEnabled: false });
    const first = createRuntimeSettingsService({
      config,
      repository,
      redis: createTestRedisCoordinator(),
      deploymentSecretDirectory: createRuntimeSecretDirectory()
    });
    const defaults = await first.getSnapshot();
    const worker = { ...defaults.worker } as Record<string, unknown>;
    const generated = { ...defaults.generated } as Record<string, unknown>;
    const maintenance = { ...defaults.maintenance } as Record<string, unknown>;
    delete worker.sourceObjectReadConcurrency;
    delete generated.directoryIndexMaxBytes;
    worker.sourceFileConcurrency = 3;
    worker.graphQueryConcurrency = 99;
    generated.impactConcurrency = 99;
    maintenance.compactionConcurrency = 99;
    await repository.upsertSetting({ key: "worker", value: worker, source: "admin" });
    await repository.upsertSetting({ key: "generated", value: generated, source: "admin" });
    await repository.upsertSetting({ key: "maintenance", value: maintenance, source: "admin" });
    const versions = Object.fromEntries(
      [...repository.settings].map(([key, value]) => [key, value.version])
    );

    const second = createRuntimeSettingsService({
      config,
      repository,
      redis: createTestRedisCoordinator(),
      deploymentSecretDirectory: createRuntimeSecretDirectory(),
      resourceCapacity: createTestResourceCapacity()
    });
    const snapshot = await second.getSnapshot();

    expect(snapshot.worker).toMatchObject({
      sourceFileConcurrency: 3,
      sourceObjectReadConcurrency: 40
    });
    expect(snapshot.generated).toMatchObject({
      directoryIndexMaxBytes: 65_536
    });
    expect(snapshot.maintenance).toMatchObject({
      reconciliationEnabled: true,
      scanBatchSize: 500
    });
    expect(snapshot.worker).not.toHaveProperty("graphQueryConcurrency");
    expect(snapshot.generated).not.toHaveProperty("impactConcurrency");
    expect(snapshot.maintenance).not.toHaveProperty("compactionConcurrency");
    expect(Object.fromEntries(
      [...repository.settings].map(([key, value]) => [key, value.version])
    )).toEqual(versions);
    expect(repository.auditLogs).toEqual([]);
  });

  it("audits maintenance updates and notifies other runtimes through Redis", async () => {
    const repository = new MemoryRuntimeSettingsRepository();
    const redis = createTestRedisCoordinator();
    const service = createRuntimeSettingsService({
      config: createConfig({ modelEnabled: false }),
      repository,
      redis,
      deploymentSecretDirectory: createRuntimeSecretDirectory()
    });
    const initial = await service.getSnapshot();
    const previousVersion = await redis.getRuntimeSettingsVersion();

    const updated = await service.updateMaintenance({
      actor: "admin",
      value: {
        ...initial.maintenance,
        scanBatchSize: 1_000
      }
    });

    expect(updated.maintenance).toMatchObject({
      scanBatchSize: 1_000
    });
    expect(await redis.getRuntimeSettingsVersion()).not.toBe(previousVersion);
    expect(repository.auditLogs).toContainEqual(
      expect.objectContaining({
        settingKey: "maintenance",
        action: "update",
        actor: "admin"
      })
    );

    await expect(
      service.updateMaintenance({
        actor: "admin",
        value: {
          ...updated.maintenance,
          scanBatchSize: 1_001
        }
      })
    ).rejects.toMatchObject({
      code: "RUNTIME_SETTINGS_VALIDATION_FAILED"
    });
    expect((await service.getSnapshot()).maintenance).toEqual(updated.maintenance);
  });

  it("rejects resource budgets that exceed their independent I/O bounds", async () => {
    const service = createRuntimeSettingsService({
      config: createConfig({ modelEnabled: false }),
      repository: new MemoryRuntimeSettingsRepository(),
      redis: createTestRedisCoordinator(),
      deploymentSecretDirectory: createRuntimeSecretDirectory(),
      resourceCapacity: createTestResourceCapacity()
    });
    const snapshot = await service.getSnapshot();

    await expect(service.updateWorker({
      value: {
        ...snapshot.worker,
        sourceObjectReadConcurrency: 49
      }
    })).rejects.toMatchObject({ code: "RUNTIME_SETTINGS_VALIDATION_FAILED" });
    await expect(service.updateGenerated({
      value: {
        ...snapshot.generated,
        directoryIndexMaxEntries: 0
      }
    })).rejects.toMatchObject({ code: "RUNTIME_SETTINGS_VALIDATION_FAILED" });
    await expect(service.updateMaintenance({
      value: {
        ...snapshot.maintenance,
        hardDeleteConcurrency: 17
      }
    })).rejects.toMatchObject({ code: "RUNTIME_SETTINGS_VALIDATION_FAILED" });
  });

  it("accepts minimum and maximum resource-budget boundaries", async () => {
    const service = createRuntimeSettingsService({
      config: createConfig({ modelEnabled: false }),
      repository: new MemoryRuntimeSettingsRepository(),
      redis: createTestRedisCoordinator(),
      deploymentSecretDirectory: createRuntimeSecretDirectory(),
      resourceCapacity: {
        databaseConnections: 128,
        objectStoreRequests: 128,
        cpuConcurrency: 256
      }
    });
    const initial = await service.getSnapshot();

    const minimum = await service.updateWorker({
      value: {
        ...initial.worker,
        sourceFileConcurrency: 1,
        sourceObjectReadConcurrency: 1
      }
    });
    expect(minimum.worker).toMatchObject({
      sourceFileConcurrency: 1,
      sourceObjectReadConcurrency: 1
    });

    const maximumWorker = await service.updateWorker({
      value: {
        ...minimum.worker,
        sourceFileConcurrency: 32,
        sourceObjectReadConcurrency: 48,
        claimBatchSize: 32
      }
    });
    const updatedGenerated = await service.updateGenerated({
      value: {
        ...maximumWorker.generated,
        directoryIndexMaxEntries: 10_000,
        directoryIndexMaxBytes: 10_485_760
      }
    });
    const maximumMaintenance = await service.updateMaintenance({
      value: {
        ...updatedGenerated.maintenance,
        hardDeleteConcurrency: 16,
        hardDeleteDatabaseBatchSize: 10_000,
        hardDeleteObjectBatchSize: 1_000
      }
    });

    expect(maximumMaintenance.worker.sourceObjectReadConcurrency).toBe(48);
    expect(maximumMaintenance.generated.directoryIndexMaxEntries).toBe(10_000);
    expect(maximumMaintenance.maintenance.hardDeleteConcurrency).toBe(16);
    expect(maximumMaintenance.maintenance.hardDeleteDatabaseBatchSize).toBe(10_000);
  });

  it("rejects source concurrency above the process budget and undersized claim batches", async () => {
    const service = createRuntimeSettingsService({
      config: createConfig({ modelEnabled: false }),
      repository: new MemoryRuntimeSettingsRepository(),
      redis: createTestRedisCoordinator(),
      deploymentSecretDirectory: createRuntimeSecretDirectory()
    });
    const initial = await service.getSnapshot();

    await expect(service.updateWorker({
      value: {
        ...initial.worker,
        sourceFileConcurrency: 33,
        sourceObjectReadConcurrency: 32,
        claimBatchSize: 33
      }
    })).rejects.toMatchObject({ code: "RUNTIME_SETTINGS_VALIDATION_FAILED" });

    await expect(service.updateWorker({
      value: {
        ...initial.worker,
        sourceFileConcurrency: 16,
        sourceObjectReadConcurrency: 16,
        claimBatchSize: 10
      }
    })).rejects.toMatchObject({ code: "RUNTIME_SETTINGS_VALIDATION_FAILED" });
  });

  it("rejects empty and malformed setting documents without changing saved values", async () => {
    const repository = new MemoryRuntimeSettingsRepository();
    const service = createRuntimeSettingsService({
      config: createConfig({ modelEnabled: false }),
      repository,
      redis: createTestRedisCoordinator(),
      deploymentSecretDirectory: createRuntimeSecretDirectory()
    });
    const initial = await service.getSnapshot();

    await expect(service.updateWorker({ value: {} as never })).rejects.toMatchObject({
      code: "RUNTIME_SETTINGS_VALIDATION_FAILED"
    });
    await expect(service.updateGenerated({
      value: { ...initial.generated, directoryIndexMaxBytes: "large" } as never
    })).rejects.toMatchObject({ code: "RUNTIME_SETTINGS_VALIDATION_FAILED" });
    await expect(service.updateMaintenance({ value: [] as never })).rejects.toMatchObject({
      code: "RUNTIME_SETTINGS_VALIDATION_FAILED"
    });

    expect((await service.getSnapshot()).worker).toEqual(initial.worker);
    expect((await service.getSnapshot()).generated).toEqual(initial.generated);
    expect((await service.getSnapshot()).maintenance).toEqual(initial.maintenance);
  });

  it("rejects removed maintenance scheduler fields atomically", async () => {
    const repository = new MemoryRuntimeSettingsRepository();
    const service = createRuntimeSettingsService({
      config: createConfig({ modelEnabled: false }),
      repository,
      redis: createTestRedisCoordinator(),
      deploymentSecretDirectory: createRuntimeSecretDirectory(),
      resourceCapacity: createTestResourceCapacity()
    });
    const initial = await service.getSnapshot();

    await expect(service.updateMaintenance({
      value: {
        ...initial.maintenance,
        knowledgeBaseMaintenanceMode: "scheduled"
      } as never
    })).rejects.toMatchObject({
      code: "RUNTIME_SETTINGS_VALIDATION_FAILED",
      issues: expect.arrayContaining([
        expect.objectContaining({ field: "knowledgeBaseMaintenanceMode" })
      ])
    });
    await expect(service.updateMaintenance({
      value: {
        ...initial.maintenance,
        knowledgeBaseMaintenanceScanIntervalSeconds: 59
      } as never
    })).rejects.toMatchObject({
      code: "RUNTIME_SETTINGS_VALIDATION_FAILED",
      issues: expect.arrayContaining([
        expect.objectContaining({
          field: "knowledgeBaseMaintenanceScanIntervalSeconds"
        })
      ])
    });
    await expect(service.updateMaintenance({
      value: {
        ...initial.maintenance,
        knowledgeBaseMaintenanceConcurrency: 17
      } as never
    })).rejects.toMatchObject({
      code: "RUNTIME_SETTINGS_VALIDATION_FAILED",
      issues: expect.arrayContaining([
        expect.objectContaining({ field: "knowledgeBaseMaintenanceConcurrency" })
      ])
    });

    expect((await service.getSnapshot()).maintenance).toEqual(initial.maintenance);

    await expect(service.getMaintenanceRevision()).resolves.toBe(1);
  });

  it("propagates concurrent live updates and preserves them after service restart", async () => {
    const repository = new MemoryRuntimeSettingsRepository();
    const redis = createTestRedisCoordinator();
    const config = createConfig({ modelEnabled: false });
    const first = createRuntimeSettingsService({
      config,
      repository,
      redis,
      deploymentSecretDirectory: createRuntimeSecretDirectory(),
      resourceCapacity: createTestResourceCapacity()
    });
    const second = createRuntimeSettingsService({
      config,
      repository,
      redis,
      deploymentSecretDirectory: createRuntimeSecretDirectory(),
      resourceCapacity: createTestResourceCapacity()
    });
    const initial = await first.getSnapshot();
    await second.getSnapshot();

    await Promise.all([
      first.updateWorker({
        actor: "worker-admin",
        value: { ...initial.worker, sourceFileConcurrency: 4 }
      }),
      second.updateMaintenance({
        actor: "maintenance-admin",
        value: { ...initial.maintenance, reconciliationEnabled: false }
      })
    ]);

    const liveSnapshot = await first.getSnapshot();
    expect(liveSnapshot.worker.sourceFileConcurrency).toBe(4);
    expect(liveSnapshot.maintenance.reconciliationEnabled).toBe(false);

    const restarted = createRuntimeSettingsService({
      config,
      repository,
      redis,
      deploymentSecretDirectory: createRuntimeSecretDirectory(),
      resourceCapacity: createTestResourceCapacity()
    });
    const restartedSnapshot = await restarted.getSnapshot();
    expect(restartedSnapshot.worker.sourceFileConcurrency).toBe(4);
    expect(restartedSnapshot.maintenance.reconciliationEnabled).toBe(false);
  });

  it("creates a model without exposing the raw key and deletes it after running work ends", async () => {
    const repository = new MemoryRuntimeSettingsRepository();
    repository.runningModelInvocationCount = 1;
    const service = createRuntimeSettingsService({
      config: createConfig({ modelEnabled: false }),
      repository,
      redis: createTestRedisCoordinator(),
      deploymentSecretDirectory: createRuntimeSecretDirectory(),
      resourceCapacity: createTestResourceCapacity()
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
    repository.runningModelInvocationCount = 0;
    await expect(service.deleteModel({ id: model.id })).resolves.toMatchObject({
      id: model.id,
      status: "deleted",
      isActive: false
    });
  });

  it("updates a generation model without replacing its encrypted API key", async () => {
    const repository = new MemoryRuntimeSettingsRepository();
    const service = createRuntimeSettingsService({
      config: createConfig({ modelEnabled: false }),
      repository,
      redis: createTestRedisCoordinator(),
      deploymentSecretDirectory: createRuntimeSecretDirectory(),
      resourceCapacity: createTestResourceCapacity()
    });
    const model = await service.createModel({
      displayName: "Generation model",
      apiMode: "responses",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-generation-secret",
      modelName: "generation-v1",
      contextWindowTokens: 128_000,
      requestMaxTimeoutMs: 600_000,
      requestIdleTimeoutMs: 120_000,
      suggestionConcurrency: 2,
      transientRetryDelayMs: 60_000,
      requestMinIntervalMs: 0,
      isActive: false
    });
    const encryptedBefore = repository.models.get(model.id)?.apiKey;

    const updated = await service.updateModel({
      id: model.id,
      actor: "admin",
      value: {
        displayName: "Generation model updated",
        apiMode: "chat_completions",
        baseUrl: "https://api.example.com/v2",
        modelName: "generation-v2",
        contextWindowTokens: 256_000,
        requestMaxTimeoutMs: 300_000,
        requestIdleTimeoutMs: 60_000,
        suggestionConcurrency: 3,
        transientRetryDelayMs: 30_000,
        requestMinIntervalMs: 1_000
      }
    });

    expect(updated).toMatchObject({
      id: model.id,
      displayName: "Generation model updated",
      apiMode: "chat_completions",
      modelName: "generation-v2",
      apiKeyFingerprint: model.apiKeyFingerprint
    });
    expect(repository.models.get(model.id)?.apiKey).toBe(encryptedBefore);
    expect(repository.auditLogs.at(-1)).toMatchObject({
      settingKey: "model_configs",
      action: "update"
    });
  });

  it("updates a generation model through Admin API without returning its credential", async () => {
    const repository = new MemoryRuntimeSettingsRepository();
    const redis = createTestRedisCoordinator();
    const config = createConfig({ modelEnabled: false });
    const app = createApiApp({
      config,
      redis,
      runtimeSettings: createRuntimeSettingsService({
        config,
        repository,
        redis,
        deploymentSecretDirectory: createRuntimeSecretDirectory(),
        resourceCapacity: createTestResourceCapacity()
      })
    });
    const cookie = await loginAndReadSessionCookie(app);
    const createdResponse = await app.request("/admin/api/settings/models", {
      method: "POST",
      headers: withTrustedAdminOrigin({ cookie, "content-type": "application/json" }),
      body: JSON.stringify({
        displayName: "Generation API model",
        apiMode: "responses",
        baseUrl: "https://api.example.com/v1",
        apiKey: "sk-generation-api-secret",
        modelName: "generation-api-v1",
        contextWindowTokens: 128_000,
        requestMaxTimeoutMs: 600_000,
        requestIdleTimeoutMs: 120_000,
        suggestionConcurrency: 2,
        transientRetryDelayMs: 60_000,
        requestMinIntervalMs: 0,
        isActive: false
      })
    });
    const created = (await createdResponse.json()) as { model: RuntimeModelConfigPrivate };

    const updatedResponse = await app.request(
      `/admin/api/settings/models/${created.model.id}`,
      {
        method: "PUT",
        headers: withTrustedAdminOrigin({ cookie, "content-type": "application/json" }),
        body: JSON.stringify({
          displayName: "Generation API model updated",
          apiMode: "chat_completions",
          baseUrl: "https://api.example.com/v2",
          modelName: "generation-api-v2",
          contextWindowTokens: 256_000,
          requestMaxTimeoutMs: 300_000,
          requestIdleTimeoutMs: 60_000,
          suggestionConcurrency: 3,
          transientRetryDelayMs: 30_000,
          requestMinIntervalMs: 1_000
        })
      }
    );
    const updated = await updatedResponse.json();

    expect(updatedResponse.status).toBe(200);
    expect(updated).toMatchObject({
      model: {
        id: created.model.id,
        displayName: "Generation API model updated",
        apiKeyFingerprint: created.model.apiKeyFingerprint
      }
    });
    expect(JSON.stringify(updated)).not.toContain("sk-generation-api-secret");

    const nullRequired = await app.request(
      `/admin/api/settings/models/${created.model.id}`,
      {
        method: "PUT",
        headers: withTrustedAdminOrigin({ cookie, "content-type": "application/json" }),
        body: JSON.stringify({ displayName: null })
      }
    );
    expect(nullRequired.status).toBe(400);

    const nullCredential = await app.request(
      `/admin/api/settings/models/${created.model.id}`,
      {
        method: "PUT",
        headers: withTrustedAdminOrigin({ cookie, "content-type": "application/json" }),
        body: JSON.stringify({ apiKey: null })
      }
    );
    expect(nullCredential.status).toBe(200);
    await expect(nullCredential.json()).resolves.toMatchObject({
      model: { apiKeyFingerprint: created.model.apiKeyFingerprint }
    });

    const wrongCredentialType = await app.request(
      `/admin/api/settings/models/${created.model.id}`,
      {
        method: "PUT",
        headers: withTrustedAdminOrigin({ cookie, "content-type": "application/json" }),
        body: JSON.stringify({ apiKey: 42 })
      }
    );
    expect(wrongCredentialType.status).toBe(400);
  });

  it("soft deletes an active generation model and removes it from future selection", async () => {
    const repository = new MemoryRuntimeSettingsRepository();
    const service = createRuntimeSettingsService({
      config: createConfig({ modelEnabled: false }),
      repository,
      redis: createTestRedisCoordinator(),
      deploymentSecretDirectory: createRuntimeSecretDirectory(),
      resourceCapacity: createTestResourceCapacity()
    });
    const model = await service.createModel({
      displayName: "Pinned generation model",
      apiMode: "chat_completions",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-pinned-test",
      modelName: "generation-test",
      contextWindowTokens: 128_000,
      requestMaxTimeoutMs: 600_000,
      requestIdleTimeoutMs: 120_000,
      suggestionConcurrency: 2,
      transientRetryDelayMs: 60_000,
      requestMinIntervalMs: 0,
      isActive: true
    });
    await expect(service.deleteModel({ id: model.id })).resolves.toMatchObject({
      id: model.id,
      status: "deleted",
      isActive: false
    });
    await expect(repository.getModel(model.id)).resolves.toMatchObject({
      status: "deleted",
      isActive: false
    });
    await expect(repository.getActiveModel()).resolves.toBeNull();
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
      deploymentSecretDirectory: runtimeSecretDirectory,
      resourceCapacity: createTestResourceCapacity()
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
      deploymentSecretDirectory: runtimeSecretDirectory,
      resourceCapacity: createTestResourceCapacity()
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

  it("persists every exposed runtime setting field through Admin API one by one", async () => {
    const repository = new MemoryRuntimeSettingsRepository();
    const redis = createTestRedisCoordinator();
    const config = createConfig({ modelEnabled: false });
    const runtimeSettings = createRuntimeSettingsService({
      config,
      repository,
      redis,
      deploymentSecretDirectory: createRuntimeSecretDirectory(),
      resourceCapacity: createTestResourceCapacity()
    });
    const app = createApiApp({ config, redis, runtimeSettings });
    const cookie = await loginAndReadSessionCookie(app);
    const initialResponse = await app.request("/admin/api/settings/runtime", {
      headers: { cookie }
    });
    const initial = (await initialResponse.json()) as {
      settings: PublicRuntimeSettings;
    };

    for (const testCase of runtimeSettingFieldCases) {
      const section = structuredClone(initial.settings[testCase.section]) as Record<
        string,
        unknown
      >;
      testCase.prepare?.(section);
      writeNestedValue(section, testCase.path, testCase.value);

      const update = await app.request(`/admin/api/settings/${testCase.route}`, {
        method: "PUT",
        headers: withTrustedAdminOrigin({
          cookie,
          "content-type": "application/json"
        }),
        body: JSON.stringify(section)
      });
      expect(update.status, testCase.id).toBe(200);
      const updateBody = (await update.json()) as {
        settings: PublicRuntimeSettings;
      };
      expect(
        readNestedValue(
          updateBody.settings[testCase.section] as unknown as Record<string, unknown>,
          testCase.path
        ),
        `${testCase.id} update response`
      ).toBe(testCase.value);

      const reloaded = await app.request("/admin/api/settings/runtime", {
        headers: { cookie }
      });
      const reloadedBody = (await reloaded.json()) as {
        settings: PublicRuntimeSettings;
      };
      expect(
        readNestedValue(
          reloadedBody.settings[testCase.section] as unknown as Record<string, unknown>,
          testCase.path
        ),
        `${testCase.id} reload response`
      ).toBe(testCase.value);

      const restarted = createRuntimeSettingsService({
        config,
        repository,
        redis,
        deploymentSecretDirectory: createRuntimeSecretDirectory(),
        resourceCapacity: createTestResourceCapacity()
      });
      const restartedSnapshot = await restarted.getPublicSnapshot();
      expect(
        readNestedValue(
          restartedSnapshot[testCase.section] as unknown as Record<string, unknown>,
          testCase.path
        ),
        `${testCase.id} restarted runtime`
      ).toBe(testCase.value);

      const restore = await app.request(`/admin/api/settings/${testCase.route}`, {
        method: "PUT",
        headers: withTrustedAdminOrigin({
          cookie,
          "content-type": "application/json"
        }),
        body: JSON.stringify(initial.settings[testCase.section])
      });
      expect(restore.status, `${testCase.id} restore`).toBe(200);
    }

    const restored = await runtimeSettings.getPublicSnapshot();
    expect(restored.rateLimits).toEqual(initial.settings.rateLimits);
    expect(restored.worker).toEqual(initial.settings.worker);
    expect(restored.generated).toEqual(initial.settings.generated);
    expect(restored.graph).toEqual(initial.settings.graph);
    expect(restored.maintenance).toEqual(initial.settings.maintenance);
    expect(restored.semantic).toEqual(initial.settings.semantic);
    expect(restored.search).toEqual(initial.settings.search);
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
      })
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
      settings: PublicRuntimeSettings;
      models: unknown[];
    };
    expect(initialBody).toMatchObject({ settings: { activeModel: null }, models: [] });
    expect(initialBody.settings).not.toHaveProperty("publication");
    expect(initialBody.settings).not.toHaveProperty("uploadGeneration");
    expect(initialBody.settings.rateLimits).not.toHaveProperty("upload");
    expect(initialBody.settings.maintenance).toMatchObject({
      reconciliationEnabled: true
    });
    expect(initialBody).not.toHaveProperty("maintenanceStatus");
    expect(initialBody).not.toHaveProperty("objectProtectionStatus");
    const serializedInitial = JSON.stringify(initialBody);
    for (const forbidden of [
      "objectKey", "checksumSha256", "secretAccessKey", "SELECT ",
      "storage_reconciliation_candidates", "tenant/demo/generated",
      "leaseToken", "workerId", "cursorObjectKey"
    ]) {
      expect(serializedInitial).not.toContain(forbidden);
    }
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({
      error: {
        code: "RUNTIME_SETTINGS_VALIDATION_FAILED",
        messageKey: "errors.runtimeSettingsValidationFailed"
      }
    });

    const invalidHardDeleteBatch = await app.request("/admin/api/settings/maintenance", {
      method: "PUT",
      headers: withTrustedAdminOrigin({
        cookie,
        "content-type": "application/json"
      }),
      body: JSON.stringify({
        ...initialBody.settings.maintenance,
        hardDeleteObjectBatchSize: 1_001,
      })
    });
    expect(invalidHardDeleteBatch.status).toBe(400);
    await expect(invalidHardDeleteBatch.json()).resolves.toMatchObject({
      error: {
        code: "RUNTIME_SETTINGS_VALIDATION_FAILED",
        messageKey: "errors.runtimeSettingsValidationFailed"
      }
    });

    const removedPublicationRoute = await app.request(
      "/admin/api/settings/publication",
      {
      method: "PUT",
      headers: withTrustedAdminOrigin({
        cookie,
        "content-type": "application/json"
      }),
      body: JSON.stringify({
        ...initialBody.settings.generated,
        generatedObjectWriteConcurrency: 33
      })
    });
    expect(removedPublicationRoute.status).toBe(404);

    const removedUploadGeneration = await app.request("/admin/api/settings/upload-generation", {
      method: "PUT",
      headers: withTrustedAdminOrigin({
        cookie,
        "content-type": "application/json"
      }),
      body: JSON.stringify({ maxBytes: 2_097_152 })
    });
    expect(removedUploadGeneration.status).toBe(404);

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

    const invalidMaintenance = await app.request("/admin/api/settings/maintenance", {
      method: "PUT",
      headers: withTrustedAdminOrigin({
        cookie,
        "content-type": "application/json"
      }),
      body: JSON.stringify({
        ...initialBody.settings.maintenance,
        scanBatchSize: 1_001
      })
    });
    expect(invalidMaintenance.status).toBe(400);

    const validMaintenance = await app.request("/admin/api/settings/maintenance", {
      method: "PUT",
      headers: withTrustedAdminOrigin({
        cookie,
        "content-type": "application/json"
      }),
      body: JSON.stringify({
        ...initialBody.settings.maintenance,
        scanBatchSize: 1_000
      })
    });
    expect(validMaintenance.status).toBe(200);
    await expect(validMaintenance.json()).resolves.toMatchObject({
      settings: {
        maintenance: {
          scanBatchSize: 1_000
        }
      }
    });
  });
});

function createConfig(input: { modelEnabled: boolean }): RuntimeConfig {
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
    generated: {
      directoryIndexMaxEntries: 200,
      directoryIndexMaxBytes: 65_536,
      rootSummaryLimit: 500,
      okfLogMaxEntries: 100,
      okfLogMaxBytes: 65_536
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
      sourceQueueHardDepth: 5_000,
      sourceQueueResumeDepth: 3_000,
      sourceQueueHardAgeSeconds: 3_600,
      sourceQueueResumeAgeSeconds: 1_800,
      shutdownGraceMs: 30_000,
      hardDeleteConcurrency: 1,
      hardDeleteDatabaseBatchSize: 1_000,
      hardDeleteObjectBatchSize: 1_000,
      hardDeleteMaxAttempts: 3,
      hardDeleteRetryDelayMs: 60_000,
      hardDeleteFailedRetentionDays: 30
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

function createTestResourceCapacity() {
  return {
    databaseConnections: 128,
    objectStoreRequests: 128,
    cpuConcurrency: 256
  };
}

type PublicRuntimeSettings = Awaited<
  ReturnType<RuntimeSettingsService["getPublicSnapshot"]>
>;

type RuntimeSettingFieldCase = {
  id: string;
  section: Exclude<keyof PublicRuntimeSettings, "activeModel">;
  route: "rate-limits" | "worker" | "generated" | "graph" | "maintenance" | "semantic" | "search";
  path: readonly string[];
  value: string | number | boolean;
  prepare?: (section: Record<string, unknown>) => void;
};

const runtimeSettingFieldCases: readonly RuntimeSettingFieldCase[] = [
  { id: "rateLimits.adminLogin.max", section: "rateLimits", route: "rate-limits", path: ["adminLogin", "max"], value: 9 },
  { id: "rateLimits.adminLogin.windowSeconds", section: "rateLimits", route: "rate-limits", path: ["adminLogin", "windowSeconds"], value: 901 },
  { id: "rateLimits.adminApi.max", section: "rateLimits", route: "rate-limits", path: ["adminApi", "max"], value: 601 },
  { id: "rateLimits.adminApi.windowSeconds", section: "rateLimits", route: "rate-limits", path: ["adminApi", "windowSeconds"], value: 61 },
  { id: "rateLimits.publicOpenApi.max", section: "rateLimits", route: "rate-limits", path: ["publicOpenApi", "max"], value: 1_201 },
  { id: "rateLimits.publicOpenApi.windowSeconds", section: "rateLimits", route: "rate-limits", path: ["publicOpenApi", "windowSeconds"], value: 61 },
  {
    id: "worker.sourceFileConcurrency",
    section: "worker",
    route: "worker",
    path: ["sourceFileConcurrency"],
    value: 1
  },
  {
    id: "worker.s3Concurrency",
    section: "worker",
    route: "worker",
    path: ["s3Concurrency"],
    value: 3
  },
  { id: "worker.jobMaxAttempts", section: "worker", route: "worker", path: ["jobMaxAttempts"], value: 4 },
  { id: "worker.jobRetryDelayMs", section: "worker", route: "worker", path: ["jobRetryDelayMs"], value: 30_001 },
  { id: "worker.completedJobRetentionDays", section: "worker", route: "worker", path: ["completedJobRetentionDays"], value: 8 },
  { id: "generated.directoryIndexMaxEntries", section: "generated", route: "generated", path: ["directoryIndexMaxEntries"], value: 201 },
  { id: "generated.directoryIndexMaxBytes", section: "generated", route: "generated", path: ["directoryIndexMaxBytes"], value: 65_537 },
  { id: "generated.rootSummaryLimit", section: "generated", route: "generated", path: ["rootSummaryLimit"], value: 501 },
  { id: "generated.okfLogMaxEntries", section: "generated", route: "generated", path: ["okfLogMaxEntries"], value: 101 },
  { id: "generated.okfLogMaxBytes", section: "generated", route: "generated", path: ["okfLogMaxBytes"], value: 65_537 },
  { id: "graph.candidateLimit", section: "graph", route: "graph", path: ["candidateLimit"], value: 201 },
  { id: "graph.acceptedEdgeLimit", section: "graph", route: "graph", path: ["acceptedEdgeLimit"], value: 41 },
  { id: "graph.searchDefaultDepth", section: "graph", route: "graph", path: ["searchDefaultDepth"], value: 0 },
  { id: "graph.searchMaxDepth", section: "graph", route: "graph", path: ["searchMaxDepth"], value: 1 },
  { id: "graph.searchDefaultFanout", section: "graph", route: "graph", path: ["searchDefaultFanout"], value: 11 },
  { id: "graph.searchMaxFanout", section: "graph", route: "graph", path: ["searchMaxFanout"], value: 26 },
  { id: "graph.shardSize", section: "graph", route: "graph", path: ["shardSize"], value: 5_001 },
  { id: "graph.genericPhraseThreshold", section: "graph", route: "graph", path: ["genericPhraseThreshold"], value: 5 },
  { id: "maintenance.reconciliationEnabled", section: "maintenance", route: "maintenance", path: ["reconciliationEnabled"], value: false },
  { id: "maintenance.scanBatchSize", section: "maintenance", route: "maintenance", path: ["scanBatchSize"], value: 501 },
  { id: "maintenance.maxAttempts", section: "maintenance", route: "maintenance", path: ["maxAttempts"], value: 6 },
  { id: "maintenance.retryDelayMs", section: "maintenance", route: "maintenance", path: ["retryDelayMs"], value: 30_001 },
  { id: "maintenance.hardDeleteConcurrency", section: "maintenance", route: "maintenance", path: ["hardDeleteConcurrency"], value: 2 },
  { id: "maintenance.hardDeleteDatabaseBatchSize", section: "maintenance", route: "maintenance", path: ["hardDeleteDatabaseBatchSize"], value: 1_001 },
  { id: "maintenance.hardDeleteObjectBatchSize", section: "maintenance", route: "maintenance", path: ["hardDeleteObjectBatchSize"], value: 999 },
  { id: "maintenance.hardDeleteMaxAttempts", section: "maintenance", route: "maintenance", path: ["hardDeleteMaxAttempts"], value: 4 },
  { id: "maintenance.hardDeleteRetryDelayMs", section: "maintenance", route: "maintenance", path: ["hardDeleteRetryDelayMs"], value: 60_001 },
  { id: "maintenance.hardDeleteFailedRetentionDays", section: "maintenance", route: "maintenance", path: ["hardDeleteFailedRetentionDays"], value: 31 },
  { id: "semantic.maximumChunkCharacters", section: "semantic", route: "semantic", path: ["maximumChunkCharacters"], value: 16_001 },
  { id: "semantic.maximumChunks", section: "semantic", route: "semantic", path: ["maximumChunks"], value: 31 },
  { id: "semantic.maximumEvidenceTargets", section: "semantic", route: "semantic", path: ["maximumEvidenceTargets"], value: 65 },
  { id: "semantic.graphRagAdapterTimeoutMs", section: "semantic", route: "semantic", path: ["graphRagAdapterTimeoutMs"], value: 30_001 },
  { id: "semantic.searchLaneCutoffMs", section: "semantic", route: "semantic", path: ["searchLaneCutoffMs"], value: 1_001 },
  { id: "semantic.queryEmbeddingConcurrency", section: "semantic", route: "semantic", path: ["queryEmbeddingConcurrency"], value: 5 },
  { id: "semantic.queryEmbeddingCacheEntries", section: "semantic", route: "semantic", path: ["queryEmbeddingCacheEntries"], value: 1_001 },
  { id: "search.requestTimeoutMs", section: "search", route: "search", path: ["requestTimeoutMs"], value: 4_000 },
  { id: "search.engineSearchCutoffMs", section: "search", route: "search", path: ["engineSearchCutoffMs"], value: 1_100 },
  { id: "search.overfetchFactor", section: "search", route: "search", path: ["overfetchFactor"], value: 4 },
  { id: "search.indexBatchDocumentCount", section: "search", route: "search", path: ["indexBatchDocumentCount"], value: 9_999 },
  { id: "search.indexBatchCompressedBytes", section: "search", route: "search", path: ["indexBatchCompressedBytes"], value: 8_388_609 },
  { id: "search.maxInFlightTasks", section: "search", route: "search", path: ["maxInFlightTasks"], value: 7 },
  { id: "search.taskPollIntervalMs", section: "search", route: "search", path: ["taskPollIntervalMs"], value: 501 },
  { id: "search.taskTimeoutMs", section: "search", route: "search", path: ["taskTimeoutMs"], value: 600_001 },
  { id: "search.maxAttempts", section: "search", route: "search", path: ["maxAttempts"], value: 6 },
  { id: "search.retryDelayMs", section: "search", route: "search", path: ["retryDelayMs"], value: 2_001 },
  { id: "search.cleanupBatchSize", section: "search", route: "search", path: ["cleanupBatchSize"], value: 1_001 },
  { id: "search.cropLength", section: "search", route: "search", path: ["cropLength"], value: 1_201 }
];

function writeNestedValue(
  target: Record<string, unknown>,
  path: readonly string[],
  value: string | number | boolean
): void {
  let current = target;
  for (const segment of path.slice(0, -1)) {
    current = current[segment] as Record<string, unknown>;
  }
  current[path.at(-1)!] = value;
}

function readNestedValue(
  target: Record<string, unknown>,
  path: readonly string[]
): unknown {
  let current: unknown = target;
  for (const segment of path) {
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

class MemoryRuntimeSettingsRepository implements RuntimeSettingsRepository {
  public readonly settings = new Map<RuntimeSettingKey, RuntimeSettingRecord>();
  public readonly models = new Map<string, RuntimeModelConfigPrivate>();
  public runningModelInvocationCount = 0;
  public readonly auditLogs: Array<{
    settingKey: string;
    action: string;
    actor?: string | null | undefined;
    value: unknown;
  }> = [];

  public async listSettings() {
    return [...this.settings.values()];
  }

  public async getSetting(key: RuntimeSettingKey) {
    return this.settings.get(key) ?? null;
  }

  public async getCurrentRevision() {
    const version = Math.max(
      0,
      ...[...this.settings.values()].map((setting) => setting.version)
    );
    return version === 0 ? null : {
      publicId: `runtime-settings-memory-${version}`,
      checksum: "0".repeat(64),
      version
    };
  }

  public async getRevision() {
    return null;
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

  public async createAuditLog(input: {
    settingKey: string;
    action: string;
    actor?: string | null | undefined;
    value: unknown;
    expiresAt: string;
  }) {
    this.auditLogs.push(input);
  }

  public async listModels() {
    return [...this.models.values()].filter((model) => model.status !== "deleted");
  }

  public async getModel(id: string) {
    return this.models.get(id) ?? null;
  }

  public async getModelRevision(id: string, revision: number) {
    const model = this.models.get(id) ?? null;
    return model?.configurationRevision === revision ? model : null;
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

  public async updateModel(input: {
    id: string;
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
  }) {
    const model = this.models.get(input.id);
    if (!model) return null;
    Object.assign(model, {
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
      updatedAt: new Date().toISOString()
    });
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

}

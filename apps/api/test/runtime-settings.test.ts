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
    expect(snapshot.worker).not.toHaveProperty("hardDeleteVersionPurgeEnabled");
    expect(snapshot.worker).not.toHaveProperty("databasePoolMax");
    expect(snapshot.rateLimits.publicOpenApi.max).toBe(1_200);
    expect(snapshot.rateLimits).not.toHaveProperty("upload");
    expect(snapshot).not.toHaveProperty("uploadGeneration");
    expect(snapshot.worker).toMatchObject({
      sourceFileConcurrency: 2,
      sourceObjectReadConcurrency: 2
    });
    expect(snapshot.publication).toMatchObject({
      roleConcurrency: 1,
      claimBatchSize: 1,
      generatedObjectWriteConcurrency: 8
    });
    expect(snapshot.maintenance).toEqual({
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
      stagingRetentionHours: 24,
      cropLength: 1_200
    });
    expect(snapshot.activeModel).toBeNull();
  });

  it("validates and persists bounded search settings", async () => {
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
    await expect(service.updateSearch({
      actor: "admin",
      value: { ...updated.search, maxInFlightTasks: 9 }
    })).rejects.toMatchObject({
      code: "RUNTIME_SETTINGS_VALIDATION_FAILED",
      issues: expect.arrayContaining([
        expect.objectContaining({ field: "memoryCapacity" })
      ])
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
        expect.objectContaining({ field: "maintenance.scanIntervalSeconds" })
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
    const publication = { ...defaults.publication } as Record<string, unknown>;
    const maintenance = { ...defaults.maintenance } as Record<string, unknown>;
    delete worker.sourceObjectReadConcurrency;
    delete publication.generatedObjectWriteConcurrency;
    delete maintenance.projectionRepairConcurrency;
    delete maintenance.projectionRepairDatabaseBatchSize;
    delete maintenance.projectionRepairObjectWriteConcurrency;
    delete maintenance.lexicalRebuildConcurrency;
    delete maintenance.lexicalRebuildSourceReadConcurrency;
    delete maintenance.lexicalRebuildMaxInFlightSourceBytes;
    delete maintenance.knowledgeBaseMaintenanceMode;
    delete maintenance.knowledgeBaseMaintenanceScanIntervalSeconds;
    delete maintenance.knowledgeBaseMaintenanceConcurrency;
    worker.sourceFileConcurrency = 3;
    worker.graphQueryConcurrency = 99;
    publication.impactConcurrency = 99;
    maintenance.compactionConcurrency = 99;
    await repository.upsertSetting({ key: "worker", value: worker, source: "admin" });
    await repository.upsertSetting({ key: "publication", value: publication, source: "admin" });
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
      sourceObjectReadConcurrency: 2
    });
    expect(snapshot.publication).toMatchObject({
      generatedObjectWriteConcurrency: 8
    });
    expect(snapshot.maintenance).toMatchObject({
      knowledgeBaseMaintenanceMode: "manual",
      knowledgeBaseMaintenanceScanIntervalSeconds: 21_600,
      knowledgeBaseMaintenanceConcurrency: 1,
      projectionRepairConcurrency: 4,
      projectionRepairDatabaseBatchSize: 2_000,
      projectionRepairObjectWriteConcurrency: 4,
      lexicalRebuildConcurrency: 4,
      lexicalRebuildSourceReadConcurrency: 2,
      lexicalRebuildMaxInFlightSourceBytes: 67_108_864
    });
    expect(snapshot.worker).not.toHaveProperty("graphQueryConcurrency");
    expect(snapshot.publication).not.toHaveProperty("impactConcurrency");
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
        scanBatchSize: 1_000,
        deletionBatchSize: 250
      }
    });

    expect(updated.maintenance).toMatchObject({
      scanBatchSize: 1_000,
      deletionBatchSize: 250
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

  it("rejects resource budgets that exceed their owning role or I/O bounds", async () => {
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
        sourceObjectReadConcurrency: snapshot.worker.sourceFileConcurrency + 1
      }
    })).rejects.toMatchObject({ code: "RUNTIME_SETTINGS_VALIDATION_FAILED" });
    await expect(service.updatePublication({
      value: {
        ...snapshot.publication,
        generatedObjectWriteConcurrency: 33
      }
    })).rejects.toMatchObject({ code: "RUNTIME_SETTINGS_VALIDATION_FAILED" });
    await expect(service.updateMaintenance({
      value: {
        ...snapshot.maintenance,
        projectionRepairConcurrency: 17
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
        searchTasks: 64,
        objectStoreRequests: 128,
        memoryBytes: 1_073_741_824,
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
        sourceObjectReadConcurrency: 32,
        claimBatchSize: 32
      }
    });
    const maximumPublication = await service.updatePublication({
      value: {
        ...maximumWorker.publication,
        roleConcurrency: 32,
        generatedObjectWriteConcurrency: 32,
        claimBatchSize: 32
      }
    });
    const maximumMaintenance = await service.updateMaintenance({
      value: {
        ...maximumPublication.maintenance,
        projectionRepairConcurrency: 16,
        projectionRepairDatabaseBatchSize: 10_000,
        projectionRepairObjectWriteConcurrency: 32,
        lexicalRebuildConcurrency: 16,
        lexicalRebuildSourceReadConcurrency: 32,
        lexicalRebuildMaxInFlightSourceBytes: 536_870_912
      }
    });

    expect(maximumMaintenance.worker.sourceObjectReadConcurrency).toBe(32);
    expect(maximumMaintenance.publication.generatedObjectWriteConcurrency).toBe(32);
    expect(maximumMaintenance.maintenance.projectionRepairConcurrency).toBe(16);
    expect(maximumMaintenance.maintenance.lexicalRebuildConcurrency).toBe(16);
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
    await expect(service.updatePublication({
      value: { ...initial.publication, generatedObjectWriteConcurrency: "eight" } as never
    })).rejects.toMatchObject({ code: "RUNTIME_SETTINGS_VALIDATION_FAILED" });
    await expect(service.updateMaintenance({ value: [] as never })).rejects.toMatchObject({
      code: "RUNTIME_SETTINGS_VALIDATION_FAILED"
    });

    expect((await service.getSnapshot()).worker).toEqual(initial.worker);
    expect((await service.getSnapshot()).publication).toEqual(initial.publication);
    expect((await service.getSnapshot()).maintenance).toEqual(initial.maintenance);
  });

  it("validates knowledge-base maintenance scheduling atomically", async () => {
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
        knowledgeBaseMaintenanceMode: "automatic",
        knowledgeBaseMaintenanceScanIntervalSeconds: 59
      }
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
      }
    })).rejects.toMatchObject({
      code: "RUNTIME_SETTINGS_VALIDATION_FAILED",
      issues: expect.arrayContaining([
        expect.objectContaining({ field: "knowledgeBaseMaintenanceConcurrency" })
      ])
    });

    expect((await service.getSnapshot()).maintenance).toEqual(initial.maintenance);

    const automatic = await service.updateMaintenance({
      value: {
        ...initial.maintenance,
        knowledgeBaseMaintenanceMode: "automatic",
        knowledgeBaseMaintenanceScanIntervalSeconds: 3_600,
        knowledgeBaseMaintenanceConcurrency: 2
      }
    });
    expect(automatic.maintenance).toMatchObject({
      knowledgeBaseMaintenanceMode: "automatic",
      knowledgeBaseMaintenanceScanIntervalSeconds: 3_600,
      knowledgeBaseMaintenanceConcurrency: 2
    });
    await expect(service.getMaintenanceRevision()).resolves.toBeGreaterThan(1);
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

  it("creates a model without exposing the raw key and blocks deleting a running model", async () => {
    const repository = new MemoryRuntimeSettingsRepository();
    repository.runningSourceFileJobCount = 1;
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
      settings: RuntimeSettingsSnapshot;
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
        settings: RuntimeSettingsSnapshot;
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
        settings: RuntimeSettingsSnapshot;
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
      const restartedSnapshot = await restarted.getSnapshot();
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

    const restored = await runtimeSettings.getSnapshot();
    expect(restored.rateLimits).toEqual(initial.settings.rateLimits);
    expect(restored.worker).toEqual(initial.settings.worker);
    expect(restored.publication).toEqual(initial.settings.publication);
    expect(restored.graph).toEqual(initial.settings.graph);
    expect(restored.maintenance).toEqual(initial.settings.maintenance);
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
      settings: RuntimeSettingsSnapshot;
      models: unknown[];
      maintenanceStatus: unknown;
      objectProtectionStatus: unknown;
    };
    expect(initialBody).toMatchObject({ settings: { activeModel: null }, models: [] });
    expect(initialBody.settings).not.toHaveProperty("uploadGeneration");
    expect(initialBody.settings.rateLimits).not.toHaveProperty("upload");
    expect(initialBody.settings.maintenance).toMatchObject({
      reconciliationEnabled: true
    });
    expect(initialBody.maintenanceStatus).toBeNull();
    expect(initialBody.objectProtectionStatus).toBeNull();
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

    const invalidHardDeleteBatch = await app.request("/admin/api/settings/worker", {
      method: "PUT",
      headers: withTrustedAdminOrigin({
        cookie,
        "content-type": "application/json"
      }),
      body: JSON.stringify({
        ...initialBody.settings.worker,
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

    const invalidGeneratedObjectWriteConcurrency = await app.request(
      "/admin/api/settings/publication",
      {
      method: "PUT",
      headers: withTrustedAdminOrigin({
        cookie,
        "content-type": "application/json"
      }),
      body: JSON.stringify({
        ...initialBody.settings.publication,
        generatedObjectWriteConcurrency: 33
      })
    });
    expect(invalidGeneratedObjectWriteConcurrency.status).toBe(400);
    await expect(invalidGeneratedObjectWriteConcurrency.json()).resolves.toMatchObject({
      error: {
        code: "RUNTIME_SETTINGS_VALIDATION_FAILED",
        messageKey: "errors.runtimeSettingsValidationFailed"
      }
    });

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
    searchTasks: 64,
    objectStoreRequests: 128,
    memoryBytes: 1_073_741_824,
    cpuConcurrency: 256
  };
}

type RuntimeSettingFieldCase = {
  id: string;
  section: Exclude<keyof RuntimeSettingsSnapshot, "activeModel">;
  route: "rate-limits" | "worker" | "publication" | "graph" | "maintenance" | "search";
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
    value: 1,
    prepare: (section) => { section.sourceObjectReadConcurrency = 1; }
  },
  { id: "worker.sourceObjectReadConcurrency", section: "worker", route: "worker", path: ["sourceObjectReadConcurrency"], value: 1 },
  { id: "worker.claimBatchSize", section: "worker", route: "worker", path: ["claimBatchSize"], value: 11 },
  { id: "worker.pollIntervalMs", section: "worker", route: "worker", path: ["pollIntervalMs"], value: 1_001 },
  { id: "worker.lockTtlSeconds", section: "worker", route: "worker", path: ["lockTtlSeconds"], value: 901 },
  { id: "worker.heartbeatIntervalMs", section: "worker", route: "worker", path: ["heartbeatIntervalMs"], value: 15_001 },
  { id: "worker.jobMaxAttempts", section: "worker", route: "worker", path: ["jobMaxAttempts"], value: 4 },
  { id: "worker.jobRetryDelayMs", section: "worker", route: "worker", path: ["jobRetryDelayMs"], value: 30_001 },
  { id: "worker.completedJobRetentionDays", section: "worker", route: "worker", path: ["completedJobRetentionDays"], value: 8 },
  { id: "worker.hardDeleteConcurrency", section: "worker", route: "worker", path: ["hardDeleteConcurrency"], value: 2 },
  { id: "worker.hardDeleteDatabaseBatchSize", section: "worker", route: "worker", path: ["hardDeleteDatabaseBatchSize"], value: 999 },
  { id: "worker.hardDeleteObjectBatchSize", section: "worker", route: "worker", path: ["hardDeleteObjectBatchSize"], value: 999 },
  { id: "worker.hardDeleteMaxAttempts", section: "worker", route: "worker", path: ["hardDeleteMaxAttempts"], value: 4 },
  { id: "worker.hardDeleteRetryDelayMs", section: "worker", route: "worker", path: ["hardDeleteRetryDelayMs"], value: 60_001 },
  { id: "publication.mode", section: "publication", route: "publication", path: ["mode"], value: "manual" },
  { id: "publication.intervalSeconds", section: "publication", route: "publication", path: ["intervalSeconds"], value: 301 },
  {
    id: "publication.roleConcurrency",
    section: "publication",
    route: "publication",
    path: ["roleConcurrency"],
    value: 2,
    prepare: (section) => { section.claimBatchSize = 2; }
  },
  { id: "publication.claimBatchSize", section: "publication", route: "publication", path: ["claimBatchSize"], value: 2 },
  { id: "publication.generatedObjectWriteConcurrency", section: "publication", route: "publication", path: ["generatedObjectWriteConcurrency"], value: 7 },
  { id: "publication.directoryIndexMaxEntries", section: "publication", route: "publication", path: ["directoryIndexMaxEntries"], value: 201 },
  { id: "publication.directoryIndexMaxBytes", section: "publication", route: "publication", path: ["directoryIndexMaxBytes"], value: 65_537 },
  { id: "graph.candidateLimit", section: "graph", route: "graph", path: ["candidateLimit"], value: 201 },
  { id: "graph.acceptedEdgeLimit", section: "graph", route: "graph", path: ["acceptedEdgeLimit"], value: 41 },
  { id: "graph.searchDefaultDepth", section: "graph", route: "graph", path: ["searchDefaultDepth"], value: 0 },
  { id: "graph.searchMaxDepth", section: "graph", route: "graph", path: ["searchMaxDepth"], value: 1 },
  { id: "graph.searchDefaultFanout", section: "graph", route: "graph", path: ["searchDefaultFanout"], value: 11 },
  { id: "graph.searchMaxFanout", section: "graph", route: "graph", path: ["searchMaxFanout"], value: 26 },
  { id: "graph.modelReviewEnabled", section: "graph", route: "graph", path: ["modelReviewEnabled"], value: false },
  { id: "graph.genericPhraseThreshold", section: "graph", route: "graph", path: ["genericPhraseThreshold"], value: 5 },
  { id: "maintenance.knowledgeBaseMaintenanceMode", section: "maintenance", route: "maintenance", path: ["knowledgeBaseMaintenanceMode"], value: "automatic" },
  { id: "maintenance.knowledgeBaseMaintenanceScanIntervalSeconds", section: "maintenance", route: "maintenance", path: ["knowledgeBaseMaintenanceScanIntervalSeconds"], value: 3_600 },
  { id: "maintenance.knowledgeBaseMaintenanceConcurrency", section: "maintenance", route: "maintenance", path: ["knowledgeBaseMaintenanceConcurrency"], value: 2 },
  { id: "maintenance.reconciliationEnabled", section: "maintenance", route: "maintenance", path: ["reconciliationEnabled"], value: false },
  { id: "maintenance.scanBatchSize", section: "maintenance", route: "maintenance", path: ["scanBatchSize"], value: 501 },
  { id: "maintenance.deletionBatchSize", section: "maintenance", route: "maintenance", path: ["deletionBatchSize"], value: 101 },
  { id: "maintenance.quarantineGracePeriodSeconds", section: "maintenance", route: "maintenance", path: ["quarantineGracePeriodSeconds"], value: 86_401 },
  { id: "maintenance.maxAttempts", section: "maintenance", route: "maintenance", path: ["maxAttempts"], value: 6 },
  { id: "maintenance.retryDelayMs", section: "maintenance", route: "maintenance", path: ["retryDelayMs"], value: 30_001 },
  { id: "maintenance.projectionRepairConcurrency", section: "maintenance", route: "maintenance", path: ["projectionRepairConcurrency"], value: 5 },
  { id: "maintenance.projectionRepairDatabaseBatchSize", section: "maintenance", route: "maintenance", path: ["projectionRepairDatabaseBatchSize"], value: 2_001 },
  { id: "maintenance.projectionRepairObjectWriteConcurrency", section: "maintenance", route: "maintenance", path: ["projectionRepairObjectWriteConcurrency"], value: 5 },
  { id: "maintenance.lexicalRebuildConcurrency", section: "maintenance", route: "maintenance", path: ["lexicalRebuildConcurrency"], value: 5 },
  { id: "maintenance.lexicalRebuildSourceReadConcurrency", section: "maintenance", route: "maintenance", path: ["lexicalRebuildSourceReadConcurrency"], value: 3 },
  { id: "maintenance.lexicalRebuildMaxInFlightSourceBytes", section: "maintenance", route: "maintenance", path: ["lexicalRebuildMaxInFlightSourceBytes"], value: 67_108_865 },
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
  { id: "search.stagingRetentionHours", section: "search", route: "search", path: ["stagingRetentionHours"], value: 25 },
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
  public runningSourceFileJobCount = 0;
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

import { randomUUID } from "node:crypto";
import type { RuntimeConfig } from "../../config.js";
import { resolveWorkerConfig } from "../../config.js";
import { closeDatabaseClient, createDatabaseClient } from "../../db/client.js";
import { assertRuntimeSchemaGeneration } from "../../db/migrations.js";
import { createRuntimeSettingsRepository } from
  "../../runtime-settings/repository.js";
import { createNodeJiebaTokenizer } from
  "../../infrastructure/tokenization/nodejieba-tokenizer.js";
import { createRuntimeSearchProvider } from "../../runtime/search-provider.js";
import { createStorageVnextSearchSettings } from
  "../../storage-vnext/search/settings.js";
import { createRuntimeSettingsDefaults, sanitizeSearchSettings } from
  "../../runtime-settings/validation.js";
import type { RuntimeWorkerSettings } from
  "../../runtime-settings/types.js";
import {
  sanitizeWorkerSettings,
  validateWorkerSettings
} from "../../runtime-settings/validation.js";
import {
  createRedisClient,
  createRedisKeyBuilder
} from "../../redis/coordination.js";
import { createUnifiedMaintenanceLane } from
  "../application/unified-maintenance-lane.js";
import { createContinuousBackgroundWindow } from
  "../application/continuous-background-window.js";
import { createDocumentWorkerObservability } from
  "../application/document-worker-observability.js";
import { deriveDocumentWorkerRuntimeSettings } from
  "../application/document-worker-settings.js";
import type { ResolvedDocumentWorkerRuntimeSettings } from
  "../application/document-worker-settings.js";
import { createProductionBackgroundRuntime } from
  "./production-background-runtime.js";
import { createProductionDocumentFixedProcessor } from
  "./production-document-fixed-processor.js";
import { safeWorkerErrorDiagnostic } from
  "./production-document-error-diagnostic.js";
import { createRedisWorkerWakeup } from "./redis-worker-wakeup.js";
import { createPostgresEmbeddingConfigurationRepository } from
  "../../semantic/infrastructure/postgres-embedding-configuration-repository.js";
import { resolveGraphRagPoolSize } from
  "../../semantic/graphrag/graph-rag-runtime.js";
import type { DocumentResourceCapacityInput } from
  "../application/document-resource-capacity.js";
import { createPostgresStorageVnextWebhookRepository } from
  "../../storage-vnext/webhook/postgres-repository.js";
import { runWebhookDeliveryLoop } from
  "../../storage-vnext/webhook/runtime.js";
import { createStorageVnextWebhookWorker } from
  "../../storage-vnext/webhook/worker.js";

export async function runUnifiedWorkerProduction(config: RuntimeConfig): Promise<void> {
  const defaults = resolveWorkerConfig(config);
  const sql = createDatabaseClient(config, { role: "worker" });
  const redis = createRedisClient(config);
  const controller = new AbortController();
  const stop = (signal: NodeJS.Signals) => controller.abort(
    Object.assign(new Error(`Worker received ${signal}`), { code: "WORKER_SHUTDOWN" })
  );
  const onSigint = () => stop("SIGINT");
  const onSigterm = () => stop("SIGTERM");
  let webhookDeliveryLoop: Promise<void> | null = null;
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  try {
    await assertRuntimeSchemaGeneration(sql);
    let redisConnected = false;
    try {
      await redis.connect();
      redisConnected = true;
    } catch (error) {
      console.warn(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "warn",
        event: "worker.redis_acceleration_unavailable",
        fields: { errorCode: safeWorkerErrorDiagnostic(error).errorCode }
      }));
    }
    const settings = await readWorkerSettings(sql, defaults);
    const webhookWorker = createStorageVnextWebhookWorker({
      repository: createPostgresStorageVnextWebhookRepository(sql),
      owner: `webhook-worker-${randomUUID()}`,
      claimLimit: Math.min(100, settings.claimBatchSize),
      maximumAttempts: settings.jobMaxAttempts,
      retryDelayMilliseconds: settings.jobRetryDelayMs,
      requestTimeoutMilliseconds: Math.max(
        1,
        Math.floor(settings.lockTtlSeconds * 1_000 * 0.8)
      ),
      clock: () => new Date().toISOString()
    });
    webhookDeliveryLoop = runWebhookDeliveryLoop({
      worker: webhookWorker,
      pollIntervalMilliseconds: settings.pollIntervalMs,
      leaseDurationMilliseconds: settings.lockTtlSeconds * 1_000,
      signal: controller.signal,
      onCycle(outcome) {
        if (outcome.claimed > 0) {
          console.info(JSON.stringify({
            timestamp: new Date().toISOString(),
            level: "info",
            event: "worker.webhook_delivery_cycle",
            fields: outcome
          }));
        }
      },
      onError(error) {
        console.error(JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "error",
          event: "worker.webhook_delivery_failed",
          fields: safeWorkerErrorDiagnostic(error)
        }));
      }
    });
    const wakeup = createRedisWorkerWakeup({
      publisher: redis,
      createSubscriber: () => redis.duplicate(),
      channel: createRedisKeyBuilder(
        config.redis.keyPrefix ?? "focowiki"
      )("worker", "wakeup")
    });
    let wakeupStarted = false;
    try {
      if (!redisConnected) throw new Error("Redis wakeup is unavailable");
      await wakeup.start();
      wakeupStarted = true;
    } catch (error) {
      console.warn(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "warn",
        event: "worker.redis_wakeup_unavailable",
        fields: { errorCode: safeWorkerErrorDiagnostic(error).errorCode }
      }));
    }
    const workerId = `worker-${randomUUID()}`;
    const observability = createDocumentWorkerObservability({
      write(event) {
        console.info(JSON.stringify({
          timestamp: new Date().toISOString(),
          ...event
        }));
      }
    });
    const resourceCapacity = await waitForDocumentResourceCapacity({
      read: () => readDocumentResourceCapacity(sql, config, settings),
      wait: waitForWork,
      signal: controller.signal,
      pollIntervalMs: settings.pollIntervalMs,
      warn() {
        console.warn(JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "warn",
          event: "worker.configuration_waiting",
          fields: { requiredConfiguration: "generation_and_embedding" }
        }));
      }
    });
    const searchSettings = await readSearchSettings(sql, config);
    if (!config.search) throw new Error("Worker search configuration is missing");
    const tokenizer = createNodeJiebaTokenizer();
    const searchProvider = createRuntimeSearchProvider({
      config: config.search,
      settings: searchSettings,
      indexDefinition: createStorageVnextSearchSettings({
        searchCutoffMs: searchSettings.engineSearchCutoffMs
      }),
      tokenizer
    });
    let processor: ReturnType<typeof createProductionDocumentFixedProcessor> | null = null;
    let backgroundRuntime: ReturnType<typeof createProductionBackgroundRuntime> | null = null;
    let runtimeRefresh: Promise<void> | null = null;
    try {
      processor = createProductionDocumentFixedProcessor({
        sql,
        config,
        workerConfig: settings,
        resourceCapacity,
        searchSettings,
        tokenizer,
        searchProvider,
        workerId,
        observability
      });
      backgroundRuntime = createProductionBackgroundRuntime({
        sql,
        config,
        workerConfig: settings,
        resourceCapacity,
        searchProvider,
        tokenizer,
        workerId,
        observability
      });
      await processor.start();
      runtimeRefresh = watchDocumentWorkerRuntime({
        initial: { workerConfig: settings, resourceCapacity },
        async read() {
          const workerConfig = await readWorkerSettings(sql, defaults);
          const nextCapacity = await readDocumentResourceCapacity(
            sql,
            config,
            workerConfig
          );
          return nextCapacity
            ? { workerConfig, resourceCapacity: nextCapacity }
            : null;
        },
        async apply(next) {
          await processor!.updateRuntime(next);
          Object.assign(settings, next.workerConfig);
          console.info(JSON.stringify({
            timestamp: new Date().toISOString(),
            level: "info",
            event: "worker.runtime_configuration_applied",
            fields: { resourceCapacity: next.resourceCapacity }
          }));
        },
        wait: waitForWork,
        signal: controller.signal,
        pollIntervalMs: settings.pollIntervalMs,
        onError(error) {
          console.error(JSON.stringify({
            timestamp: new Date().toISOString(),
            level: "error",
            event: "worker.runtime_configuration_refresh_failed",
            fields: safeWorkerErrorDiagnostic(error)
          }));
        }
      });
      const background = createUnifiedMaintenanceLane({
        schedule: {
          mutation: 100,
          deletion: 1_000,
          maintenance: 5_000,
          orphan: 30_000
        },
        run: (workClass, signal) => backgroundRuntime!.run(workClass, signal)
      });
      const backgroundWindow = createContinuousBackgroundWindow({
        capacity: 1,
        claim: background.claim,
        process: background.process,
        waitForWork: (signal) => wakeupStarted
          ? wakeup.wait(settings.pollIntervalMs, signal)
          : waitForWork(settings.pollIntervalMs, signal),
        onError(error, work) {
          const diagnostic = safeWorkerErrorDiagnostic(error);
          console.error(JSON.stringify({
            timestamp: new Date().toISOString(),
            level: "error",
            event: "worker.work_failed",
            fields: {
              lane: "background",
              workPublicId: work.publicId,
              ...diagnostic
            }
          }));
        }
      });
      console.info(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "info",
        event: "worker.started",
        fields: { workerId, resourceCapacity }
      }));
      try {
        await Promise.all([
          processor.run(controller.signal),
          backgroundWindow.run(controller.signal),
          webhookDeliveryLoop,
          runtimeRefresh
        ]);
      } catch (error) {
        console.error(JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "error",
          event: "worker.runtime_failed",
          fields: safeWorkerErrorDiagnostic(error)
        }));
        throw error;
      }
    } finally {
      await settleDocumentWorkerRuntime({
        controller,
        cleanup: [
          () => runtimeRefresh ?? Promise.resolve(),
          () => processor?.close() ?? Promise.resolve(),
          () => backgroundRuntime?.close() ?? Promise.resolve(),
          () => searchProvider.close(),
          () => wakeup.close()
        ]
      });
    }
  } finally {
    if (!controller.signal.aborted) {
      controller.abort(Object.assign(
        new Error("Worker runtime is stopping"),
        { code: "WORKER_SHUTDOWN" }
      ));
    }
    await webhookDeliveryLoop?.catch(() => undefined);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    await redis.close().catch(() => undefined);
    await closeDatabaseClient(sql);
  }
}

export async function settleDocumentWorkerRuntime(input: Readonly<{
  controller: AbortController;
  cleanup: readonly (() => Promise<unknown>)[];
}>): Promise<void> {
  if (!input.controller.signal.aborted) {
    input.controller.abort(Object.assign(
      new Error("Worker runtime is stopping"),
      { code: "WORKER_SHUTDOWN" }
    ));
  }
  await Promise.allSettled(input.cleanup.map((cleanup) => cleanup()));
}

type DocumentWorkerRuntimeState = {
  workerConfig: ResolvedDocumentWorkerRuntimeSettings;
  resourceCapacity: DocumentResourceCapacityInput;
};

export async function watchDocumentWorkerRuntime(input: {
  initial: DocumentWorkerRuntimeState;
  read(): Promise<DocumentWorkerRuntimeState | null>;
  apply(state: DocumentWorkerRuntimeState): Promise<void>;
  wait(milliseconds: number, signal: AbortSignal): Promise<void>;
  signal: AbortSignal;
  pollIntervalMs: number;
  onError?(error: unknown): void;
}): Promise<void> {
  let fingerprint = runtimeStateFingerprint(input.initial);
  while (!input.signal.aborted) {
    await input.wait(input.pollIntervalMs, input.signal);
    if (input.signal.aborted) break;
    try {
      const next = await input.read();
      if (!next) continue;
      const nextFingerprint = runtimeStateFingerprint(next);
      if (nextFingerprint === fingerprint) continue;
      await input.apply(next);
      fingerprint = nextFingerprint;
    } catch (error) {
      input.onError?.(error);
    }
  }
}

function runtimeStateFingerprint(state: DocumentWorkerRuntimeState): string {
  return JSON.stringify({
    workerConfig: state.workerConfig,
    resourceCapacity: state.resourceCapacity
  });
}

async function readDocumentResourceCapacity(
  sql: ReturnType<typeof createDatabaseClient>,
  config: RuntimeConfig,
  settings: ResolvedDocumentWorkerRuntimeSettings
): Promise<DocumentResourceCapacityInput | null> {
  const runtime = createRuntimeSettingsRepository(sql);
  const [model, embeddingConfigurations, searchRecord] = await Promise.all([
    runtime.getActiveModel(),
    createPostgresEmbeddingConfigurationRepository(sql).list(),
    runtime.getSetting("search")
  ]);
  const embedding = embeddingConfigurations.find(
    (configuration) => configuration.lifecycleStatus === "active"
  );
  if (!model || !embedding) return null;
  const defaults = createRuntimeSettingsDefaults(config);
  const search = sanitizeSearchSettings({
    ...defaults.search,
    ...(searchRecord?.value ?? {})
  } as never);
  return {
    documentConcurrency: settings.sourceFileConcurrency,
    sourceObjectReadConcurrency: settings.sourceObjectReadConcurrency,
    generationModelConcurrency: model.suggestionConcurrency,
    graphRagConcurrency: resolveGraphRagPoolSize(settings.sourceFileConcurrency),
    embeddingConcurrency: embedding.concurrency,
    databaseConnectionLimit: config.database.workerPoolMax ?? 8,
    searchConcurrency: search.maxInFlightTasks
  };
}

async function readSearchSettings(
  sql: ReturnType<typeof createDatabaseClient>,
  config: RuntimeConfig
) {
  const runtime = createRuntimeSettingsRepository(sql);
  const record = await runtime.getSetting("search");
  const defaults = createRuntimeSettingsDefaults(config);
  return sanitizeSearchSettings({
    ...defaults.search,
    ...(record?.value ?? {})
  } as never);
}

export async function waitForDocumentResourceCapacity(input: {
  read(): Promise<DocumentResourceCapacityInput | null>;
  wait(milliseconds: number, signal: AbortSignal): Promise<void>;
  warn(): void;
  signal: AbortSignal;
  pollIntervalMs: number;
}): Promise<DocumentResourceCapacityInput> {
  let warningReported = false;
  while (!input.signal.aborted) {
    const capacity = await input.read();
    if (capacity) return capacity;
    if (!warningReported) {
      input.warn();
      warningReported = true;
    }
    await input.wait(input.pollIntervalMs, input.signal);
  }
  throw input.signal.reason instanceof Error
    ? input.signal.reason
    : new Error("Worker configuration wait was aborted");
}

async function readWorkerSettings(
  sql: ReturnType<typeof createDatabaseClient>,
  defaults: ReturnType<typeof resolveWorkerConfig>
): Promise<ResolvedDocumentWorkerRuntimeSettings> {
  const record = await createRuntimeSettingsRepository(sql).getSetting("worker");
  const stored = !record || validateWorkerSettings(record.value).length > 0
    ? null : sanitizeWorkerSettings(record.value as RuntimeWorkerSettings);
  return deriveDocumentWorkerRuntimeSettings({
    deployment: defaults,
    stored: stored ? {
      sourceFileConcurrency: stored.sourceFileConcurrency,
      s3Concurrency: stored.sourceObjectReadConcurrency,
      jobMaxAttempts: stored.jobMaxAttempts,
      jobRetryDelayMs: stored.jobRetryDelayMs,
      completedJobRetentionDays: stored.completedJobRetentionDays
    } : null
  });
}

function waitForWork(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    timer.unref?.();
    signal.addEventListener("abort", finish, { once: true });
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}

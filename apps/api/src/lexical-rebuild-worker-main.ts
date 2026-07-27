import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import type {
  LexicalRebuildSettingsSnapshot
} from "./application/ports/lexical-rebuild-work-repository.js";
import { loadRuntimeConfig } from "./config.js";
import { closeDatabaseClient, createDatabaseClient } from "./db/client.js";
import { assertRuntimeSchemaGeneration } from "./db/migrations.js";
import { createPostgresLexicalRebuildRepository } from "./infrastructure/postgres/lexical-rebuild-repository.js";
import { createPostgresLexicalRebuildWorkRepository } from "./infrastructure/postgres/lexical-rebuild-work-repository.js";
import { createPostgresRoleJobRepository } from "./infrastructure/postgres/role-job-repository.js";
import { createPostgresSearchProjectionRepository } from "./infrastructure/postgres/search-projection-repository.js";
import {
  assertNodeJiebaRuntimeAvailable,
  createNodeJiebaTokenizer
} from "./infrastructure/tokenization/nodejieba-tokenizer.js";
import { createRuntimeLogger } from "./logger.js";
import { bootstrapLexicalRebuildWork } from "./maintenance/lexical-rebuild-bootstrap.js";
import { runLexicalCapacityRefill } from "./maintenance/lexical-rebuild-capacity.js";
import { runLexicalRebuildFinalization } from "./maintenance/lexical-rebuild-finalization.js";
import { processLexicalRebuildClaims } from "./maintenance/lexical-rebuild-worker.js";
import { createLexicalSourceReader } from "./maintenance/lexical-source-reader.js";
import { createRedisClient, createRedisCoordinator } from "./redis/coordination.js";
import { createResilientRedisCoordinator } from "./redis/resilient-coordinator.js";
import { registerWorkerRedisRuntimeEvents } from "./redis/worker-runtime.js";
import { createProcessResourceBudgets } from "./runtime/resource-budget.js";
import { createResourceBudgetReporter } from "./runtime/resource-budget-reporter.js";
import { resolveResourceBudgetLimits } from "./runtime-settings/resource-budget-settings.js";
import { createRuntimeSettingsRepository } from "./runtime-settings/repository.js";
import { createRuntimeSettingsService } from "./runtime-settings/service.js";
import { createS3StorageAdapter } from "./storage/s3.js";

const BOOTSTRAP_INTERVAL_MS = 60_000;
const MAX_PLANNED_KNOWLEDGE_BASES_PER_INTERVAL = 100;
const MAX_CLAIM_CYCLES_PER_SETTINGS_REFRESH = 2;

loadLocalEnvFile();
const config = loadRuntimeConfig();

if (process.argv.includes("--healthcheck")) {
  await runHealthcheck();
} else {
  await runLexicalRebuildWorker();
}

async function runLexicalRebuildWorker(): Promise<void> {
  const logger = createRuntimeLogger(config, console, {
    streamName: "lexical-rebuild-worker"
  });
  const sql = createDatabaseClient(config, { role: "lexical-rebuild-worker" });
  const redisClient = createRedisClient(config);
  const abort = new AbortController();
  let redisConnected = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => abort.abort());
  }
  registerWorkerRedisRuntimeEvents({
    client: redisClient,
    logger,
    role: "lexical_rebuild"
  });

  try {
    await assertRuntimeSchemaGeneration(sql);
    await redisClient.connect();
    redisConnected = true;
    const redis = createResilientRedisCoordinator({
      client: redisClient,
      coordinator: createRedisCoordinator(redisClient),
      sessionWrites: "best_effort"
    });
    const runtimeSettings = createRuntimeSettingsService({
      config,
      repository: createRuntimeSettingsRepository(sql),
      redis
    });
    await runtimeSettings.ensureBootstrapped();
    let lastValidSnapshot = await runtimeSettings.getSnapshot();
    const tokenizer = createNodeJiebaTokenizer();
    const storage = createS3StorageAdapter(config.storage);
    const rebuilds = createPostgresLexicalRebuildRepository(sql);
    const work = createPostgresLexicalRebuildWorkRepository(sql);
    const search = createPostgresSearchProjectionRepository(sql);
    const roleJobs = createPostgresRoleJobRepository(sql);
    const budgets = createProcessResourceBudgets(
      resolveResourceBudgetLimits(lastValidSnapshot)
    );
    const resourceBudgetReporter = createResourceBudgetReporter({ logger });
    const sourceReader = createLexicalSourceReader({
      storage,
      concurrency: lastValidSnapshot.maintenance.lexicalRebuildSourceReadConcurrency,
      maxInFlightBytes:
        lastValidSnapshot.maintenance.lexicalRebuildMaxInFlightSourceBytes,
      maxObjectBytes: config.pagination.generatedContentMaxBytes
    });
    const workerId = `lexical-rebuild-worker-${randomUUID()}`;
    let lastBootstrapAt = 0;

    logger.info("Lexical rebuild worker started", { workerId });
    while (!abort.signal.aborted) {
      try {
        const snapshot = await runtimeSettings.getSnapshot()
          .then((next) => {
            lastValidSnapshot = next;
            return next;
          })
          .catch((error) => {
            logger.warn(
              "Lexical rebuild settings refresh failed",
              { code: "LEXICAL_REBUILD_SETTINGS_REFRESH_FAILED" },
              error
            );
            return lastValidSnapshot;
          });
        const settings = readSettings(snapshot.maintenance);
        sourceReader.updateLimits({
          concurrency: settings.sourceReadConcurrency,
          maxInFlightBytes: settings.maxInFlightSourceBytes
        });
        budgets.update({
          sourceObjectRead: settings.sourceReadConcurrency,
          databaseMutation: settings.databaseWriteConcurrency
        });
        resourceBudgetReporter.report(budgets);

        const cycleNow = new Date();
        const settingsRevision = await readSettingsRevision(sql);
        if (cycleNow.getTime() - lastBootstrapAt >= BOOTSTRAP_INTERVAL_MS) {
          await bootstrapLexicalRebuildWork({
            rebuilds,
            tokenizer,
            now: cycleNow.toISOString()
          });
          for (
            let planned = 0;
            planned < MAX_PLANNED_KNOWLEDGE_BASES_PER_INTERVAL;
            planned += 1
          ) {
            const result = await work.planNext({
              targetGenerationId: `generation-lexical-${randomUUID()}`,
              settingsRevision,
              settings,
              maxAttempts: snapshot.worker.jobMaxAttempts,
              now: cycleNow.toISOString()
            });
            if (!result) break;
          }
          lastBootstrapAt = cycleNow.getTime();
        }

        const capacity = await runLexicalCapacityRefill({
          concurrency: settings.concurrency,
          databaseBatchSize: settings.databaseBatchSize,
          maxClaimCycles: MAX_CLAIM_CYCLES_PER_SETTINGS_REFRESH,
          async claim() {
            const claimedAt = new Date();
            return work.claimBatch({
              workerId,
              leaseTokenPrefix: randomUUID(),
              limit: settings.claimBatchSize,
              settingsRevision,
              settings,
              now: claimedAt.toISOString(),
              leaseExpiresAt: new Date(
                claimedAt.getTime() + snapshot.worker.lockTtlSeconds * 1_000
              ).toISOString()
            });
          },
          async onClaim(claims) {
            await roleJobs.heartbeat({
              role: "lexical_rebuild",
              workerId,
              jobIds: claims.map((claim) => claim.sourceFileId),
              now: new Date().toISOString()
            });
          },
          process: (claims) =>
            processLexicalRebuildClaims({
              repository: work,
              sourceReader,
              tokenizer,
              databaseWriteBudget: budgets.databaseMutation,
              workerId,
              claims,
              databaseBatchSize: settings.databaseBatchSize,
              retryDelayMs: snapshot.worker.jobRetryDelayMs,
              leaseDurationMs: snapshot.worker.lockTtlSeconds * 1_000,
              heartbeatIntervalMs: snapshot.worker.heartbeatIntervalMs,
              onHeartbeatError(error) {
                logger.warn(
                  "Lexical rebuild claim heartbeat failed",
                  { code: "LEXICAL_REBUILD_HEARTBEAT_FAILED" },
                  error
                );
              },
              onMetrics(metrics) {
                logger.info("Lexical rebuild processing metrics", metrics);
              }
            })
        });
        if (capacity.claimed > 0) {
          logger.info("Lexical rebuild claim batch completed", {
            claimCycles: capacity.claimCycles,
            claimed: capacity.claimed,
            completed: capacity.completed,
            retried: capacity.retried,
            drained: capacity.drained
          });
          if (!capacity.drained) continue;
        }

        const finalized = await runLexicalRebuildFinalization({
          work,
          rebuilds,
          search,
          workerId,
          leaseToken: randomUUID(),
          now: new Date(),
          leaseDurationMs: snapshot.worker.lockTtlSeconds * 1_000,
          retryDelayMs: snapshot.worker.jobRetryDelayMs,
          cleanupBatchSize: settings.databaseBatchSize
        });
        await roleJobs.heartbeat({
          role: "lexical_rebuild",
          workerId,
          jobIds: [],
          now: new Date().toISOString()
        });
        if (!finalized) {
          await sleep(snapshot.worker.pollIntervalMs, abort.signal);
        }
      } catch (error) {
        logger.error(
          "Lexical rebuild worker cycle failed",
          { code: "LEXICAL_REBUILD_WORKER_CYCLE_FAILED" },
          error
        );
        await sleep(lastValidSnapshot.worker.jobRetryDelayMs, abort.signal);
      }
    }
  } finally {
    if (redisConnected) await redisClient.close();
    await closeDatabaseClient(sql);
  }
}

function readSettings(
  maintenance: {
    lexicalRebuildConcurrency: number;
    lexicalRebuildSourceReadConcurrency: number;
    lexicalRebuildDatabaseWriteConcurrency: number;
    lexicalRebuildClaimBatchSize: number;
    lexicalRebuildDatabaseBatchSize: number;
    lexicalRebuildMaxInFlightSourceBytes: number;
  }
): LexicalRebuildSettingsSnapshot {
  return {
    concurrency: maintenance.lexicalRebuildConcurrency,
    sourceReadConcurrency: maintenance.lexicalRebuildSourceReadConcurrency,
    databaseWriteConcurrency: maintenance.lexicalRebuildDatabaseWriteConcurrency,
    claimBatchSize: maintenance.lexicalRebuildClaimBatchSize,
    databaseBatchSize: maintenance.lexicalRebuildDatabaseBatchSize,
    maxInFlightSourceBytes: maintenance.lexicalRebuildMaxInFlightSourceBytes
  };
}

async function readSettingsRevision(
  sql: ReturnType<typeof createDatabaseClient>
): Promise<number> {
  const rows = await sql<Array<{ revision: number }>>`
    SELECT coalesce(max(version), 0)::int AS revision
    FROM focowiki.runtime_settings
  `;
  return Number(rows[0]?.revision ?? 0);
}

async function runHealthcheck(): Promise<void> {
  assertNodeJiebaRuntimeAvailable();
  const sql = createDatabaseClient(config, { role: "lexical-rebuild-worker" });
  const redisClient = createRedisClient(config);
  const storage = createS3StorageAdapter(config.storage);
  let redisConnected = false;
  try {
    await assertRuntimeSchemaGeneration(sql);
    await sql`
      SELECT
        (SELECT count(*) FROM focowiki.knowledge_base_lexical_rebuilds)
          AS rebuild_count,
        (SELECT count(*) FROM focowiki.lexical_rebuild_work_items)
          AS work_item_count
    `;
    await redisClient.connect();
    redisConnected = true;
    await redisClient.ping();
    await storage.checkHealth?.();
  } finally {
    if (redisConnected) await redisClient.close();
    await closeDatabaseClient(sql);
  }
}

async function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function loadLocalEnvFile(): void {
  if (process.env.ENV_FILE) {
    loadEnvFile(process.env.ENV_FILE);
    return;
  }
  const candidates = [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")];
  const envFile = candidates.find((candidate) => existsSync(candidate));
  if (envFile) loadEnvFile(envFile);
}

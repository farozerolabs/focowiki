import { serve } from "@hono/node-server";
import { S3Client } from "@aws-sdk/client-s3";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { loadRuntimeConfig } from "./config.js";
import { createDatabaseClient } from "./db/client.js";
import { assertRuntimeSchemaGeneration } from "./db/migrations.js";
import { createS3ClientConfig } from "./storage/s3.js";
import { createAdminApiApp, createPublicOpenApiApp } from "./server.js";
import { connectApiRedis } from "./redis/api-runtime.js";
import { createRuntimeLogger } from "./logger.js";
import {
  assertNodeJiebaRuntimeAvailable
} from "./infrastructure/tokenization/nodejieba-tokenizer.js";
import {
  createDynamicRuntimeMeilisearchSearchTransport
} from "./infrastructure/meilisearch/runtime-meilisearch-transport.js";
import { createRuntimeSettingsService } from "./runtime-settings/service.js";
import { createRuntimeSettingsRepository } from "./runtime-settings/repository.js";
import { runRuntimeDeploymentHealthcheck } from "./runtime/deployment-healthcheck.js";
import { createPostgresStorageVnextCatalogRepository } from "./storage-vnext/catalog/postgres-repository.js";
import { createPostgresStorageVnextReleaseRepository } from "./storage-vnext/release/postgres-repository.js";
import { createPostgresStorageVnextAuditRepository } from "./storage-vnext/audit/postgres-repository.js";
import { createPostgresStorageVnextActiveSearchProjectionRepository } from "./storage-vnext/search/postgres-active-projection.js";
import { createPostgresStorageVnextSearchHydration } from "./storage-vnext/search/postgres-hydration.js";
import { createStorageVnextActiveSearch } from "./storage-vnext/search/active-search.js";
import { createPostgresStorageVnextAdminRead } from "./storage-vnext/api/postgres-admin-read.js";
import { createPostgresStorageVnextApiKeyRepository } from "./storage-vnext/api/postgres-api-key.js";
import { createPostgresStorageVnextAdminProcessing } from "./storage-vnext/api/postgres-admin-processing.js";
import { createPostgresStorageVnextMaintenanceRepository } from "./storage-vnext/maintenance/postgres-repository.js";
import { createStorageVnextMaintenanceRequestService } from "./storage-vnext/maintenance/maintenance-coordinator.js";
import { createPostgresStorageVnextWorkflowRepository } from "./storage-vnext/workflow/postgres-repository.js";
import { createPostgresStorageVnextDeletionRepository } from "./storage-vnext/deletion/postgres-repository.js";
import { createStorageVnextDeletionCoordinator } from "./storage-vnext/deletion/deletion-coordinator.js";
import { createRedisStorageVnextDeletionVisibilityCache } from "./storage-vnext/deletion/redis-visibility.js";
import { createPostgresStorageVnextAdminSource } from "./storage-vnext/api/postgres-admin-source.js";
import { createS3StorageVnextSourceBodyStore } from "./storage-vnext/catalog/s3-source-body-store.js";
import { createPostgresStorageVnextOwnershipRepository } from "./storage-vnext/ownership/postgres-repository.js";
import {
  createS3StorageVnextFailedWriteProvider,
  createStorageVnextFailedWriteCompensator
} from "./storage-vnext/ownership/failed-write-compensation.js";
import { createPostgresStorageVnextUploadRepository } from "./storage-vnext/upload/postgres-repository.js";
import { createPostgresStorageVnextUploadTerminalPort } from "./storage-vnext/upload/postgres-terminal.js";
import { createPostgresStorageVnextAdminUpload } from "./storage-vnext/api/postgres-admin-upload.js";
import { createPostgresStorageVnextAdminResourceRead } from "./storage-vnext/api/postgres-admin-resources.js";
import { createPostgresStorageVnextOperationRead } from "./storage-vnext/api/postgres-operation-read.js";
import { createPostgresStorageVnextMutationRepository } from "./storage-vnext/mutation/postgres-repository.js";
import { createStorageVnextMutationCoordinator } from "./storage-vnext/mutation/mutation-coordinator.js";
import { createS3StorageVnextImmutableBodyStore } from "./storage-vnext/ownership/s3-immutable-body-store.js";
import { createStorageVnextImmutableObjectWriter } from "./storage-vnext/ownership/immutable-object-writer.js";
import { createPostgresStorageVnextAdminMutation } from "./storage-vnext/api/postgres-admin-mutation.js";
import { createPostgresStorageVnextAdminCore } from "./storage-vnext/api/postgres-admin-core.js";
import { createPostgresStorageVnextOpenApiWebhooks } from "./storage-vnext/api/postgres-openapi-webhooks.js";
import { createPostgresStorageVnextOpenApiApplication } from "./storage-vnext/api/postgres-openapi-application.js";
import { createPostgresStorageVnextSourceEventRepository } from
  "./storage-vnext/source-events/postgres-repository.js";

loadLocalEnvFile();

const config = loadRuntimeConfig();

if (process.argv.includes("--healthcheck")) {
  await runHealthcheck();
} else {
  await runApi();
}

async function runApi(): Promise<void> {
  const logger = createRuntimeLogger(config, console, { streamName: "api" });
  const s3 = new S3Client(createS3ClientConfig(config.storage));
  const sql = createDatabaseClient(config);
  await assertRuntimeSchemaGeneration(sql);
  const redis = await connectApiRedis({ config, logger });
  const runtimeSettings = createRuntimeSettingsService({
    config,
    repository: createRuntimeSettingsRepository(sql),
    redis
  });
  await runtimeSettings.ensureBootstrapped();
  const storageVnextCatalog = createPostgresStorageVnextCatalogRepository(sql);
  const storageVnextReleases = createPostgresStorageVnextReleaseRepository(sql);
  const initialRuntimeSettings = await runtimeSettings.getSnapshot();
  const completedWorkRetentionMilliseconds =
    initialRuntimeSettings.worker.completedJobRetentionDays * 86_400_000;
  const storageVnextSearch = config.search
    ? createStorageVnextActiveSearch({
        projections: createPostgresStorageVnextActiveSearchProjectionRepository(sql),
        transport: createDynamicRuntimeMeilisearchSearchTransport(
          config.search,
          async () => {
            const snapshot = await runtimeSettings.getSnapshot();
            return {
              timeoutMs: snapshot.search.requestTimeoutMs,
              maxAttempts: snapshot.search.maxAttempts,
              retryDelayMs: snapshot.search.retryDelayMs
            };
          }
        ),
        hydration: createPostgresStorageVnextSearchHydration(sql),
        maxPageSize: config.pagination.maxPageSize,
        overfetchFactor: initialRuntimeSettings.search.overfetchFactor,
        cropLength: initialRuntimeSettings.search.cropLength,
        async resolveRuntimeSettings() {
          const snapshot = await runtimeSettings.getSnapshot();
          return {
            overfetchFactor: snapshot.search.overfetchFactor,
            cropLength: snapshot.search.cropLength
          };
        }
      })
    : null;
  const storageVnextAdminRead = createPostgresStorageVnextAdminRead({
    sql,
    catalog: storageVnextCatalog,
    releases: storageVnextReleases,
    search: storageVnextSearch
  });
  const storageVnextAudit = createPostgresStorageVnextAuditRepository(sql);
  const storageVnextApiKeys = createPostgresStorageVnextApiKeyRepository(sql);
  const storageVnextMaintenance = createPostgresStorageVnextMaintenanceRepository(sql);
  const storageVnextMaintenanceRequests = createStorageVnextMaintenanceRequestService({
    repository: storageVnextMaintenance
  });
  const storageVnextAdminProcessing = createPostgresStorageVnextAdminProcessing({
    sql,
    catalog: storageVnextCatalog,
    releases: storageVnextReleases,
    maintenance: storageVnextMaintenance
  });
  const storageVnextWorkflow = createPostgresStorageVnextWorkflowRepository(sql);
  const storageVnextDeletion = redis
    ? createStorageVnextDeletionCoordinator({
        repository: createPostgresStorageVnextDeletionRepository(sql),
        visibilityCache: createRedisStorageVnextDeletionVisibilityCache({ redis })
      })
    : null;
  const storageVnextAdminSource = storageVnextDeletion
    ? createPostgresStorageVnextAdminSource({
        catalog: storageVnextCatalog,
        workflow: storageVnextWorkflow,
        deletion: storageVnextDeletion,
        runtimeSettings
      })
    : undefined;
  const storageVnextSourceBodies = createS3StorageVnextSourceBodyStore({
    client: s3,
    bucket: config.storage.bucket,
    prefix: config.storage.prefix
  });
  const storageVnextOwnership = createPostgresStorageVnextOwnershipRepository(sql, {
    zeroOwnerGraceMilliseconds:
      initialRuntimeSettings.maintenance.quarantineGracePeriodSeconds * 1_000
  });
  const storageVnextFailedWriteCompensation = createStorageVnextFailedWriteCompensator({
    registrations: storageVnextOwnership,
    provider: createS3StorageVnextFailedWriteProvider({
      client: s3,
      bucket: config.storage.bucket,
      prefix: config.storage.prefix
    })
  });
  const storageVnextUpload = createPostgresStorageVnextUploadRepository(sql, {
    sourceWorkRetentionMilliseconds: completedWorkRetentionMilliseconds
  });
  const storageVnextAdminUpload = createPostgresStorageVnextAdminUpload({
    sql,
    s3,
    bucket: config.storage.bucket,
    prefix: config.storage.prefix,
    catalog: storageVnextCatalog,
    registrations: storageVnextOwnership,
    compensation: storageVnextFailedWriteCompensation,
    describeSource: storageVnextSourceBodies.describeExpected,
    uploads: storageVnextUpload,
    terminal: createPostgresStorageVnextUploadTerminalPort(sql, {
      resultRetentionMilliseconds: completedWorkRetentionMilliseconds
    }),
    runtimeSettings
  });
  const storageVnextAdminResources = createPostgresStorageVnextAdminResourceRead(sql);
  const storageVnextSourceEvents = createPostgresStorageVnextSourceEventRepository(sql);
  const storageVnextOperations = createPostgresStorageVnextOperationRead(sql);
  const storageVnextImmutableBodies = createS3StorageVnextImmutableBodyStore({
    client: s3,
    bucket: config.storage.bucket,
    prefix: config.storage.prefix
  });
  const storageVnextAdminMutation = storageVnextDeletion
    ? createPostgresStorageVnextAdminMutation({
        sql,
        catalog: storageVnextCatalog,
        releases: storageVnextReleases,
        resources: storageVnextAdminResources,
        operations: storageVnextOperations,
        mutations: createStorageVnextMutationCoordinator({
          repository: createPostgresStorageVnextMutationRepository(sql)
        }),
        deletions: storageVnextDeletion,
        sourceBodies: storageVnextSourceBodies,
        objectWriter: createStorageVnextImmutableObjectWriter({
          registrations: storageVnextOwnership,
          bodyStore: storageVnextImmutableBodies,
          compensation: storageVnextFailedWriteCompensation,
          clock: () => new Date().toISOString()
        }),
        runtimeSettings,
        maximumSourceBytes: config.pagination.generatedContentMaxBytes
      })
    : undefined;
  const storageVnextAdminCore = storageVnextAdminMutation
    ? createPostgresStorageVnextAdminCore({
        sql,
        catalog: storageVnextCatalog,
        releases: storageVnextReleases,
        resources: storageVnextAdminResources,
        sourceEvents: storageVnextSourceEvents,
        mutations: storageVnextAdminMutation,
        bodies: storageVnextImmutableBodies,
        maximumGeneratedBytes: config.pagination.generatedContentMaxBytes
      })
    : undefined;
  const storageVnextOpenApi = storageVnextAdminCore
    && storageVnextAdminMutation
    && storageVnextAdminSource
    ? createPostgresStorageVnextOpenApiApplication({
        sql,
        catalog: storageVnextCatalog,
        releases: storageVnextReleases,
        adminRead: storageVnextAdminRead,
        adminCore: storageVnextAdminCore,
        resources: storageVnextAdminMutation,
        sourceEvents: storageVnextSourceEvents,
        source: storageVnextAdminSource,
        search: storageVnextSearch,
        webhooks: createPostgresStorageVnextOpenApiWebhooks(sql, {
          resultRetentionMilliseconds: completedWorkRetentionMilliseconds
        })
      })
    : undefined;
  const sharedServices = {
    config,
    runtimeSettings,
    storageVnextAdminRead,
    storageVnextAudit,
    storageVnextApiKeys,
    storageVnextAdminProcessing,
    storageVnextCatalog,
    storageVnextMaintenanceRequests,
    storageVnextMaintenanceStatus: storageVnextMaintenance,
    storageVnextAdminUpload,
    ...(storageVnextAdminMutation ? { storageVnextAdminMutation } : {}),
    ...(storageVnextAdminCore ? { storageVnextAdminCore } : {}),
    ...(storageVnextOpenApi ? { storageVnextOpenApi } : {}),
    ...(storageVnextAdminSource ? { storageVnextAdminSource } : {}),
    logger,
    ...(redis ? { redis } : {})
  };

  serve({
    fetch: createAdminApiApp(sharedServices).fetch,
    port: config.ports.adminApi
  });

  serve({
    fetch: createPublicOpenApiApp(sharedServices).fetch,
    port: config.ports.publicOpenApi
  });

  logger.info("api.admin_started");
  logger.info("api.public_openapi_started");
}

async function runHealthcheck(): Promise<void> {
  await runRuntimeDeploymentHealthcheck(config, {
    role: "api",
    assertTokenizer: assertNodeJiebaRuntimeAvailable,
    httpPorts: [config.ports.adminApi, config.ports.publicOpenApi]
  });
}

function loadLocalEnvFile() {
  if (process.env.ENV_FILE) {
    loadEnvFile(process.env.ENV_FILE);
    return;
  }

  const candidates = [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")];
  const envFile = candidates.find((candidate) => existsSync(candidate));

  if (envFile) {
    loadEnvFile(envFile);
  }
}

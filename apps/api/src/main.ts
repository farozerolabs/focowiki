import { serve } from "@hono/node-server";
import { S3Client } from "@aws-sdk/client-s3";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import {
  loadRuntimeConfig,
  resolveSecurityConfig,
  type RuntimeConfig
} from "./config.js";
import { createDatabaseClient } from "./db/client.js";
import { assertRuntimeSchemaGeneration } from "./db/migrations.js";
import { createS3ClientConfig } from "./storage/s3.js";
import { createAdminApiApp, createPublicOpenApiApp } from "./server.js";
import { connectApiRedis } from "./redis/api-runtime.js";
import { createRuntimeLogger } from "./logger.js";
import {
  assertNodeJiebaRuntimeAvailable,
  createNodeJiebaTokenizer
} from "./infrastructure/tokenization/nodejieba-tokenizer.js";
import {
  createDynamicRuntimeSearchQueryProvider
} from "./runtime/search-provider.js";
import { createRuntimeSettingsService } from "./runtime-settings/service.js";
import { createRuntimeSettingsRepository } from "./runtime-settings/repository.js";
import { runRuntimeDeploymentHealthcheck } from "./runtime/deployment-healthcheck.js";
import { createPostgresStorageVnextCatalogRepository } from "./storage-vnext/catalog/postgres-repository.js";
import { createPostgresStorageVnextReleaseRepository } from "./storage-vnext/release/postgres-repository.js";
import { createPostgresStorageVnextAuditRepository } from "./storage-vnext/audit/postgres-repository.js";
import { createPostgresStorageVnextActiveSearchProjectionRepository } from "./storage-vnext/search/postgres-active-projection.js";
import { createPostgresStorageVnextSearchHydration } from "./storage-vnext/search/postgres-hydration.js";
import { createStorageVnextActiveSearch } from "./storage-vnext/search/active-search.js";
import { createRedisStorageVnextSemanticPagination } from
  "./storage-vnext/search/redis-semantic-pagination.js";
import { createStorageVnextSearchSettings } from
  "./storage-vnext/search/settings.js";
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
import { createPostgresKnowledgeBaseCreation } from
  "./storage-vnext/api/postgres-knowledge-base-creation.js";
import { createPostgresStorageVnextSourceEventRepository } from
  "./storage-vnext/source-events/postgres-repository.js";
import { createPostgresEmbeddingConfigurationRepository } from
  "./semantic/infrastructure/postgres-embedding-configuration-repository.js";
import { createEmbeddingConfigurationService } from
  "./semantic/embedding/service.js";
import { createOpenAiCompatibleEmbeddingTransport } from
  "./semantic/embedding/openai-compatible-transport.js";
import { createEmbeddingConfigurationAuditAdapter } from
  "./semantic/embedding/audit-adapter.js";
import { loadDeploymentSecret } from "./security/runtime-secrets.js";
import { createEmbeddingGateway } from "./semantic/embedding/gateway.js";
import { createPostgresRerankerConfigurationRepository } from
  "./semantic/infrastructure/postgres-reranker-configuration-repository.js";
import { createRerankerConfigurationService } from
  "./semantic/reranker/service.js";
import { createOpenAiCompatibleRerankerTransport } from
  "./semantic/reranker/openai-compatible-transport.js";
import { createRerankerConfigurationAuditAdapter } from
  "./semantic/reranker/audit-adapter.js";
import { createRerankerGateway } from "./semantic/reranker/gateway.js";
import { createSemanticSearchProductionRuntime } from
  "./semantic/search/production-runtime.js";
import { createPostgresSemanticGenerationRepository } from
  "./semantic/infrastructure/postgres-generation-repository.js";
import { createStorageVnextSemanticSearch } from
  "./storage-vnext/search/semantic-search.js";
import {
  createSemanticAdoptionStageSettings,
  resolveSemanticAdoptionTarget
} from "./semantic/application/adoption-target.js";
import { createSemanticAdoptionService } from
  "./semantic/application/adoption.js";
import { classifySemanticAdoption } from
  "./semantic/application/adoption-policy.js";
import { createPostgresSemanticStageRepository } from
  "./semantic/infrastructure/postgres-stage-repository.js";
import { createStorageVnextMaintenanceCancellationCleanup } from
  "./storage-vnext/maintenance/cancellation-cleanup.js";

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
  const storageVnextActiveSearchProjections =
    createPostgresStorageVnextActiveSearchProjectionRepository(sql);
  const initialRuntimeSettings = await runtimeSettings.getSnapshot();
  const searchTokenizer = config.search
    ? createNodeJiebaTokenizer()
    : undefined;
  const completedWorkRetentionMilliseconds =
    initialRuntimeSettings.worker.completedJobRetentionDays * 86_400_000;
  const storageVnextSearchHydration = createPostgresStorageVnextSearchHydration(sql);
  const searchProvider = config.search
    ? createDynamicRuntimeSearchQueryProvider({
        config: config.search,
        indexDefinition: createStorageVnextSearchSettings({
          searchCutoffMs: initialRuntimeSettings.search.engineSearchCutoffMs
        }),
        ...(searchTokenizer ? { tokenizer: searchTokenizer } : {}),
        async resolveSettings() {
          const snapshot = await runtimeSettings.getSnapshot();
          return snapshot.search;
        }
      })
    : null;
  const lexicalSearch = searchProvider
    ? createStorageVnextActiveSearch({
        projections: storageVnextActiveSearchProjections,
        provider: searchProvider,
        hydration: storageVnextSearchHydration,
        maxPageSize: config.pagination.maxPageSize,
        overfetchFactor: initialRuntimeSettings.search.overfetchFactor,
        cropLength: initialRuntimeSettings.search.cropLength,
        requestTimeoutMs: initialRuntimeSettings.search.requestTimeoutMs,
        engineSearchCutoffMs: initialRuntimeSettings.search.engineSearchCutoffMs,
        async resolveRuntimeSettings() {
          const snapshot = await runtimeSettings.getSnapshot();
          return {
            overfetchFactor: snapshot.search.overfetchFactor,
            cropLength: snapshot.search.cropLength,
            requestTimeoutMs: snapshot.search.requestTimeoutMs,
            engineSearchCutoffMs: snapshot.search.engineSearchCutoffMs
          };
        }
      })
    : null;
  const deploymentSecret = loadDeploymentSecret();
  const embeddingConfigurationRepository =
    createPostgresEmbeddingConfigurationRepository(sql);
  const rerankerConfigurationRepository =
    createPostgresRerankerConfigurationRepository(sql);
  const embeddingTransport = createOpenAiCompatibleEmbeddingTransport();
  const rerankerTransport = createOpenAiCompatibleRerankerTransport();
  const rerankerGateway = createRerankerGateway({
    resolveActiveConfiguration: () => rerankerConfigurationRepository.getActive(),
    transport: rerankerTransport,
    deploymentSecret
  });
  const embeddingGateway = createEmbeddingGateway({
    transport: embeddingTransport,
    deploymentSecret
  });
  const semanticGenerations = createPostgresSemanticGenerationRepository(sql);
  const storageVnextKnowledgeBaseCreation = createPostgresKnowledgeBaseCreation({
    sql,
    async resolveSemanticTarget(knowledgeBaseId) {
      try {
        const [snapshot, configurations] = await Promise.all([
          runtimeSettings.getSnapshot(),
          embeddingConfigurationRepository.list()
        ]);
        return resolveSemanticAdoptionTarget({
          knowledgeBaseId,
          runtimeSettings: snapshot,
          embeddingConfigurations: configurations,
          searchProviderKind: requireSearchProviderKind(config.search)
        }).target;
      } catch (error) {
        if (isInitialSemanticConfigurationUnavailable(error)) return null;
        throw error;
      }
    }
  });
  const semanticCancellation = createSemanticAdoptionService({
    generations: semanticGenerations,
    stages: createPostgresSemanticStageRepository(sql),
    catalog: storageVnextCatalog
  });
  const maintenanceCancellationCleanup =
    createStorageVnextMaintenanceCancellationCleanup({
      semanticTerminal: semanticGenerations,
      releases: storageVnextReleases,
      resultRetentionMilliseconds: completedWorkRetentionMilliseconds
    });
  const storageVnextSearch = config.search && searchProvider && lexicalSearch
    ? createStorageVnextSemanticSearch({
        semanticGenerations,
        resolveActiveRerankerRevision: async () =>
          (await rerankerConfigurationRepository.getActive())?.revisionPublicId ?? null,
        lexicalProjections: storageVnextActiveSearchProjections,
        semantic: createSemanticSearchProductionRuntime({
          sql,
          provider: searchProvider,
          embeddingConfigurations: embeddingConfigurationRepository,
          embeddingGateway,
          hydration: storageVnextSearchHydration,
          runtimeSettings,
          reranker: rerankerGateway
        }),
        fallback: lexicalSearch,
        hydration: storageVnextSearchHydration,
        ...(redis ? {
          pagination: createRedisStorageVnextSemanticPagination({
            redis,
            ttlSeconds: config.pagination.cursorTtlSeconds
          })
        } : {}),
        providerKind: config.search.provider,
        vectorIndexPrefix: config.search.indexPrefix,
        maxPageSize: config.pagination.maxPageSize,
        async resolveRuntimeSettings() {
          const snapshot = await runtimeSettings.getSnapshot();
          return {
            requestTimeoutMs: snapshot.search.requestTimeoutMs,
            searchLaneCutoffMs: snapshot.semantic.searchLaneCutoffMs
          };
        }
      })
    : lexicalSearch;
  const storageVnextAdminRead = createPostgresStorageVnextAdminRead({
    sql,
    catalog: storageVnextCatalog,
    releases: storageVnextReleases,
    search: storageVnextSearch
  });
  const storageVnextAudit = createPostgresStorageVnextAuditRepository(sql);
  const embeddingConfigurations = createEmbeddingConfigurationService({
    repository: embeddingConfigurationRepository,
    transport: embeddingTransport,
    audit: createEmbeddingConfigurationAuditAdapter({
      audit: storageVnextAudit,
      retentionDays: resolveSecurityConfig(config).audit.retentionDays
    }),
    deploymentSecret
  });
  const rerankerConfigurations = createRerankerConfigurationService({
    repository: rerankerConfigurationRepository,
    transport: rerankerTransport,
    audit: createRerankerConfigurationAuditAdapter({
      audit: storageVnextAudit,
      retentionDays: resolveSecurityConfig(config).audit.retentionDays
    }),
    deploymentSecret
  });
  const storageVnextApiKeys = createPostgresStorageVnextApiKeyRepository(sql);
  const selectedSearchProviderKind = requireSearchProviderKind(config.search);
  const storageVnextMaintenance = createPostgresStorageVnextMaintenanceRepository(sql, {
    selectedSearchProviderKind
  });
  const storageVnextMaintenanceRequests = createStorageVnextMaintenanceRequestService({
    repository: storageVnextMaintenance,
    searchProviderKind: selectedSearchProviderKind,
    activeSearchProjections: storageVnextActiveSearchProjections
  });
  const semanticAdoption = {
    async resolve(input: {
      knowledgeBaseId: string;
      settingsRevisionPublicId: string;
    }) {
      try {
        const [snapshot, configurations, active] = await Promise.all([
          runtimeSettings.getSnapshot(),
          embeddingConfigurationRepository.list(),
          semanticGenerations.getActiveProjection(input.knowledgeBaseId)
        ]);
        const resolved = resolveSemanticAdoptionTarget({
          knowledgeBaseId: input.knowledgeBaseId,
          runtimeSettings: snapshot,
          embeddingConfigurations: configurations,
          searchProviderKind: selectedSearchProviderKind
        });
        const adoptionMode = classifySemanticAdoption(active, resolved.target);
        if (!adoptionMode) {
          return { available: true as const, snapshot: null };
        }
        return {
          available: true as const,
          snapshot: {
            mode: adoptionMode,
            target: resolved.target,
            stageSettings: createSemanticAdoptionStageSettings({
              runtimeSettingsRevisionPublicId: input.settingsRevisionPublicId,
              runtimeSettings: snapshot,
              target: resolved.target,
              embedding: resolved.embedding,
              maximumSourceBytes: config.pagination.generatedContentMaxBytes
            }),
            expectedPredecessorPublicId: active?.publicId ?? null,
            expectedPredecessorRevision: active?.revision ?? 0,
            sourcePageSize: Math.min(100, snapshot.maintenance.scanBatchSize)
          }
        };
      } catch (error) {
        return {
          available: false as const,
          safeCode: semanticAdoptionSafeCode(error)
        };
      }
    }
  };
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
        maximumGeneratedBytes: config.pagination.generatedContentMaxBytes,
        knowledgeBaseCreation: storageVnextKnowledgeBaseCreation
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
        }),
        knowledgeBaseCreation: storageVnextKnowledgeBaseCreation
      })
    : undefined;
  const sharedServices = {
    config,
    runtimeSettings,
    storageVnextAdminRead,
    storageVnextAudit,
    embeddingConfigurations,
    rerankerConfigurations,
    storageVnextApiKeys,
    storageVnextAdminProcessing,
    storageVnextCatalog,
    storageVnextMaintenanceRequests,
    storageVnextMaintenanceStatus: storageVnextMaintenance,
    semanticAdoption,
    semanticCancellation,
    maintenanceCancellationCleanup,
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

function semanticAdoptionSafeCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = String(error.code);
    if (/^semantic_[a-z0-9_]+$/u.test(code) && code.length <= 128) return code;
  }
  return "semantic_configuration_unavailable";
}

function isInitialSemanticConfigurationUnavailable(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return [
    "semantic_generation_model_required",
    "semantic_embedding_model_required",
    "semantic_embedding_revision_not_validated"
  ].includes(String(error.code));
}

function requireSearchProviderKind(
  search: RuntimeConfig["search"]
): NonNullable<RuntimeConfig["search"]>["provider"] {
  if (!search) throw new Error("Search configuration is required");
  return search.provider;
}

async function runHealthcheck(): Promise<void> {
  await runRuntimeDeploymentHealthcheck(config, {
    role: "api",
    ...(config.search
      ? { assertTokenizer: assertNodeJiebaRuntimeAvailable }
      : {}),
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

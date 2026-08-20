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
import { createPostgresStorageVnextAuditRepository } from "./storage-vnext/audit/postgres-repository.js";
import { createPostgresStorageVnextActiveSearchProjectionRepository } from "./storage-vnext/search/postgres-active-projection.js";
import { createPostgresStorageVnextSearchHydration } from "./storage-vnext/search/postgres-hydration.js";
import { createStorageVnextActiveSearch } from "./storage-vnext/search/active-search.js";
import { createRedisStorageVnextSemanticPagination } from
  "./storage-vnext/search/redis-semantic-pagination.js";
import { createStorageVnextSearchSettings } from
  "./storage-vnext/search/settings.js";
import { createDocumentSearchProjectionBootstrap } from
  "./document-indexing/domain/document-search-projection.js";
import { createPostgresDocumentMaintenance } from
  "./document-indexing/infrastructure/postgres-document-maintenance.js";
import { createPostgresStorageVnextAdminRead } from "./storage-vnext/api/postgres-admin-read.js";
import { createPostgresStorageVnextApiKeyRepository } from "./storage-vnext/api/postgres-api-key.js";
import { createPostgresStorageVnextAdminProcessing } from "./storage-vnext/api/postgres-admin-processing.js";
import { createPostgresStorageVnextMaintenanceRepository } from "./storage-vnext/maintenance/postgres-repository.js";
import { createStorageVnextMaintenanceRequestService } from "./storage-vnext/maintenance/maintenance-coordinator.js";
import { createPostgresStorageVnextAdminSource } from "./storage-vnext/api/postgres-admin-source.js";
import { createPostgresDocumentRetry } from
  "./document-indexing/infrastructure/postgres-document-retry.js";
import { createPostgresDocumentTaskRemoval } from
  "./document-indexing/infrastructure/postgres-document-task-removal.js";
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
import type { ProviderRequestFailureReporter } from
  "./semantic/provider-request-failure.js";
import { createPostgresSemanticGenerationRepository } from
  "./semantic/infrastructure/postgres-generation-repository.js";
import { createStorageVnextSemanticSearch } from
  "./storage-vnext/search/semantic-search.js";
import {
  resolveSemanticAdoptionTarget
} from "./semantic/application/adoption-target.js";
import { classifySemanticAdoption } from
  "./semantic/application/adoption-policy.js";
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
  const storageVnextActiveSearchProjections =
    createPostgresStorageVnextActiveSearchProjectionRepository(sql);
  const initialRuntimeSettings = await runtimeSettings.getSnapshot();
  const selectedSearchProviderKind = requireSearchProviderKind(config.search);
  const documentMaintenance = createPostgresDocumentMaintenance({
    sql,
    providerKind: selectedSearchProviderKind,
    indexUidPrefix: config.search!.indexPrefix,
    searchDefinition: createStorageVnextSearchSettings({
      searchCutoffMs: initialRuntimeSettings.search.engineSearchCutoffMs
    }),
    pageSize: Math.min(initialRuntimeSettings.maintenance.scanBatchSize, 100)
  });
  const maintenanceCancellationCleanup =
    createStorageVnextMaintenanceCancellationCleanup({
      documents: documentMaintenance
    });
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
  const onProviderFailure: ProviderRequestFailureReporter = (failure) => {
    logger.error("provider.request_failed", failure);
  };
  const embeddingTransport = createOpenAiCompatibleEmbeddingTransport({
    onFailure: onProviderFailure
  });
  const rerankerTransport = createOpenAiCompatibleRerankerTransport({
    onFailure: onProviderFailure
  });
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
  const resolveConfiguredSemanticTarget = async (knowledgeBaseId: string) => {
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
  };
  const storageVnextKnowledgeBaseCreation = createPostgresKnowledgeBaseCreation({
    sql,
    resolveSearchProjection(knowledgeBaseId) {
      if (!config.search) throw new Error("Search configuration is required");
      return createDocumentSearchProjectionBootstrap({
        knowledgeBaseId,
        providerKind: config.search.provider,
        indexUidPrefix: config.search.indexPrefix,
        definition: createStorageVnextSearchSettings({
          searchCutoffMs: initialRuntimeSettings.search.engineSearchCutoffMs
        })
      });
    },
    resolveSemanticTarget: resolveConfiguredSemanticTarget
  });
  const storageVnextSearch = config.search && searchProvider && lexicalSearch && redis
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
        pagination: createRedisStorageVnextSemanticPagination({
          redis,
          ttlSeconds: config.pagination.cursorTtlSeconds
        }),
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
            runtimeSettingsRevisionPublicId: input.settingsRevisionPublicId,
            maximumSourceBytes: config.pagination.generatedContentMaxBytes,
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
    catalog: storageVnextCatalog
  });
  const storageVnextAdminSource = createPostgresStorageVnextAdminSource({
    retryCurrentDocument: createPostgresDocumentRetry(sql, {
      webhookRetentionMilliseconds: completedWorkRetentionMilliseconds
    }),
    removeDocumentTasks: createPostgresDocumentTaskRemoval(sql)
  });
  const storageVnextSourceBodies = createS3StorageVnextSourceBodyStore({
    client: s3,
    bucket: config.storage.bucket,
    prefix: config.storage.prefix
  });
  const storageVnextOwnership = createPostgresStorageVnextOwnershipRepository(sql);
  const storageVnextFailedWriteCompensation = createStorageVnextFailedWriteCompensator({
    registrations: storageVnextOwnership,
    provider: createS3StorageVnextFailedWriteProvider({
      client: s3,
      bucket: config.storage.bucket,
      prefix: config.storage.prefix
    })
  });
  const storageVnextUpload = createPostgresStorageVnextUploadRepository(sql, {
    sourceWorkRetentionMilliseconds: completedWorkRetentionMilliseconds,
    resolveSemanticTarget: resolveConfiguredSemanticTarget
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
  const storageVnextAdminMutation = createPostgresStorageVnextAdminMutation({
        sql,
        catalog: storageVnextCatalog,
        resources: storageVnextAdminResources,
        operations: storageVnextOperations,
        sourceBodies: storageVnextSourceBodies,
        objectWriter: createStorageVnextImmutableObjectWriter({
          registrations: storageVnextOwnership,
          bodyStore: storageVnextImmutableBodies,
          compensation: storageVnextFailedWriteCompensation,
          clock: () => new Date().toISOString()
        }),
        runtimeSettings,
        maximumSourceBytes: config.pagination.generatedContentMaxBytes
      });
  const storageVnextAdminCore = createPostgresStorageVnextAdminCore({
        sql,
        catalog: storageVnextCatalog,
        resources: storageVnextAdminResources,
        sourceEvents: storageVnextSourceEvents,
        mutations: storageVnextAdminMutation,
        bodies: storageVnextImmutableBodies,
        maximumGeneratedBytes: config.pagination.generatedContentMaxBytes,
        knowledgeBaseCreation: storageVnextKnowledgeBaseCreation
      });
  const storageVnextOpenApi = storageVnextAdminCore
    && storageVnextAdminMutation
    && storageVnextAdminSource
    ? createPostgresStorageVnextOpenApiApplication({
        sql,
        catalog: storageVnextCatalog,
        adminRead: storageVnextAdminRead,
        adminCore: storageVnextAdminCore,
        resources: storageVnextAdminMutation,
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

import type { S3Client } from "@aws-sdk/client-s3";
import type { RuntimeConfig, WorkerRuntimeConfig } from "../../config.js";
import type { DatabaseClient } from "../../db/client.js";
import { createRuntimeSettingsRepository } from
  "../../runtime-settings/repository.js";
import { createS3StorageVnextSourceBodyStore } from
  "../../storage-vnext/catalog/s3-source-body-store.js";
import { createStorageVnextImmutableObjectWriter } from
  "../../storage-vnext/ownership/immutable-object-writer.js";
import {
  createS3StorageVnextFailedWriteProvider,
  createStorageVnextFailedWriteCompensator
} from "../../storage-vnext/ownership/failed-write-compensation.js";
import { createS3StorageVnextImmutableBodyStore } from
  "../../storage-vnext/ownership/s3-immutable-body-store.js";
import type { createPostgresStorageVnextOwnershipRepository } from
  "../../storage-vnext/ownership/postgres-repository.js";
import { createDocumentResourcePermits } from
  "../application/document-resource-permits.js";
import { deriveDocumentResourceCapacities } from
  "../application/document-resource-capacity.js";
import type { DocumentResourceCapacityInput } from
  "../application/document-resource-capacity.js";
import { resolvePinnedDocumentOutputSettings } from
  "../application/document-output-settings.js";
import type { DocumentResourceDeletionAction } from
  "../application/document-resource-deletion-worker.js";
import { readPostgresKnowledgeBaseSequence } from
  "./postgres-knowledge-base-sequence.js";
import { createPostgresDocumentDeletionProjectionCommit } from
  "./postgres-document-deletion-projection-commit.js";
import { createPostgresDocumentDeletionProjectionContext } from
  "./postgres-document-deletion-projection-context.js";
import { createPostgresDocumentDirectoryNavigation } from
  "./postgres-document-directory-navigation.js";
import { createPostgresDocumentGeneratedContext } from
  "./postgres-document-generated-context.js";
import { createPostgresGeneratedPageRepository } from
  "./postgres-generated-page-repository.js";
import { createPostgresOperationGeneratedPageRepository } from
  "./postgres-operation-generated-page-repository.js";
import { createProductionDocumentDeletionPageStaging } from
  "./production-document-deletion-page-staging.js";
import { createProductionDocumentDeletionPages } from
  "./production-document-deletion-pages.js";
import { createProductionDocumentDeletionScopePages } from
  "./production-document-deletion-scope-pages.js";
import { createPostgresDocumentMachineProjectionReader } from
  "./postgres-document-machine-projection-reader.js";
import { createPostgresProjectionScopeSnapshot } from
  "./postgres-projection-scope-snapshot.js";
import { createPostgresProjectionScopeContributions } from
  "./postgres-projection-scope-contributions.js";
import { createProductionDocumentScopeRenderer } from
  "./production-document-scope-renderer.js";

export function createProductionDocumentDeletionProjection(input: {
  sql: DatabaseClient;
  config: RuntimeConfig;
  workerConfig: Required<WorkerRuntimeConfig>;
  resourceCapacity: DocumentResourceCapacityInput;
  s3: S3Client;
  ownership: ReturnType<typeof createPostgresStorageVnextOwnershipRepository>;
}) {
  const concurrency = input.workerConfig.sourceFileConcurrency;
  const resourceCapacity = deriveDocumentResourceCapacities(
    input.resourceCapacity
  );
  const permits = createDocumentResourcePermits({
    ...resourceCapacity
  });
  const settings = createRuntimeSettingsRepository(input.sql);
  const graphConfig = input.config.graph;
  if (!graphConfig) throw projectionError("graph_configuration_missing");
  const context = createPostgresDocumentDeletionProjectionContext(input.sql);
  const generatedContext = createPostgresDocumentGeneratedContext(input.sql);
  const directoryNavigation = createPostgresDocumentDirectoryNavigation(input.sql);
  const pages = createPostgresGeneratedPageRepository(input.sql);
  const immutableBodies = createS3StorageVnextImmutableBodyStore({
    client: input.s3,
    bucket: input.config.storage.bucket,
    prefix: input.config.storage.prefix
  });
  const objectWriter = createStorageVnextImmutableObjectWriter({
    registrations: input.ownership,
    bodyStore: immutableBodies,
    compensation: createStorageVnextFailedWriteCompensator({
      registrations: input.ownership,
      provider: createS3StorageVnextFailedWriteProvider({
        client: input.s3,
        bucket: input.config.storage.bucket,
        prefix: input.config.storage.prefix
      })
    }),
    clock: () => new Date().toISOString()
  });
  const deletionPages = createProductionDocumentDeletionPages({
    context,
    generatedContext,
    directoryNavigation,
    bodyStore: createS3StorageVnextSourceBodyStore({
      client: input.s3,
      bucket: input.config.storage.bucket,
      prefix: input.config.storage.prefix
    }),
    permits,
    documentConcurrency: concurrency,
    maximumSourceBytes: input.config.pagination.generatedContentMaxBytes
  });
  const machineProjection = createPostgresDocumentMachineProjectionReader(
    input.sql
  );
  const scopeRenderer = createProductionDocumentScopeRenderer({
    snapshots: createPostgresProjectionScopeSnapshot(input.sql),
    machineProjection,
    scopeContributions: createPostgresProjectionScopeContributions(input.sql),
    directoryNavigation,
    directoryLeafLimits: {
      maxEntries: input.config.generated.directoryIndexMaxEntries,
      maxBytes: input.config.generated.directoryIndexMaxBytes,
      mergeBelowEntries: Math.max(1,
        Math.floor(input.config.generated.directoryIndexMaxEntries / 4))
    },
    rootLimits: {
      rootSummaryLimit: input.config.generated.rootSummaryLimit,
      okfLogMaxEntries: input.config.generated.okfLogMaxEntries,
      okfLogMaxBytes: input.config.generated.okfLogMaxBytes
    },
    objectWriter,
    maximumRecordsPerShard: graphConfig.shardSize,
    maximumShardBytes: 1_048_576
  });
  const scopePages = createProductionDocumentDeletionScopePages({
    machineProjection,
    renderer: scopeRenderer
  });
  const staging = createProductionDocumentDeletionPageStaging({
    pages,
    operationPages: createPostgresOperationGeneratedPageRepository(input.sql),
    ownership: input.ownership,
    objectWriter,
    permits,
    writeConcurrency: resourceCapacity.capacities.generated_object_write
  });
  const commit = createPostgresDocumentDeletionProjectionCommit(input.sql);

  return {
    async reconcile(request: {
      action: DocumentResourceDeletionAction;
      pageSize: number;
      now: string;
      signal: AbortSignal;
    }) {
      if (request.action.targetKind === "knowledge_base") {
        await commit.clearKnowledgeBase({
          action: request.action,
          committedAt: request.now
        });
        return continuation(request.action, request.action.checkpoint.affectedSourceCount);
      }
      const current = await settings.getCurrentRevision();
      const revision = current ? await settings.getRevision(current.publicId) : null;
      if (!revision) throw projectionError("runtime_settings_revision_missing");
      const outputSettings = resolvePinnedDocumentOutputSettings(revision.document);
      const baseRevision = await readPostgresKnowledgeBaseSequence(
        input.sql,
        request.action.knowledgeBaseId
      );
      const rendered = await deletionPages({
          action: request.action,
          outputSettings,
          baseRevision,
          completedAt: request.now,
          signal: request.signal
        });
      const affectedSurvivorIds = new Set(
        rendered.projection.affectedSurvivorSourceFilePublicIds
      );
      const projectedScopes = await scopePages({
        action: request.action,
        deletedSources: rendered.projection.deletedSources,
        affectedSurvivors: rendered.generatedSources.filter((source) =>
          affectedSurvivorIds.has(source.sourceFilePublicId)).map((source) => ({
            sourceFilePublicId: source.sourceFilePublicId,
          logicalPath: source.logicalPath
        })),
        affectedPageIntegrity: rendered.renderedPages.map((page) => ({
          path: page.logicalPath,
          checksumSha256: page.checksumSha256,
          byteCount: page.byteCount
        })),
        obsoleteRelationPublicIds:
          rendered.projection.obsoleteRelationPublicIds,
        baseRevision,
        signal: request.signal
      });
      const candidate = await staging({
          action: request.action,
          deletionPages: rendered,
          scopePages: projectedScopes,
          baseRevision,
          completedAt: request.now,
          signal: request.signal
        });
      await permits.run("database_mutation", () => commit.commit({
        action: request.action,
        ...candidate,
        committedAt: request.now
      }), { signal: request.signal });
      return continuation(
        request.action,
        rendered.projection.deletedSources.length
      );
    }
  };
}

function continuation(
  action: DocumentResourceDeletionAction,
  processedSourceCount: number
) {
  return {
    done: false,
    processedSourceCount,
    checkpoint: {
      phase: "await_external" as const,
      cursor: null,
      affectedSourceCount: action.checkpoint.affectedSourceCount
    }
  };
}

function projectionError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document deletion projection error: ${code}`), {
    code
  });
}

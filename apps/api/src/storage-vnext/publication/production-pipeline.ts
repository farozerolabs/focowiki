import type { RuntimeConfig } from "../../config.js";
import type { DatabaseClient } from "../../db/client.js";
import type { SearchProviderRuntime } from
  "../../application/ports/search-provider-runtime.js";
import { buildPersistedGraphCandidateTerms } from
  "../../graph/graph-candidates.js";
import { createGraphEdgeScorer } from
  "../../graph/graph-edge-scoring.js";
import { INCREMENTAL_PUBLICATION_DEFAULTS } from
  "../../publication/incremental-defaults.js";
import type { RuntimeSettingsSnapshot } from "../../runtime-settings/types.js";
import type { createPostgresStorageVnextCatalogRepository } from
  "../catalog/postgres-repository.js";
import type { StorageVnextCatalogReadPort } from "../catalog/ports.js";
import type { createS3StorageVnextSourceBodyStore } from
  "../catalog/s3-source-body-store.js";
import type { createPostgresStorageVnextGraphRepository } from
  "../graph/postgres-repository.js";
import type { StorageVnextGraphReadPort, StorageVnextGraphWritePort } from
  "../graph/ports.js";
import {
  createPostgresStorageVnextMutationCandidateCatalog as
    createStorageVnextMutationCandidateCatalog,
  readPostgresStorageVnextMutationCandidateOverlay
} from "../mutation/postgres-candidate-overlay.js";
import {
  createPostgresStorageVnextMutationCandidateGraph,
  type StorageVnextMutationCandidateGraph
} from "../mutation/postgres-candidate-graph.js";
import {
  createPostgresStorageVnextMutationCandidateSnapshot
} from "../mutation/candidate-snapshot.js";
import type { createStorageVnextImmutableObjectWriter } from
  "../ownership/immutable-object-writer.js";
import type { createPostgresStorageVnextOwnershipRepository } from
  "../ownership/postgres-repository.js";
import type { createS3StorageVnextImmutableBodyStore } from
  "../ownership/s3-immutable-body-store.js";
import { MAX_STORAGE_VNEXT_CANDIDATE_DEPENDENCIES } from
  "../release/ports.js";
import type { createPostgresStorageVnextReleaseRepository } from
  "../release/postgres-repository.js";
import {
  createStorageVnextSearchCandidateLifecycle,
  createStorageVnextSearchSettingsChecksum
} from "../search/candidate-lifecycle.js";
import { createStorageVnextSearchCandidateValidator } from
  "../search/candidate-validation.js";
import type { StorageVnextActiveSearchProjectionRepository } from
  "../search/active-projection-repository.js";
import { createStorageVnextGraphCandidateSearchForProjection } from
  "../search/graph-candidate-search.js";
import { createPostgresStorageVnextSearchHydration } from
  "../search/postgres-hydration.js";
import type { createPostgresStorageVnextSearchProjectionRepository } from
  "../search/postgres-repository.js";
import { buildStorageVnextSearchCandidate } from
  "../search/streaming-builder.js";
import {
  createStorageVnextSearchSchemaChecksum,
  createStorageVnextSearchSettings
} from "../search/settings.js";
import { reconcileStorageVnextGraphFacts } from
  "../source-processing/graph-extractor.js";
import { createStorageVnextPublicationArtifactAssembler } from
  "./artifact-assembler.js";
import { createStorageVnextPublicationCandidateValidator } from
  "./candidate-validator.js";
import type { createPostgresStorageVnextEffectiveCatalog } from
  "./effective-catalog.js";
import { createStorageVnextPublicationGraphReconciler } from
  "./graph-reconciler.js";
import type { createStorageVnextPublicationObjectValidator } from
  "./object-validator.js";
import type { createPostgresStorageVnextPublicationSnapshot } from
  "./postgres-snapshot.js";
import { createStorageVnextPublicationProjectionLoader } from
  "./projection-loader.js";
import { createStorageVnextPublicationProcessor } from "./processor.js";
import { createStorageVnextPublicationPublisher } from "./publisher.js";

type Catalog = ReturnType<typeof createPostgresStorageVnextCatalogRepository>;
type Graph = ReturnType<typeof createPostgresStorageVnextGraphRepository>;
type PublicationCatalog = Pick<
  StorageVnextCatalogReadPort,
  | "getKnowledgeBase"
  | "getSourceRevision"
  | "getCurrentSourceRevision"
  | "listDirectories"
  | "listSourceFiles"
  | "listSourceFilesByPublicIds"
  | "listCurrentSources"
>;
type PublicationGraph = Pick<
  StorageVnextGraphReadPort & StorageVnextGraphWritePort,
  | "getNode"
  | "getEdge"
  | "listNodes"
  | "listBySourceFile"
  | "listNeighborhood"
  | "replaceSourceFileGraph"
> & Pick<Graph, "listNodesBySourceFiles">;
type Releases = ReturnType<typeof createPostgresStorageVnextReleaseRepository>;
type Ownership = ReturnType<typeof createPostgresStorageVnextOwnershipRepository>;
type SearchRepository = ReturnType<
  typeof createPostgresStorageVnextSearchProjectionRepository
>;
type SourceBodies = ReturnType<typeof createS3StorageVnextSourceBodyStore>;
type GeneratedBodies = ReturnType<typeof createS3StorageVnextImmutableBodyStore>;
type ObjectWriter = ReturnType<typeof createStorageVnextImmutableObjectWriter>;
type ObjectValidator = ReturnType<typeof createStorageVnextPublicationObjectValidator>;
type EffectiveCatalog = ReturnType<typeof createPostgresStorageVnextEffectiveCatalog>;
type PublicationSnapshot = ReturnType<
  typeof createPostgresStorageVnextPublicationSnapshot
>;
export function createStorageVnextProductionPublicationPipeline(input: {
  config: RuntimeConfig & { search: NonNullable<RuntimeConfig["search"]> };
  sql: DatabaseClient;
  snapshot: RuntimeSettingsSnapshot;
  catalog: Catalog;
  graph: Graph;
  releases: Releases;
  ownership: Ownership;
  searchRepository: SearchRepository;
  activeSearchProjections: StorageVnextActiveSearchProjectionRepository;
  sourceBodies: SourceBodies;
  generatedBodies: GeneratedBodies;
  objects: Pick<ObjectWriter, "putVerified">;
  objectValidator: ObjectValidator;
  effectiveCatalog: EffectiveCatalog;
  publicationSnapshot: PublicationSnapshot;
  searchProvider: SearchProviderRuntime;
}) {
  const searchSettings = createStorageVnextSearchSettings({
    searchCutoffMs: input.snapshot.search.engineSearchCutoffMs
  });
  const schemaChecksum = createStorageVnextSearchSchemaChecksum();
  const settingsChecksum = createStorageVnextSearchSettingsChecksum(searchSettings);
  const searchProvider = input.searchProvider;
  if (searchProvider.kind !== input.config.search.provider) {
    throw new Error("Selected search provider does not match runtime configuration");
  }
  const searchLifecycle = createStorageVnextSearchCandidateLifecycle({
    repository: input.searchRepository,
    provider: searchProvider,
    settings: searchSettings,
    indexUidPrefix: input.config.search.indexPrefix,
    maxPollAttempts: Math.max(1, Math.ceil(
      input.snapshot.search.taskTimeoutMs
        / input.snapshot.search.taskPollIntervalMs
    )),
    pollIntervalMs: input.snapshot.search.taskPollIntervalMs
  });
  const searchValidation = createStorageVnextSearchCandidateValidator({
    repository: input.searchRepository,
    provider: searchProvider,
    hydration: createPostgresStorageVnextSearchHydration(input.sql),
    settings: searchSettings,
    documentPageSize: pageSize(input.config)
  });
  const publisher = createStorageVnextPublicationPublisher({
    objects: input.objects,
    releases: input.releases,
    search: searchLifecycle,
    clock: now,
    limits: {
      maximumArtifacts: MAX_STORAGE_VNEXT_CANDIDATE_DEPENDENCIES,
      maximumArtifactBytes: input.config.pagination.generatedContentMaxBytes,
      maximumSearchDocuments: 1,
      maximumSearchCompressedBytes: input.snapshot.search.indexBatchCompressedBytes,
      objectWriteConcurrency:
        input.snapshot.maintenance.projectionRepairObjectWriteConcurrency
    }
  });
  const releaseValidation = createStorageVnextPublicationCandidateValidator({
    releases: input.releases,
    effectiveCatalog: input.effectiveCatalog,
    objects: input.objectValidator,
    search: {
      async getProjection(request) {
        const candidate = await input.searchRepository.getCandidate(request.publicId);
        if (candidate) return candidate;
        const active = await input.activeSearchProjections.getActiveProjection(
          request.knowledgeBaseId
        );
        return active?.publicId === request.publicId
          ? { ...active, state: "ready" as const }
          : null;
      }
    },
    clock: now,
    limits: {
      maximumPageSize: pageSize(input.config),
      maximumMarkdownBytes: input.config.pagination.generatedContentMaxBytes,
      objectReadConcurrency: input.snapshot.worker.sourceObjectReadConcurrency
    }
  });

  function createBoundPublication(
    catalog: PublicationCatalog,
    graph: PublicationGraph,
    publicationSnapshot: PublicationSnapshot = input.publicationSnapshot
  ) {
    const projection = createStorageVnextPublicationProjectionLoader({
      catalog,
      graph,
      sourceBodies: input.sourceBodies,
      snapshot: publicationSnapshot,
      limits: {
        catalogPageSize: Math.min(
          pageSize(input.config),
          input.snapshot.maintenance.projectionRepairDatabaseBatchSize
        ),
        maximumSourceBytes: input.config.pagination.generatedContentMaxBytes,
        maximumAffectedPaths: MAX_STORAGE_VNEXT_CANDIDATE_DEPENDENCIES,
        directoryIndexMaxEntries: input.snapshot.publication.directoryIndexMaxEntries,
        directoryIndexMaxBytes: input.snapshot.publication.directoryIndexMaxBytes,
        relatedFileLimit: input.snapshot.graph.acceptedEdgeLimit,
        maximumProjectionShards: INCREMENTAL_PUBLICATION_DEFAULTS.maxShardDescriptors,
        maximumMachineArtifactBytes: input.config.pagination.generatedContentMaxBytes,
        machineShardCounts: {
          search: INCREMENTAL_PUBLICATION_DEFAULTS.impactPlanner.searchShardCount,
          links: INCREMENTAL_PUBLICATION_DEFAULTS.impactPlanner.linkShardCount,
          manifest: INCREMENTAL_PUBLICATION_DEFAULTS.impactPlanner.manifestShardCount,
          tree: INCREMENTAL_PUBLICATION_DEFAULTS.impactPlanner.treeShardCount,
          graphNode: INCREMENTAL_PUBLICATION_DEFAULTS.impactPlanner.graphNodeShardCount,
          graphEdge: INCREMENTAL_PUBLICATION_DEFAULTS.impactPlanner.graphEdgeShardCount
        }
      }
    });
    const artifacts = createStorageVnextPublicationArtifactAssembler({
      releases: input.releases,
      projection,
      publisher,
      schemaChecksum,
      settingsChecksum,
      limits: {
        dependencyPageSize: pageSize(input.config),
        maximumDependencies: MAX_STORAGE_VNEXT_CANDIDATE_DEPENDENCIES,
        relatedFileLimit: input.snapshot.graph.acceptedEdgeLimit
      }
    });
    const graphEdgeScorer = createGraphEdgeScorer({
      maximumCachedProfiles: input.snapshot.graph.candidateLimit * 2 + 1
    });
    const graphReconciler = createStorageVnextPublicationGraphReconciler({
      releases: input.releases,
      catalog,
      sourceBodies: input.sourceBodies,
      graph,
      async reconcileEdges(request) {
        const candidates = createStorageVnextGraphCandidateSearchForProjection({
          searchProjectionPublicId: request.searchProjectionPublicId,
          projections: input.searchRepository,
          provider: searchProvider,
          deadlineMs: input.snapshot.search.requestTimeoutMs,
          graph
        });
        return reconcileStorageVnextGraphFacts({
          candidateTerms: buildPersistedGraphCandidateTerms,
          candidates,
          edgeScorer: graphEdgeScorer,
          limits: {
            maximumCandidateNodes: input.snapshot.graph.candidateLimit,
            acceptedEdgeLimit: input.snapshot.graph.acceptedEdgeLimit,
            genericPhraseThreshold: input.snapshot.graph.genericPhraseThreshold
          }
        }, {
          node: request.node,
          checksum: request.current.sourceRevision.checksum,
          body: request.body,
          signal: request.signal
        });
      },
      sourcePageSize: pageSize(input.config),
      sourceConcurrency:
        input.snapshot.maintenance.lexicalRebuildSourceReadConcurrency,
      maximumSourceBytes: input.config.pagination.generatedContentMaxBytes
    });

    async function buildSearchCandidate(request: {
      knowledgeBaseId: string;
      candidatePublicId: string;
      operationPublicId: string;
      signal?: AbortSignal;
    }) {
      const candidate = await input.searchRepository.getCandidate(
        request.candidatePublicId
      );
      return buildStorageVnextSearchCandidate({
        ...request,
        catalog,
        sourceBodies: input.sourceBodies,
        graph,
        projection: searchLifecycle,
        sourcePageSize: pageSize(input.config),
        graphPageSize: pageSize(input.config),
        sourceReadConcurrency:
          input.snapshot.maintenance.lexicalRebuildSourceReadConcurrency,
        maxInFlightSourceBytes:
          input.snapshot.maintenance.lexicalRebuildMaxInFlightSourceBytes,
        maxSourceBytes: Math.min(
          input.config.pagination.generatedContentMaxBytes,
          input.snapshot.maintenance.lexicalRebuildMaxInFlightSourceBytes
        ),
        maxSegmentBytes: input.config.pagination.generatedContentMaxBytes,
        maxBatchDocuments: input.snapshot.search.indexBatchDocumentCount,
        maxBatchCompressedBytes: input.snapshot.search.indexBatchCompressedBytes,
        resumeFromBatchOrdinal: candidate?.nextBatchOrdinal ?? 0
      });
    }

    function createProcessor(request: {
      queryCases?: readonly import("../search/ports.js")
        .StorageVnextSearchValidationCase[];
      maxP95ProcessingTimeMs?: number;
    } = {}) {
      return createStorageVnextPublicationProcessor({
        selectedSearchProviderKind: input.config.search.provider,
        activeSearchProjections: input.activeSearchProjections,
        search: { ...searchLifecycle, ...searchValidation },
        searchBuilder: { build: buildSearchCandidate },
        graph: {
          async reconcile(identity) {
            await graphReconciler.reconcile(identity);
          }
        },
        artifacts: {
          async publish(identity) {
            await artifacts.publish(identity);
          }
        },
        releases: {
          async getCandidate(identity) {
            const candidate = await input.releases.getLiveCandidate(
              identity.knowledgeBaseId
            );
            return candidate
              && candidate.publicId === identity.candidatePublicId
              && candidate.operationPublicId === identity.operationPublicId
              ? { state: candidate.state }
              : null;
          },
          validate: releaseValidation.validate
        },
        schemaChecksum,
        settingsChecksum,
        queryCases: request.queryCases ?? [],
        maxP95ProcessingTimeMs:
          request.maxP95ProcessingTimeMs ?? input.snapshot.search.requestTimeoutMs
      });
    }

    return { artifacts, graphReconciler, buildSearchCandidate, createProcessor };
  }

  const base = createBoundPublication(input.catalog, input.graph);

  return {
    schemaChecksum,
    settingsChecksum,
    searchProvider,
    searchLifecycle,
    searchValidation,
    graphReconciler: base.graphReconciler,
    artifacts: base.artifacts,
    releaseValidation,
    createProcessor(request: {
      queryCases?: readonly import("../search/ports.js").StorageVnextSearchValidationCase[];
      maxP95ProcessingTimeMs?: number;
    } = {}) {
      const baseProcessor = base.createProcessor(request);
      return {
        async publish(identity: Parameters<typeof baseProcessor.publish>[0]) {
          const mutation = await readPostgresStorageVnextMutationCandidateOverlay(
            input.sql,
            identity
          );
          if (!mutation) return baseProcessor.publish(identity);
          const catalog = createStorageVnextMutationCandidateCatalog({
            sql: input.sql,
            mutation,
            catalog: input.catalog
          });
          const graph: StorageVnextMutationCandidateGraph =
            createPostgresStorageVnextMutationCandidateGraph({
              sql: input.sql,
              candidatePublicId: identity.candidatePublicId,
              mutation,
              catalog,
              graph: input.graph
            });
          const publicationSnapshot =
            createPostgresStorageVnextMutationCandidateSnapshot({
              sql: input.sql,
              mutation,
              snapshot: input.publicationSnapshot
            });
          return createBoundPublication(catalog, graph, publicationSnapshot)
            .createProcessor(request)
            .publish(identity);
        }
      };
    },
    buildSearchCandidate: base.buildSearchCandidate
  };
}

function pageSize(config: RuntimeConfig): number {
  return Math.min(1_000, config.pagination.maxPageSize);
}

function now(): string {
  return new Date().toISOString();
}

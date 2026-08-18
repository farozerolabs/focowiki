import type { SearchProviderRuntime } from
  "../../application/ports/search-provider-runtime.js";
import type { RuntimeSettingsService } from
  "../../runtime-settings/service.js";
import type { DatabaseClient } from "../../db/client.js";
import type { StorageVnextSearchHydrationPort } from
  "../../storage-vnext/search/search-hydration.js";
import type { EmbeddingConfigurationRepository } from
  "../embedding/repository.js";
import type { EmbeddingGateway } from "../embedding/gateway.js";
import type { createRerankerGateway } from "../reranker/gateway.js";
import { createSemanticSearchOrchestrator } from "./orchestrator.js";
import type { SemanticRankObserver } from "./rank-observer.js";
import { createSemanticQueryEmbeddingGateway } from "./query-embedding.js";
import { createSemanticRankedLaneAdapter } from "./ranked-lanes.js";
import { createPostgresActiveVectorHitRepository } from
  "../infrastructure/postgres-active-vector-hit-repository.js";
import { createPostgresActiveFileRelationshipHitRepository } from
  "../../document-indexing/infrastructure/postgres-active-file-relationship-hit-repository.js";

export function createSemanticSearchProductionRuntime(input: {
  sql: DatabaseClient;
  provider: Pick<SearchProviderRuntime, "query"> & {
    vector: NonNullable<SearchProviderRuntime["vector"]>;
  };
  embeddingConfigurations: EmbeddingConfigurationRepository;
  embeddingGateway: EmbeddingGateway;
  hydration: StorageVnextSearchHydrationPort;
  runtimeSettings: RuntimeSettingsService;
  reranker: ReturnType<typeof createRerankerGateway>;
  observer?: SemanticRankObserver;
}) {
  let queryGateway: ReturnType<typeof createSemanticQueryEmbeddingGateway> | null = null;
  let queryGatewayKey = "";
  const activeRelationshipHits =
    createPostgresActiveFileRelationshipHitRepository(input.sql);
  const rankedLanes = createSemanticRankedLaneAdapter({
    query: input.provider.query,
    relationshipDocuments: {
      async resolveActive(request) {
        if (request.signal.aborted) throw request.signal.reason;
        const result = await activeRelationshipHits.resolveActive(request);
        if (request.signal.aborted) throw request.signal.reason;
        return result;
      }
    }
  });
  const activeVectorHits = createPostgresActiveVectorHitRepository(input.sql);
  return createSemanticSearchOrchestrator({
    reranker: input.reranker,
    ...(input.observer ? { observer: input.observer } : {}),
    rankedLanes,
    vectors: input.provider.vector,
    vectorDocuments: {
      async resolveActive(request) {
        if (request.signal.aborted) throw request.signal.reason;
        const result = await activeVectorHits.resolveActive(request);
        if (request.signal.aborted) throw request.signal.reason;
        return result;
      }
    },
    sources: {
      async resolve(request) {
        if (request.signal.aborted) throw request.signal.reason;
        if (request.sourceFilePublicIds.length > request.limit) {
          throw new Error("Semantic source resolution exceeds its bound");
        }
        const values = await input.hydration.hydrateCurrentSources({
          knowledgeBaseId: request.knowledgeBaseId,
          sourceFilePublicIds: request.sourceFilePublicIds
        });
        if (request.signal.aborted) throw request.signal.reason;
        return values.map((value) => ({
          sourceFilePublicId: value.sourceFilePublicId,
          sourceRevisionPublicId: value.sourceRevisionPublicId,
          logicalPath: value.logicalPath,
          title: value.title
        }));
      }
    },
    queryEmbedding: {
      async embed(request) {
        const settings = (await input.runtimeSettings.getSnapshot()).semantic;
        const key = JSON.stringify({
          maximumConcurrency: settings.queryEmbeddingConcurrency,
          maximumCacheEntries: settings.queryEmbeddingCacheEntries
        });
        if (!queryGateway || queryGatewayKey !== key) {
          queryGatewayKey = key;
          queryGateway = createSemanticQueryEmbeddingGateway({
            maximumConcurrency: settings.queryEmbeddingConcurrency,
            maximumBacklog: settings.queryEmbeddingConcurrency * 8,
            maximumCacheEntries: settings.queryEmbeddingCacheEntries,
            cacheTtlMs: 60_000,
            async embed(embeddingRequest) {
              const configuration = await input.embeddingConfigurations.getRevision(
                embeddingRequest.embeddingConfigurationRevisionPublicId
              );
              if (
                !configuration
                || configuration.revisionPublicId
                  !== embeddingRequest.embeddingConfigurationRevisionPublicId
                || configuration.resolvedDimension !== embeddingRequest.dimension
              ) throw new Error("Semantic query embedding contract is unavailable");
              const vectors = await input.embeddingGateway.embed({
                configuration,
                inputs: [embeddingRequest.query],
                signal: embeddingRequest.signal
              });
              const vector = vectors[0];
              if (!vector) throw new Error("Semantic query embedding result is unavailable");
              return vector;
            }
          });
        }
        return queryGateway.embed(request);
      }
    }
  });
}

import type { DatabaseClient } from "../../db/client.js";
import type { createS3StorageVnextImmutableBodyStore } from
  "../../storage-vnext/ownership/s3-immutable-body-store.js";
import { createDocumentFirstLayerSourceLoader } from
  "./document-first-layer-source-loader.js";
import { createDocumentKnowledgeProjectionManifestLoader } from
  "./document-knowledge-projection-manifest-loader.js";
import { createDocumentPageBaseLoader } from "./document-page-base-loader.js";
import { createDocumentPreparedSourceLoader } from
  "./document-prepared-source-loader.js";
import { createDocumentSemanticFactLoader } from
  "./document-semantic-fact-loader.js";
import { createPostgresCandidateFileRelationRepository } from
  "./postgres-candidate-file-relation-repository.js";
import { createPostgresDocumentReferenceFactRepository } from
  "./postgres-document-reference-fact-repository.js";
import { createPostgresDocumentArtifactWorkRepository } from
  "./postgres-document-artifact-work-repository.js";
import { createPostgresDocumentDirectoryNavigation } from
  "./postgres-document-directory-navigation.js";
import { createPostgresDocumentGeneratedContext } from
  "./postgres-document-generated-context.js";
import { createPostgresDocumentGraphRagChunkRepository } from
  "./postgres-document-graphrag-chunk-repository.js";
import { createPostgresDocumentModelEvaluationRepository } from
  "./postgres-document-model-evaluation.js";
import { createPostgresDocumentModelLayerExecutionRepository } from
  "./postgres-document-model-layer-execution.js";
import { createPostgresDocumentModelTraceRepository } from
  "./postgres-document-model-trace.js";
import { createPostgresDocumentReceiptRepository } from
  "./postgres-document-receipt-repository.js";
import { createPostgresDocumentSearchOwnerRepository } from
  "./postgres-document-search-owner-repository.js";
import { createPostgresDocumentSemanticFactReuse } from
  "./postgres-document-semantic-fact-reuse.js";
import { createPostgresDocumentWorkContext } from
  "./postgres-document-work-context.js";
import { createPostgresGeneratedPageBaseRepository } from
  "./postgres-generated-page-base-repository.js";
import { createPostgresGeneratedPageRepository } from
  "./postgres-generated-page-repository.js";
import { createPostgresProjectionDirtyScopeRepository } from
  "./postgres-projection-dirty-scope-repository.js";
import { createPostgresDocumentProjectionFacts } from
  "./postgres-document-projection-facts.js";
import { createPostgresProjectionScopeContributions } from
  "./postgres-projection-scope-contributions.js";
import { createPostgresRelationPairRepository } from
  "./postgres-relation-pair-repository.js";
import { createPostgresScopedActivationOwnerRepository } from
  "./postgres-scoped-activation-owner-repository.js";
import { createPostgresSearchFamilyRepository } from
  "./postgres-search-family-repository.js";
import { createPostgresSemanticFactRepository } from
  "../../semantic/infrastructure/postgres-fact-repository.js";

export function createProductionDocumentFixedRepositories(
  sql: DatabaseClient,
  webhookRetentionMilliseconds = 30 * 86_400_000
) {
  return {
    work: createPostgresDocumentArtifactWorkRepository(sql, {
      webhookRetentionMilliseconds
    }),
    receipts: createPostgresDocumentReceiptRepository(sql),
    contexts: createPostgresDocumentWorkContext(sql),
    referenceFacts: createPostgresDocumentReferenceFactRepository(sql),
    pairs: createPostgresRelationPairRepository(sql),
    relations: createPostgresCandidateFileRelationRepository(sql),
    dirtyScopes: createPostgresProjectionDirtyScopeRepository(sql),
    projectionFacts: createPostgresDocumentProjectionFacts(sql),
    scopeContributions: createPostgresProjectionScopeContributions(sql),
    activationOwners: createPostgresScopedActivationOwnerRepository(sql),
    searchFamilies: createPostgresSearchFamilyRepository(sql),
    searchOwners: createPostgresDocumentSearchOwnerRepository(sql),
    bases: createPostgresGeneratedPageBaseRepository(sql),
    pages: createPostgresGeneratedPageRepository(sql),
    directoryNavigation: createPostgresDocumentDirectoryNavigation(sql),
    generatedContext: createPostgresDocumentGeneratedContext(sql),
    modelTraces: createPostgresDocumentModelTraceRepository(sql),
    modelLayers: createPostgresDocumentModelLayerExecutionRepository(sql),
    modelEvaluations: createPostgresDocumentModelEvaluationRepository(sql),
    semanticFacts: createPostgresSemanticFactRepository(sql),
    semanticFactReuse: createPostgresDocumentSemanticFactReuse(sql),
    graphRagChunks: createPostgresDocumentGraphRagChunkRepository(sql)
  };
}

export function createProductionDocumentFixedLoaders(input: {
  contexts: ReturnType<typeof createPostgresDocumentWorkContext>;
  receipts: ReturnType<typeof createPostgresDocumentReceiptRepository>;
  bodies: ReturnType<typeof createS3StorageVnextImmutableBodyStore>;
  maximumBytes: number;
}) {
  const maximumSnapshotBytes = input.maximumBytes * 3 + 2 * 1_048_576;
  return {
    prepared: createDocumentPreparedSourceLoader({
      ...input,
      maximumSnapshotBytes
    }),
    firstLayer: createDocumentFirstLayerSourceLoader({
      receipts: input.receipts,
      bodies: input.bodies,
      maximumSnapshotBytes
    }),
    facts: createDocumentSemanticFactLoader({
      receipts: input.receipts,
      bodies: input.bodies,
      maximumBytes: maximumSnapshotBytes
    }),
    pageBase: createDocumentPageBaseLoader({
      bodies: input.bodies,
      maximumBytes: maximumSnapshotBytes
    }),
    manifest: createDocumentKnowledgeProjectionManifestLoader({
      bodies: input.bodies,
      maximumBytes: maximumSnapshotBytes
    })
  };
}

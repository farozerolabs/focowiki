import { createHash } from "node:crypto";
import type { RuntimeConfig } from "../../config.js";
import type { DatabaseClient } from "../../db/client.js";
import type { createEmbeddingArtifactService } from
  "../../semantic/embedding/artifact-service.js";
import { createPostgresSemanticVectorProjectionRepository } from
  "../../semantic/infrastructure/postgres-vector-projection-repository.js";
import { planSemanticVectorProjection } from
  "../../semantic/vector/projection-planner.js";
import { createSemanticVectorProjectionService } from
  "../../semantic/vector/projection-service.js";
import type { CanonicalFileRelation } from "../domain/file-relation.js";
import { createDocumentSemanticPlan } from
  "../application/document-semantic-plan.js";
import { prepareDocumentRelationshipSearchDocuments } from
  "../application/document-search-preparation.js";
import { resolvePinnedDocumentOutputSettings } from
  "../application/document-output-settings.js";
import type { ClaimedDocumentArtifactWork } from
  "../application/document-work-port.js";
import type { DocumentPageBaseSnapshot } from
  "./production-document-page-base.js";
import type { createDocumentSemanticFactLoader } from
  "./document-semantic-fact-loader.js";
import type { createPostgresDocumentWorkContext } from
  "./postgres-document-work-context.js";
import type { createDocumentPreparedSourceLoader } from
  "./document-prepared-source-loader.js";
import type { createPostgresEmbeddingConfigurationRepository as EmbeddingRepository } from
  "../../semantic/infrastructure/postgres-embedding-configuration-repository.js";
import type { createPostgresSearchFamilyRepository } from
  "./postgres-search-family-repository.js";
import type { createWorkerDocumentSearchRuntime } from
  "./worker-document-search-runtime.js";
import type { createDocumentResourceLanes } from
  "../application/document-resource-lanes.js";
import { buildEmbeddingInputs } from
  "./production-document-processor-support.js";
import {
  abortableWait,
  isCurrentSourceRevision,
  preferMaintenanceSearchProjection,
  processorError,
  readSearchProjection,
  readVectorProjection
} from "./production-document-processor-support.js";
import { documentJobContextFromWork } from
  "./production-document-first-layer-work-handler.js";
import { documentSourceExcerpt } from
  "../application/document-source-excerpt.js";

type Context = Awaited<ReturnType<ReturnType<
  typeof createPostgresDocumentWorkContext
>["read"]>>;
type Prepared = Awaited<ReturnType<ReturnType<
  typeof createDocumentPreparedSourceLoader
>>>;

export type DocumentSemanticSearchProjection = {
  semanticVectorDocumentPublicIds: readonly string[];
  relationshipSearchDocumentPublicIds: readonly string[];
  searchFamilyPublicIds: readonly string[];
};

export function createProductionDocumentSemanticSearchProjection(input: {
  sql: DatabaseClient;
  config: RuntimeConfig;
  facts: ReturnType<typeof createDocumentSemanticFactLoader>;
  embeddingConfigurations: ReturnType<typeof EmbeddingRepository>;
  embeddingArtifacts: ReturnType<typeof createEmbeddingArtifactService>;
  search: ReturnType<typeof createWorkerDocumentSearchRuntime>;
  searchFamilies: ReturnType<typeof createPostgresSearchFamilyRepository>;
  lanes: ReturnType<typeof createDocumentResourceLanes>;
  now?: () => string;
}) {
  const clock = input.now ?? (() => new Date().toISOString());
  return async (request: {
    claimed: ClaimedDocumentArtifactWork;
    context: Context;
    prepared: Prepared;
    sources: readonly DocumentPageBaseSnapshot[];
    relations: readonly CanonicalFileRelation[];
    affectedSourceFilePublicIds: readonly string[];
    signal: AbortSignal;
  }): Promise<DocumentSemanticSearchProjection> => {
    const job = documentJobContextFromWork(request.claimed, request.context.job);
    const semanticGenerationPublicId = request.context.job.semanticGenerationPublicId;
    const embeddingRevisionPublicId = request.context.job
      .embeddingConfigurationRevisionPublicId;
    if (!semanticGenerationPublicId || !embeddingRevisionPublicId) {
      throw processorError("embedding_configuration_missing");
    }
    const [facts, embeddingConfiguration] = await Promise.all([
      input.facts({ claimed: request.claimed, signal: request.signal }),
      input.embeddingConfigurations.getRevision(embeddingRevisionPublicId)
    ]);
    if (!embeddingConfiguration
      || embeddingConfiguration.validationStatus !== "valid"
      || embeddingConfiguration.resolvedDimension === null) {
      throw processorError("embedding_configuration_invalid");
    }
    const resolvedDimension = embeddingConfiguration.resolvedDimension;
    const settings = resolvePinnedDocumentOutputSettings(
      request.context.runtimeSettings as never
    );
    const plan = createDocumentSemanticPlan({
      maximumChunkCharacters: settings.semantic.maximumChunkCharacters,
      maximumChunks: settings.semantic.maximumChunks
    })({
      sourceRevisionPublicId: request.claimed.sourceRevisionPublicId,
      logicalPath: request.context.source.logicalPath,
      title: request.prepared.resolvedMetadata.title,
      markdown: request.prepared.body,
      metadata: request.prepared.parsedMetadata,
      contentProfile: request.prepared.contentProfile
    });
    const embeddingInputs = buildEmbeddingInputs({
      job,
      logicalPath: request.context.source.logicalPath,
      plan,
      facts,
      maximumEvidenceTargets: settings.semantic.maximumEvidenceTargets
    }).filter((item) => item.inputKind !== "content");
    const embeddings = await input.lanes.run("embedding", () =>
      input.embeddingArtifacts.resolveMany(
        embeddingInputs.map((embeddingInput) => ({
          embeddingInput,
          configuration: embeddingConfiguration,
          knowledgeBaseId: request.claimed.knowledgeBaseId,
          semanticGenerationPublicId,
          operationPublicId: request.context.job.operationPublicId,
          retentionKind: "candidate" as const,
          sourceExcerpt: documentSourceExcerpt(embeddingInput.canonicalText),
          signal: request.signal
        }))
      ), request.signal);
    const searchConfig = input.config.search;
    if (!searchConfig) throw processorError("search_configuration_missing");
    const projection = await readSearchProjection(input.sql, {
      knowledgeBaseId: request.claimed.knowledgeBaseId,
      providerKind: input.search.provider.kind,
      preferPreparing: preferMaintenanceSearchProjection(job)
    });
    const relationshipDocuments = prepareDocumentRelationshipSearchDocuments({
      knowledgeBaseId: request.claimed.knowledgeBaseId,
      searchContractSha256: projection.schemaChecksumSha256,
      affectedSourceFilePublicIds: request.affectedSourceFilePublicIds,
      sources: request.sources,
      relations: request.relations
    });
    const { relationshipSearchIds, semanticVectorIds } = await input.lanes.run(
      "search_transport",
      async () => {
      await input.search.ensure(projection.providerIndexUid, request.signal);
      const relationshipSearchIds = await indexRelationships({
        search: input.search,
        projection,
        documents: relationshipDocuments,
        knowledgeBaseId: request.claimed.knowledgeBaseId,
        stagedAt: clock(),
        signal: request.signal
      });
      if (!input.search.provider.vector) {
        throw processorError("search_vector_capability_missing");
      }
      const vectorContext = await readVectorProjection(input.sql, {
        knowledgeBaseId: request.claimed.knowledgeBaseId,
        semanticGenerationPublicId,
        embeddingConfigurationRevisionPublicId:
          embeddingConfiguration.vectorProducingRevisionPublicId,
        providerKind: input.search.provider.kind
      });
      const vectorInputs = embeddingInputs.map((embeddingInput, index) => ({
        publicId: `vector-document-${hash([
          semanticGenerationPublicId,
          embeddingInput.inputKind,
          embeddingInput.ownerPublicId,
          request.claimed.sourceRevisionPublicId,
          embeddings[index]!.artifact.publicId
        ])}`,
        ownerPublicId: embeddingInput.ownerPublicId,
        family: embeddingInput.inputKind,
        sourceFilePublicId: request.claimed.sourceFilePublicId,
        sourceRevisionPublicId: request.claimed.sourceRevisionPublicId,
        artifactPublicId: embeddings[index]!.artifact.publicId,
        evidenceTargetPath: request.context.source.logicalPath,
        sourceExcerpt: documentSourceExcerpt(embeddingInput.canonicalText),
        fileKind: "page",
        okfStatus: null,
        okfTrustTier: null,
        okfStaleAfterEpochDay: null,
        vector: embeddings[index]!.vector
      }));
      const vectors = createPostgresSemanticVectorProjectionRepository(input.sql);
      const prior = await vectors.listSourceDocuments({
        knowledgeBaseId: request.claimed.knowledgeBaseId,
        semanticGenerationPublicId,
        sourceFilePublicId: request.claimed.sourceFilePublicId,
        limit: 10_000
      });
      const desired = new Set(vectorInputs.map((item) => item.publicId));
      const vectorPlan = planSemanticVectorProjection({
        operationPublicId: request.context.job.operationPublicId,
        indexPrefix: searchConfig.indexPrefix,
        knowledgeBaseId: request.claimed.knowledgeBaseId,
        semanticGenerationPublicId,
        projectionContractPublicId: vectorContext.publicId,
        embeddingConfigurationRevisionPublicId:
          embeddingConfiguration.vectorProducingRevisionPublicId,
        dimension: resolvedDimension,
        mappingFingerprintSha256: vectorContext.mappingFingerprintSha256,
        upserts: vectorInputs,
        deletes: prior.filter((item) => !desired.has(item.publicId))
      });
      await createSemanticVectorProjectionService({
        provider: input.search.provider.vector,
        repository: vectors,
        async isCurrent() { return isCurrentSourceRevision(input.sql, job); },
        maximumOperationPolls: Math.max(1, Math.ceil(
          settings.search.taskTimeoutMs / settings.search.taskPollIntervalMs
        )),
        operationPollIntervalMs: settings.search.taskPollIntervalMs,
        wait: (milliseconds) => abortableWait(milliseconds, request.signal)
      }).apply(vectorPlan);
      const semanticVectorIds = vectorPlan.desiredDocuments.map(
        (item) => item.publicId
      );
      return { relationshipSearchIds, semanticVectorIds };
      },
      request.signal
    );
    const semanticFamilyId = await input.searchFamilies.recordAcknowledged({
      knowledgeBaseId: request.claimed.knowledgeBaseId,
      sourceFilePublicId: request.claimed.sourceFilePublicId,
      sourceRevisionPublicId: request.claimed.sourceRevisionPublicId,
      providerKind: input.search.provider.kind,
      family: "semantic_seed_vectors",
      inputFingerprintSha256: hash([
        projection.schemaChecksumSha256,
        ...semanticVectorIds
      ]),
      providerDocumentIds: semanticVectorIds,
      acknowledgedAt: clock()
    });
    const relationshipFamilyId = await input.searchFamilies.recordAcknowledged({
      knowledgeBaseId: request.claimed.knowledgeBaseId,
      sourceFilePublicId: request.claimed.sourceFilePublicId,
      sourceRevisionPublicId: request.claimed.sourceRevisionPublicId,
      providerKind: input.search.provider.kind,
      family: "relation_evidence",
      inputFingerprintSha256: hash([
        projection.schemaChecksumSha256,
        ...relationshipSearchIds,
        ...semanticVectorIds.filter((_, index) =>
          embeddingInputs[index]?.inputKind === "relationship")
      ]),
      providerDocumentIds: relationshipSearchIds,
      acknowledgedAt: clock()
    });
    return {
      semanticVectorDocumentPublicIds: semanticVectorIds,
      relationshipSearchDocumentPublicIds: relationshipSearchIds,
      searchFamilyPublicIds: [semanticFamilyId, relationshipFamilyId]
    };
  };
}

async function indexRelationships(input: {
  search: ReturnType<typeof createWorkerDocumentSearchRuntime>;
  projection: Awaited<ReturnType<typeof readSearchProjection>>;
  documents: ReturnType<typeof prepareDocumentRelationshipSearchDocuments>;
  knowledgeBaseId: string;
  stagedAt: string;
  signal: AbortSignal;
}): Promise<readonly string[]> {
  const grouped = new Map<string, typeof input.documents>();
  for (const document of input.documents) {
    const key = `${document.sourceFilePublicId}\0${document.sourceRevisionPublicId}`;
    const group = grouped.get(key) ?? [];
    group.push(document);
    grouped.set(key, group);
  }
  const ids: string[] = [];
  for (const documents of grouped.values()) {
    const first = documents[0]!;
    const result = await input.search.index({
      knowledgeBaseId: input.knowledgeBaseId,
      sourceFilePublicId: first.sourceFilePublicId,
      sourceRevisionPublicId: first.sourceRevisionPublicId,
      searchProjectionPublicId: input.projection.publicId,
      providerIndexUid: input.projection.providerIndexUid,
      documents,
      stagedAt: input.stagedAt,
      signal: input.signal
    });
    ids.push(...result.documentIds);
  }
  return ids.sort();
}

function hash(values: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

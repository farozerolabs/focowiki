import { createHash } from "node:crypto";
import type { RuntimeConfig } from "../../config.js";
import type { DatabaseClient } from "../../db/client.js";
import type { createEmbeddingArtifactService } from
  "../../semantic/embedding/artifact-service.js";
import { buildSemanticEmbeddingInput } from
  "../../semantic/embedding/input-builder.js";
import type { createPostgresEmbeddingConfigurationRepository } from
  "../../semantic/infrastructure/postgres-embedding-configuration-repository.js";
import { createPostgresSemanticVectorProjectionRepository } from
  "../../semantic/infrastructure/postgres-vector-projection-repository.js";
import { planSemanticVectorProjection } from
  "../../semantic/vector/projection-planner.js";
import { createSemanticVectorProjectionService } from
  "../../semantic/vector/projection-service.js";
import type { ClaimedDocumentArtifactWork } from
  "../application/document-work-port.js";
import { createDocumentSemanticPlan } from
  "../application/document-semantic-plan.js";
import { prepareDocumentSearchDocuments } from
  "../application/document-search-preparation.js";
import { resolvePinnedDocumentOutputSettings } from
  "../application/document-output-settings.js";
import { documentSourceExcerpt } from
  "../application/document-source-excerpt.js";
import type { createDocumentResourceLanes } from
  "../application/document-resource-lanes.js";
import type { createDocumentPreparedSourceLoader } from
  "./document-prepared-source-loader.js";
import type { createPostgresDocumentWorkContext } from
  "./postgres-document-work-context.js";
import type { createPostgresSearchFamilyRepository } from
  "./postgres-search-family-repository.js";
import type { createWorkerDocumentSearchRuntime } from
  "./worker-document-search-runtime.js";
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

export function createProductionDocumentContentProjectionWorkHandler(input: {
  sql: DatabaseClient;
  config: RuntimeConfig;
  contexts: ReturnType<typeof createPostgresDocumentWorkContext>;
  preparedSources: ReturnType<typeof createDocumentPreparedSourceLoader>;
  embeddingConfigurations: ReturnType<
    typeof createPostgresEmbeddingConfigurationRepository
  >;
  embeddingArtifacts: ReturnType<typeof createEmbeddingArtifactService>;
  search: ReturnType<typeof createWorkerDocumentSearchRuntime>;
  searchFamilies: ReturnType<typeof createPostgresSearchFamilyRepository>;
  lanes: ReturnType<typeof createDocumentResourceLanes>;
  now?: () => string;
}) {
  const clock = input.now ?? (() => new Date().toISOString());
  return async (request: {
    claimed: ClaimedDocumentArtifactWork;
    signal: AbortSignal;
    releasePrimaryLane(): void;
  }) => {
    const [context, prepared] = await Promise.all([
      input.contexts.read(request.claimed),
      input.preparedSources({ claimed: request.claimed, signal: request.signal })
    ]);
    const job = documentJobContextFromWork(request.claimed, context.job);
    const semanticGenerationPublicId = context.job.semanticGenerationPublicId;
    const embeddingRevisionPublicId = context.job
      .embeddingConfigurationRevisionPublicId;
    if (!semanticGenerationPublicId || !embeddingRevisionPublicId) {
      throw processorError("embedding_configuration_missing");
    }
    const embeddingConfiguration = await input.embeddingConfigurations
      .getRevision(embeddingRevisionPublicId);
    if (!embeddingConfiguration
      || embeddingConfiguration.validationStatus !== "valid"
      || embeddingConfiguration.resolvedDimension === null) {
      throw processorError("embedding_configuration_invalid");
    }
    const resolvedDimension = embeddingConfiguration.resolvedDimension;
    const settings = resolvePinnedDocumentOutputSettings(
      context.runtimeSettings as never
    );
    const plan = createDocumentSemanticPlan({
      maximumChunkCharacters: settings.semantic.maximumChunkCharacters,
      maximumChunks: settings.semantic.maximumChunks
    })({
      sourceRevisionPublicId: request.claimed.sourceRevisionPublicId,
      logicalPath: context.source.logicalPath,
      title: prepared.resolvedMetadata.title,
      markdown: prepared.body,
      metadata: prepared.parsedMetadata,
      contentProfile: prepared.contentProfile
    });
    const embeddingInputs = plan.contentVectorInputs.map((chunk) =>
      buildSemanticEmbeddingInput({
        inputKind: "content",
        ownerPublicId: chunk.publicId,
        sourceFilePublicId: request.claimed.sourceFilePublicId,
        sourceRevisionPublicId: request.claimed.sourceRevisionPublicId,
        fields: { body: chunk.text },
        evidenceTargets: [{
          sourceFilePublicId: request.claimed.sourceFilePublicId,
          sourceRevisionPublicId: request.claimed.sourceRevisionPublicId,
          evidencePublicId: chunk.publicId,
          logicalPath: context.source.logicalPath
        }],
        maximumCharacters: 32_000,
        maximumEvidenceTargets: settings.semantic.maximumEvidenceTargets
      }));
    const embeddings = await input.embeddingArtifacts.resolveMany(
      embeddingInputs.map((embeddingInput) => ({
        embeddingInput,
        configuration: embeddingConfiguration,
        knowledgeBaseId: request.claimed.knowledgeBaseId,
        semanticGenerationPublicId,
        operationPublicId: context.job.operationPublicId,
        retentionKind: "candidate" as const,
        sourceExcerpt: documentSourceExcerpt(embeddingInput.canonicalText),
        signal: request.signal
      }))
    );
    const searchConfig = input.config.search;
    if (!searchConfig) throw processorError("search_configuration_missing");
    const projection = await readSearchProjection(input.sql, {
      knowledgeBaseId: request.claimed.knowledgeBaseId,
      providerKind: input.search.provider.kind,
      preferPreparing: preferMaintenanceSearchProjection(job)
    });
    const searchContractSha256 = projection.schemaChecksumSha256;
    const embeddingByOwner = new Map(embeddings.map((item) => [
      item.artifact.ownerPublicId,
      item.artifact.publicId
    ]));
    const searchDocuments = prepareDocumentSearchDocuments({
      knowledgeBaseId: request.claimed.knowledgeBaseId,
      sourceFilePublicId: request.claimed.sourceFilePublicId,
      sourceRevisionPublicId: request.claimed.sourceRevisionPublicId,
      searchContractSha256,
      logicalPath: context.source.logicalPath,
      title: prepared.resolvedMetadata.title,
      metadata: prepared.metadata,
      fileSearchText: prepared.body,
      graphSeed: {
        searchText: [
          prepared.resolvedMetadata.title,
          prepared.contentProfile.summary,
          ...prepared.contentProfile.subjects,
          ...prepared.contentProfile.entities,
          ...prepared.contentProfile.relationshipHints
        ].filter(Boolean).join("\n"),
        rankingTerms: [
          ...prepared.contentProfile.subjects,
          ...prepared.contentProfile.entities,
          ...prepared.contentProfile.keywords,
          ...prepared.contentProfile.tags,
          ...prepared.contentProfile.relationshipHints
        ]
      },
      segments: plan.contentVectorInputs.map((segment, ordinal) => ({
        publicId: segment.publicId,
        ordinal,
        headingAncestors: [],
        searchText: segment.text,
        embeddingArtifactPublicId: embeddingByOwner.get(segment.publicId)
          ?? missing("content_embedding_artifact_missing")
      }))
    });
    const { indexed, vectorDocumentIds } = await input.lanes.run(
      "search_transport",
      async () => {
      await input.search.ensure(projection.providerIndexUid, request.signal);
      const indexed = await input.search.index({
        knowledgeBaseId: request.claimed.knowledgeBaseId,
        sourceFilePublicId: request.claimed.sourceFilePublicId,
        sourceRevisionPublicId: request.claimed.sourceRevisionPublicId,
        searchProjectionPublicId: projection.publicId,
        providerIndexUid: projection.providerIndexUid,
        documents: searchDocuments,
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
          embeddingInput.ownerPublicId,
          request.claimed.sourceRevisionPublicId,
          embeddings[index]!.artifact.publicId
        ])}`,
        ownerPublicId: embeddingInput.ownerPublicId,
        family: "content" as const,
        sourceFilePublicId: request.claimed.sourceFilePublicId,
        sourceRevisionPublicId: request.claimed.sourceRevisionPublicId,
        artifactPublicId: embeddings[index]!.artifact.publicId,
        evidenceTargetPath: context.source.logicalPath,
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
        operationPublicId: context.job.operationPublicId,
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
      const vectorDocumentIds = vectorPlan.desiredDocuments.map(
        (item) => item.publicId
      );
      return { indexed, vectorDocumentIds };
      },
      request.signal
    );
    const familyEntries = [
      ["content_metadata", searchDocuments.filter((item) => item.documentKind === "file")],
      ["graph_seed", searchDocuments.filter((item) => item.documentKind === "graph_seed")],
      ["content_segments_vectors", searchDocuments.filter(
        (item) => item.documentKind === "segment"
      )]
    ] as const;
    const familyPublicIds: string[] = [];
    for (const [family, documents] of familyEntries) {
      familyPublicIds.push(await input.searchFamilies.recordAcknowledged({
        knowledgeBaseId: request.claimed.knowledgeBaseId,
        sourceFilePublicId: request.claimed.sourceFilePublicId,
        sourceRevisionPublicId: request.claimed.sourceRevisionPublicId,
        providerKind: input.search.provider.kind,
        family,
        inputFingerprintSha256: hash([
          family,
          searchContractSha256,
          ...documents.map((item) => item.publicId),
          ...vectorDocumentIds
        ]),
        providerDocumentIds: [
          ...documents.map((item) => item.publicId),
          ...(family === "content_segments_vectors" ? vectorDocumentIds : [])
        ],
        acknowledgedAt: clock()
      }));
    }
    const outputFingerprintSha256 = hash([
      ...embeddings.map((item) => item.artifact.publicId),
      ...indexed.documentIds,
      ...vectorDocumentIds,
      ...familyPublicIds
    ]);
    return {
      key: "content",
      outputFingerprintSha256,
      value: {
        schemaVersion: "document-content-projection-receipt-v1",
        embeddingArtifactPublicIds: embeddings.map((item) => item.artifact.publicId),
        searchDocumentPublicIds: indexed.documentIds,
        vectorDocumentPublicIds: vectorDocumentIds,
        searchFamilyPublicIds: familyPublicIds
      },
      serviceEndedAt: clock()
    };
  };
}

function hash(values: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

function missing(code: string): never {
  throw processorError(code);
}

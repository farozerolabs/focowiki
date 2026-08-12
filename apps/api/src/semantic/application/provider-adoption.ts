import type {
  SearchProviderOperationReceipt,
  SearchProviderVectorDocument,
  SearchProviderVectorIndexDefinition,
  SearchProviderVectorPort
} from "../../application/ports/search-provider-runtime.js";
import { sameSearchProviderVectorIndexDefinition } from
  "../../application/ports/search-provider-runtime.js";
import { mapWithConcurrency } from "../../runtime/bounded.js";
import type { StorageVnextCatalogReadPort } from
  "../../storage-vnext/catalog/ports.js";
import { isStorageVnextStablePublicationSource } from
  "../../storage-vnext/publication/source-eligibility.js";
import type {
  EmbeddingArtifactRepositoryPort,
  EmbeddingArtifactStorePort
} from "../embedding/artifact-ports.js";
import { decodeVectorArtifact } from
  "../embedding/vector-artifact-codec.js";
import type { SemanticMaintenanceTarget } from "../domain/contracts.js";
import { semanticVectorIndexUid } from "../vector/projection-planner.js";
import { vectorDocumentPublicId } from "./vector-stage-handler.js";

export type SemanticProviderAdoptionRepository = {
  countActiveVectorDocuments(input: {
    knowledgeBaseId: string;
    semanticGenerationPublicId: string;
  }): Promise<number>;
  activateProviderProjection(input: {
    knowledgeBaseId: string;
    operationPublicId: string;
    semanticGenerationPublicId: string;
    expectedGenerationRevision: number;
    cleanupNotBefore: string;
    target: SemanticMaintenanceTarget;
  }): Promise<boolean>;
};

export function createSemanticProviderAdoptionService(input: {
  catalog: Pick<StorageVnextCatalogReadPort, "listCurrentSources">;
  artifacts: Pick<EmbeddingArtifactRepositoryPort, "listSourceReferences">;
  store: Pick<EmbeddingArtifactStorePort, "readVerified">;
  repository: SemanticProviderAdoptionRepository;
  provider: SearchProviderVectorPort;
  indexPrefix: string;
  artifactReadConcurrency?: number;
  operationPollLimit?: number;
  operationPollIntervalMs?: number;
  wait?: (milliseconds: number) => Promise<void>;
}) {
  const concurrency = input.artifactReadConcurrency ?? 4;
  const pollLimit = input.operationPollLimit ?? 100;
  const pollIntervalMs = input.operationPollIntervalMs ?? 100;
  const wait = input.wait ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  assertLimit(concurrency, 1, 32);
  assertLimit(pollLimit, 1, 10_000);
  assertLimit(pollIntervalMs, 0, 30_000);

  return {
    async planSourcePage(request: {
      knowledgeBaseId: string;
      semanticGenerationPublicId: string;
      target: SemanticMaintenanceTarget;
      cursor: string | null;
      pageSize: number;
      signal?: AbortSignal;
    }) {
      assertRequest(request);
      const indexUid = semanticVectorIndexUid({
        indexPrefix: input.indexPrefix,
        knowledgeBaseId: request.knowledgeBaseId,
        semanticGenerationPublicId: request.semanticGenerationPublicId,
        mappingFingerprintSha256: request.target.mappingFingerprintSha256
      });
      const definition = definitionFor(request.target);
      if (request.cursor === null) {
        const existing = await input.provider.getIndexDefinition({ indexUid });
        if (!existing) {
          await awaitReceipt(await input.provider.createIndex({
            indexUid,
            definition
          }));
        } else if (!sameSearchProviderVectorIndexDefinition(existing, definition)) {
          throw providerAdoptionError("semantic_provider_mapping_conflict");
        }
      }
      const page = await input.catalog.listCurrentSources({
        knowledgeBaseId: request.knowledgeBaseId,
        limit: request.pageSize,
        cursor: request.cursor
      });
      const sources = page.items.filter(({ sourceFile }) =>
        isStorageVnextStablePublicationSource(sourceFile));
      let documentCount = 0;
      for (const source of sources) {
        throwIfAborted(request.signal);
        const references = await input.artifacts.listSourceReferences({
          knowledgeBaseId: request.knowledgeBaseId,
          semanticGenerationPublicId: request.semanticGenerationPublicId,
          sourceFilePublicId: source.sourceFile.publicId,
          sourceRevisionPublicId: source.sourceRevision.publicId,
          limit: 1_000
        });
        const documents = await mapWithConcurrency(
          references,
          concurrency,
          async (reference): Promise<SearchProviderVectorDocument> => {
            throwIfAborted(request.signal);
            const artifact = reference.artifact;
            if (
              artifact.embeddingConfigurationRevisionPublicId
                !== request.target.embeddingConfigurationRevisionPublicId
              || artifact.dimension !== request.target.resolvedDimension
              || artifact.normalization !== request.target.normalization
              || artifact.artifactSchemaVersion
                !== request.target.artifactSchemaVersion
              || artifact.sourceRevisionPublicId !== source.sourceRevision.publicId
            ) throw providerAdoptionError(
              "semantic_provider_artifact_contract_mismatch"
            );
            const bytes = await input.store.readVerified({
              descriptor: {
                objectId: artifact.objectId,
                storageKey: artifact.storageKey,
                checksumSha256: artifact.vectorChecksumSha256,
                byteCount: artifact.byteCount,
                contentType: "application/octet-stream",
                objectFormat: "semantic-vector-v1"
              },
              maximumBytes: 16 + request.target.resolvedDimension * 4,
              ...(request.signal ? { signal: request.signal } : {})
            });
            return {
              id: vectorDocumentPublicId(
                request.semanticGenerationPublicId,
                artifact.inputKind,
                artifact.ownerPublicId,
                source.sourceRevision.publicId
              ),
              knowledgeBaseId: request.knowledgeBaseId,
              semanticGenerationPublicId: request.semanticGenerationPublicId,
              ownerPublicId: artifact.ownerPublicId,
              family: artifact.inputKind,
              sourceFilePublicId: source.sourceFile.publicId,
              sourceRevisionPublicId: source.sourceRevision.publicId,
              embeddingConfigurationRevisionPublicId:
                request.target.embeddingConfigurationRevisionPublicId,
              evidenceTargetPath: reference.evidenceTargetPath,
              sourceExcerpt: reference.sourceExcerpt,
              fileKind: reference.fileKind,
              okfStatus: reference.okfSignals.status,
              okfTrustTier: reference.okfSignals.trustTier,
              okfStaleAfterEpochDay: reference.okfSignals.staleAfterEpochDay,
              vector: decodeVectorArtifact({
                bytes,
                checksumSha256: artifact.vectorChecksumSha256,
                dimension: request.target.resolvedDimension,
                normalization: request.target.normalization,
                maximumBytes: 16 + request.target.resolvedDimension * 4
              })
            };
          }
        );
        for (let offset = 0; offset < documents.length; offset += 1_000) {
          const batch = documents.slice(offset, offset + 1_000);
          if (batch.length === 0) continue;
          await awaitReceipt(await input.provider.writeDocuments({
            indexUid,
            definition,
            documents: batch,
            correlation: `${indexUid}:${source.sourceFile.publicId}:${offset}`
          }));
        }
        documentCount += documents.length;
      }
      return {
        sourceCount: sources.length,
        documentCount,
        nextCursor: page.nextCursor,
        candidateIndexUid: indexUid
      };
    },

    async validate(request: {
      knowledgeBaseId: string;
      semanticGenerationPublicId: string;
      target: SemanticMaintenanceTarget;
    }) {
      const expectedDocumentCount = await input.repository
        .countActiveVectorDocuments(request);
      const indexUid = semanticVectorIndexUid({
        indexPrefix: input.indexPrefix,
        knowledgeBaseId: request.knowledgeBaseId,
        semanticGenerationPublicId: request.semanticGenerationPublicId,
        mappingFingerprintSha256: request.target.mappingFingerprintSha256
      });
      const validation = await input.provider.validate({
        indexUid,
        definition: definitionFor(request.target),
        expectedDocumentCount
      });
      if (!validation.valid || validation.documentCount !== expectedDocumentCount) {
        throw providerAdoptionError("semantic_provider_validation_failed");
      }
      return { expectedDocumentCount, candidateIndexUid: indexUid };
    },

    async activate(request: {
      knowledgeBaseId: string;
      operationPublicId: string;
      semanticGenerationPublicId: string;
      expectedGenerationRevision: number;
      cleanupNotBefore: string;
      target: SemanticMaintenanceTarget;
    }) {
      assertActivationRequest(request);
      if (!await input.repository.activateProviderProjection(request)) {
        throw providerAdoptionError("semantic_provider_activation_stale");
      }
    }
  };

  async function awaitReceipt(receipt: SearchProviderOperationReceipt): Promise<void> {
    if (receipt.state === "completed") return;
    for (let poll = 0; poll < pollLimit; poll += 1) {
      const status = await input.provider.getOperation({
        operationRef: receipt.operationRef
      });
      if (status.state === "completed") return;
      if (status.state === "failed") {
        throw providerAdoptionError("semantic_provider_operation_failed");
      }
      await wait(pollIntervalMs);
    }
    throw providerAdoptionError("semantic_provider_operation_timeout");
  }
}

function definitionFor(
  target: SemanticMaintenanceTarget
): SearchProviderVectorIndexDefinition {
  return {
    schemaVersion: target.vectorSchemaVersion,
    dimension: target.resolvedDimension,
    similarity: "cosine",
    families: ["content", "entity", "relationship", "community"],
    mappingFingerprintSha256: target.mappingFingerprintSha256
  };
}

function assertRequest(input: {
  knowledgeBaseId: string;
  semanticGenerationPublicId: string;
  target: SemanticMaintenanceTarget;
  pageSize: number;
}): void {
  if (
    !input.knowledgeBaseId
    || !input.semanticGenerationPublicId
    || input.target.knowledgeBaseId !== input.knowledgeBaseId
    || !Number.isSafeInteger(input.pageSize)
    || input.pageSize < 1
    || input.pageSize > 100
  ) throw providerAdoptionError("semantic_provider_request_invalid");
}

function assertActivationRequest(input: {
  knowledgeBaseId: string;
  operationPublicId: string;
  semanticGenerationPublicId: string;
  expectedGenerationRevision: number;
  cleanupNotBefore: string;
  target: SemanticMaintenanceTarget;
}): void {
  if (
    !input.knowledgeBaseId
    || !input.operationPublicId
    || !input.semanticGenerationPublicId
    || input.target.knowledgeBaseId !== input.knowledgeBaseId
    || !Number.isSafeInteger(input.expectedGenerationRevision)
    || input.expectedGenerationRevision < 0
    || !Number.isFinite(Date.parse(input.cleanupNotBefore))
  ) throw providerAdoptionError("semantic_provider_request_invalid");
}

function assertLimit(value: number, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw providerAdoptionError("semantic_provider_limit_invalid");
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Semantic provider adoption aborted", "AbortError");
  }
}

function providerAdoptionError(
  code: string
): Error & { code: string; retryable: boolean } {
  return Object.assign(
    new Error(`Semantic provider adoption failed: ${code}`),
    { code, retryable: false }
  );
}

import { createHash } from "node:crypto";
import type { StorageVnextCatalogRepository } from
  "../../storage-vnext/catalog/ports.js";
import type { SemanticSourceBodyReadPort } from "./ports.js";
import type { SemanticStageWorkClaim } from "./stage-ports.js";
import type { SemanticStageHandlerResult } from "./stage-worker.js";
import type { EmbeddingArtifactRecord } from "../embedding/artifact-ports.js";
import type { EmbeddingConfigurationPrivate } from
  "../embedding/configuration.js";
import type { SemanticSourceEmbeddingInputRepositoryPort } from
  "../embedding/source-input-repository.js";
import { buildSemanticEmbeddingInput } from "../embedding/input-builder.js";
import { createSemanticSourceChunks } from "../graphrag/source-chunks.js";
import { createBoundedSourceExcerpt } from "../search/source-excerpt.js";

type ArtifactResolver = {
  resolveMany(requests: readonly {
    embeddingInput: ReturnType<typeof buildSemanticEmbeddingInput>;
    configuration: EmbeddingConfigurationPrivate;
    knowledgeBaseId: string;
    semanticGenerationPublicId: string;
    operationPublicId: string | null;
    retentionKind: "candidate" | "active" | "retry" | "cleanup";
    sourceExcerpt: string;
    signal?: AbortSignal;
  }[]): Promise<readonly {
    artifact: EmbeddingArtifactRecord;
    vector: readonly number[];
    reused: boolean;
  }[]>;
};

export function createSemanticEmbeddingStageHandler(input: {
  catalog: Pick<StorageVnextCatalogRepository,
    "getSourceFile" | "getSourceRevision" | "getCurrentSourceRevision">;
  bodyStore: SemanticSourceBodyReadPort;
  isOwnedRevision?(claim: SemanticStageWorkClaim): Promise<boolean>;
  sourceInputs: SemanticSourceEmbeddingInputRepositoryPort;
  resolveConfiguration(claim: SemanticStageWorkClaim): Promise<EmbeddingConfigurationPrivate>;
  artifacts: ArtifactResolver;
}) {
  return async function handleEmbedding(
    claim: SemanticStageWorkClaim,
    signal?: AbortSignal
  ): Promise<SemanticStageHandlerResult> {
    const effectiveSignal = signal ?? new AbortController().signal;
    const current = await loadOwnedSource(
      input.catalog,
      claim,
      input.isOwnedRevision
    );
    const configuration = await input.resolveConfiguration(claim);
    if (configuration.revisionPublicId
        !== claim.embeddingConfigurationRevisionPublicId
      || configuration.validationStatus !== "valid"
      || configuration.resolvedDimension
        !== snapshotInteger(claim, "resolvedDimension", 1, 65_536)
      || configuration.normalization !== claim.settingsSnapshot.normalization) {
      throw stageError("semantic_embedding_contract_mismatch", false);
    }
    const maximumSourceBytes = snapshotInteger(
      claim, "maximumSourceBytes", 1, 268_435_456
    );
    const stream = await input.bodyStore.readVerifiedStream({
      objectId: current.revision.objectId,
      checksum: current.revision.checksum,
      byteCount: current.revision.byteCount,
      contentType: current.revision.contentType,
      maxBytes: maximumSourceBytes,
      signal: effectiveSignal
    });
    const markdown = await readUtf8(stream, maximumSourceBytes, effectiveSignal);
    const chunks = createSemanticSourceChunks({
      sourceRevisionPublicId: claim.sourceRevisionPublicId,
      markdown,
      maximumChunkCharacters: snapshotInteger(
        claim, "maximumChunkCharacters", 1, 64_000
      ),
      maximumChunks: snapshotInteger(claim, "maximumChunks", 1, 32)
    });
    const maximumEvidenceTargets = snapshotInteger(
      claim, "maximumEvidenceTargets", 1, 64
    );
    const sourceFacts = await input.sourceInputs.listSourceInputs({
      knowledgeBaseId: claim.knowledgeBaseId,
      semanticGenerationPublicId: claim.semanticGenerationPublicId,
      sourceFilePublicId: claim.sourceFilePublicId,
      sourceRevisionPublicId: claim.sourceRevisionPublicId,
      maximumEntities: 2_000,
      maximumRelationships: 4_000,
      maximumEvidenceTargets
    });
    const maximumCharacters = snapshotInteger(
      claim, "maximumEmbeddingCharacters", 1, 64_000
    );
    const embeddingInputs = [
      ...chunks.map((chunk) => buildSemanticEmbeddingInput({
        inputKind: "content",
        ownerPublicId: `content-${createHash("sha256")
          .update(`${claim.sourceRevisionPublicId}\u001f${chunk.id}`)
          .digest("hex")}`,
        sourceFilePublicId: claim.sourceFilePublicId,
        sourceRevisionPublicId: claim.sourceRevisionPublicId,
        fields: { body: chunk.text },
        evidenceTargets: [{
          sourceFilePublicId: claim.sourceFilePublicId,
          sourceRevisionPublicId: claim.sourceRevisionPublicId,
          evidencePublicId: chunk.id,
          logicalPath: current.source.logicalPath
        }],
        maximumCharacters,
        maximumEvidenceTargets
      })),
      ...sourceFacts.entities.map((entity) => buildSemanticEmbeddingInput({
        inputKind: "entity",
        ownerPublicId: entity.ownerPublicId,
        sourceFilePublicId: claim.sourceFilePublicId,
        sourceRevisionPublicId: claim.sourceRevisionPublicId,
        fields: {
          label: entity.label,
          kind: entity.kind,
          description: entity.description ?? entity.label
        },
        evidenceTargets: entity.evidenceTargets,
        maximumCharacters,
        maximumEvidenceTargets
      })),
      ...sourceFacts.relationships.map((relationship) => buildSemanticEmbeddingInput({
        inputKind: "relationship",
        ownerPublicId: relationship.ownerPublicId,
        sourceFilePublicId: claim.sourceFilePublicId,
        sourceRevisionPublicId: claim.sourceRevisionPublicId,
        fields: {
          sourceLabel: relationship.sourceLabel,
          targetLabel: relationship.targetLabel,
          description: relationship.description
        },
        evidenceTargets: relationship.evidenceTargets,
        maximumCharacters,
        maximumEvidenceTargets
      })),
      ...sourceFacts.communities.map((community) => buildSemanticEmbeddingInput({
        inputKind: "community",
        ownerPublicId: community.ownerPublicId,
        sourceFilePublicId: claim.sourceFilePublicId,
        sourceRevisionPublicId: claim.sourceRevisionPublicId,
        fields: {
          label: community.summary.slice(0, 512),
          summary: community.summary
        },
        evidenceTargets: community.evidenceTargets,
        maximumCharacters,
        maximumEvidenceTargets
      }))
    ];
    const resolvedArtifacts = await input.artifacts.resolveMany(
      embeddingInputs.map((embeddingInput) => ({
          embeddingInput,
          configuration,
          knowledgeBaseId: claim.knowledgeBaseId,
          semanticGenerationPublicId: claim.semanticGenerationPublicId,
          operationPublicId: claim.operationPublicId,
          retentionKind: current.candidate
            ? "candidate"
            : snapshotRetentionKind(claim),
          sourceExcerpt: createBoundedSourceExcerpt(
            embeddingInput.inputKind === "content"
              ? embeddingInput.canonicalText.slice("content: ".length)
              : markdown
          ),
          signal: effectiveSignal
      }))
    );
    if (resolvedArtifacts.length !== embeddingInputs.length) {
      throw stageError("semantic_embedding_batch_incomplete", false);
    }
    const reusedArtifactCount = resolvedArtifacts.filter((item) => item.reused).length;
    const artifacts = resolvedArtifacts.map((item) => item.artifact.publicId);
    return {
      checkpoint: {
        sourceRevisionPublicId: claim.sourceRevisionPublicId,
        inputCount: embeddingInputs.length,
        contentInputCount: chunks.length,
        entityInputCount: sourceFacts.entities.length,
        relationshipInputCount: sourceFacts.relationships.length,
        communityInputCount: sourceFacts.communities.length,
        artifactCount: new Set(artifacts).size,
        configuredBatchSize: configuration.batchSize
      },
      reusedArtifactCount
    };
  };
}

async function loadOwnedSource(
  catalog: Pick<StorageVnextCatalogRepository,
    "getSourceFile" | "getSourceRevision" | "getCurrentSourceRevision">,
  claim: SemanticStageWorkClaim,
  isOwnedRevision?: (claim: SemanticStageWorkClaim) => Promise<boolean>
) {
  const source = await catalog.getSourceFile({
    knowledgeBaseId: claim.knowledgeBaseId,
    publicId: claim.sourceFilePublicId,
    visibility: "current"
  });
  const revision = await catalog.getSourceRevision({
    knowledgeBaseId: claim.knowledgeBaseId,
    publicId: claim.sourceRevisionPublicId
  });
  const current = await catalog.getCurrentSourceRevision({
    knowledgeBaseId: claim.knowledgeBaseId,
    sourceFilePublicId: claim.sourceFilePublicId
  });
  const isCurrent = source && current
    && source.currentRevisionPublicId === claim.sourceRevisionPublicId
    && current.publicId === claim.sourceRevisionPublicId;
  const isOwnedCandidate = source && revision && !isCurrent
    && await isOwnedRevision?.(claim) === true;
  if (!source || !revision
    || revision.sourceFilePublicId !== claim.sourceFilePublicId
    || (!isCurrent && !isOwnedCandidate)) {
    throw stageError("semantic_source_revision_superseded", false);
  }
  return { source, revision, candidate: !isCurrent };
}

async function readUtf8(
  stream: AsyncIterable<Uint8Array>, maximumBytes: number, signal: AbortSignal
) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    if (signal.aborted) throw signal.reason;
    bytes += chunk.byteLength;
    if (bytes > maximumBytes) throw stageError("semantic_source_size_limit", false);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}

function snapshotInteger(
  claim: SemanticStageWorkClaim, key: string, minimum: number, maximum: number
) {
  const value = claim.settingsSnapshot[key];
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw stageError("semantic_settings_snapshot_invalid", false);
  }
  return Number(value);
}

function snapshotRetentionKind(
  claim: SemanticStageWorkClaim
): "active" | "candidate" {
  const value = claim.settingsSnapshot.semanticGenerationRole;
  if (value !== "active" && value !== "candidate") {
    throw stageError("semantic_settings_snapshot_invalid", false);
  }
  return value;
}

function stageError(code: string, retryable: boolean): Error & {
  code: string;
  retryable: boolean;
} {
  return Object.assign(new Error(`Semantic embedding stage failed: ${code}`), {
    code, retryable
  });
}

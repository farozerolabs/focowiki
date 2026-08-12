import { createHash } from "node:crypto";
import { mapWithConcurrency } from "../../runtime/bounded.js";
import type { SemanticStageWorkClaim } from "./stage-ports.js";
import type { SemanticStageHandlerResult } from "./stage-worker.js";
import type {
  EmbeddingArtifactRepositoryPort,
  EmbeddingArtifactStorePort
} from "../embedding/artifact-ports.js";
import { decodeVectorArtifact } from "../embedding/vector-artifact-codec.js";
import type { SemanticVectorProjectionRepositoryPort } from
  "../vector/projection-service.js";
import {
  planSemanticVectorProjection,
  type SemanticVectorProjectionPlan
} from "../vector/projection-planner.js";

export function createSemanticVectorStageHandler(input: {
  artifacts: Pick<EmbeddingArtifactRepositoryPort, "listSourceReferences">;
  cleanup?: Pick<EmbeddingArtifactRepositoryPort,
    "releaseSupersededSourceReferences">;
  store: Pick<EmbeddingArtifactStorePort, "readVerified">;
  projections: Pick<SemanticVectorProjectionRepositoryPort, "listSourceDocuments">;
  applyPlan(plan: SemanticVectorProjectionPlan): Promise<{
    upserted: number;
    deleted: number;
    enumeratedCorpus: 0;
  }>;
  indexPrefix: string;
  artifactReadConcurrency?: number;
  clock?: () => string;
  isOwnedRevision?(claim: SemanticStageWorkClaim): Promise<boolean>;
}) {
  const artifactReadConcurrency = input.artifactReadConcurrency ?? 4;
  const clock = input.clock ?? (() => new Date().toISOString());
  if (!Number.isSafeInteger(artifactReadConcurrency)
    || artifactReadConcurrency < 1 || artifactReadConcurrency > 32) {
    throw new Error("Semantic vector artifact read concurrency is invalid");
  }
  return async function handleVector(
    claim: SemanticStageWorkClaim,
    signal?: AbortSignal
  ): Promise<SemanticStageHandlerResult> {
    const dimension = snapshotInteger(claim, "resolvedDimension", 1, 65_536);
    const normalization = snapshotNormalization(claim);
    const projectionContractPublicId = snapshotString(
      claim,
      "projectionContractPublicId",
      255
    );
    const mappingFingerprintSha256 = snapshotChecksum(
      claim,
      "mappingFingerprintSha256"
    );
    const batchSize = Math.min(
      1_000,
      snapshotInteger(claim, "vectorBatchDocumentCount", 1, 10_000)
    );
    const filterOverride = snapshotFilterProjectionOverride(claim);
    const references = latestOwnerReferences(
      await input.artifacts.listSourceReferences({
      knowledgeBaseId: claim.knowledgeBaseId,
      semanticGenerationPublicId: claim.semanticGenerationPublicId,
      sourceFilePublicId: claim.sourceFilePublicId,
      sourceRevisionPublicId: claim.sourceRevisionPublicId,
      limit: 10_000
      })
    );
    const upserts = await mapWithConcurrency(
      references,
      artifactReadConcurrency,
      async (reference) => {
        throwIfAborted(signal);
        const artifact = reference.artifact;
        if (artifact.dimension !== dimension
          || artifact.normalization !== normalization
          || artifact.embeddingConfigurationRevisionPublicId
            !== claim.embeddingConfigurationRevisionPublicId) {
          throw stageError("semantic_vector_artifact_contract_mismatch", false);
        }
        const bytes = await input.store.readVerified({
          descriptor: {
            objectId: artifact.objectId,
            storageKey: artifact.storageKey,
            checksumSha256: artifact.vectorChecksumSha256,
            byteCount: artifact.byteCount,
            contentType: "application/octet-stream",
            objectFormat: "semantic-vector-v1"
          },
          maximumBytes: 16 + dimension * 4,
          ...(signal ? { signal } : {})
        });
        const vector = decodeVectorArtifact({
          bytes,
          checksumSha256: artifact.vectorChecksumSha256,
          dimension,
          normalization,
          maximumBytes: 16 + dimension * 4
        });
        return {
          publicId: vectorDocumentPublicId(
            claim.semanticGenerationPublicId,
            artifact.inputKind,
            artifact.ownerPublicId,
            claim.sourceRevisionPublicId
          ),
          ownerPublicId: artifact.ownerPublicId,
          family: artifact.inputKind,
          sourceFilePublicId: reference.sourceFilePublicId,
          sourceRevisionPublicId: claim.sourceRevisionPublicId,
          artifactPublicId: artifact.publicId,
          evidenceTargetPath: reference.evidenceTargetPath,
          sourceExcerpt: reference.sourceExcerpt,
          fileKind: reference.fileKind,
          okfStatus: filterOverride
            ? filterOverride.status
            : reference.okfSignals.status,
          okfTrustTier: filterOverride
            ? filterOverride.trustTier
            : reference.okfSignals.trustTier,
          okfStaleAfterEpochDay: filterOverride
            ? filterOverride.staleAfterEpochDay
            : reference.okfSignals.staleAfterEpochDay,
          vector
        };
      }
    );
    const desiredIds = new Set(upserts.map((item) => item.publicId));
    const existing = await input.projections.listSourceDocuments({
      knowledgeBaseId: claim.knowledgeBaseId,
      semanticGenerationPublicId: claim.semanticGenerationPublicId,
      sourceFilePublicId: claim.sourceFilePublicId,
      limit: 10_000
    });
    const deletes = existing.filter((item) => !desiredIds.has(item.publicId));
    let upserted = 0;
    let deleted = 0;
    const batches = chunk(upserts, batchSize);
    if (batches.length === 0) batches.push([]);
    for (let index = 0; index < batches.length; index += 1) {
      throwIfAborted(signal);
      const plan = planSemanticVectorProjection({
        operationPublicId: claim.operationPublicId,
        indexPrefix: input.indexPrefix,
        knowledgeBaseId: claim.knowledgeBaseId,
        semanticGenerationPublicId: claim.semanticGenerationPublicId,
        projectionContractPublicId,
        embeddingConfigurationRevisionPublicId:
          claim.embeddingConfigurationRevisionPublicId,
        dimension,
        mappingFingerprintSha256,
        upserts: batches[index]!,
        deletes: index === 0 ? deletes : []
      });
      const counters = await input.applyPlan(plan);
      if (counters.enumeratedCorpus !== 0) {
        throw stageError("semantic_vector_full_scan_detected", false);
      }
      upserted += counters.upserted;
      deleted += counters.deleted;
    }
    const candidateRevision = await input.isOwnedRevision?.(claim) === true;
    const releasedSupersededArtifactCount = input.cleanup && !candidateRevision
      ? await input.cleanup.releaseSupersededSourceReferences({
          knowledgeBaseId: claim.knowledgeBaseId,
          semanticGenerationPublicId: claim.semanticGenerationPublicId,
          sourceFilePublicId: claim.sourceFilePublicId,
          currentSourceRevisionPublicId: claim.sourceRevisionPublicId,
          releasedAt: clock(),
          limit: 10_000
        })
      : 0;
    return {
      checkpoint: {
        sourceRevisionPublicId: claim.sourceRevisionPublicId,
        artifactCount: references.length,
        upsertedDocumentCount: upserted,
        deletedDocumentCount: deleted,
        releasedSupersededArtifactCount,
        enumeratedCorpusCount: 0
      },
      reusedArtifactCount: references.length
    };
  };
}

function snapshotFilterProjectionOverride(
  claim: SemanticStageWorkClaim
): {
  status: "draft" | "stable" | "deprecated" | null;
  trustTier: "unverified" | "machine-confirmed" | "human-reviewed" | null;
  staleAfterEpochDay: number | null;
} | null {
  if (claim.settingsSnapshot.sourceFilterProjectionOverride !== true) return null;
  const status = claim.settingsSnapshot.sourceOkfStatusOverride;
  const trustTier = claim.settingsSnapshot.sourceOkfTrustTierOverride;
  const staleAfterEpochDayValue =
    claim.settingsSnapshot.sourceOkfStaleAfterEpochDayOverride;
  const staleAfterEpochDay = staleAfterEpochDayValue === null
    || typeof staleAfterEpochDayValue === "number"
    ? staleAfterEpochDayValue
    : undefined;
  if (
    status !== null && status !== "draft"
      && status !== "stable" && status !== "deprecated"
    || trustTier !== null && trustTier !== "unverified"
      && trustTier !== "machine-confirmed" && trustTier !== "human-reviewed"
    || staleAfterEpochDay === undefined
    || staleAfterEpochDay !== null && (
      !Number.isSafeInteger(staleAfterEpochDay) || staleAfterEpochDay < 0
    )
  ) throw stageError("semantic_vector_filter_override_invalid", false);
  return { status, trustTier, staleAfterEpochDay };
}

function latestOwnerReferences<T extends {
  artifact: { inputKind: string; ownerPublicId: string };
}>(references: readonly T[]): T[] {
  const owners = new Set<string>();
  return references.filter((reference) => {
    const key = `${reference.artifact.inputKind}\0${reference.artifact.ownerPublicId}`;
    if (owners.has(key)) return false;
    owners.add(key);
    return true;
  });
}

export function vectorDocumentPublicId(
  generationPublicId: string,
  family: string,
  ownerPublicId: string,
  sourceRevisionPublicId = "current"
): string {
  return `semantic-vector-${createHash("sha256")
    .update(`${generationPublicId}\u001f${family}\u001f${ownerPublicId}\u001f${sourceRevisionPublicId}`)
    .digest("hex")}`;
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    result.push(values.slice(offset, offset + size));
  }
  return result;
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

function snapshotString(claim: SemanticStageWorkClaim, key: string, maximum: number) {
  const value = claim.settingsSnapshot[key];
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > maximum) {
    throw stageError("semantic_settings_snapshot_invalid", false);
  }
  return value;
}

function snapshotChecksum(claim: SemanticStageWorkClaim, key: string) {
  const value = snapshotString(claim, key, 64);
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw stageError("semantic_settings_snapshot_invalid", false);
  }
  return value;
}

function snapshotNormalization(claim: SemanticStageWorkClaim): "none" | "l2" {
  const value = claim.settingsSnapshot.normalization;
  if (value !== "none" && value !== "l2") {
    throw stageError("semantic_settings_snapshot_invalid", false);
  }
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Semantic vector stage aborted", "AbortError");
  }
}

function stageError(code: string, retryable: boolean): Error & {
  code: string;
  retryable: boolean;
} {
  return Object.assign(new Error(`Semantic vector stage failed: ${code}`), {
    code, retryable
  });
}

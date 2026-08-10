import type { StorageVnextCatalogRepository } from
  "../../storage-vnext/catalog/ports.js";
import type { SemanticFactRepositoryPort } from "./ports.js";
import type { SemanticSourceBodyReadPort } from "./ports.js";
import type { SemanticStageWorkClaim } from "./stage-ports.js";
import type { SemanticStageHandlerResult } from "./stage-worker.js";
import type { SemanticDesiredFactSet } from "../domain/contracts.js";
import {
  SEMANTIC_EXTRACTION_CONTRACT_VERSION,
  SEMANTIC_PROMPT_CONTRACT_VERSION
} from "../domain/contracts.js";
import type { SemanticSourceChunk } from "../graphrag/source-chunks.js";
import type { SemanticSkeletonSelection } from
  "../graphrag/skeleton-selector.js";
import type { SemanticSkeletonGraphSignals } from
  "../graphrag/skeleton-selector.js";

type ExtractionResult = {
  desiredFacts: SemanticDesiredFactSet;
  chunks: readonly SemanticSourceChunk[];
  promptRevision: string;
  canonicalInputHash: string;
  generationRequestCount: number;
  generationServiceTimeMilliseconds: number;
  selection: SemanticSkeletonSelection;
};

export function createSemanticExtractionStageHandler(input: {
  catalog: Pick<StorageVnextCatalogRepository,
    "getSourceFile" | "getSourceRevision" | "getCurrentSourceRevision">;
  bodyStore: SemanticSourceBodyReadPort;
  isOwnedRevision?(claim: SemanticStageWorkClaim): Promise<boolean>;
  loadSkeletonGraphSignals?(input: {
    knowledgeBaseId: string;
    sourceFilePublicId: string;
  }): Promise<SemanticSkeletonGraphSignals>;
  facts: Pick<SemanticFactRepositoryPort,
    "hasSourceRevisionFacts" | "replaceSourceFacts">;
  resolveExtractor(claim: SemanticStageWorkClaim): Promise<{
    extract(request: {
      knowledgeBaseId: string;
      semanticGenerationPublicId: string;
      sourceFilePublicId: string;
      sourceRevisionPublicId: string;
      logicalPath: string;
      markdown: string;
      skeletonGraphSignals?: SemanticSkeletonGraphSignals;
      signal: AbortSignal;
    }): Promise<ExtractionResult>;
  }>;
}) {
  return async function handleExtraction(
    claim: SemanticStageWorkClaim,
    signal?: AbortSignal
  ): Promise<SemanticStageHandlerResult> {
    const effectiveSignal = signal ?? new AbortController().signal;
    assertCurrentExtractionContract(claim);
    if (await input.facts.hasSourceRevisionFacts(scope(claim))) {
      return {
        checkpoint: {
          sourceRevisionPublicId: claim.sourceRevisionPublicId,
          reconciliationState: "reused"
        },
        reusedArtifactCount: 1
      };
    }
    const current = await loadOwnedSource(
      input.catalog,
      claim,
      input.isOwnedRevision
    );
    const maximumSourceBytes = snapshotInteger(
      claim,
      "maximumSourceBytes",
      1,
      268_435_456
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
    const extractor = await input.resolveExtractor(claim);
    const skeletonGraphSignals = claimSkeletonGraphSignals(claim)
      ?? await input.loadSkeletonGraphSignals?.({
        knowledgeBaseId: claim.knowledgeBaseId,
        sourceFilePublicId: claim.sourceFilePublicId
      });
    const extracted = await extractor.extract({
      knowledgeBaseId: claim.knowledgeBaseId,
      semanticGenerationPublicId: claim.semanticGenerationPublicId,
      sourceFilePublicId: claim.sourceFilePublicId,
      sourceRevisionPublicId: claim.sourceRevisionPublicId,
      logicalPath: current.source.logicalPath,
      markdown,
      ...(skeletonGraphSignals ? { skeletonGraphSignals } : {}),
      signal: effectiveSignal
    });
    if (extracted.promptRevision !== claim.settingsSnapshot.promptContractVersion) {
      throw stageError("semantic_prompt_contract_mismatch", false);
    }
    try {
      const closure = await input.facts.replaceSourceFacts(
        extracted.desiredFacts,
        {
          extractionContractVersion: claim.extractionContractVersion,
          canonicalInputSha256: extracted.canonicalInputHash,
          skeletonPolicyVersion: extracted.selection.policyVersion,
          skeletonSelected: extracted.selection.selected,
          sourceChunkCount: extracted.selection.sourceChunkCount,
          selectedChunkCount: extracted.selection.selectedChunkIds.length,
          selectionReasons: extracted.selection.reasons,
          selectionDecisionSha256: extracted.selection.decisionSha256
        }
      );
      return {
        checkpoint: {
          sourceRevisionPublicId: claim.sourceRevisionPublicId,
          canonicalInputHash: extracted.canonicalInputHash,
          promptRevision: extracted.promptRevision,
          chunkCount: extracted.chunks.length,
          skeletonPolicyVersion: extracted.selection.policyVersion,
          skeletonSelected: extracted.selection.selected,
          skeletonSelectedChunkCount: extracted.selection.selectedChunkIds.length,
          graphRagGenerationRequestCount: extracted.generationRequestCount,
          graphRagGenerationServiceTimeMilliseconds:
            extracted.generationServiceTimeMilliseconds,
          skeletonSelectionReasons: extracted.selection.reasons.join(","),
          skeletonDecisionSha256: extracted.selection.decisionSha256,
          entityCount: extracted.desiredFacts.entities.length,
          relationshipCount: extracted.desiredFacts.relationships.length,
          affectedSourceFileCount: closure.sourceFilePublicIds.length,
          dirtyPartitionCount: closure.dirtyPartitionKeys.length,
          reconciliationState: "created"
        },
        reusedArtifactCount: 0
      };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "scope_conflict") {
        throw stageError("semantic_source_revision_superseded", false);
      }
      throw error;
    }
  };
}

function assertCurrentExtractionContract(claim: SemanticStageWorkClaim): void {
  if (claim.extractionContractVersion !== SEMANTIC_EXTRACTION_CONTRACT_VERSION
    || claim.settingsSnapshot.promptContractVersion
      !== SEMANTIC_PROMPT_CONTRACT_VERSION) {
    throw stageError("semantic_contract_maintenance_required", false);
  }
}

function claimSkeletonGraphSignals(
  claim: SemanticStageWorkClaim
): SemanticSkeletonGraphSignals | null {
  const values = [
    claim.settingsSnapshot.skeletonAcceptedEdgeCount,
    claim.settingsSnapshot.skeletonInboundEdgeCount,
    claim.settingsSnapshot.skeletonOutboundEdgeCount,
    claim.settingsSnapshot.skeletonDistinctNeighborCount,
    claim.settingsSnapshot.skeletonRelationKindCount,
    claim.settingsSnapshot.skeletonContentProfileHeadingCount ?? 0,
    claim.settingsSnapshot.skeletonContentProfileDefinitionCount ?? 0,
    claim.settingsSnapshot.skeletonContentProfileExplicitReferenceCount ?? 0
  ];
  if (values.some((value) => !Number.isSafeInteger(value)
    || Number(value) < 0 || Number(value) > 64)) return null;
  return {
    acceptedEdgeCount: Number(values[0]),
    inboundEdgeCount: Number(values[1]),
    outboundEdgeCount: Number(values[2]),
    distinctNeighborCount: Number(values[3]),
    relationKindCount: Number(values[4]),
    contentProfileHeadingCount: Number(values[5]),
    contentProfileDefinitionCount: Number(values[6]),
    contentProfileExplicitReferenceCount: Number(values[7])
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
  return { source, revision };
}

async function readUtf8(
  stream: AsyncIterable<Uint8Array>,
  maximumBytes: number,
  signal: AbortSignal
): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    if (signal.aborted) {
      throw signal.reason ?? new DOMException("Semantic source read aborted", "AbortError");
    }
    bytes += chunk.byteLength;
    if (bytes > maximumBytes) throw stageError("semantic_source_size_limit", false);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}

function snapshotInteger(
  claim: SemanticStageWorkClaim,
  key: string,
  minimum: number,
  maximum: number
): number {
  const value = claim.settingsSnapshot[key];
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw stageError("semantic_settings_snapshot_invalid", false);
  }
  return Number(value);
}

function scope(claim: SemanticStageWorkClaim) {
  return {
    knowledgeBaseId: claim.knowledgeBaseId,
    semanticGenerationPublicId: claim.semanticGenerationPublicId,
    sourceFilePublicId: claim.sourceFilePublicId,
    sourceRevisionPublicId: claim.sourceRevisionPublicId
  };
}

function stageError(code: string, retryable: boolean): Error & {
  code: string;
  retryable: boolean;
} {
  return Object.assign(new Error(`Semantic extraction stage failed: ${code}`), {
    code,
    retryable
  });
}

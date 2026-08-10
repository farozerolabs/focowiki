import type { SemanticAffectedClosure } from "../domain/contracts.js";
import type { SemanticFactRepositoryPort } from "./ports.js";
import type { SemanticStageWorkClaim } from "./stage-ports.js";
import type { SemanticStageHandlerResult } from "./stage-worker.js";

export function createSemanticPublicationStageHandler(input: {
  facts: Pick<SemanticFactRepositoryPort, "getSourceAffectedClosure">;
  publish(input: {
    claim: SemanticStageWorkClaim;
    closure: SemanticAffectedClosure;
    settingsRevisionPublicId: string;
    publicationDelayMilliseconds: number;
    publicationMaximumDelayMilliseconds: number;
    completedAt: string;
  }): Promise<{ candidatePublicId: string }>;
  clock?: () => string;
}) {
  const clock = input.clock ?? (() => new Date().toISOString());
  return async function handlePublication(
    claim: SemanticStageWorkClaim
  ): Promise<SemanticStageHandlerResult> {
    const closure = await input.facts.getSourceAffectedClosure({
      knowledgeBaseId: claim.knowledgeBaseId,
      semanticGenerationPublicId: claim.semanticGenerationPublicId,
      sourceFilePublicId: claim.sourceFilePublicId,
      sourceRevisionPublicId: claim.sourceRevisionPublicId
    });
    if (!closure) {
      throw stageError("semantic_publication_closure_unavailable", true);
    }
    const settingsRevisionPublicId = snapshotString(
      claim,
      "runtimeSettingsRevisionPublicId"
    );
    const publicationDelayMilliseconds = snapshotInteger(
      claim,
      "publicationDelayMilliseconds",
      0,
      86_400_000
    );
    const publicationMaximumDelayMilliseconds = snapshotOptionalInteger(
      claim,
      "publicationMaximumDelayMilliseconds",
      publicationDelayMilliseconds,
      publicationDelayMilliseconds,
      86_400_000
    );
    const result = await input.publish({
      claim,
      closure,
      settingsRevisionPublicId,
      publicationDelayMilliseconds,
      publicationMaximumDelayMilliseconds,
      completedAt: clock()
    });
    return {
      checkpoint: {
        candidatePublicId: result.candidatePublicId,
        affectedSourceFileCount: closure.sourceFilePublicIds.length,
        affectedEntityCount: closure.entityPublicIds.length,
        affectedRelationshipCount: closure.relationshipPublicIds.length,
        affectedGeneratedPathCount: closure.generatedLogicalPaths.length
      },
      reusedArtifactCount: 0
    };
  };
}

function snapshotOptionalInteger(
  claim: SemanticStageWorkClaim,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (claim.settingsSnapshot[key] === undefined) return fallback;
  return snapshotInteger(claim, key, minimum, maximum);
}

function snapshotInteger(
  claim: SemanticStageWorkClaim,
  key: string,
  minimum: number,
  maximum: number
): number {
  const value = claim.settingsSnapshot[key];
  if (!Number.isSafeInteger(value)
    || Number(value) < minimum
    || Number(value) > maximum) {
    throw stageError("semantic_settings_snapshot_invalid", false);
  }
  return Number(value);
}

function snapshotString(claim: SemanticStageWorkClaim, key: string): string {
  const value = claim.settingsSnapshot[key];
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > 255) {
    throw stageError("semantic_settings_snapshot_invalid", false);
  }
  return value;
}

function stageError(code: string, retryable: boolean): Error & {
  code: string;
  retryable: boolean;
} {
  return Object.assign(new Error(`Semantic publication stage failed: ${code}`), {
    code,
    retryable
  });
}

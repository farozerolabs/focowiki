import { createHash } from "node:crypto";
import type { SemanticFactRepositoryPort } from "./ports.js";
import type { SemanticStageWorkClaim } from "./stage-ports.js";
import type { SemanticStageHandlerResult } from "./stage-worker.js";
import type { CommunityPartitionRepositoryPort } from "./community-ports.js";
import {
  deriveDirtyCommunityPartitions,
  deriveEntityPartitionAssignments
} from "./community-planner.js";

export function createSemanticReconciliationStageHandler(input: {
  facts: Pick<SemanticFactRepositoryPort,
    | "hasSourceRevisionFacts"
    | "listSourceEntityPublicIds"
    | "getSourceAffectedClosure">;
  communities: Pick<CommunityPartitionRepositoryPort,
    "upsertAssignments" | "enqueueDirty">;
}) {
  return async function handleReconciliation(
    claim: SemanticStageWorkClaim
  ): Promise<SemanticStageHandlerResult> {
    const scope = {
      knowledgeBaseId: claim.knowledgeBaseId,
      semanticGenerationPublicId: claim.semanticGenerationPublicId,
      sourceFilePublicId: claim.sourceFilePublicId,
      sourceRevisionPublicId: claim.sourceRevisionPublicId
    };
    if (!await input.facts.hasSourceRevisionFacts(scope)) {
      throw stageError("semantic_extraction_facts_unavailable", true);
    }
    const closure = await input.facts.getSourceAffectedClosure(scope);
    if (!closure) {
      throw stageError("semantic_affected_closure_unavailable", true);
    }
    const entityPublicIds = await input.facts.listSourceEntityPublicIds({
      ...scope,
      limit: 2_000
    });
    const inputVersion = createHash("sha256")
      .update(`${claim.semanticGenerationPublicId}\u001f${claim.sourceRevisionPublicId}`)
      .digest("hex");
    const assignments = deriveEntityPartitionAssignments({
      entityPublicIds,
      inputVersion
    });
    await input.communities.upsertAssignments({
      knowledgeBaseId: claim.knowledgeBaseId,
      semanticGenerationPublicId: claim.semanticGenerationPublicId,
      assignments
    });
    const dirty = deriveDirtyCommunityPartitions({
      knowledgeBaseId: claim.knowledgeBaseId,
      semanticGenerationPublicId: claim.semanticGenerationPublicId,
      inputVersion,
      reasonKind: entityPublicIds.length === 0 ? "deleted" : "entity_changed",
      changedEntityPublicIds: entityPublicIds,
      changedRelationships: [],
      priorMembershipPartitionKeys: closure.dirtyPartitionKeys,
      boundaryNeighborEntityPublicIds: [],
      maximumBoundaryNeighbors: 0
    });
    await input.communities.enqueueDirty({
      knowledgeBaseId: claim.knowledgeBaseId,
      semanticGenerationPublicId: claim.semanticGenerationPublicId,
      partitions: dirty
    });
    return {
      checkpoint: {
        sourceRevisionPublicId: claim.sourceRevisionPublicId,
        entityCount: entityPublicIds.length,
        dirtyPartitionCount: dirty.length,
        inputVersion
      },
      reusedArtifactCount: 0
    };
  };
}

function stageError(code: string, retryable: boolean): Error & {
  code: string;
  retryable: boolean;
} {
  return Object.assign(new Error(`Semantic reconciliation stage failed: ${code}`), {
    code, retryable
  });
}

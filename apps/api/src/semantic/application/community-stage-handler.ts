import type {
  CommunityPartitionClaim,
  CommunityPartitionRepositoryPort
} from "./community-ports.js";
import { assembleBoundedCommunityPartition } from "./community-planner.js";
import type { SemanticStageWorkClaim } from "./stage-ports.js";
import type { SemanticStageHandlerResult } from "./stage-worker.js";

type PartitionOutcome = {
  outcome: "created" | "updated" | "reused" | "superseded";
};

export function createSemanticCommunityStageHandler(input: {
  repository: Pick<CommunityPartitionRepositoryPort, "claimNext" | "loadPage">;
  processPartition(input: {
    stageClaim: SemanticStageWorkClaim;
    claim: CommunityPartitionClaim;
    work: {
      knowledgeBaseId: string;
      semanticGenerationPublicId: string;
      partitionPublicId: string;
      partitionKey: string;
      inputVersion: string;
      boundaryVersion: string;
      entityPublicIds: readonly string[];
      localRelationships: readonly {
        publicId: string;
        fromEntityPublicId: string;
        toEntityPublicId: string;
        weight: number;
      }[];
      boundaryRelationships: readonly {
        publicId: string;
        fromEntityPublicId: string;
        toEntityPublicId: string;
        weight: number;
      }[];
      timeoutMs: number;
    };
    signal?: AbortSignal;
  }): Promise<PartitionOutcome>;
  clock?: () => string;
}) {
  const clock = input.clock ?? (() => new Date().toISOString());
  return async function handleCommunity(
    stageClaim: SemanticStageWorkClaim,
    signal?: AbortSignal
  ): Promise<SemanticStageHandlerResult> {
    const maximumPartitions = snapshotInteger(
      stageClaim, "maximumCommunityPartitions", 1, 256
    );
    const maximumEntities = snapshotInteger(
      stageClaim, "maximumCommunityEntities", 1, 10_000
    );
    const maximumRelationships = snapshotInteger(
      stageClaim, "maximumCommunityRelationships", 0, 20_000
    );
    const maximumBoundaryRelationships = snapshotInteger(
      stageClaim, "maximumCommunityBoundaryRelationships", 0, 10_000
    );
    const timeoutMs = snapshotInteger(
      stageClaim, "communityAdapterTimeoutMs", 100, 300_000
    );
    let processedPartitionCount = 0;
    let reusedPartitionCount = 0;
    for (; processedPartitionCount < maximumPartitions; processedPartitionCount += 1) {
      throwIfAborted(signal);
      const partitionClaim = await input.repository.claimNext({
        workerId: `semantic-stage:${stageClaim.publicId}`,
        knowledgeBaseId: stageClaim.knowledgeBaseId,
        semanticGenerationPublicId: stageClaim.semanticGenerationPublicId,
        now: clock(),
        leaseExpiresAt: stageClaim.leaseExpiresAt
      });
      if (!partitionClaim) break;
      const page = await input.repository.loadPage({
        claim: partitionClaim,
        maximumEntities,
        maximumRelationships,
        maximumBoundaryRelationships
      });
      if (page.nextEntityCursor !== null || page.relationshipTruncated) {
        throw stageError("semantic_community_partition_split_required", false);
      }
      const assembled = assembleBoundedCommunityPartition({
        partitionKey: partitionClaim.partitionKey,
        inputVersion: partitionClaim.inputVersion,
        cursor: null,
        entities: page.entityPublicIds,
        relationships: page.relationships,
        maximumEntities,
        maximumRelationships,
        maximumBoundaryRelationships
      });
      const result = await input.processPartition({
        stageClaim,
        claim: partitionClaim,
        work: {
          knowledgeBaseId: partitionClaim.knowledgeBaseId,
          semanticGenerationPublicId: partitionClaim.semanticGenerationPublicId,
          partitionPublicId: partitionClaim.publicId,
          partitionKey: partitionClaim.partitionKey,
          inputVersion: partitionClaim.inputVersion,
          boundaryVersion: assembled.boundaryVersion,
          entityPublicIds: assembled.entityPublicIds,
          localRelationships: assembled.localRelationships,
          boundaryRelationships: assembled.boundaryRelationships,
          timeoutMs
        },
        ...(signal ? { signal } : {})
      });
      if (result.outcome === "reused") reusedPartitionCount += 1;
    }
    return {
      checkpoint: {
        processedPartitionCount,
        reusedPartitionCount,
        communityScope: stageClaim.semanticGenerationPublicId
      },
      reusedArtifactCount: reusedPartitionCount
    };
  };
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

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Semantic community stage aborted", "AbortError");
  }
}

function stageError(code: string, retryable: boolean): Error & {
  code: string;
  retryable: boolean;
} {
  return Object.assign(new Error(`Semantic community stage failed: ${code}`), {
    code,
    retryable
  });
}

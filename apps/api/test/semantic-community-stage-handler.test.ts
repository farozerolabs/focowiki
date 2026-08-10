import { describe, expect, it, vi } from "vitest";
import { createSemanticCommunityStageHandler } from
  "../src/semantic/application/community-stage-handler.js";

describe("semantic community stage handler", () => {
  it("drains only bounded dirty partitions in the claimed generation", async () => {
    const dirtyClaims = [partitionClaim("partition-a"), partitionClaim("partition-b")];
    const claimNext = vi.fn(async () => dirtyClaims.shift() ?? null);
    const processPartition = vi.fn(async () => ({ outcome: "created" as const }));
    const handler = createSemanticCommunityStageHandler({
      repository: {
        claimNext,
        loadPage: async () => ({
          entityPublicIds: ["entity-a", "entity-b"],
          relationships: [{
            publicId: "relationship-a-b",
            fromEntityPublicId: "entity-a",
            toEntityPublicId: "entity-b",
            weight: 1
          }],
          nextEntityCursor: null,
          relationshipTruncated: false
        })
      },
      processPartition,
      clock: () => "2027-08-08T00:00:00.000Z"
    });

    await expect(handler(stageClaim())).resolves.toMatchObject({
      checkpoint: { processedPartitionCount: 2, reusedPartitionCount: 0 }
    });
    expect(claimNext).toHaveBeenCalledWith(expect.objectContaining({
      knowledgeBaseId: "kb-a",
      semanticGenerationPublicId: "generation-a"
    }));
    expect(processPartition).toHaveBeenCalledTimes(2);
  });

  it("rejects an oversized partition page without materializing more data", async () => {
    const processPartition = vi.fn();
    const handler = createSemanticCommunityStageHandler({
      repository: {
        claimNext: async () => partitionClaim("partition-a"),
        loadPage: async () => ({
          entityPublicIds: ["entity-a"], relationships: [],
          nextEntityCursor: "entity-a", relationshipTruncated: false
        })
      },
      processPartition
    });
    await expect(handler(stageClaim())).rejects.toMatchObject({
      code: "semantic_community_partition_split_required",
      retryable: false
    });
    expect(processPartition).not.toHaveBeenCalled();
  });
});

function stageClaim(): any {
  return {
    publicId: "stage-a", knowledgeBaseId: "kb-a",
    semanticGenerationPublicId: "generation-a",
    leaseExpiresAt: "2027-08-08T00:01:00.000Z",
    settingsSnapshot: {
      maximumCommunityPartitions: 256,
      maximumCommunityEntities: 10_000,
      maximumCommunityRelationships: 20_000,
      maximumCommunityBoundaryRelationships: 10_000,
      communityAdapterTimeoutMs: 30_000
    }
  };
}

function partitionClaim(partitionKey: string): any {
  return {
    knowledgeBaseId: "kb-a",
    semanticGenerationPublicId: "generation-a",
    publicId: `dirty-${partitionKey}`,
    partitionKey,
    inputVersion: "input-v1",
    checkpoint: { entityCursor: null, relationshipTruncated: false },
    leaseOwner: "semantic-stage:stage-a",
    leaseExpiresAt: "2027-08-08T00:01:00.000Z",
    revision: 1
  };
}

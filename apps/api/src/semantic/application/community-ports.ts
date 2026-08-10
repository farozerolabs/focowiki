import type {
  CommunityRelationshipInput,
  DirtyCommunityPartition
} from "./community-planner.js";

export type CommunityPartitionClaim = {
  knowledgeBaseId: string;
  semanticGenerationPublicId: string;
  publicId: string;
  partitionKey: string;
  reasonKind: DirtyCommunityPartition["reasonKind"];
  inputVersion: string;
  attemptCount: number;
  checkpoint: { entityCursor: string | null; relationshipTruncated: boolean };
  leaseOwner: string;
  leaseExpiresAt: string;
  revision: number;
};

export type CommunityPartitionRepositoryPort = {
  upsertAssignments(input: {
    knowledgeBaseId: string;
    semanticGenerationPublicId: string;
    assignments: readonly {
      entityPublicId: string;
      partitionKey: string;
      inputVersion: string;
    }[];
  }): Promise<void>;
  enqueueDirty(input: {
    knowledgeBaseId: string;
    semanticGenerationPublicId: string;
    partitions: readonly DirtyCommunityPartition[];
  }): Promise<void>;
  claimNext(input: {
    workerId: string;
    knowledgeBaseId: string;
    semanticGenerationPublicId: string;
    now: string;
    leaseExpiresAt: string;
  }): Promise<CommunityPartitionClaim | null>;
  loadPage(input: {
    claim: CommunityPartitionClaim;
    maximumEntities: number;
    maximumRelationships: number;
    maximumBoundaryRelationships: number;
  }): Promise<{
    entityPublicIds: string[];
    relationships: CommunityRelationshipInput[];
    nextEntityCursor: string | null;
    relationshipTruncated: boolean;
  }>;
  isCurrent(input: {
    claim: CommunityPartitionClaim;
  }): Promise<boolean>;
  saveCheckpoint(input: {
    claim: CommunityPartitionClaim;
    entityCursor: string | null;
    relationshipTruncated: boolean;
    outcome: "continue" | "completed" | "failed" | "cancelled" | "superseded";
    safeCode: string | null;
    nextAttemptAt: string;
  }): Promise<boolean>;
  replacePartition(input: {
    claim: CommunityPartitionClaim;
    boundaryVersion: string;
    outputs: readonly {
      communityPublicId: string;
      level: number;
      entityPublicIds: readonly string[];
      summary: string;
      checksumSha256: string;
    }[];
  }): Promise<"created" | "updated" | "reused">;
};

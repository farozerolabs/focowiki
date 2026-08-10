import { describe, expect, it } from "vitest";
import {
  acceptCommunityPartitionResult,
  assembleBoundedCommunityPartition,
  buildBoundedParentSummaryInput,
  deriveEntityPartitionAssignments,
  deriveDirtyCommunityPartitions
} from "../src/semantic/application/community-planner.js";

describe("bounded semantic community planning", () => {
  it("assigns each entity to one stable partition without corpus state", () => {
    const first = deriveEntityPartitionAssignments({
      entityPublicIds: ["entity-b", "entity-a", "entity-a"],
      inputVersion: "graph-v2"
    });
    expect(first).toHaveLength(2);
    expect(first.map((item) => item.entityPublicId)).toEqual(["entity-a", "entity-b"]);
    expect(deriveEntityPartitionAssignments({
      entityPublicIds: ["entity-a", "entity-b"], inputVersion: "graph-v2"
    })).toEqual(first);
  });
  it.each(["entity_changed", "relationship_changed", "deleted", "merge", "split"] as const)(
    "derives deterministic dirty partitions for %s with prior and boundary impacts",
    (reasonKind) => {
      const first = deriveDirtyCommunityPartitions({
        knowledgeBaseId: "kb-main",
        semanticGenerationPublicId: "generation-main",
        inputVersion: "graph-v2",
        reasonKind,
        changedEntityPublicIds: ["entity-a"],
        changedRelationships: [{
          publicId: "relationship-ab",
          fromEntityPublicId: "entity-a",
          toEntityPublicId: "entity-b"
        }],
        priorMembershipPartitionKeys: ["partition-prior"],
        boundaryNeighborEntityPublicIds: ["entity-c", "entity-d"],
        maximumBoundaryNeighbors: 2
      });
      expect(first).toEqual(deriveDirtyCommunityPartitions({
        knowledgeBaseId: "kb-main",
        semanticGenerationPublicId: "generation-main",
        inputVersion: "graph-v2",
        reasonKind,
        changedEntityPublicIds: ["entity-a"],
        changedRelationships: [{
          publicId: "relationship-ab",
          fromEntityPublicId: "entity-a",
          toEntityPublicId: "entity-b"
        }],
        priorMembershipPartitionKeys: ["partition-prior"],
        boundaryNeighborEntityPublicIds: ["entity-d", "entity-c"],
        maximumBoundaryNeighbors: 2
      }));
      expect(first.map((item) => item.partitionKey)).toEqual(expect.arrayContaining([
        "partition-prior"
      ]));
      expect(first.every((item) => item.inputVersion === "graph-v2")).toBe(true);
    }
  );

  it("assembles cursor-bounded local entities and explicit boundary edges", () => {
    const result = assembleBoundedCommunityPartition({
      partitionKey: "partition-main",
      inputVersion: "graph-v2",
      cursor: null,
      entities: ["entity-c", "entity-a", "entity-b"],
      relationships: [
        edge("ab", "entity-a", "entity-b"),
        edge("bc", "entity-b", "entity-c"),
        edge("az", "entity-a", "entity-z")
      ],
      maximumEntities: 2,
      maximumRelationships: 3,
      maximumBoundaryRelationships: 1
    });
    expect(result.entityPublicIds).toEqual(["entity-a", "entity-b"]);
    expect(result.localRelationships.map((item) => item.publicId)).toEqual(["ab"]);
    expect(result.boundaryRelationships.map((item) => item.publicId)).toHaveLength(1);
    expect(result.nextCursor).toBe("entity-b");
    expect(result.inputVersion).toBe("graph-v2");
  });

  it("chunks oversized components and parent summaries without complete-graph memory", () => {
    const first = assembleBoundedCommunityPartition({
      partitionKey: "partition-large",
      inputVersion: "graph-v3",
      cursor: null,
      entities: Array.from({ length: 5 }, (_, index) => `entity-${String(index).padStart(2, "0")}`),
      relationships: Array.from({ length: 4 }, (_, index) =>
        edge(`edge-${index}`, `entity-${String(index).padStart(2, "0")}`, `entity-${String(index + 1).padStart(2, "0")}`)),
      maximumEntities: 4,
      maximumRelationships: 5,
      maximumBoundaryRelationships: 2
    });
    expect(first.entityPublicIds).toHaveLength(4);
    expect(first.localRelationships.length + first.boundaryRelationships.length).toBeLessThanOrEqual(7);
    expect(first.nextCursor).not.toBeNull();
    expect(buildBoundedParentSummaryInput({
      childSummaries: ["Gamma", "Alpha", "Beta"],
      maximumChildren: 2,
      maximumCharacters: 11
    })).toEqual(["Alpha", "Beta"]);
    expect(() => assembleBoundedCommunityPartition({
      partitionKey: "partition-overflow",
      inputVersion: "graph-v3",
      cursor: null,
      entities: ["a", "b", "c", "d"],
      relationships: [],
      maximumEntities: 2,
      maximumRelationships: 1,
      maximumBoundaryRelationships: 1
    })).toThrow("bounded database input");
    expect(() => assembleBoundedCommunityPartition({
      partitionKey: "partition-overflow",
      inputVersion: "graph-v3",
      cursor: null,
      entities: ["a"],
      relationships: [edge("1", "a", "b"), edge("2", "a", "c"), edge("3", "a", "d"), edge("4", "a", "e")],
      maximumEntities: 1,
      maximumRelationships: 1,
      maximumBoundaryRelationships: 1
    })).toThrow("bounded database input");
  });

  it("rejects stale partition output and accepts an idempotent current replacement", () => {
    expect(() => acceptCommunityPartitionResult({
      expectedInputVersion: "graph-v2",
      resultInputVersion: "graph-v1",
      priorChecksumSha256: null,
      resultChecksumSha256: "a".repeat(64)
    })).toThrow("stale");
    expect(acceptCommunityPartitionResult({
      expectedInputVersion: "graph-v2",
      resultInputVersion: "graph-v2",
      priorChecksumSha256: "a".repeat(64),
      resultChecksumSha256: "a".repeat(64)
    })).toEqual({ outcome: "reused", changed: false });
  });
});

function edge(publicId: string, fromEntityPublicId: string, toEntityPublicId: string) {
  return { publicId, fromEntityPublicId, toEntityPublicId, weight: 1 };
}

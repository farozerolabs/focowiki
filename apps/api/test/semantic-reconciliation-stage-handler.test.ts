import { describe, expect, it, vi } from "vitest";
import { createSemanticReconciliationStageHandler } from
  "../src/semantic/application/reconciliation-stage-handler.js";

describe("semantic reconciliation stage handler", () => {
  it("marks only partitions owned by entities changed in the source revision", async () => {
    const upsertAssignments = vi.fn(async () => undefined);
    const enqueueDirty = vi.fn(async () => undefined);
    const handler = createSemanticReconciliationStageHandler({
      facts: {
        hasSourceRevisionFacts: async () => true,
        listSourceEntityPublicIds: async () => ["entity-b", "entity-a"],
        getSourceAffectedClosure: async () => closure(["partition-prior"])
      },
      communities: { upsertAssignments, enqueueDirty }
    });
    await expect(handler(claim())).resolves.toMatchObject({
      checkpoint: { entityCount: 2, dirtyPartitionCount: expect.any(Number) }
    });
    expect(upsertAssignments).toHaveBeenCalledWith(expect.objectContaining({
      semanticGenerationPublicId: "generation-a",
      assignments: expect.arrayContaining([
        expect.objectContaining({ entityPublicId: "entity-a" }),
        expect.objectContaining({ entityPublicId: "entity-b" })
      ])
    }));
    expect(enqueueDirty).toHaveBeenCalledWith(expect.objectContaining({
      partitions: expect.arrayContaining([
        expect.objectContaining({ partitionKey: "partition-prior" })
      ])
    }));
  });

  it("retains prior dirty partitions when a replacement removes every entity", async () => {
    const enqueueDirty = vi.fn(async () => undefined);
    const handler = createSemanticReconciliationStageHandler({
      facts: {
        hasSourceRevisionFacts: async () => true,
        listSourceEntityPublicIds: async () => [],
        getSourceAffectedClosure: async () => closure(["partition-removed"])
      },
      communities: {
        upsertAssignments: async () => undefined,
        enqueueDirty
      }
    });

    await expect(handler(claim())).resolves.toMatchObject({
      checkpoint: { entityCount: 0, dirtyPartitionCount: 1 }
    });
    expect(enqueueDirty).toHaveBeenCalledWith(expect.objectContaining({
      partitions: [expect.objectContaining({
        partitionKey: "partition-removed",
        reasonKind: "deleted"
      })]
    }));
  });
});

function closure(dirtyPartitionKeys: string[]): any {
  return {
    knowledgeBaseId: "kb-a",
    semanticGenerationPublicId: "generation-a",
    sourceFilePublicIds: ["file-a"],
    entityPublicIds: [],
    relationshipPublicIds: [],
    evidencePublicIds: [],
    reverseReferencePublicIds: [],
    vectorOwnerPublicIds: [],
    dirtyPartitionKeys,
    affectedFileNeighborPublicIds: [],
    generatedLogicalPaths: []
  };
}

function claim(): any {
  return {
    knowledgeBaseId: "kb-a", semanticGenerationPublicId: "generation-a",
    sourceFilePublicId: "file-a", sourceRevisionPublicId: "revision-a"
  };
}

import { describe, expect, it, vi } from "vitest";
import { createSemanticPublicationStageHandler } from
  "../src/semantic/application/publication-stage-handler.js";

describe("semantic publication stage handler", () => {
  it("publishes only the durable affected closure for the source revision", async () => {
    const closure = affectedClosure();
    const publish = vi.fn(async () => ({ candidatePublicId: "candidate-a" }));
    const handler = createSemanticPublicationStageHandler({
      facts: { getSourceAffectedClosure: async () => closure },
      publish,
      clock: () => "2027-08-08T00:00:00.000Z"
    });
    await expect(handler(claim())).resolves.toMatchObject({
      checkpoint: {
        candidatePublicId: "candidate-a",
        affectedSourceFileCount: 1,
        affectedEntityCount: 1
      }
    });
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      closure,
      settingsRevisionPublicId: "settings-a",
      publicationDelayMilliseconds: 0
    }));
  });

  it("rejects publication when extraction closure is unavailable", async () => {
    const handler = createSemanticPublicationStageHandler({
      facts: { getSourceAffectedClosure: async () => null },
      publish: vi.fn()
    });
    await expect(handler(claim())).rejects.toMatchObject({
      code: "semantic_publication_closure_unavailable"
    });
  });
});

function claim(): any {
  return {
    knowledgeBaseId: "kb-a", semanticGenerationPublicId: "generation-a",
    sourceFilePublicId: "file-a", sourceRevisionPublicId: "revision-a",
    operationPublicId: "operation-a",
    settingsSnapshot: {
      runtimeSettingsRevisionPublicId: "settings-a",
      publicationDelayMilliseconds: 0
    }
  };
}

function affectedClosure(): any {
  return {
    knowledgeBaseId: "kb-a", sourceFilePublicIds: ["file-a"],
    sourceRevisionPublicIds: ["revision-a"], entityPublicIds: ["entity-a"],
    relationshipPublicIds: [], evidencePublicIds: ["evidence-a"],
    reverseReferencePublicIds: ["entity:entity-a"],
    vectorOwnerPublicIds: ["entity-a"], dirtyPartitionKeys: ["entity-aa"],
    affectedFileNeighborPublicIds: [], generatedLogicalPaths: ["alpha.md"],
    graphShardPublicIds: ["graph-a"], searchShardPublicIds: ["search-a"]
  };
}

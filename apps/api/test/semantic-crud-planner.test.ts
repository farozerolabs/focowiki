import { describe, expect, it } from "vitest";
import {
  planSemanticCrudMutation,
  selectSemanticCrudStages
} from "../src/semantic/application/crud-planner.js";
import { planSemanticSourceStages } from
  "../src/semantic/application/stage-orchestration.js";

describe("semantic CRUD planner", () => {
  it.each(["upload", "body_replacement"] as const)(
    "runs revision-bound model work for %s only",
    (mutationKind) => {
      const plan = planSemanticCrudMutation({
        ...baseInput(mutationKind),
        sources: [source({ bodyChanged: true })]
      });
      expect(plan.extractionSourceRevisionPublicIds).toEqual(["revision-new"]);
      expect(plan.embeddingOwnerPublicIds).toEqual([
        "entity-main", "file-main", "relationship-main"
      ]);
      expect(plan.semanticReconciliationSourceFilePublicIds).toEqual(["file-main"]);
      expect(plan.unrelatedSourceReadAllowed).toBe(false);
      expect(plan.fullKnowledgeBaseFallbackAllowed).toBe(false);
    }
  );

  it.each(["file_rename", "file_move", "directory_rename", "directory_move"] as const)(
    "reuses body artifacts and changes only path-dependent projections for %s",
    (mutationKind) => {
      const plan = planSemanticCrudMutation({
        ...baseInput(mutationKind),
        sources: [source({ bodyChanged: false })]
      });
      expect(plan.extractionSourceRevisionPublicIds).toEqual([]);
      expect(plan.embeddingOwnerPublicIds).toEqual([]);
      expect(plan.reusedArtifactOwnerPublicIds).toEqual([
        "entity-main", "file-main", "relationship-main"
      ]);
      expect(plan.vectorUpsertOwnerPublicIds).toEqual([
        "entity-main", "file-main", "relationship-main"
      ]);
      expect(plan.affectedLogicalPaths).toEqual(expect.arrayContaining([
        "pages/Guides/Old.md", "pages/Guides/New.md"
      ]));
    }
  );

  it.each(["empty_directory_create", "knowledge_base_metadata_update"] as const)(
    "does not schedule semantic model work for %s",
    (mutationKind) => {
      const plan = planSemanticCrudMutation({
        ...baseInput(mutationKind),
        sources: []
      });
      expect(plan.extractionSourceRevisionPublicIds).toEqual([]);
      expect(plan.embeddingOwnerPublicIds).toEqual([]);
      expect(plan.semanticReconciliationSourceFilePublicIds).toEqual([]);
    }
  );

  it("excludes a deleted file immediately and schedules owned cleanup only", () => {
    const plan = planSemanticCrudMutation({
      ...baseInput("file_delete"),
      sources: [source({ bodyChanged: false, deleted: true })]
    });
    expect(plan.visibilityExcludedSourceFilePublicIds).toEqual(["file-main"]);
    expect(plan.cancelledSourceRevisionPublicIds).toEqual(["revision-old"]);
    expect(plan.semanticReconciliationSourceFilePublicIds).toEqual(["file-main"]);
    expect(plan.vectorDeleteOwnerPublicIds).toEqual([
      "entity-main", "file-main", "relationship-main"
    ]);
    expect(plan.affectedSourceFilePublicIds).toEqual([
      "file-main", "file-neighbor"
    ]);
    expect(plan.vectorUpsertOwnerPublicIds).toEqual([]);
  });

  it.each(["directory_delete", "knowledge_base_delete"] as const)(
    "keeps %s cleanup cursor-paged and knowledge-base scoped",
    (mutationKind) => {
      const plan = planSemanticCrudMutation({
        ...baseInput(mutationKind),
        sources: [
          source({ sourceFilePublicId: "file-a", deleted: true }),
          source({ sourceFilePublicId: "file-b", deleted: true })
        ],
        page: { maximumItems: 2, nextCursor: "cursor-next", hasMore: true }
      });
      expect(plan.cleanupScope).toEqual({
        knowledgeBaseId: "kb-main", sourceFilePublicIds: ["file-a", "file-b"]
      });
      expect(plan.continuation).toEqual({ nextCursor: "cursor-next", hasMore: true });
      expect(plan.fullKnowledgeBaseFallbackAllowed).toBe(false);
      expect(plan.affectedSourceFilePublicIds).not.toContain("file-other-kb");
    }
  );

  it("rejects an over-bound page instead of widening to a whole-knowledge-base scan", () => {
    expect(() => planSemanticCrudMutation({
      ...baseInput("directory_delete"),
      sources: [source(), source({ sourceFilePublicId: "file-two" })],
      page: { maximumItems: 1, nextCursor: null, hasMore: false }
    })).toThrow("page bound");
  });

  it("shares the production stage policy without a second CRUD executor", () => {
    const stages = planSemanticSourceStages({
      knowledgeBaseId: "kb-main",
      operationPublicId: "operation-main",
      semanticGenerationPublicId: "semantic-main",
      sourceFilePublicId: "file-main",
      sourceRevisionPublicId: "revision-new",
      extractionContractVersion: "extract-v1",
      embeddingConfigurationRevisionPublicId: "embedding-revision",
      settingsSnapshot: {},
      dirtyCommunityPartitionKeys: [],
      includeValidation: false,
      maximumAttempts: 3
    });
    expect(selectSemanticCrudStages("body_replacement", stages)
      .map((stage) => stage.stageKind)).toEqual([
      "extraction", "reconciliation", "community", "embedding",
      "vector", "publication"
    ]);
    expect(selectSemanticCrudStages("directory_move", stages)
      .map((stage) => stage.stageKind)).toEqual(["vector", "publication"]);
    expect(selectSemanticCrudStages("knowledge_base_metadata_update", stages))
      .toEqual([]);
  });
});

function baseInput(mutationKind: Parameters<typeof planSemanticCrudMutation>[0]["mutationKind"]) {
  return {
    knowledgeBaseId: "kb-main",
    operationPublicId: "operation-main",
    semanticGenerationPublicId: "semantic-main",
    mutationKind,
    sources: []
  };
}

type SourceFixture = {
  sourceFilePublicId: string;
  priorSourceRevisionPublicId: string;
  currentSourceRevisionPublicId: string;
  bodyChanged: boolean;
  deleted: boolean;
  priorLogicalPath: string;
  currentLogicalPath: string;
  semanticImpact: {
    sourceFilePublicIds: string[];
    sourceRevisionPublicIds: string[];
    entityPublicIds: string[];
    relationshipPublicIds: string[];
    evidencePublicIds: string[];
    reverseReferencePublicIds: string[];
    vectorOwnerPublicIds: string[];
    dirtyPartitionKeys: string[];
    affectedFileNeighborPublicIds: string[];
    generatedLogicalPaths: string[];
    graphShardPublicIds: string[];
    searchShardPublicIds: string[];
  };
};

function source(overrides: Partial<SourceFixture> = {}): SourceFixture {
  return {
    sourceFilePublicId: "file-main",
    priorSourceRevisionPublicId: "revision-old",
    currentSourceRevisionPublicId: "revision-new",
    bodyChanged: false,
    deleted: false,
    priorLogicalPath: "Guides/Old.md",
    currentLogicalPath: "Guides/New.md",
    semanticImpact: {
      sourceFilePublicIds: ["file-main"],
      sourceRevisionPublicIds: ["revision-old", "revision-new"],
      entityPublicIds: ["entity-main"],
      relationshipPublicIds: ["relationship-main"],
      evidencePublicIds: ["evidence-main"],
      reverseReferencePublicIds: ["entity:entity-main"],
      vectorOwnerPublicIds: ["file-main", "entity-main", "relationship-main"],
      dirtyPartitionKeys: ["entity-en"],
      affectedFileNeighborPublicIds: ["file-neighbor"],
      generatedLogicalPaths: ["_graph/by-file/file-main.json"],
      graphShardPublicIds: ["graph-abcd"],
      searchShardPublicIds: ["search-abcd"]
    },
    ...overrides
  };
}

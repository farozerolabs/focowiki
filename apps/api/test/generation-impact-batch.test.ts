import { describe, expect, it } from "vitest";
import {
  planPublicationImpactBatch,
  type PublicationImpactPlanningFact
} from "../src/publication/generation-impact-batch.js";

describe("generation impact batch", () => {
  it("plans one bounded affected closure and preserves all causes", () => {
    const batch = planPublicationImpactBatch([
      fact({
        id: "change-create",
        kind: "source_created",
        sourceFileId: "source-a",
        path: "guides/start.md",
        graphNeighborSourceFileIds: ["source-neighbor"],
        graphEdgeIds: ["edge-a"]
      }),
      fact({
        id: "change-move",
        kind: "source_moved",
        sourceFileId: "source-a",
        previousPath: "guides/start.md",
        path: "archive/start.md",
        graphEdgeIds: ["edge-b"],
        removedGraphEdgeIds: ["edge-a"]
      }),
      fact({
        id: "change-delete",
        kind: "source_deleted",
        sourceFileId: "source-a",
        previousPath: "archive/start.md",
        path: null,
        graphNeighborSourceFileIds: ["source-neighbor"],
        removedGraphEdgeIds: ["edge-b"]
      })
    ]);

    expect(batch.plannedFacts).toHaveLength(3);
    expect(batch.causeRows.length).toBe(
      batch.plannedFacts.reduce((total, planned) => total + planned.impacts.length, 0)
    );
    expect(batch.effectiveImpacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        projectionKind: "page",
        recordIdentity: "source-a",
        action: "delete"
      }),
      expect.objectContaining({
        projectionKind: "directory",
        projectionKey: "guides",
        action: "validate"
      }),
      expect.objectContaining({
        projectionKind: "directory",
        projectionKey: "archive",
        action: "validate"
      }),
      expect.objectContaining({
        projectionKind: "graph_reverse_neighbor",
        recordIdentity: "source-neighbor",
        action: "upsert"
      }),
      expect.objectContaining({
        projectionKind: "graph_edge",
        recordIdentity: "edge-a",
        action: "delete"
      }),
      expect.objectContaining({
        projectionKind: "graph_edge",
        recordIdentity: "edge-b",
        action: "delete"
      })
    ]));
    expect(batch.effectiveImpacts.filter((impact) => impact.projectionKind === "root"))
      .toHaveLength(5);
    expect(batch.effectiveImpacts).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ recordIdentity: "source-unrelated" })
    ]));

    const pageCauses = batch.causeRows.filter((row) =>
      row.impact.projectionKind === "page" && row.impact.recordIdentity === "source-a"
    );
    expect(pageCauses.map((row) => row.changeFactId)).toEqual([
      "change-create",
      "change-move",
      "change-delete"
    ]);
  });

  it("accepts retained preplanned impacts while new facts use assembler planning", () => {
    const retained = fact({
      id: "change-retained",
      kind: "source_replaced",
      sourceFileId: "source-retained",
      path: "docs/retained.md"
    });
    const planned = planPublicationImpactBatch([{
      ...retained,
      preplannedImpacts: [{
        id: "impact-retained",
        projectionKind: "page",
        projectionKey: "source-retained",
        recordIdentity: "source-retained",
        action: "upsert"
      }],
      impactPlanner: null
    }]);

    expect(planned.effectiveImpacts).toEqual([{
      id: "impact-retained",
      projectionKind: "page",
      projectionKey: "source-retained",
      recordIdentity: "source-retained",
      action: "upsert"
    }]);
  });
});

function fact(input: Partial<PublicationImpactPlanningFact> & Pick<
  PublicationImpactPlanningFact,
  "id" | "kind"
>): PublicationImpactPlanningFact {
  return {
    id: input.id,
    kind: input.kind,
    sourceFileId: input.sourceFileId ?? null,
    previousPath: input.previousPath ?? null,
    path: input.path ?? null,
    graphNeighborSourceFileIds: input.graphNeighborSourceFileIds ?? [],
    graphEdgeIds: input.graphEdgeIds ?? [],
    removedGraphEdgeIds: input.removedGraphEdgeIds ?? [],
    preplannedImpacts: input.preplannedImpacts,
    impactPlanner: input.impactPlanner ?? oneShardConfig()
  };
}

function oneShardConfig() {
  return {
    searchShardCount: 1,
    linkShardCount: 1,
    manifestShardCount: 1,
    treeShardCount: 1,
    graphNodeShardCount: 1,
    graphEdgeShardCount: 1
  };
}

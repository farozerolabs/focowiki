import { describe, expect, it } from "vitest";
import {
  buildProjectionRepairPlan,
  clampProjectionRepairConcurrency,
  REQUIRED_PROJECTION_REPAIR_VERSIONS
} from "../src/maintenance/projection-repair-plan.js";

describe("projection repair plan", () => {
  it("plans only stale projection kinds with deterministic physical tasks", () => {
    const input = {
      knowledgeBaseId: "kb-test",
      repairVersion: 4,
      baseGenerationId: "generation-active",
      targetGenerationId: "generation-repair",
      sourceWatermark: 42,
      settingsRevision: 7,
      settings: {
        concurrency: 4,
        databaseBatchSize: 2_000,
        objectWriteConcurrency: 8
      },
      currentVersions: {
        tree: REQUIRED_PROJECTION_REPAIR_VERSIONS.tree,
        directory: 0,
        graph: REQUIRED_PROJECTION_REPAIR_VERSIONS.graph
      },
      treePartitions: ["tree/v1/0002", "tree/v1/0001"],
      directories: ["pages/zeta", "pages", "pages/alpha"]
    } as const;

    const first = buildProjectionRepairPlan(input);
    const second = buildProjectionRepairPlan(input);

    expect(first).toEqual(second);
    expect(first.staleProjectionKinds).toEqual(["directory"]);
    expect(first.tasks.map((task) => [task.kind, task.partitionKey])).toEqual([
      ["directory", "pages"],
      ["directory", "pages/alpha"],
      ["directory", "pages/zeta"],
      ["finalize", "root"]
    ]);
    expect(new Set(first.tasks.map((task) => task.id)).size).toBe(first.tasks.length);
    expect(first.tasks.every((task) =>
      task.baseGenerationId === "generation-active"
      && task.sourceWatermark === 42
      && task.settingsRevision === 7
    )).toBe(true);
  });

  it("creates no work when all required projection versions are current", () => {
    const plan = buildProjectionRepairPlan({
      knowledgeBaseId: "kb-current",
      repairVersion: 4,
      baseGenerationId: "generation-active",
      targetGenerationId: "generation-repair",
      sourceWatermark: 10,
      settingsRevision: 1,
      settings: {
        concurrency: 4,
        databaseBatchSize: 2_000,
        objectWriteConcurrency: 8
      },
      currentVersions: { ...REQUIRED_PROJECTION_REPAIR_VERSIONS },
      treePartitions: ["tree/v1/0000"],
      directories: ["pages"]
    });

    expect(plan.staleProjectionKinds).toEqual([]);
    expect(plan.tasks).toEqual([]);
  });

  it("plans independently retryable graph partitions before graph finalization", () => {
    const plan = buildProjectionRepairPlan({
      knowledgeBaseId: "kb-graph",
      repairVersion: 4,
      baseGenerationId: "generation-active",
      targetGenerationId: "generation-repair",
      sourceWatermark: 10,
      settingsRevision: 1,
      settings: {
        concurrency: 4,
        databaseBatchSize: 2_000,
        objectWriteConcurrency: 8
      },
      currentVersions: {
        tree: REQUIRED_PROJECTION_REPAIR_VERSIONS.tree,
        directory: REQUIRED_PROJECTION_REPAIR_VERSIONS.directory,
        graph: 1
      },
      treePartitions: [],
      directories: [],
      graphPartitions: [
        { projectionKind: "graph_node", shardKey: "graph_node/v1/0001" },
        { projectionKind: "graph_edge", shardKey: "graph_edge/v1/0000" },
        { projectionKind: "graph_node", shardKey: "graph_node/v1/0001" }
      ]
    });

    expect(plan.tasks.map((task) => [task.kind, task.partitionKey, task.phaseOrder]))
      .toEqual([
        ["graph_partition", "graph_edge\u001fgraph_edge/v1/0000", 30],
        ["graph_partition", "graph_node\u001fgraph_node/v1/0001", 30],
        ["graph_finalize", "graph", 40],
        ["finalize", "root", 100]
      ]);
  });

  it("clamps claims below the process database-pool reserve", () => {
    expect(clampProjectionRepairConcurrency({
      configuredConcurrency: 12,
      databasePoolMax: 8,
      reservedConnections: 2
    })).toEqual({
      effectiveConcurrency: 6,
      clamped: true
    });
    expect(clampProjectionRepairConcurrency({
      configuredConcurrency: 4,
      databasePoolMax: 8,
      reservedConnections: 2
    })).toEqual({
      effectiveConcurrency: 4,
      clamped: false
    });
  });
});

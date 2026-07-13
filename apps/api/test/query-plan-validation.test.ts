import { describe, expect, it } from "vitest";
import {
  buildExplainAnalyzeSql,
  createHardDeletePlanTargets,
  createLargeScaleReadPlanTargets,
  createReleaseValidationPlanTargets,
  summarizeQueryPlan
} from "../src/db/query-plan-validation.js";

describe("query plan validation helpers", () => {
  it("builds one EXPLAIN ANALYZE statement for critical read targets", () => {
    const targets = createLargeScaleReadPlanTargets();

    expect(targets.map((target) => target.name)).toEqual(
      expect.arrayContaining([
        "knowledge-base-card-search",
        "knowledge-tree-search-name",
        "knowledge-tree-search-path",
        "knowledge-tree-search-next-page",
        "knowledge-tree-search-ancestors",
        "knowledge-file-search-first-page",
        "knowledge-file-search-next-page",
        "knowledge-file-search-no-result",
        "knowledge-file-search-kind-filter",
        "knowledge-file-search-cache-hit",
        "knowledge-graph-search-first-page",
        "knowledge-graph-search-edge-match",
        "graph-expand-file-neighborhood",
        "graph-expand-edge-seed",
        "graph-expand-query-seed",
        "source-resource-list-filter",
        "worker-job-source-cancellation"
      ])
    );

    for (const target of targets) {
      const explainSql = buildExplainAnalyzeSql(target.sql);

      expect(explainSql).toContain("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)");
      expect(explainSql).toContain("focowiki.");
    }
  });

  it("keeps version-two source-resource filters bounded and independent from task visibility", () => {
    const target = createLargeScaleReadPlanTargets().find((item) =>
      item.name === "source-resource-list-filter"
    );
    expect(target).toBeDefined();
    const normalizedSql = target!.sql.replace(/\s+/g, " ").toLowerCase();
    expect(normalizedSql).toContain("deletion_intent_id is null");
    expect(normalizedSql).toContain("order by id asc");
    expect(normalizedSql).toContain("limit 51");
    expect(normalizedSql).not.toContain("task_deleted_at");
    expect(normalizedSql).not.toContain(" offset ");
  });

  it("keeps source-file task list plans task-hidden aware", () => {
    const targets = createLargeScaleReadPlanTargets().filter((target) =>
      target.name.startsWith("source-file-list")
    );

    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(target.sql).toContain("task_deleted_at IS NULL");
    }
  });

  it("builds bounded hard-delete cleanup plan targets", () => {
    const targets = createHardDeletePlanTargets();

    expect(targets.map((target) => target.name)).toEqual(
      expect.arrayContaining([
        "hard-delete-source-knowledge-graph-search-documents",
        "hard-delete-source-knowledge-graph-edges",
        "hard-delete-source-knowledge-tree-entries",
        "hard-delete-source-bundle-files",
        "hard-delete-source-worker-jobs",
        "hard-delete-knowledge-base-graph-search-documents",
        "hard-delete-knowledge-base-graph-edges",
        "hard-delete-knowledge-base-tree-entries",
        "hard-delete-knowledge-base-bundle-files",
        "hard-delete-knowledge-base-source-files",
        "hard-delete-knowledge-base-worker-jobs"
      ])
    );

    for (const target of targets) {
      const normalizedSql = target.sql.replace(/\s+/g, " ").toLowerCase();

      expect(buildExplainAnalyzeSql(target.sql)).toContain("EXPLAIN");
      expect(normalizedSql).toContain("knowledge_base_id = 'kb-plan'");
      expect(normalizedSql).toContain("limit 100");
      expect(normalizedSql).not.toContain(" offset ");
    }
  });

  it("builds bounded release validation plan targets", () => {
    const targets = createReleaseValidationPlanTargets();

    expect(targets.map((target) => target.name)).toEqual([
      "release-validation-source-page",
      "release-validation-tree-reachability",
      "release-validation-concept-type",
      "release-validation-generated-target",
      "release-validation-continuation-chain",
      "release-validation-index-coverage"
    ]);

    for (const target of targets) {
      const normalizedSql = target.sql.replace(/\s+/g, " ").toLowerCase();

      expect(buildExplainAnalyzeSql(target.sql)).toContain("EXPLAIN");
      expect(normalizedSql).toContain("knowledge_base_id = 'kb-okf-scale'");
      expect(normalizedSql).toContain("release_id = 'release-okf-scale'");
      expect(normalizedSql).toContain("limit 101");
      expect(normalizedSql).not.toContain(" offset ");
    }
  });

  it("keeps normal read plan targets decoupled from hard-delete tables", () => {
    const targets = createLargeScaleReadPlanTargets();

    for (const target of targets) {
      const normalizedSql = target.sql.replace(/\s+/g, " ").toLowerCase();

      expect(normalizedSql).not.toContain("hard_delete_object_deletions");
      expect(normalizedSql).not.toContain("kind = 'hard_delete'");
    }
  });

  it("keeps graph expansion plan targets bounded and graph-index scoped", () => {
    const targets = createLargeScaleReadPlanTargets().filter((target) =>
      target.name.startsWith("graph-expand")
    );

    expect(targets.map((target) => target.name)).toEqual([
      "graph-expand-file-neighborhood",
      "graph-expand-edge-seed",
      "graph-expand-query-seed"
    ]);

    for (const target of targets) {
      const normalizedSql = target.sql.replace(/\s+/g, " ").toLowerCase();

      expect(normalizedSql).toContain("knowledge_base_id = 'kb-plan'");
      expect(normalizedSql).toContain("limit ");
      expect(normalizedSql).not.toContain(" offset ");
    }

    expect(targets.find((target) => target.name === "graph-expand-file-neighborhood")?.sql).toContain(
      "knowledge_graph_edges"
    );
    expect(targets.find((target) => target.name === "graph-expand-query-seed")?.sql).toContain(
      "knowledge_graph_search_documents"
    );
  });

  it("rejects empty and multi-statement query plan inputs", () => {
    expect(() => buildExplainAnalyzeSql("")).toThrow("must not be empty");
    expect(() => buildExplainAnalyzeSql("SELECT 1; SELECT 2")).toThrow("one statement");
  });

  it("summarizes JSON plans into bounded evidence", () => {
    const summary = summarizeQueryPlan([
      {
        Plan: {
          "Node Type": "Nested Loop",
          "Shared Hit Blocks": 10,
          "Shared Read Blocks": 2,
          Plans: [
            {
              "Node Type": "Index Scan",
              "Relation Name": "source_files",
              "Shared Hit Blocks": 3,
              "Shared Read Blocks": 0
            },
            {
              "Node Type": "Seq Scan",
              "Relation Name": "bundle_files",
              "Shared Hit Blocks": 7,
              "Shared Read Blocks": 2
            }
          ]
        },
        "Planning Time": 1.5,
        "Execution Time": 12.3
      }
    ]);

    expect(summary).toEqual({
      nodeTypes: ["Nested Loop", "Index Scan", "Seq Scan"],
      relationNames: ["source_files", "bundle_files"],
      hasSequentialScan: true,
      planningTimeMs: 1.5,
      executionTimeMs: 12.3,
      sharedHitBlocks: 20,
      sharedReadBlocks: 4
    });
  });
});

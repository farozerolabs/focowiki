import { describe, expect, it } from "vitest";
import {
  buildExplainAnalyzeSql,
  createHardDeletePlanTargets,
  createLargeScaleReadPlanTargets,
  summarizeQueryPlan
} from "../src/db/query-plan-validation.js";

describe("query plan validation helpers", () => {
  it("builds one EXPLAIN ANALYZE statement for critical read targets", () => {
    const targets = createLargeScaleReadPlanTargets();

    expect(targets.map((target) => target.name)).toEqual(
      expect.arrayContaining([
        "knowledge-base-card-search",
        "bundle-tree-search-name",
        "bundle-tree-search-path",
        "bundle-tree-search-next-page",
        "bundle-tree-search-ancestors",
        "generated-file-search-first-page",
        "generated-file-search-next-page",
        "generated-file-search-no-result",
        "generated-file-search-kind-filter",
        "generated-file-search-cache-hit",
        "worker-job-source-cancellation"
      ])
    );

    for (const target of targets) {
      const explainSql = buildExplainAnalyzeSql(target.sql);

      expect(explainSql).toContain("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)");
      expect(explainSql).toContain("focowiki.");
    }
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
        "hard-delete-source-search-documents",
        "hard-delete-source-tree-entries",
        "hard-delete-source-bundle-files",
        "hard-delete-source-worker-jobs",
        "hard-delete-knowledge-base-search-documents",
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

  it("keeps normal read plan targets decoupled from hard-delete tables", () => {
    const targets = createLargeScaleReadPlanTargets();

    for (const target of targets) {
      const normalizedSql = target.sql.replace(/\s+/g, " ").toLowerCase();

      expect(normalizedSql).not.toContain("hard_delete_object_deletions");
      expect(normalizedSql).not.toContain("kind = 'hard_delete'");
    }
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

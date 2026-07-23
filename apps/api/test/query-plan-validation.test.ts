import { describe, expect, it } from "vitest";
import {
  buildExplainAnalyzeSql,
  createCleanupPlanTargets,
  createGenerationValidationPlanTargets,
  createLargeScaleReadPlanTargets,
  createMaintenanceProgressPlanTargets,
  createRoleQueuePlanTargets,
  summarizeQueryPlan
} from "../src/db/query-plan-validation.js";

describe("query plan validation helpers", () => {
  it("defines generation-scoped read targets with bounded keyset pages", () => {
    const targets = createLargeScaleReadPlanTargets();
    expect(targets.map((target) => target.name)).toEqual(expect.arrayContaining([
      "active-generation-resolve",
      "active-file-by-id",
      "active-file-by-path",
      "active-file-metadata-by-source",
      "active-tree-page",
      "active-tree-search",
      "active-file-search",
      "active-graph-search",
      "active-related-page"
    ]));
    for (const target of targets) {
      const sql = normalize(target.sql);
      expect(buildExplainAnalyzeSql(target.sql)).toContain("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)");
      expect(sql).toContain("focowiki.");
      expect(sql).not.toContain(" offset ");
      expect(sql).not.toContain("release_id");
      expect(sql).not.toContain("bundle_files");
    }
  });

  it("keeps source-resource filters independent from task-list visibility", () => {
    const target = createLargeScaleReadPlanTargets().find((item) =>
      item.name === "source-resource-list-filter"
    );
    expect(target).toBeDefined();
    const sql = normalize(target!.sql);
    expect(sql).toContain("deletion_intent_id is null");
    expect(sql).toContain("order by id");
    expect(sql).toContain("limit 51");
    expect(sql).not.toContain("task_deleted_at");
  });

  it("keeps task-list targets aware of task-hidden records", () => {
    const target = createLargeScaleReadPlanTargets().find((item) =>
      item.name === "source-file-list"
    );
    expect(normalize(target!.sql)).toContain("task_deleted_at is null");
  });

  it("matches active text-index expressions before bounded search joins", () => {
    const targets = createLargeScaleReadPlanTargets();
    for (const name of ["active-tree-search", "active-file-search", "active-graph-search"]) {
      const target = targets.find((item) => item.name === name);
      expect(target).toBeDefined();
      const sql = normalize(target!.sql);
      expect(sql).toContain("lower(");
      expect(sql).toContain(" like '%example%'");
      expect(sql).toContain("limit 51");
    }
  });

  it("defines role-isolated bounded claim targets", () => {
    const targets = createRoleQueuePlanTargets();
    expect(targets.map((target) => target.name)).toEqual([
      "role-job-source-cancellation",
      "role-job-claim",
      "source-dispatch-claim",
      "publication-impact-claim",
      "publication-progress-summary",
      "generation-freeze"
    ]);
    for (const target of targets) {
      const sql = normalize(target.sql);
      expect(buildExplainAnalyzeSql(target.sql)).toContain("EXPLAIN");
      expect(sql).not.toContain("worker_jobs");
      expect(sql).not.toContain(" offset ");
    }
  });

  it("defines bounded maintenance summaries without internal payload columns", () => {
    const targets = createMaintenanceProgressPlanTargets();
    expect(targets).toHaveLength(4);
    expect(normalize(targets[0]!.sql)).toContain("knowledge_base_id = 'kb-plan'");
    const repairTarget = targets.find(
      (target) => target.name === "projection-repair-progress-summary"
    );
    expect(repairTarget).toBeDefined();
    expect(normalize(repairTarget!.sql)).toContain("order by repair_version desc");
    expect(normalize(repairTarget!.sql)).toContain("limit 1");
    for (const target of targets.filter((target) => target.name.includes("compaction"))) {
      const sql = normalize(target.sql);
      expect(sql).toContain("order by updated_at desc, id");
      expect(sql).toContain("limit 1");
    }
    for (const target of targets) {
      const sql = normalize(target.sql);
      expect(sql).not.toMatch(/object_key|segment_ids|lease_token|payload_json|high_water/);
    }
  });

  it("validates only generation-local references and projections", () => {
    const targets = createGenerationValidationPlanTargets();
    expect(targets.map((target) => target.name)).toEqual([
      "generation-validation-ref-page",
      "generation-validation-projection-page"
    ]);
    for (const target of targets) {
      const sql = normalize(target.sql);
      expect(sql).toContain("generation_id = 'generation-plan'");
      expect(sql).toContain("limit 101");
      expect(sql).not.toContain("source_files");
      expect(sql).not.toContain(" offset ");
    }
  });

  it("keeps cleanup and immutable object collection bounded", () => {
    const targets = createCleanupPlanTargets();
    expect(targets.map((target) => target.name)).toEqual([
      "cleanup-object-page",
      "immutable-object-gc-claim"
    ]);
    for (const target of targets) {
      const sql = normalize(target.sql);
      expect(buildExplainAnalyzeSql(target.sql)).toContain("EXPLAIN");
      expect(sql).toMatch(/limit 100/);
      expect(sql).not.toContain(" offset ");
    }
  });

  it("rejects empty and multi-statement inputs", () => {
    expect(() => buildExplainAnalyzeSql("")).toThrow("must not be empty");
    expect(() => buildExplainAnalyzeSql("SELECT 1; SELECT 2")).toThrow("one statement");
  });

  it("summarizes JSON plans into bounded evidence", () => {
    const summary = summarizeQueryPlan([{
      Plan: {
        "Node Type": "Nested Loop",
        "Shared Hit Blocks": 10,
        "Shared Read Blocks": 2,
        Plans: [
          {
            "Node Type": "Index Scan",
            "Relation Name": "active_projection_records",
            "Index Name": "active_projection_records_pkey",
            "Actual Rows": 5,
            "Shared Hit Blocks": 3,
            "Shared Read Blocks": 0
          },
          {
            "Node Type": "Seq Scan",
            "Relation Name": "projection_shards",
            "Actual Rows": 7,
            "Rows Removed by Filter": 11,
            "Shared Hit Blocks": 7,
            "Shared Read Blocks": 2
          }
        ]
      },
      "Planning Time": 1.5,
      "Execution Time": 12.3
    }]);

    expect(summary).toEqual({
      nodeTypes: ["Nested Loop", "Index Scan", "Seq Scan"],
      relationNames: ["active_projection_records", "projection_shards"],
      indexNames: ["active_projection_records_pkey"],
      sequentialScanRelations: ["projection_shards"],
      hasSequentialScan: true,
      actualRows: 12,
      rowsRemovedByFilter: 11,
      planningTimeMs: 1.5,
      executionTimeMs: 12.3,
      sharedHitBlocks: 20,
      sharedReadBlocks: 4
    });
  });
});

function normalize(sql: string): string {
  return ` ${sql.replace(/\s+/g, " ").trim().toLowerCase()} `;
}

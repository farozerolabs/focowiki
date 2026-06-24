import { describe, expect, it } from "vitest";
import {
  buildExplainAnalyzeSql,
  createLargeScaleReadPlanTargets,
  summarizeQueryPlan
} from "../src/db/query-plan-validation.js";

describe("query plan validation helpers", () => {
  it("builds one EXPLAIN ANALYZE statement for critical read targets", () => {
    for (const target of createLargeScaleReadPlanTargets()) {
      const explainSql = buildExplainAnalyzeSql(target.sql);

      expect(explainSql).toContain("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)");
      expect(explainSql).toContain("focowiki.");
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

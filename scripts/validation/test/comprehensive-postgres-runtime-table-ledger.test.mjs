import assert from "node:assert/strict";
import test from "node:test";

import {
  reconcileComprehensivePostgresRuntimeTables
} from "../lib/comprehensive-postgres-runtime-table-ledger.mjs";

test("reconciles every inventoried table and declared runtime partition", () => {
  const report = reconcileComprehensivePostgresRuntimeTables({
    phase: "document-activation",
    expectedTableNames: ["events", "knowledge_bases"],
    runtimeTables: [
      table("events", { exactRows: 2 }),
      table("events_2026", {
        parentTableName: "events",
        relationKind: "partition",
        exactRows: 2
      }),
      table("knowledge_bases")
    ]
  });

  assert.equal(report.ok, true);
  assert.equal(report.summary.expectedFixedTableCount, 2);
  assert.equal(report.summary.observedRuntimeTableCount, 3);
  assert.equal(report.summary.partitionTableCount, 1);
  assert.equal(report.summary.totalExactRows, 2);
  assert.equal(report.summary.partitionExactRows, 2);
  assert.equal(report.rows[0].manualStatus, "pass");
});

test("rejects missing fixed tables and unexplained runtime tables", () => {
  assert.throws(() => reconcileComprehensivePostgresRuntimeTables({
    phase: "document-activation",
    expectedTableNames: ["events", "knowledge_bases"],
    runtimeTables: [table("events"), table("unknown")]
  }), /knowledge_bases|unknown/u);
});

function table(tableName, overrides = {}) {
  return {
    tableName,
    relationKind: "table",
    parentTableName: null,
    exactRows: 0,
    totalBytes: 8192,
    columnCount: 1,
    constraintCount: 1,
    indexCount: 1,
    indexScanCount: 0,
    sequentialScanCount: 0,
    liveTupleEstimate: 0,
    deadTupleEstimate: 0,
    lockCount: 0,
    knowledgeBaseCounts: null,
    stateCounts: [],
    ...overrides
  };
}

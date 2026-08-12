import assert from "node:assert/strict";
import test from "node:test";

import {
  buildComprehensiveCorpusManualReconciliation
} from "../lib/comprehensive-corpus-manual-reconciliation.mjs";

test("keeps every corpus file individually passed while cleanup remains pending", () => {
  const report = buildComprehensiveCorpusManualReconciliation({
    runId: "validation-20260810111944-b648eb2f",
    files: Array.from({ length: 200 }, (_, index) => file(index + 1)),
    cleanupCompleted: false
  });

  assert.equal(report.reviewOk, true);
  assert.equal(report.cleanupOk, false);
  assert.equal(report.rows.length, 200);
  assert.equal(report.rows.every((row) => row.manualStatus === "pass"), true);
  assert.equal(report.rows.every((row) => row.cleanupStatus === "pending"), true);
  assert.equal(report.summary.reviewPassed, 200);
  assert.equal(report.summary.cleanupPending, 200);
});

test("rejects missing files, duplicate aliases, failed checks, and aggregate evidence", () => {
  const complete = Array.from({ length: 200 }, (_, index) => file(index + 1));
  assert.throws(() => buildComprehensiveCorpusManualReconciliation({
    runId: "validation-20260810111944-b648eb2f",
    files: complete.slice(1),
    cleanupCompleted: false
  }), /exactly 200/u);
  assert.throws(() => buildComprehensiveCorpusManualReconciliation({
    runId: "validation-20260810111944-b648eb2f",
    files: [...complete.slice(0, 199), complete[0]],
    cleanupCompleted: false
  }), /duplicate corpus alias/u);
  const failed = structuredClone(complete);
  failed[37].checks.search = false;
  assert.throws(() => buildComprehensiveCorpusManualReconciliation({
    runId: "validation-20260810111944-b648eb2f",
    files: failed,
    cleanupCompleted: false
  }), /corpus manual check failed/u);
  const aggregate = structuredClone(complete);
  aggregate[0].evidenceIds = ["bulk-pass"];
  assert.throws(() => buildComprehensiveCorpusManualReconciliation({
    runId: "validation-20260810111944-b648eb2f",
    files: aggregate,
    cleanupCompleted: false
  }), /aggregate evidence/u);
});

function file(number) {
  const alias = number <= 53
    ? `official-${String(number).padStart(3, "0")}`
    : `legacy-${String(number - 53).padStart(3, "0")}`;
  return {
    alias,
    family: number <= 53 ? "official" : "legacy",
    checks: Object.fromEntries([
      "manifest", "upload", "processing", "tree", "content", "generated",
      "graph", "search", "vector", "originalRead", "crud", "crossFileImpact",
      "directoryImpact", "manualUi"
    ].map((key) => [key, true])),
    evidenceIds: [`file:${alias}`]
  };
}

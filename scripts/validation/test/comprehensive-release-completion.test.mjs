import assert from "node:assert/strict";
import test from "node:test";

import { assertCompleteAuditResult } from "../lib/comprehensive-release-ledger.mjs";

function validReport() {
  const corpusFiles = Array.from({ length: 200 }, (_, index) => `corpus:${String(index + 1).padStart(3, "0")}`);
  const result = (id, value) => ({ id, status: "pass", evidenceHash: value.repeat(64) });
  return {
    schemaVersion: 1,
    runId: "validation-20260810111944-b648eb2f",
    applicationFingerprint: "app-current",
    evidenceFingerprint: "app-current",
    coverageMode: "exhaustive",
    expectedItems: ["surface:one"],
    automatedResults: [{ id: "surface:one", status: "pass", evidenceHash: "a".repeat(64) }],
    manualResults: [{ id: "surface:one", status: "pass", evidenceHash: "b".repeat(64) }],
    cleanupResults: [{ id: "surface:one", status: "pass", evidenceHash: "c".repeat(64) }],
    corpusFiles,
    corpusAutomatedResults: corpusFiles.map((id) => result(id, "d")),
    corpusManualResults: corpusFiles.map((id) => result(id, "e")),
    corpusCleanupResults: corpusFiles.map((id) => result(id, "f")),
    skipped: [],
    resources: [{ id: "validation-20260810111944-b648eb2f:kb", owned: true }],
    sanitizedEvidence: ["safe-count=1"]
  };
}

test("accepts one-to-one exhaustive automated, manual, and cleanup evidence", () => {
  assert.doesNotThrow(() => assertCompleteAuditResult(validReport()));
});

test("rejects zero-item, aggregate, sampled, stale, skipped, incomplete, private, and unowned reports", () => {
  const invalidReports = [
    { ...validReport(), expectedItems: [], automatedResults: [], manualResults: [], cleanupResults: [] },
    { ...validReport(), automatedResults: [{ status: "pass", total: 1 }] },
    { ...validReport(), coverageMode: "sampled" },
    { ...validReport(), evidenceFingerprint: "stale" },
    { ...validReport(), skipped: [{ id: "surface:one", reason: "" }] },
    { ...validReport(), manualResults: [] },
    { ...validReport(), cleanupResults: [] },
    { ...validReport(), corpusFiles: validReport().corpusFiles.slice(1) },
    { ...validReport(), sanitizedEvidence: ["Authorization: Bearer private-token"] },
    { ...validReport(), resources: [{ id: "shared-kb", owned: false }] }
  ];

  for (const report of invalidReports) {
    assert.throws(() => assertCompleteAuditResult(report));
  }
});

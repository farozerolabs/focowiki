import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  REQUIRED_CLI_OPENAPI_CASE_IDS,
  validateCliOpenApiDiagnosisReport
} from "../lib/cli-openapi-diagnosis-report.mjs";

const finalReportPath = process.env.CLI_OPENAPI_DIAGNOSIS_REPORT;

test("accepts the finalized diagnosis report", { skip: !finalReportPath }, async () => {
  const report = JSON.parse(await readFile(finalReportPath, "utf8"));
  assert.deepEqual(validateCliOpenApiDiagnosisReport(report), []);
});

test("accepts a complete scoped and redacted diagnosis", () => {
  assert.deepEqual(validateCliOpenApiDiagnosisReport(validReport()), []);
});

test("rejects missing layer evidence and unresolved fixed findings", () => {
  const report = validReport();
  report.cases[0].layers.cli = null;
  report.cases[1].category = "unresolved";
  report.cases[1].status = "fixed";
  assert.deepEqual(validateCliOpenApiDiagnosisReport(report), [
    "CLI-OPENAPI-001 is missing cli evidence",
    "CLI-OPENAPI-002 cannot be fixed while unresolved"
  ]);
});

test("rejects corpus mutation, unrelated changes, and sensitive evidence", () => {
  const report = validReport();
  report.corpusMutationCount = 1;
  report.unrelatedChangedAreas = ["worker"];
  report.summary = "Authorization: Bearer secret-token";
  assert.deepEqual(validateCliOpenApiDiagnosisReport(report), [
    "Corpus mutation is prohibited",
    "Unrelated changed areas are prohibited: worker",
    "Report contains sensitive authorization data"
  ]);
});

function validReport() {
  return {
    summary: "All original cases have an explicit conclusion.",
    corpusMutationCount: 0,
    unrelatedChangedAreas: [],
    cases: REQUIRED_CLI_OPENAPI_CASE_IDS.map((caseId) => ({
      caseId,
      category: caseId === "CLI-OPENAPI-008" ? "corpus_content" : "non_defect",
      status: "no_fix_required",
      layers: {
        openapi: { status: "passed" },
        demo: { status: "passed" },
        cli: { status: "passed" },
        skill: { status: "reviewed" }
      },
      manualReview: "completed",
      compatibility: "preserved",
      conclusion: "Recorded without unrelated changes."
    }))
  };
}

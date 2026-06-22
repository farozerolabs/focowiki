import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  applyResumeState,
  buildLargeLegalFullCoveragePlan,
  createLargeLegalFullCoverageReport,
  readLargeLegalFullCoverageConfig
} from "../large-legal-full-coverage.mjs";

test("large legal full-coverage plan uses local Focowiki and 100-file defaults", () => {
  const config = readLargeLegalFullCoverageConfig("all", {
    FOCOWIKI_VALIDATION_MARKDOWN_DIR: "/private/legal-fixtures"
  });
  const plan = buildLargeLegalFullCoveragePlan(config);

  assert.equal(config.sampleCount, 100);
  assert.equal(config.batchSampleCount, 99);
  assert.equal(config.minBatchFiles, 99);
  assert.equal(config.contentSampleCount, 25);
  assert.equal(config.requireModel, true);
  assert.deepEqual(
    plan.map((step) => step.id),
    ["sample-selection", "api-whitebox-blackbox-content"]
  );
  assert.equal(plan[0].extraEnv.FOCOWIKI_VALIDATION_REPORT_DIR, config.reportDir);
  assert.equal(plan[1].touchesConfiguredExternals, true);
});

test("large legal full-coverage plan supports sample-only dry checks", () => {
  const config = readLargeLegalFullCoverageConfig("samples", {
    FOCOWIKI_VALIDATION_REPORT_DIR: "ReferenceDocs/custom-report"
  });
  const plan = buildLargeLegalFullCoveragePlan(config);

  assert.equal(path.basename(config.reportDir), "custom-report");
  assert.deepEqual(plan.map((step) => step.id), ["sample-selection"]);
  assert.equal(plan[0].touchesConfiguredExternals, false);
});

test("large legal full-coverage report redacts source roots", () => {
  const config = readLargeLegalFullCoverageConfig("samples", {
    FOCOWIKI_VALIDATION_MARKDOWN_DIR: "/private/legal-fixtures"
  });
  const report = createLargeLegalFullCoverageReport(config, buildLargeLegalFullCoveragePlan(config));
  const serialized = JSON.stringify(report);

  assert.equal(serialized.includes("/private/legal-fixtures"), false);
  assert.equal(report.source.redactedRoot, "<FOCOWIKI_VALIDATION_MARKDOWN_DIR>");
});

test("large legal full-coverage report can reuse compatible passed steps", () => {
  const config = readLargeLegalFullCoverageConfig("all", {});
  const report = createLargeLegalFullCoverageReport(config, buildLargeLegalFullCoveragePlan(config));
  const existing = {
    ...report,
    steps: [
      {
        ...report.steps[0],
        status: "passed",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
        durationMs: 1000
      },
      report.steps[1]
    ]
  };

  applyResumeState(report, existing);

  assert.equal(report.steps[0].status, "passed");
  assert.equal(report.steps[0].durationMs, 1000);
  assert.equal(report.steps[1].status, "pending");
  assert.equal(report.checks[0].layer, "resume");
});

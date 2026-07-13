import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  ALLOW_CONFIGURED_EXTERNALS_ENV,
  ERROR_BOUNDARY_MATRIX,
  RESOURCE_EVIDENCE_MATRIX,
  applyResumeState,
  assertStepAllowed,
  buildLargeScaleFullSystemPlan,
  createLargeScaleFullSystemReport,
  readLargeScaleFullSystemConfig
} from "../lib/large-scale-full-system-validation.mjs";

test("large-scale full-system plan composes runtime and repository validation", () => {
  const config = readLargeScaleFullSystemConfig("all", {
    FOCOWIKI_LARGE_SCALE_FULL_SYSTEM_REPORT_DIR: "ReferenceDocs/test-large-system"
  });
  const plan = buildLargeScaleFullSystemPlan(config);

  assert.equal(config.sampleCount, 200);
  assert.equal(config.batchSampleCount, 199);
  assert.equal(config.minBatchFiles, 199);
  assert.equal(config.contentSampleCount, 30);
  assert.equal(path.basename(config.reportDir), "test-large-system");
  assert.deepEqual(
    plan.map((step) => step.id),
    [
      "full-flow-large-system",
      "generated-content-review",
      "validation-unit-tests",
      "openapi-contract",
      "docs-contract",
      "no-local-paths"
    ]
  );
  assert.equal(plan[0].touchesConfiguredExternals, true);
  assert.equal(plan[1].extraEnv.FOCOWIKI_VALIDATION_SAMPLE_COUNT, "200");
  assert.equal(plan[0].extraEnv.FOCOWIKI_VALIDATION_MAX_MUTATION_ENDPOINT_MS, "60000");
});

test("large-scale full-system plan command writes scope without runtime steps", () => {
  const config = readLargeScaleFullSystemConfig("plan", {});
  const plan = buildLargeScaleFullSystemPlan(config);
  const report = createLargeScaleFullSystemReport(config, plan);

  assert.deepEqual(plan, []);
  assert.equal(report.architecture.surfaces.includes("developer-openapi"), true);
  assert.equal(report.errorBoundaries.length, ERROR_BOUNDARY_MATRIX.length);
  assert.equal(report.resourceEvidence.length, RESOURCE_EVIDENCE_MATRIX.length);
});

test("large-scale full-system report redacts source roots", () => {
  const fixtureRoot = "/private/markdown-fixtures";
  const config = readLargeScaleFullSystemConfig("all", {
    FOCOWIKI_VALIDATION_MARKDOWN_DIR: fixtureRoot,
    FOCOWIKI_FULL_FLOW_INCLUDE_REPOSITORY: "false"
  });
  const report = createLargeScaleFullSystemReport(
    config,
    buildLargeScaleFullSystemPlan(config)
  );
  const serialized = JSON.stringify(report);

  assert.equal(serialized.includes(fixtureRoot), false);
  assert.equal(report.source.redactedRoot, "<FOCOWIKI_VALIDATION_MARKDOWN_DIR>");
});

test("large-scale full-system runtime steps require explicit external approval", () => {
  const blockedConfig = readLargeScaleFullSystemConfig("all", {
    FOCOWIKI_FULL_FLOW_INCLUDE_REPOSITORY: "false"
  });
  const allowedConfig = readLargeScaleFullSystemConfig("all", {
    FOCOWIKI_FULL_FLOW_INCLUDE_REPOSITORY: "false",
    [ALLOW_CONFIGURED_EXTERNALS_ENV]: "true"
  });
  const [runtimeStep] = buildLargeScaleFullSystemPlan(blockedConfig);

  assert.throws(() => assertStepAllowed(runtimeStep, blockedConfig), /is required/);
  assert.doesNotThrow(() => assertStepAllowed(runtimeStep, allowedConfig));
});

test("large-scale full-system report can reuse compatible passed steps", () => {
  const config = readLargeScaleFullSystemConfig("all", {
    FOCOWIKI_FULL_FLOW_INCLUDE_REPOSITORY: "false"
  });
  const report = createLargeScaleFullSystemReport(
    config,
    buildLargeScaleFullSystemPlan(config)
  );
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
  assert.equal(report.checks.some((check) => check.layer === "resume"), true);
});

test("large-scale full-system config can disable error boundary expansion", () => {
  const config = readLargeScaleFullSystemConfig("all", {
    FOCOWIKI_LARGE_SCALE_INCLUDE_ERROR_BOUNDARIES: "false",
    FOCOWIKI_FULL_FLOW_INCLUDE_REPOSITORY: "false"
  });
  const report = createLargeScaleFullSystemReport(
    config,
    buildLargeScaleFullSystemPlan(config)
  );

  assert.deepEqual(report.errorBoundaries, []);
});

test("large-scale full-system config rejects unknown commands", () => {
  assert.throws(
    () => readLargeScaleFullSystemConfig("unknown"),
    /must be all or plan/
  );
});

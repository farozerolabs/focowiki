import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildFullFlowPlan,
  createFullFlowReport,
  readFullFlowConfig
} from "../full-flow-e2e.mjs";
import {
  buildFullCodebaseValidationMatrix,
  summarizeFullCodebaseMatrix
} from "../lib/full-codebase-validation.mjs";

test("full-flow plan composes bounded API validation without optional layers", () => {
  const config = readFullFlowConfig("all", {
    FOCOWIKI_FULL_FLOW_INCLUDE_BROWSER: "false",
    FOCOWIKI_FULL_FLOW_INCLUDE_REPOSITORY: "false"
  });

  const plan = buildFullFlowPlan(config);

  assert.deepEqual(
    plan.map((step) => step.id),
    ["sample-selection", "api-whitebox-blackbox"]
  );
  assert.deepEqual(plan[0].args, ["scripts/validation/cleaned-markdown-flow.mjs", "samples"]);
  assert.deepEqual(plan[1].args, ["scripts/validation/cleaned-markdown-flow.mjs", "api"]);
});

test("full-flow plan names codebase regression commands explicitly", () => {
  const config = readFullFlowConfig("all", {
    FOCOWIKI_FULL_FLOW_INCLUDE_BROWSER: "false",
    FOCOWIKI_FULL_FLOW_INCLUDE_DOCKER: "false"
  });
  const plan = buildFullFlowPlan(config);

  assert.deepEqual(
    plan.map((step) => step.id),
    [
      "sample-selection",
      "api-whitebox-blackbox",
      "workspace-typecheck",
      "workspace-test",
      "workspace-build",
      "validation-unit-tests",
      "openapi-contract",
      "docs-contract",
      "api-runtime-build",
      "no-local-paths"
    ]
  );
});

test("full-flow plan command generates matrix without runtime steps", () => {
  const config = readFullFlowConfig("plan", {
    FOCOWIKI_FULL_FLOW_RUN_ID: "validation-plan-run",
    FOCOWIKI_FULL_FLOW_INCLUDE_BROWSER: "false",
    FOCOWIKI_FULL_FLOW_INCLUDE_REPOSITORY: "true",
    FOCOWIKI_FULL_FLOW_INCLUDE_DOCKER: "true"
  });
  const plan = buildFullFlowPlan(config);
  const report = createFullFlowReport(config, plan);

  assert.deepEqual(plan, []);
  assert.equal(report.runId, "validation-plan-run");
  assert.equal(report.matrixSummary.surfaceCount >= 15, true);
});

test("full-flow config rejects unknown commands", () => {
  assert.throws(() => readFullFlowConfig("unknown"), /Unknown full-flow validation command/);
});

test("full-flow plan keeps Docker checks optional", () => {
  const disabled = readFullFlowConfig("all", {
    FOCOWIKI_FULL_FLOW_INCLUDE_BROWSER: "false",
    FOCOWIKI_FULL_FLOW_INCLUDE_REPOSITORY: "false",
    FOCOWIKI_FULL_FLOW_INCLUDE_DOCKER: "false"
  });
  const enabled = readFullFlowConfig("all", {
    FOCOWIKI_FULL_FLOW_INCLUDE_BROWSER: "false",
    FOCOWIKI_FULL_FLOW_INCLUDE_REPOSITORY: "false",
    FOCOWIKI_FULL_FLOW_INCLUDE_DOCKER: "true"
  });

  assert.equal(buildFullFlowPlan(disabled).some((step) => step.id.startsWith("compose-")), false);
  assert.deepEqual(
    buildFullFlowPlan(enabled).map((step) => step.id),
    ["sample-selection", "api-whitebox-blackbox", "compose-example-config", "compose-dev-example-config", "compose-local-example-config"]
  );
});

test("full-flow plan switches to large profile commands without reading fixture bodies", () => {
  const config = readFullFlowConfig("large", {
    FOCOWIKI_FULL_FLOW_INCLUDE_BROWSER: "true",
    FOCOWIKI_FULL_FLOW_INCLUDE_REPOSITORY: "false"
  });

  const plan = buildFullFlowPlan(config);

  assert.equal(config.largeProfile, true);
  assert.deepEqual(
    plan.map((step) => step.args.at(-1)),
    ["large-samples", "large-api", "large-browser"]
  );
  assert.equal(plan[1].extraEnv.FOCOWIKI_VALIDATION_MAX_ENDPOINT_MS, "10000");
});

test("full-flow report stores only redacted runtime source hints", () => {
  const fixtureRoot = "private-fixtures-root";
  const config = readFullFlowConfig("all", {
    FOCOWIKI_VALIDATION_MARKDOWN_DIR: fixtureRoot,
    FOCOWIKI_FULL_FLOW_INCLUDE_BROWSER: "false",
    FOCOWIKI_FULL_FLOW_INCLUDE_REPOSITORY: "false"
  });
  const report = createFullFlowReport(config, buildFullFlowPlan(config));
  const serialized = JSON.stringify(report);

  assert.equal(serialized.includes(fixtureRoot), false);
  assert.equal(report.source.redactedRoot, "<FOCOWIKI_VALIDATION_MARKDOWN_DIR>");
});

test("full-flow report records run id, local-only report dir, and full codebase matrix", () => {
  const config = readFullFlowConfig("all", {
    FOCOWIKI_FULL_FLOW_RUN_ID: "validation-test-run",
    FOCOWIKI_FULL_FLOW_REPORT_DIR: "ReferenceDocs/test-full-codebase",
    FOCOWIKI_FULL_FLOW_INCLUDE_BROWSER: "false",
    FOCOWIKI_FULL_FLOW_INCLUDE_REPOSITORY: "false"
  });
  const report = createFullFlowReport(config, buildFullFlowPlan(config));
  const surfaceIds = report.matrix.map((surface) => surface.id);

  assert.equal(config.runId, "validation-test-run");
  assert.equal(path.basename(config.reportDir), "test-full-codebase");
  assert.equal(report.runId, "validation-test-run");
  assert.equal(surfaceIds.includes("admin-ui"), true);
  assert.equal(surfaceIds.includes("developer-openapi"), true);
  assert.equal(surfaceIds.includes("worker-queues"), true);
  assert.equal(surfaceIds.includes("s3-storage"), true);
  assert.equal(surfaceIds.includes("docs-openapi"), true);
});

test("full-codebase matrix marks optional local prerequisites without dropping surfaces", () => {
  const matrix = buildFullCodebaseValidationMatrix({
    includeBrowser: false,
    includeDocker: false
  });
  const summary = summarizeFullCodebaseMatrix(matrix);
  const adminUi = matrix.find((surface) => surface.id === "admin-ui");
  const runtimePackaging = matrix.find((surface) => surface.id === "runtime-packaging");

  assert.equal(summary.surfaceCount >= 15, true);
  assert.equal(adminUi.executable, "browser-optional");
  assert.equal(runtimePackaging.executable, "docker-optional");
});

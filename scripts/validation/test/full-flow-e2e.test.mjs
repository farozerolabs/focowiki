import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildFullFlowPlan,
  createFullFlowReport,
  readFullFlowConfig
} from "../full-flow-e2e.mjs";

const DEMO_REPO_ENV = "FOCOWIKI_DEMO_E2E_DEMO_REPO";

test("full-flow plan composes bounded API validation without optional layers", () => {
  const demoRepo = path.join(os.tmpdir(), "missing-focowiki-demo-repo");
  const config = readFullFlowConfig("all", {
    [DEMO_REPO_ENV]: demoRepo,
    FOCOWIKI_FULL_FLOW_INCLUDE_BROWSER: "false",
    FOCOWIKI_FULL_FLOW_INCLUDE_DEMO: "false",
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

test("full-flow plan switches to large profile commands without reading fixture bodies", () => {
  const demoRepo = path.join(os.tmpdir(), "missing-focowiki-demo-repo");
  const config = readFullFlowConfig("large", {
    [DEMO_REPO_ENV]: demoRepo,
    FOCOWIKI_FULL_FLOW_INCLUDE_BROWSER: "true",
    FOCOWIKI_FULL_FLOW_INCLUDE_DEMO: "false",
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

test("full-flow plan enables demo validation when the demo repository is available", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "focowiki-demo-plan-"));
  fs.writeFileSync(path.join(root, "package.json"), "{}\n");

  try {
    const config = readFullFlowConfig("all", {
      [DEMO_REPO_ENV]: root,
      FOCOWIKI_FULL_FLOW_INCLUDE_BROWSER: "false",
      FOCOWIKI_FULL_FLOW_INCLUDE_REPOSITORY: "false"
    });
    const plan = buildFullFlowPlan(config);

    assert.equal(config.includeDemo, true);
    assert.equal(plan.some((step) => step.id === "demo-agent-e2e"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("full-flow report stores only redacted runtime source hints", () => {
  const fixtureRoot = "private-fixtures-root";
  const config = readFullFlowConfig("all", {
    FOCOWIKI_VALIDATION_MARKDOWN_DIR: fixtureRoot,
    FOCOWIKI_FULL_FLOW_INCLUDE_BROWSER: "false",
    FOCOWIKI_FULL_FLOW_INCLUDE_DEMO: "false",
    FOCOWIKI_FULL_FLOW_INCLUDE_REPOSITORY: "false"
  });
  const report = createFullFlowReport(config, buildFullFlowPlan(config));
  const serialized = JSON.stringify(report);

  assert.equal(serialized.includes(fixtureRoot), false);
  assert.equal(report.source.redactedRoot, "<FOCOWIKI_VALIDATION_MARKDOWN_DIR>");
});

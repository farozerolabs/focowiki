import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { readDemoAgentE2eConfig } from "../lib/demo-agent-e2e-config.mjs";

test("demo Agent E2E config supports current validation change id override", () => {
  const config = readDemoAgentE2eConfig({
    FOCOWIKI_DEMO_E2E_CHANGE_ID: "validate-current-e2e-full-flow",
    FOCOWIKI_DEMO_E2E_DEMO_REPO: "../focowiki-demo"
  });

  assert.equal(config.changeId, "validate-current-e2e-full-flow");
  assert.equal(
    config.changeDir,
    path.resolve("openspec/changes", "validate-current-e2e-full-flow")
  );
  assert.equal(
    config.demoLogDir,
    path.resolve("openspec/changes", "validate-current-e2e-full-flow", "runtime/demo-logs")
  );
});

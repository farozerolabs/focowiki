import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFullSystemPlan,
  readFullSystemConfig
} from "../lib/full-system-plan.mjs";

test("full-system plan separates baseline from external runtime stages", () => {
  const config = readFullSystemConfig("all", {
    FOCOWIKI_FULL_SYSTEM_INCLUDE_BROWSER: "true",
    FOCOWIKI_FULL_SYSTEM_INCLUDE_DOCKER: "true",
    FOCOWIKI_FULL_SYSTEM_ALLOW_CONFIGURED_EXTERNALS: "false"
  });
  const plan = buildFullSystemPlan(config);

  assert.equal(plan[0].id, "coverage-manifest");
  assert.ok(plan.some((step) => step.id === "workspace-tests"));
  assert.ok(plan.some((step) => step.id === "openapi-contract"));
  assert.ok(plan.some((step) => step.id === "admin-ui-browser"));
  const databaseStep = plan.find((step) => step.id === "incremental-database");
  assert.ok(databaseStep);
  assert.match(databaseStep.safeCommand, /publication-generation-repository\.integration\.test\.ts/);
  assert.doesNotMatch(databaseStep.safeCommand, /large-nested-scale|release/i);
  assert.ok(plan.filter((step) => step.touchesConfiguredExternals).length >= 3);
});

test("defaults validation evidence to the current incremental publication change", () => {
  const config = readFullSystemConfig("plan", {});

  assert.equal(config.changeId, "implement-incremental-sharded-publication");
  assert.match(config.reportDir, /implement-incremental-sharded-publication$/);
});

test("baseline command excludes configured external stages", () => {
  const plan = buildFullSystemPlan(readFullSystemConfig("baseline", {}));

  assert.ok(plan.length > 5);
  assert.equal(plan.some((step) => step.touchesConfiguredExternals), false);
});

test("runtime execution requires explicit configured-external approval", () => {
  const config = readFullSystemConfig("runtime", {
    FOCOWIKI_FULL_SYSTEM_ALLOW_CONFIGURED_EXTERNALS: "false"
  });
  const externalStep = buildFullSystemPlan(config).find(
    (step) => step.touchesConfiguredExternals
  );

  assert.ok(externalStep);
  assert.throws(() => externalStep.assertAllowed(config), /explicit approval/i);
});

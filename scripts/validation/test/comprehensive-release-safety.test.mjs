import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPREHENSIVE_CLEANUP_ORDER,
  COMPREHENSIVE_COMPATIBILITY_BOUNDARIES,
  COMPREHENSIVE_BEFORE_STATE_FIELDS,
  COMPREHENSIVE_INTERRUPTION_POLICY,
  assertCompatibilityChange,
  assertNoScopeCollisions,
  buildOwnedCleanupPlan,
  createComprehensiveValidationScope
} from "../lib/comprehensive-release-safety.mjs";

const runId = "validation-20260810111944-b648eb2f";

test("freezes released compatibility boundaries", () => {
  assert.deepEqual(COMPREHENSIVE_COMPATIBILITY_BOUNDARIES.allowedReasons, [
    "reproduced-compatible-defect-fix",
    "validation-tooling"
  ]);
  assert.ok(COMPREHENSIVE_COMPATIBILITY_BOUNDARIES.frozen.includes("ui-style"));
  assert.ok(COMPREHENSIVE_COMPATIBILITY_BOUNDARIES.frozen.includes("generated-logical-topology"));

  assert.doesNotThrow(() =>
    assertCompatibilityChange({ reason: "validation-tooling", changedBoundaries: [] })
  );
  assert.throws(
    () =>
      assertCompatibilityChange({
        reason: "reproduced-compatible-defect-fix",
        changedBoundaries: ["ui-style"]
      }),
    /Frozen compatibility boundary/u
  );
  assert.throws(
    () => assertCompatibilityChange({ reason: "feature", changedBoundaries: [] }),
    /Unauthorized validation change reason/u
  );
});

test("creates an exact run-owned namespace and rejects collisions", () => {
  const scope = createComprehensiveValidationScope({
    runId,
    storagePrefix: "focowiki-local-audit"
  });

  assert.match(scope.dockerProjectName, /20260810111944-b648eb2f/u);
  assert.match(scope.searchIndexPrefix, /20260810111944-b648eb2f/u);
  assert.match(scope.reportDirectory, /comprehensive-large-scale-release/u);
  assert.doesNotThrow(() => assertNoScopeCollisions(scope, { namespaces: [] }));
  assert.throws(
    () => assertNoScopeCollisions(scope, { namespaces: [scope.dockerProjectName] }),
    /collision/u
  );
});

test("defines complete before-state and interruption recovery policies", () => {
  assert.deepEqual(COMPREHENSIVE_BEFORE_STATE_FIELDS, [
    "git",
    "database",
    "redis",
    "s3",
    "search",
    "docker",
    "processes",
    "temporaryPaths"
  ]);
  assert.equal(COMPREHENSIVE_INTERRUPTION_POLICY.resumeRequiresMatchingFingerprints, true);
  assert.equal(COMPREHENSIVE_INTERRUPTION_POLICY.registerBeforeReference, true);
  assert.equal(COMPREHENSIVE_INTERRUPTION_POLICY.cleanupOrder, "reverse-dependency");
  assert.equal(COMPREHENSIVE_INTERRUPTION_POLICY.staleEvidence, "invalidate");
});

test("builds reverse dependency cleanup only from registered exact resources", () => {
  const scope = createComprehensiveValidationScope({
    runId,
    storagePrefix: "focowiki-local-audit"
  });
  const plan = buildOwnedCleanupPlan(scope, [
    { kind: "temporaryRepositories", id: `${runId}:okf` },
    { kind: "knowledgeBases", id: `${runId}:kb-1` },
    { kind: "providerIndexes", id: `${runId}:index-1` }
  ]);

  assert.deepEqual(
    plan.map((item) => item.kind),
    ["knowledgeBases", "providerIndexes", "temporaryRepositories"]
  );
  assert.equal(COMPREHENSIVE_CLEANUP_ORDER.at(-1), "validationSecrets");
  assert.throws(
    () =>
      buildOwnedCleanupPlan(scope, [
        { kind: "knowledgeBases", id: "shared-kb" }
      ]),
    /not owned/u
  );
});

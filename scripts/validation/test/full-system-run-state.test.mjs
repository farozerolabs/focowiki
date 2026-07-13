import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCleanupTargetOwned,
  assertSafeValidationCommand,
  createFullSystemRunState,
  createOperationCoverageTracker,
  markOperationCovered,
  summarizeOperationCoverage
} from "../lib/full-system-run-state.mjs";

test("tracks only exact validation-owned resources", () => {
  const state = createFullSystemRunState("full-system-e2e-20260713-a1b2c3");
  state.owned.knowledgeBases.push("kb-validation-1");
  state.owned.redisKeys.push("focowiki:validation:full-system-e2e-20260713-a1b2c3:cursor");
  state.owned.s3Prefixes.push(
    "dev/validation/full-system-e2e-20260713-a1b2c3/knowledge-bases/kb-validation-1"
  );

  assert.doesNotThrow(() =>
    assertCleanupTargetOwned(state, "knowledgeBases", "kb-validation-1")
  );
  assert.throws(
    () => assertCleanupTargetOwned(state, "knowledgeBases", "kb-existing"),
    /not owned by validation run/
  );
});

test("rejects destructive shared-environment commands", () => {
  for (const command of [
    "DROP SCHEMA focowiki CASCADE",
    "TRUNCATE focowiki.knowledge_bases",
    "redis-cli FLUSHALL",
    "aws s3 rm s3://bucket --recursive",
    "docker compose down --volumes"
  ]) {
    assert.throws(() => assertSafeValidationCommand(command), /unsafe validation command/i);
  }

  assert.doesNotThrow(() =>
    assertSafeValidationCommand(
      "DELETE /admin/api/knowledge-bases/kb-validation-owned"
    )
  );
});

test("operation coverage tracker reports missing operations without secrets", () => {
  const tracker = createOperationCoverageTracker(["health", "list", "delete"]);
  markOperationCovered(tracker, "health", { status: 200, requestId: "request-safe" });
  markOperationCovered(tracker, "list", {
    status: 200,
    authorization: "Bearer must-not-survive"
  });

  const summary = summarizeOperationCoverage(tracker);
  assert.deepEqual(summary.missing, ["delete"]);
  assert.equal(summary.coveredCount, 2);
  assert.doesNotMatch(JSON.stringify(summary), /must-not-survive/);
});

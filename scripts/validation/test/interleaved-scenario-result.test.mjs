import assert from "node:assert/strict";
import test from "node:test";
import {
  buildScenarioFailure
} from "../lib/interleaved-scenario-result.mjs";

test("records a bounded safe failure without a stack or local path", () => {
  const error = new Error(
    "Handoff validation failed in /validation-workspace/private/repository/file.mjs."
  );
  error.code = "HANDOFF_ASSERTION_FAILED";
  error.stack = "private stack";

  assert.deepEqual(
    buildScenarioFailure(error, {
      workspacePath: "/validation-workspace/private/repository"
    }),
    {
      errorCode: "HANDOFF_ASSERTION_FAILED",
      errorMessage: "Handoff validation failed in <workspace>/file.mjs."
    }
  );
});

test("bounds unknown error text and uses a stable fallback code", () => {
  const failure = buildScenarioFailure(new Error("x".repeat(800)));

  assert.equal(failure.errorCode, "SCENARIO_FAILED");
  assert.equal(failure.errorMessage.length, 500);
});

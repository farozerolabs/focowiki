import assert from "node:assert/strict";
import test from "node:test";
import {
  readSourceFilePollingPlan,
  readValidationTaskTimeoutMs
} from "../cleaned-markdown-flow.mjs";

test("validation task timeout scales without env-based model configuration", () => {
  assert.equal(readValidationTaskTimeoutMs({}, 100), 12_180_000);
});

test("validation task timeout keeps explicit override", () => {
  assert.equal(
    readValidationTaskTimeoutMs(
      {
        FOCOWIKI_VALIDATION_TASK_TIMEOUT_MS: "240000"
      },
      51
    ),
    240_000
  );
});

test("polls a 200-file batch with one bounded page at a reduced frequency", () => {
  assert.deepEqual(readSourceFilePollingPlan(1), {
    pageSize: 50,
    intervalMs: 1_000
  });
  assert.deepEqual(readSourceFilePollingPlan(199), {
    pageSize: 199,
    intervalMs: 5_000
  });
  assert.deepEqual(readSourceFilePollingPlan(200), {
    pageSize: 200,
    intervalMs: 5_000
  });
});

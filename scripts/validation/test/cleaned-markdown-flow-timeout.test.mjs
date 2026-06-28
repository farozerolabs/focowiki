import assert from "node:assert/strict";
import test from "node:test";
import { readValidationTaskTimeoutMs } from "../cleaned-markdown-flow.mjs";

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

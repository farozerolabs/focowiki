import assert from "node:assert/strict";
import test from "node:test";
import { readValidationTaskTimeoutMs } from "../cleaned-markdown-flow.mjs";

test("validation task timeout scales for large no-model source-file batches", () => {
  assert.equal(
    readValidationTaskTimeoutMs(
      {
        MODEL_API_KEY: "",
        MODEL_NAME: ""
      },
      51
    ),
    3_240_000
  );
});

test("validation task timeout keeps explicit override", () => {
  assert.equal(
    readValidationTaskTimeoutMs(
      {
        FOCOWIKI_VALIDATION_TASK_TIMEOUT_MS: "240000",
        MODEL_API_KEY: "",
        MODEL_NAME: ""
      },
      51
    ),
    240_000
  );
});

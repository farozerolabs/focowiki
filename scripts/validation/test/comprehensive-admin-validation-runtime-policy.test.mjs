import assert from "node:assert/strict";
import test from "node:test";

import {
  createAdminValidationRuntimePolicy
} from "../lib/comprehensive-admin-validation-runtime-policy.mjs";

test("temporarily shortens only publication and retry waits for exhaustive Admin validation", () => {
  const current = {
    publication: {
      mode: "batch",
      intervalSeconds: 300,
      roleConcurrency: 1,
      claimBatchSize: 1
    },
    worker: {
      pollIntervalMs: 1000,
      jobRetryDelayMs: 30000,
      hardDeleteRetryDelayMs: 60000,
      sourceFileConcurrency: 2
    }
  };

  const policy = createAdminValidationRuntimePolicy(current);

  assert.deepEqual(policy.original, current);
  assert.deepEqual(policy.validation.publication, {
    ...current.publication,
    intervalSeconds: 5
  });
  assert.deepEqual(policy.validation.worker, {
    ...current.worker,
    jobRetryDelayMs: 100,
    hardDeleteRetryDelayMs: 100
  });
  assert.notEqual(policy.original.publication, current.publication);
  assert.notEqual(policy.original.worker, current.worker);
});

test("rejects missing runtime sections instead of applying partial policy", () => {
  assert.throws(
    () => createAdminValidationRuntimePolicy({ publication: {}, worker: null }),
    /Admin validation runtime settings are incomplete/u
  );
});

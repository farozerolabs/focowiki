import assert from "node:assert/strict";
import test from "node:test";
import {
  createIsolatedValidationScope,
  validateIsolatedValidationScope
} from "../lib/isolated-scope.mjs";

const runId = "validation-20260712103000-1234abcd";

test("creates isolated database, Redis, S3, and public resource scopes", () => {
  const scope = createIsolatedValidationScope({
    runId,
    storagePrefix: "test-suite"
  });

  assert.deepEqual(scope, {
    runId,
    databaseName: "focowiki_validation_20260712103000_1234abcd",
    redisPrefix: `focowiki:validation:${runId}:`,
    storagePrefix: `test-suite/validation/${runId}/`,
    adminUsername: `validation-admin-${runId}`,
    openApiKeyName: `validation-key-${runId}`,
    knowledgeBasePrefix: `validation-${runId}`
  });
  assert.doesNotThrow(() => validateIsolatedValidationScope(scope));
});

test("rejects empty, shared, production-like, and mismatched cleanup scopes", () => {
  const valid = createIsolatedValidationScope({ runId, storagePrefix: "test-suite" });
  const invalidScopes = [
    { ...valid, runId: "" },
    { ...valid, databaseName: "focowiki" },
    { ...valid, redisPrefix: "focowiki:" },
    { ...valid, storagePrefix: "production/" },
    { ...valid, storagePrefix: "test-suite/validation/another-run/" },
    { ...valid, knowledgeBasePrefix: "shared" }
  ];

  for (const scope of invalidScopes) {
    assert.throws(() => validateIsolatedValidationScope(scope));
  }
});

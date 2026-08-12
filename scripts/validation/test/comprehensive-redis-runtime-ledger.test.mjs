import assert from "node:assert/strict";
import test from "node:test";

import {
  expectedComprehensiveRedisResponsibilities,
  validateComprehensiveRedisRuntimeLedger
} from "../lib/comprehensive-redis-runtime-ledger.mjs";

function validInput() {
  return {
    rows: expectedComprehensiveRedisResponsibilities().map((responsibility) => ({
      responsibility,
      keyCount: 1,
      types: ["string"],
      minimumTtlSeconds: 30,
      maximumTtlSeconds: 30,
      expectedMaximumTtlSeconds: 60,
      memoryBytes: 72,
      latencyMs: 1,
      recoveryConfirmed: true,
      cleanupConfirmed: true,
      automatedStatus: "pass",
      manualStatus: "pass"
    })),
    existingKeys: [{
      keyFingerprintSha256: "a".repeat(64),
      type: "string",
      ttlSeconds: 30,
      memoryBytes: 72
    }]
  };
}

test("requires every Redis responsibility and bounded private evidence", () => {
  const result = validateComprehensiveRedisRuntimeLedger(validInput());

  assert.equal(result.ok, true);
  assert.equal(result.expectedResponsibilityCount, 14);
  assert.equal(result.observedResponsibilityCount, 14);
});

test("fails closed for missing, unbounded, uncleaned, or private rows", () => {
  const input = validInput();
  input.rows.shift();
  input.rows[0].maximumTtlSeconds = -1;
  input.rows[1].cleanupConfirmed = false;
  input.existingKeys[0].rawValue = "private";

  const result = validateComprehensiveRedisRuntimeLedger(input);

  assert.equal(result.ok, false);
  assert.ok(result.failures.some((failure) => failure.startsWith("missing:")));
  assert.ok(result.failures.some((failure) => failure.endsWith(":ttl")));
  assert.ok(result.failures.some((failure) => failure.endsWith(":cleanup")));
  assert.ok(result.failures.includes("private-material"));
});

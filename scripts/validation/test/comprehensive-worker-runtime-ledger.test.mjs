import assert from "node:assert/strict";
import test from "node:test";

import { reconcileComprehensiveWorkerRuntime } from
  "../lib/comprehensive-worker-runtime-ledger.mjs";

function stage(overrides = {}) {
  return {
    identity: "stage-one",
    stageKind: "extraction",
    state: "completed",
    attemptCount: 1,
    maximumAttempts: 5,
    leaseOwner: null,
    leaseExpiresAt: null,
    safeErrorCode: null,
    completedAt: "2026-08-11T01:00:00.000Z",
    ...overrides
  };
}

function input(overrides = {}) {
  return {
    observedAt: "2026-08-11T02:00:00.000Z",
    expectedStages: ["cleanup", "extraction"],
    stageEvidence: [{ stageKind: "cleanup", pass: true }],
    stageItems: [stage()],
    operationItems: [],
    dirtyItems: [{
      identity: "dirty-one",
      reasonKind: "source_changed",
      state: "completed",
      attemptCount: 1,
      maximumAttempts: 5,
      leaseOwner: null,
      leaseExpiresAt: null,
      safeErrorCode: null,
      completedAt: "2026-08-11T01:00:00.000Z"
    }],
    cleanupItems: [{
      identity: "cleanup-one",
      actionKind: "provider_adoption",
      state: "queued",
      attemptCount: 0,
      required: false,
      notBefore: "2026-08-18T00:00:00.000Z",
      leaseOwner: null,
      leaseExpiresAt: null
    }],
    webhookItems: [],
    ...overrides
  };
}

test("reconciles every terminal worker item and bounded retention action", () => {
  const result = reconcileComprehensiveWorkerRuntime(input());
  assert.equal(result.ok, true);
  assert.deepEqual(result.counts, {
    semanticStages: 1,
    operationWork: 0,
    dirtyPartitions: 1,
    cleanupActions: 1,
    webhookDeliveries: 0,
    live: 0,
    leased: 0,
    failed: 0,
    cancelled: 0,
    boundedRetention: 1
  });
});

test("rejects missing stages, live work, retained leases, and unsafe failures", () => {
  assert.throws(() => reconcileComprehensiveWorkerRuntime(input({
    stageEvidence: []
  })), /stage coverage/u);
  assert.throws(() => reconcileComprehensiveWorkerRuntime(input({
    stageItems: [stage({ state: "running", completedAt: null })]
  })), /not terminal/u);
  assert.throws(() => reconcileComprehensiveWorkerRuntime(input({
    stageItems: [stage({ leaseOwner: "worker-one" })]
  })), /retains a lease/u);
  assert.throws(() => reconcileComprehensiveWorkerRuntime(input({
    stageItems: [stage({ state: "failed", safeErrorCode: null })]
  })), /safe error/u);
});

test("rejects unbounded queued cleanup and undrained operation work", () => {
  assert.throws(() => reconcileComprehensiveWorkerRuntime(input({
    cleanupItems: [{
      identity: "cleanup-one",
      actionKind: "provider_adoption",
      state: "queued",
      attemptCount: 0,
      required: false,
      notBefore: "2026-08-11T01:00:00.000Z",
      leaseOwner: null,
      leaseExpiresAt: null
    }]
  })), /bounded retention/u);
  assert.throws(() => reconcileComprehensiveWorkerRuntime(input({
    operationItems: [{
      identity: "operation-one",
      workKind: "publication",
      state: "completed",
      attemptCount: 1,
      leaseOwner: null,
      leaseExpiresAt: null,
      safeErrorCode: null,
      completedAt: "2026-08-11T01:00:00.000Z"
    }]
  })), /did not drain/u);
});

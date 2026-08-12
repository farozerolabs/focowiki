import assert from "node:assert/strict";
import test from "node:test";

import {
  summarizeComprehensiveOpenApiPerformance
} from "../lib/comprehensive-openapi-performance.mjs";

const document = {
  paths: {
    "/openapi/v2/health": {
      get: { operationId: "getHealth" }
    },
    "/openapi/v2/items": {
      post: { operationId: "createItem" }
    }
  }
};

test("requires cold, warm, and concurrent evidence for every operation", () => {
  const report = summarizeComprehensiveOpenApiPerformance({
    document,
    coldReport: lifecycleReport("cold", [20, 30]),
    warmReport: lifecycleReport("warm", [10, 15]),
    concurrentReports: [
      lifecycleReport("concurrent", [12, 18], {
        startedAt: "2026-08-12T00:00:00.000Z",
        finishedAt: "2026-08-12T00:00:01.000Z"
      }),
      lifecycleReport("concurrent", [14, 16], {
        startedAt: "2026-08-12T00:00:00.100Z",
        finishedAt: "2026-08-12T00:00:00.900Z"
      })
    ]
  });

  assert.equal(report.ok, true);
  assert.equal(report.operationCount, 2);
  assert.equal(report.completedOperationCount, 2);
  assert.deepEqual(report.missing, []);
  const health = report.operations.find((operation) =>
    operation.operationId === "getHealth");
  assert.equal(health.cold.count, 1);
  assert.equal(health.warm.p95Ms, 10);
  assert.equal(health.concurrent.count, 2);
  assert.equal(health.concurrent.throughputPerSecond, 2);
});

test("rejects a missing operation phase instead of substituting another route", () => {
  const concurrent = lifecycleReport("concurrent", [12, 18]);
  concurrent.operationCoverage.operations = concurrent.operationCoverage.operations
    .filter((operation) => operation.operationId !== "createItem");

  assert.throws(() => summarizeComprehensiveOpenApiPerformance({
    document,
    coldReport: lifecycleReport("cold", [20, 30]),
    warmReport: lifecycleReport("warm", [10, 15]),
    concurrentReports: [concurrent]
  }), /createItem:concurrent/u);
});

function lifecycleReport(phase, durations, overrides = {}) {
  const operations = [
    { operationId: "getHealth", method: "GET", path: "/openapi/v2/health" },
    { operationId: "createItem", method: "POST", path: "/openapi/v2/items" }
  ].map((operation, index) => ({
    ...operation,
    performance: {
      cold: phase === "cold" ? performancePhase(durations[index]) : null,
      warm: phase === "warm" ? performancePhase(durations[index]) : null,
      concurrent: phase === "concurrent" ? performancePhase(durations[index]) : null
    }
  }));
  return {
    ok: true,
    startedAt: overrides.startedAt ?? "2026-08-12T00:00:00.000Z",
    finishedAt: overrides.finishedAt ?? "2026-08-12T00:00:01.000Z",
    operationCoverage: { operationCount: 2, complete: true, operations }
  };
}

function performancePhase(durationMs) {
  return {
    count: 1,
    p50Ms: durationMs,
    p90Ms: durationMs,
    p95Ms: durationMs,
    p99Ms: durationMs,
    maxMs: durationMs,
    throughputPerSecond: 1,
    errorRate: 0,
    samples: [{ status: 200, durationMs, measurementWindowMs: null }]
  };
}

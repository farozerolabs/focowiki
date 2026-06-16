import test from "node:test";
import assert from "node:assert/strict";

import {
  createPerformanceEvidence,
  finalizePerformanceEvidence,
  recordEndpointTiming,
  recordPaginationEvidence,
  recordTaskDuration
} from "../lib/performance-evidence.mjs";

test("performance evidence enforces large-scale batch size and records bounded metrics", () => {
  const evidence = createPerformanceEvidence({
    FOCOWIKI_VALIDATION_MAX_ENDPOINT_MS: "100",
    FOCOWIKI_VALIDATION_MAX_TASK_DURATION_MS: "10000",
    FOCOWIKI_VALIDATION_MAX_MEMORY_DELTA_MB: "512"
  });

  recordEndpointTiming(evidence, {
    method: "GET",
    pathname: "/admin/api/knowledge-bases/kb-secret-id/files/tree?cursor=opaque",
    status: 200,
    durationMs: 25
  });
  recordTaskDuration(evidence, {
    id: "task-secret-id",
    startedAt: "2026-06-16T00:00:00.000Z",
    endedAt: "2026-06-16T00:00:05.000Z"
  });
  recordPaginationEvidence(evidence, "task-source-pagination", {
    expectedSourceCount: 50,
    observedPages: 2
  });

  const summary = finalizePerformanceEvidence(evidence, {
    profile: "large-scale",
    batchSampleCount: 50,
    largeScaleMinBatchFiles: 50
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.endpointTimings.count, 1);
  assert.equal(summary.taskDurations.count, 1);
  assert.equal(summary.pagination.length, 1);
  assert.equal(JSON.stringify(summary).includes("kb-secret-id"), false);
  assert.equal(JSON.stringify(summary).includes("task-secret-id"), false);
});

test("performance evidence fails large-scale runs below the configured batch minimum", () => {
  const evidence = createPerformanceEvidence({});

  assert.throws(
    () =>
      finalizePerformanceEvidence(evidence, {
        profile: "large-scale",
        batchSampleCount: 49,
        largeScaleMinBatchFiles: 50
      }),
    /Large-scale validation requires at least 50 batch files/
  );
});

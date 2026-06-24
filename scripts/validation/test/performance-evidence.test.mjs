import test from "node:test";
import assert from "node:assert/strict";

import {
  createPerformanceEvidence,
  finalizePerformanceEvidence,
  recordEndpointTiming,
  recordOperationalSnapshot,
  recordPaginationEvidence,
  recordSourceFileDuration
} from "../lib/performance-evidence.mjs";

test("performance evidence uses separate read and mutation endpoint budgets by default", () => {
  const evidence = createPerformanceEvidence({});

  assert.equal(evidence.budgets.maxEndpointMs, 5000);
  assert.equal(evidence.budgets.maxMutationEndpointMs, 30000);
});

test("performance evidence enforces large-scale batch size and records bounded metrics", () => {
  const evidence = createPerformanceEvidence({
    FOCOWIKI_VALIDATION_MAX_ENDPOINT_MS: "100",
    FOCOWIKI_VALIDATION_MAX_SOURCE_FILE_DURATION_MS: "10000",
    FOCOWIKI_VALIDATION_MAX_MEMORY_DELTA_MB: "512"
  });

  recordEndpointTiming(evidence, {
    method: "GET",
    pathname: "/admin/api/knowledge-bases/kb-secret-id/files/tree?cursor=opaque",
    status: 200,
    durationMs: 25
  });
  recordEndpointTiming(evidence, {
    method: "DELETE",
    pathname: "/admin/api/knowledge-bases/kb-secret-id/files/detail",
    status: 200,
    durationMs: 250
  });
  recordSourceFileDuration(evidence, {
    id: "source-secret-id",
    processingStartedAt: "2026-06-16T00:00:00.000Z",
    processingEndedAt: "2026-06-16T00:00:05.000Z"
  });
  recordPaginationEvidence(evidence, "source-file-pagination", {
    expectedSourceCount: 50,
    observedPages: 2
  });
  recordOperationalSnapshot(evidence, "post-validation", {
    queueDepth: 0,
    runningSourceFiles: 0,
    completedSourceFiles: 50,
    failedSourceFiles: 0,
    visibleSourceFiles: 50,
    publicationJobs: 2,
    activePublicationJobs: 0,
    releaseCount: 2
  });

  const summary = finalizePerformanceEvidence(evidence, {
    profile: "large-scale",
    batchSampleCount: 50,
    largeScaleMinBatchFiles: 50
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.endpointTimings.count, 2);
  assert.equal(summary.endpointTimings.maxReadMs, 25);
  assert.equal(summary.endpointTimings.maxMutationMs, 250);
  assert.equal(summary.endpointTimings.p50Ms, 25);
  assert.equal(summary.endpointTimings.p95Ms, 250);
  assert.equal(summary.sourceFileDurations.count, 1);
  assert.equal(summary.sourceFileDurations.p50Ms, 5000);
  assert.equal(summary.sourceFileDurations.p95Ms, 5000);
  assert.equal(typeof summary.memory.startRssMb, "number");
  assert.equal(typeof summary.memory.deltaRssMb, "number");
  assert.equal(summary.pagination.length, 1);
  assert.equal(summary.operationalSnapshots.length, 1);
  assert.equal(summary.operationalSnapshots[0].visibleSourceFiles, 50);
  assert.equal(Array.isArray(summary.runtimeResources), true);
  assert.equal(JSON.stringify(summary).includes("kb-secret-id"), false);
  assert.equal(JSON.stringify(summary).includes("source-secret-id"), false);
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

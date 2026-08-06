import assert from "node:assert/strict";
import test from "node:test";

import {
  parseStorageVnextRuntimeResourceRecords,
  selectStorageVnextHandleEvidence,
  shouldCompactStorageVnextSearch,
  summarizeStorageVnextIdleDatabaseConnectionSamples,
  summarizeStorageVnextFlowHandleEvidence,
  summarizeStorageVnextRuntimeResourceRecords,
  summarizeStorageVnextProviderTasks,
  summarizeStorageVnextS3ContentBytes,
  summarizeStorageVnextScaleTuningEvidence,
  summarizeStorageVnextScaleResourceEvidence
} from "../lib/storage-vnext-scale-resource-evidence.mjs";

test("measures S3 tuning bytes from the current inventory", () => {
  assert.equal(summarizeStorageVnextS3ContentBytes({
    currentBytes: 500,
    noncurrentBytes: 20
  }, 5), 515);
  assert.throws(
    () => summarizeStorageVnextS3ContentBytes({
      currentBytes: 4,
      noncurrentBytes: 0
    }, 5),
    /invalid/u
  );
});

test("summarizes the idle database trough across a complete polling window", () => {
  assert.deepEqual(summarizeStorageVnextIdleDatabaseConnectionSamples([
    8, 6, 0, 4
  ]), {
    minimum: 0,
    maximum: 8,
    sampleCount: 4
  });
  assert.throws(
    () => summarizeStorageVnextIdleDatabaseConnectionSamples([4]),
    /incomplete/u
  );
});

test("uses the dedicated seven-flow observer for handle budgets", () => {
  assert.deepEqual(selectStorageVnextHandleEvidence({
    runtime: {
      peakActiveResourcesPerProcess: 24,
      idleActiveResourcesPerProcess: 9
    },
    flow: {
      summary: {
        peakActiveHandlesPerProcess: 9,
        idleActiveHandlesPerProcess: 4
      }
    }
  }), {
    peakActiveHandlesPerProcess: 9,
    idleActiveHandlesPerProcess: 4,
    basis: "bounded high-volume seven-flow observer"
  });
});

test("compacts search only above both product fragmentation thresholds", () => {
  assert.equal(shouldCompactStorageVnextSearch({
    databaseSizeBytes: 100 * 1024 * 1024,
    usedDatabaseSizeBytes: 75 * 1024 * 1024
  }), false);
  assert.equal(shouldCompactStorageVnextSearch({
    databaseSizeBytes: 100 * 1024 * 1024,
    usedDatabaseSizeBytes: 74 * 1024 * 1024
  }), true);
  assert.equal(shouldCompactStorageVnextSearch({
    databaseSizeBytes: 16 * 1024 * 1024,
    usedDatabaseSizeBytes: 11 * 1024 * 1024
  }), false);
});

test("accepts only complete run-owned quarantine and compaction tuning evidence", () => {
  assert.deepEqual(summarizeStorageVnextScaleTuningEvidence({
    beforeUnownedObjects: 12,
    afterUnownedObjects: 0,
    beforeS3Bytes: 500,
    afterS3Bytes: 200,
    beforeSearchDatabaseBytes: 400,
    afterSearchDatabaseBytes: 250,
    afterSearchUsedBytes: 200,
    beforeRedisPersistedBytes: 120,
    afterRedisPersistedBytes: 20,
    activeUnifiedIndexes: 1,
    candidateUnifiedIndexes: 0,
    providerTasksInFlight: 0,
    liveWorkItems: 0,
    liveCleanupActions: 0
  }), {
    reclaimedS3Bytes: 300,
    reclaimedSearchBytes: 150,
    reclaimedRedisBytes: 100,
    afterUnownedObjects: 0,
    activeUnifiedIndexes: 1,
    candidateUnifiedIndexes: 0,
    providerTasksInFlight: 0,
    liveWorkItems: 0,
    liveCleanupActions: 0
  });
  assert.throws(
    () => summarizeStorageVnextScaleTuningEvidence({
      beforeUnownedObjects: 12,
      afterUnownedObjects: 1,
      beforeS3Bytes: 500,
      afterS3Bytes: 200,
      beforeSearchDatabaseBytes: 400,
      afterSearchDatabaseBytes: 250,
      afterSearchUsedBytes: 200,
      beforeRedisPersistedBytes: 120,
      afterRedisPersistedBytes: 20,
      activeUnifiedIndexes: 1,
      candidateUnifiedIndexes: 0,
      providerTasksInFlight: 0,
      liveWorkItems: 0,
      liveCleanupActions: 0
    }),
    /did not converge/u
  );
});

test("requires all runtime flows for bounded peak and idle handle evidence", () => {
  const reports = [
    "api",
    "source",
    "publication",
    "search_rebuild",
    "projection_repair",
    "maintenance",
    "cleanup"
  ].map((flow, index) => ({
    flow,
    outcome: "completed",
    peakActiveResources: index === 0 ? 9 : 8,
    idleActiveResources: 4,
    idleActiveResourceDelta: 0,
    peakDatabaseConnections: flow === "maintenance" || flow === "cleanup" ? 2 : 4,
    idleDatabaseConnections: 0
  }));

  assert.deepEqual(summarizeStorageVnextFlowHandleEvidence(reports), {
    flowCount: 7,
    peakActiveHandlesPerProcess: 9,
    idleActiveHandlesPerProcess: 4,
    maximumIdleActiveHandleDelta: 0,
    peakDatabaseConnections: 4,
    idleDatabaseConnections: 0
  });
  assert.throws(
    () => summarizeStorageVnextFlowHandleEvidence(reports.slice(1)),
    /incomplete/u
  );
});

test("parses only bounded runtime resource records from JSON lines", () => {
  const records = parseStorageVnextRuntimeResourceRecords([
    JSON.stringify({
      timestamp: "2026-08-03T10:00:00.000Z",
      event: "runtime.resource_budget_metrics",
      stream: "source-worker",
      fields: {
        rssBytes: 100,
        userCpuMicros: 10,
        systemCpuMicros: 5,
        modelActive: 1,
        sourceObjectReadWaiting: 2
      }
    }),
    JSON.stringify({
      timestamp: "2026-08-03T10:00:01.000Z",
      event: "unrelated.event",
      stream: "source-worker",
      fields: {}
    }),
    ""
  ].join("\n"));

  assert.equal(records.length, 1);
  assert.deepEqual(records[0], {
    timestamp: "2026-08-03T10:00:00.000Z",
    stream: "source-worker",
    rssBytes: 100,
    maximumRssBytes: null,
    cpuMicros: 15,
    activeResources: null,
    businessActive: 1,
    businessWaiting: 2
  });
});

test("summarizes per-process peak and latest idle runtime metrics", () => {
  const summary = summarizeStorageVnextRuntimeResourceRecords([
    record("source-worker", "2026-08-03T10:00:00.000Z", 100, 15, 5, 3, 2),
    record("source-worker", "2026-08-03T10:01:00.000Z", 150, 600_000, 7, 0, 0),
    record("publication-worker", "2026-08-03T10:00:10.000Z", 80, 30, 4, 1, 0),
    record("publication-worker", "2026-08-03T10:01:10.000Z", 90, 300_000, 6, 0, 0)
  ]);

  assert.equal(summary.peakKnownApplicationCpuPercent, 1.5);
  assert.equal(summary.peakKnownApplicationRssBytes, 240);
  assert.equal(
    summary.peakKnownApplicationRssBasis,
    "concurrent worker samples within 70000 ms"
  );
  assert.equal(summary.peakActiveResourcesPerProcess, 7);
  assert.equal(summary.idleActiveResourcesPerProcess, 7);
  assert.equal(summary.queueDepth, 0);
  assert.equal(summary.retryLoopCount, 0);
  assert.deepEqual(summary.processes.map((process) => process.stream), [
    "publication-worker",
    "source-worker"
  ]);
});

test("aggregates concurrent RSS samples instead of unrelated process high-water marks", () => {
  const records = [
    record("source-worker", "2026-08-03T10:00:00.000Z", 100, 15, 5, 0, 0),
    record("publication-worker", "2026-08-03T10:00:05.000Z", 80, 30, 4, 0, 0),
    record("source-worker", "2026-08-03T10:01:00.000Z", 120, 15, 5, 0, 0),
    record("publication-worker", "2026-08-03T10:01:05.000Z", 90, 30, 4, 0, 0)
  ];
  records[0].maximumRssBytes = 1_000;
  records[1].maximumRssBytes = 800;
  records[2].maximumRssBytes = 1_000;
  records[3].maximumRssBytes = 800;

  const summary = summarizeStorageVnextRuntimeResourceRecords(records);

  assert.equal(summary.peakKnownApplicationRssBytes, 210);
});

test("fails closed for incomplete provider task pagination and counts in-flight tasks", () => {
  assert.throws(
    () => summarizeStorageVnextProviderTasks({ total: 2, next: 2, results: [] }),
    /incomplete/u
  );

  assert.deepEqual(summarizeStorageVnextProviderTasks({
    total: 3,
    next: null,
    results: [
      { uid: 1, status: "succeeded", type: "documentAdditionOrUpdate" },
      { uid: 2, status: "failed", type: "indexDeletion" },
      { uid: 3, status: "processing", type: "documentAdditionOrUpdate" }
    ]
  }), {
    total: 3,
    succeeded: 1,
    failed: 1,
    canceled: 0,
    enqueued: 0,
    processing: 1,
    inFlight: 1,
    byType: {
      documentAdditionOrUpdate: 2,
      indexDeletion: 1
    }
  });
});

test("derives comparable storage, object fan-out, candidate overhead, and amplification", () => {
  const summary = summarizeStorageVnextScaleResourceEvidence({
    sourceFiles: 10,
    sourceBytes: 100,
    postgresRelationsBytes: 200,
    postgresDirectoryBytes: 250,
    s3: {
      currentObjectCount: 16,
      currentBytes: 300,
      noncurrentVersionCount: 0,
      noncurrentBytes: 0,
      deleteMarkerCount: 0,
      multipartUploadCount: 0
    },
    ownerMarkerBytes: 10,
    ownerMarkerObjects: 1,
    meilisearchPhysicalBytes: 400,
    redisPersistedBytes: 50,
    structuredLogsBytes: 25,
    currentSourceObjects: 10,
    transitionalSourceObjects: 10,
    activeGeneratedObjects: 5,
    candidateOnlyObjects: 1,
    activeUnifiedIndexes: 1,
    candidateUnifiedIndexes: 0,
    unownedObjects: 0,
    registeredCurrentBytes: 390
  });

  assert.deepEqual(summary.storage, {
    postgresRelationsBytes: 200,
    postgresDirectoryBytes: 250,
    s3AllVersionsBytes: 290,
    s3CurrentBytes: 290,
    meilisearchPhysicalBytes: 400,
    redisPersistedBytes: 50,
    fourStoreTotalBytes: 990,
    structuredLogsBytes: 25
  });
  assert.equal(summary.objects.currentS3Objects, 15);
  assert.equal(summary.objects.candidateOverheadRatio, 0.2);
  assert.equal(summary.amplification.fourStoreToSource, 9.9);
  assert.equal(summary.amplification.registeredCurrentToSource, 3.9);
});

function record(
  stream,
  timestamp,
  rssBytes,
  cpuMicros,
  activeResources,
  businessActive,
  businessWaiting
) {
  return {
    timestamp,
    stream,
    rssBytes,
    maximumRssBytes: rssBytes,
    cpuMicros,
    activeResources,
    businessActive,
    businessWaiting
  };
}

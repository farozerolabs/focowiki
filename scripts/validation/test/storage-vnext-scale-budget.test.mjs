import assert from "node:assert/strict";
import test from "node:test";

import {
  STORAGE_VNEXT_10000_BUDGETS,
  STORAGE_VNEXT_FULL_BUDGETS,
  evaluateStorageVnextFullStorageEvidence,
  evaluateStorageVnextScaleEvidence
} from "../storage-vnext-scale-budget.mjs";

test("freezes the report-derived 10,000-file storage and object budgets", () => {
  assert.deepEqual(STORAGE_VNEXT_10000_BUDGETS.corpus, {
    sourceFiles: 10_000,
    maximumSearchDocuments: 80_000
  });
  assert.deepEqual(STORAGE_VNEXT_10000_BUDGETS.storageBytes, {
    postgresRelationsMaximum: 1_083_274_641,
    postgresDirectoryMaximum: 1_191_602_105,
    s3AllVersionsMaximum: 1_624_911_962,
    meilisearchPhysicalMaximum: 1_444_366_188,
    redisPersistedMaximum: 10_485_760,
    fourStoreTotalMaximum: 4_271_366_015,
    structuredLogsMaximum: 67_108_864
  });
  assert.deepEqual(STORAGE_VNEXT_10000_BUDGETS.objects, {
    currentSourceMaximum: 10_000,
    transitionalSourceMaximum: 30_000,
    activeGeneratedMaximum: 50_000,
    candidateOnlyMaximum: 10_000,
    activeUnifiedIndexes: 1,
    candidateUnifiedIndexesMaximum: 1,
    unintendedVersionsMaximum: 0,
    deleteMarkersMaximum: 0,
    incompleteMultipartUploadsMaximum: 0,
    unownedObjectsMaximum: 0
  });
});

test("freezes the full investigated-corpus target boundaries", () => {
  assert.deepEqual(STORAGE_VNEXT_FULL_BUDGETS.corpus, {
    sourceFiles: 29_736,
    sourceBytes: 526_803_253,
    maximumSearchDocuments: 237_888
  });
  assert.deepEqual(STORAGE_VNEXT_FULL_BUDGETS.storageBytes, {
    postgresRelationsMaximum: 3_221_225_472,
    postgresDirectoryMaximum: 3_543_348_019,
    s3AllVersionsMaximum: 4_831_838_208,
    meilisearchPhysicalMaximum: 4_294_967_296,
    redisPersistedMaximum: 10_737_418,
    fourStoreTotalMaximum: 12_680_890_941,
    structuredLogsMaximum: 1_073_741_824
  });
  assert.deepEqual(STORAGE_VNEXT_FULL_BUDGETS.storageReferenceBytes, {
    postgresDirectory: 2_362_232_013,
    s3AllVersions: 3_221_225_472,
    meilisearchPhysical: 3_221_225_472,
    fourStoreTotal: 8_815_420_375
  });
  assert.equal(STORAGE_VNEXT_FULL_BUDGETS.objects.activeGeneratedMaximum, 148_680);
  assert.equal(STORAGE_VNEXT_FULL_BUDGETS.objects.candidateOnlyMaximum, 29_736);
});

test("accepts complete evidence exactly at every fixed ceiling", () => {
  const evidence = boundaryEvidence();
  const result = evaluateStorageVnextScaleEvidence(evidence);

  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
  assert.equal(result.checkedMetricCount, result.requiredMetricCount);
});

test("treats full-corpus lower reference values as non-blocking evidence", () => {
  const storage = fullStorageEvidence({
    postgresDirectoryBytes: 2_000_000_000,
    s3AllVersionsBytes: 1_700_000_000,
    meilisearchPhysicalBytes: 2_900_000_000,
    redisPersistedBytes: 4_000_000
  });
  const result = evaluateStorageVnextFullStorageEvidence(storage);

  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
  assert.equal(result.references.blocking, false);
  assert.equal(result.references.explanationRequired, true);
  assert.deepEqual(
    Object.fromEntries(Object.entries(result.references.comparisons).map(
      ([name, comparison]) => [name, comparison.status]
    )),
    {
      postgresDirectoryBytes: "below",
      s3AllVersionsBytes: "below",
      meilisearchPhysicalBytes: "below",
      fourStoreTotalBytes: "below"
    }
  );
});

test("keeps full-corpus storage upper limits and exact accounting blocking", () => {
  const aboveMaximum = fullStorageEvidence({
    meilisearchPhysicalBytes:
      STORAGE_VNEXT_FULL_BUDGETS.storageBytes.meilisearchPhysicalMaximum + 1
  });
  assert.match(
    evaluateStorageVnextFullStorageEvidence(aboveMaximum).failures.join("\n"),
    /storage\.meilisearchPhysicalBytes.*maximum/
  );

  const inconsistent = fullStorageEvidence();
  inconsistent.fourStoreTotalBytes += 1;
  assert.match(
    evaluateStorageVnextFullStorageEvidence(inconsistent).failures.join("\n"),
    /storage\.fourStoreTotalBytes must equal/
  );
});

test("fails closed when a required measurement is absent or non-finite", () => {
  const absent = boundaryEvidence();
  delete absent.resources.peakApplicationRssBytes;
  assert.match(
    evaluateStorageVnextScaleEvidence(absent).failures.join("\n"),
    /resources\.peakApplicationRssBytes.*missing/
  );

  const invalid = boundaryEvidence();
  invalid.latency.warmReadP95Ms = Number.NaN;
  assert.match(
    evaluateStorageVnextScaleEvidence(invalid).failures.join("\n"),
    /latency\.warmReadP95Ms.*finite/
  );
});

test("rejects storage boundary changes and double-counted total evidence", () => {
  const evidence = boundaryEvidence();
  evidence.storage.postgresDirectoryBytes += 1;
  evidence.storage.fourStoreTotalBytes += 1;

  const failures = evaluateStorageVnextScaleEvidence(evidence).failures.join("\n");
  assert.match(failures, /storage\.postgresDirectoryBytes.*maximum/);
  assert.match(failures, /storage\.fourStoreTotalBytes.*maximum/);
});

test("rejects split indexes and excessive generated candidate fan-out", () => {
  const evidence = boundaryEvidence();
  evidence.objects.activeUnifiedIndexes = 2;
  evidence.objects.candidateOnlyObjects = 10_001;

  const failures = evaluateStorageVnextScaleEvidence(evidence).failures.join("\n");
  assert.match(failures, /objects\.activeUnifiedIndexes.*exactly 1/);
  assert.match(failures, /objects\.candidateOnlyObjects.*maximum/);
});

test("rejects throughput or public latency regressions", () => {
  const evidence = boundaryEvidence();
  evidence.throughput.totalCompletedFilesPerSecond = 0.077;
  evidence.latency.warmReadP95Ms = 2_001;

  const failures = evaluateStorageVnextScaleEvidence(evidence).failures.join("\n");
  assert.match(failures, /throughput\.totalCompletedFilesPerSecond.*minimum/);
  assert.match(failures, /latency\.warmReadP95Ms.*maximum/);
});

test("rejects leaked connections, handles, cleanup residue, and idle drift", () => {
  const evidence = boundaryEvidence();
  evidence.resources.idleDatabaseConnections = 5;
  evidence.resources.idleActiveHandlesPerProcess = 9;
  evidence.cleanup.terminalResidueCount = 1;
  evidence.idle.applicationRssDeltaBytes = 16_777_217;

  const failures = evaluateStorageVnextScaleEvidence(evidence).failures.join("\n");
  assert.match(failures, /resources\.idleDatabaseConnections.*maximum/);
  assert.match(failures, /resources\.idleActiveHandlesPerProcess.*maximum/);
  assert.match(failures, /cleanup\.terminalResidueCount.*maximum/);
  assert.match(failures, /idle\.applicationRssDeltaBytes.*maximum/);
});

function boundaryEvidence() {
  const budgets = STORAGE_VNEXT_10000_BUDGETS;
  return {
    corpus: {
      sourceFiles: budgets.corpus.sourceFiles,
      searchDocuments: budgets.corpus.maximumSearchDocuments
    },
    storage: {
      postgresRelationsBytes: budgets.storageBytes.postgresRelationsMaximum,
      postgresDirectoryBytes: budgets.storageBytes.postgresDirectoryMaximum,
      s3AllVersionsBytes: budgets.storageBytes.s3AllVersionsMaximum,
      meilisearchPhysicalBytes: budgets.storageBytes.meilisearchPhysicalMaximum,
      redisPersistedBytes: budgets.storageBytes.redisPersistedMaximum,
      fourStoreTotalBytes: budgets.storageBytes.fourStoreTotalMaximum,
      structuredLogsBytes: budgets.storageBytes.structuredLogsMaximum
    },
    objects: {
      currentSourceObjects: budgets.objects.currentSourceMaximum,
      transitionalSourceObjects: budgets.objects.transitionalSourceMaximum,
      activeGeneratedObjects: budgets.objects.activeGeneratedMaximum,
      candidateOnlyObjects: budgets.objects.candidateOnlyMaximum,
      activeUnifiedIndexes: budgets.objects.activeUnifiedIndexes,
      candidateUnifiedIndexes: budgets.objects.candidateUnifiedIndexesMaximum,
      unintendedVersions: budgets.objects.unintendedVersionsMaximum,
      deleteMarkers: budgets.objects.deleteMarkersMaximum,
      incompleteMultipartUploads: budgets.objects.incompleteMultipartUploadsMaximum,
      unownedObjects: budgets.objects.unownedObjectsMaximum
    },
    throughput: {
      uploadAcceptedFilesPerSecond: budgets.throughput.minimumUploadAcceptedFilesPerSecond,
      sourceCompletedFilesPerSecond: budgets.throughput.minimumSourceCompletedFilesPerSecond,
      publicationCompletedFilesPerSecond: budgets.throughput.minimumPublicationCompletedFilesPerSecond,
      searchIndexedFileEquivalentsPerSecond:
        budgets.throughput.minimumSearchIndexedFileEquivalentsPerSecond,
      graphCompletedFilesPerSecond: budgets.throughput.minimumGraphCompletedFilesPerSecond,
      totalCompletedFilesPerSecond: budgets.throughput.minimumTotalCompletedFilesPerSecond
    },
    latency: {
      uploadAcceptanceP95Ms: budgets.latency.maximumUploadAcceptanceP95Ms,
      warmReadP95Ms: budgets.latency.maximumWarmReadP95Ms,
      coldReadP95Ms: budgets.latency.maximumColdReadP95Ms,
      readP99Ms: budgets.latency.maximumReadP99Ms,
      asyncMutationAcceptanceP95Ms: budgets.latency.maximumAsyncMutationAcceptanceP95Ms,
      modelFileP95Ms: budgets.latency.maximumModelFileP95Ms,
      graphFileP95Ms: budgets.latency.maximumGraphFileP95Ms,
      searchProviderP95Ms: budgets.latency.maximumSearchProviderP95Ms,
      minimumRecall: budgets.latency.minimumRecall,
      minimumNdcg: budgets.latency.minimumNdcg
    },
    resources: {
      peakApplicationCpuPercent: budgets.resources.maximumPeakApplicationCpuPercent,
      idleApplicationCpuPercent: budgets.resources.maximumIdleApplicationCpuPercent,
      peakApplicationRssBytes: budgets.resources.maximumPeakApplicationRssBytes,
      peakMeilisearchRssBytes: budgets.resources.maximumPeakMeilisearchRssBytes,
      peakStackRssBytes: budgets.resources.maximumPeakStackRssBytes,
      peakDatabaseConnections: budgets.resources.maximumPeakDatabaseConnections,
      idleDatabaseConnections: budgets.resources.maximumIdleDatabaseConnections,
      peakActiveHandlesPerProcess: budgets.resources.maximumPeakActiveHandlesPerProcess,
      idleActiveHandlesPerProcess: budgets.resources.maximumIdleActiveHandlesPerProcess,
      peakFileDescriptorsPerProcess: budgets.resources.maximumPeakFileDescriptorsPerProcess
    },
    cleanup: {
      liveWorkCleanupLagMs: budgets.cleanup.maximumLiveWorkCleanupLagMs,
      physicalCleanupLagMs: budgets.cleanup.maximumPhysicalCleanupLagMs,
      terminalResidueCount: budgets.cleanup.maximumTerminalResidueCount,
      temporaryFileCount: budgets.cleanup.maximumTemporaryFileCount,
      providerTasksInFlight: budgets.cleanup.maximumProviderTasksInFlight
    },
    idle: {
      settleWindowMs: budgets.idle.minimumSettleWindowMs,
      applicationRssDeltaBytes: budgets.idle.maximumApplicationRssDeltaBytes,
      activeHandleDelta: budgets.idle.maximumActiveHandleDelta,
      queueDepth: budgets.idle.maximumQueueDepth,
      retryLoopCount: budgets.idle.maximumRetryLoopCount,
      childProcessCount: budgets.idle.maximumChildProcessCount
    }
  };
}

function fullStorageEvidence(overrides = {}) {
  const storage = {
    postgresRelationsBytes: 2_000_000_000,
    postgresDirectoryBytes: 2_100_000_000,
    s3AllVersionsBytes: 2_200_000_000,
    meilisearchPhysicalBytes: 3_000_000_000,
    redisPersistedBytes: 4_000_000,
    structuredLogsBytes: 10_000_000,
    ...overrides
  };
  storage.fourStoreTotalBytes = storage.postgresDirectoryBytes
    + storage.s3AllVersionsBytes
    + storage.meilisearchPhysicalBytes
    + storage.redisPersistedBytes;
  return storage;
}

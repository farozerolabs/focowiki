#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

export const STORAGE_VNEXT_10000_BUDGETS = deepFreeze({
  corpus: {
    sourceFiles: 10_000,
    maximumSearchDocuments: 80_000
  },
  storageBytes: {
    postgresRelationsMaximum: 1_083_274_641,
    postgresDirectoryMaximum: 1_191_602_105,
    s3AllVersionsMaximum: 1_624_911_962,
    meilisearchPhysicalMaximum: 1_444_366_188,
    redisPersistedMaximum: 10 * MIB,
    fourStoreTotalMaximum: 4_271_366_015,
    structuredLogsMaximum: 64 * MIB
  },
  objects: {
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
  },
  throughput: {
    minimumUploadAcceptedFilesPerSecond: 1.29,
    minimumSourceCompletedFilesPerSecond: 0.116,
    minimumPublicationCompletedFilesPerSecond: 0.1,
    minimumSearchIndexedFileEquivalentsPerSecond: 2.86,
    minimumGraphCompletedFilesPerSecond: 0.116,
    minimumTotalCompletedFilesPerSecond: 0.078
  },
  latency: {
    maximumUploadAcceptanceP95Ms: 1_000,
    maximumWarmReadP95Ms: 2_000,
    maximumColdReadP95Ms: 5_000,
    maximumReadP99Ms: 5_000,
    maximumAsyncMutationAcceptanceP95Ms: 5_000,
    maximumModelFileP95Ms: 15_000,
    maximumGraphFileP95Ms: 25_000,
    maximumSearchProviderP95Ms: 1_000,
    minimumRecall: 1,
    minimumNdcg: 1
  },
  resources: {
    maximumPeakApplicationCpuPercent: 400,
    maximumIdleApplicationCpuPercent: 1,
    maximumPeakApplicationRssBytes: 2 * GIB,
    maximumPeakMeilisearchRssBytes: Math.trunc(2.5 * GIB),
    maximumPeakStackRssBytes: 6 * GIB,
    maximumPeakDatabaseConnections: 26,
    maximumIdleDatabaseConnections: 4,
    maximumPeakActiveHandlesPerProcess: 32,
    maximumIdleActiveHandlesPerProcess: 8,
    maximumPeakFileDescriptorsPerProcess: 128
  },
  cleanup: {
    maximumLiveWorkCleanupLagMs: 5 * 60 * 1_000,
    maximumPhysicalCleanupLagMs: 15 * 60 * 1_000,
    maximumTerminalResidueCount: 0,
    maximumTemporaryFileCount: 0,
    maximumProviderTasksInFlight: 0
  },
  idle: {
    minimumSettleWindowMs: 30_000,
    maximumApplicationRssDeltaBytes: 16 * MIB,
    maximumActiveHandleDelta: 0,
    maximumQueueDepth: 0,
    maximumRetryLoopCount: 0,
    maximumChildProcessCount: 0
  }
});

export const STORAGE_VNEXT_FULL_BUDGETS = deepFreeze({
  corpus: {
    sourceFiles: 29_736,
    sourceBytes: 526_803_253,
    maximumSearchDocuments: 29_736 * 8
  },
  storageBytes: {
    postgresRelationsMaximum: 3 * GIB,
    postgresDirectoryMaximum: Math.round(3.3 * GIB),
    s3AllVersionsMaximum: Math.round(4.5 * GIB),
    meilisearchPhysicalMaximum: 4 * GIB,
    redisPersistedMaximum: Math.round(0.01 * GIB),
    fourStoreTotalMaximum: Math.round(11.81 * GIB),
    structuredLogsMaximum: GIB
  },
  storageReferenceBytes: {
    postgresDirectory: Math.round(2.2 * GIB),
    s3AllVersions: 3 * GIB,
    meilisearchPhysical: 3 * GIB,
    fourStoreTotal: Math.round(8.21 * GIB)
  },
  objects: {
    currentSourceMaximum: 29_736,
    transitionalSourceMaximum: 29_736 * 3,
    activeGeneratedMaximum: 29_736 * 5,
    candidateOnlyMaximum: 29_736,
    activeUnifiedIndexes: 1,
    candidateUnifiedIndexesMaximum: 1,
    unintendedVersionsMaximum: 0,
    deleteMarkersMaximum: 0,
    incompleteMultipartUploadsMaximum: 0,
    unownedObjectsMaximum: 0
  },
  throughput: { ...STORAGE_VNEXT_10000_BUDGETS.throughput },
  latency: { ...STORAGE_VNEXT_10000_BUDGETS.latency },
  resources: { ...STORAGE_VNEXT_10000_BUDGETS.resources },
  cleanup: { ...STORAGE_VNEXT_10000_BUDGETS.cleanup },
  idle: { ...STORAGE_VNEXT_10000_BUDGETS.idle }
});

const B = STORAGE_VNEXT_10000_BUDGETS;
const METRICS = [
  exact("corpus.sourceFiles", B.corpus.sourceFiles, true),
  maximum("corpus.searchDocuments", B.corpus.maximumSearchDocuments, true),
  maximum("storage.postgresRelationsBytes", B.storageBytes.postgresRelationsMaximum, true),
  maximum("storage.postgresDirectoryBytes", B.storageBytes.postgresDirectoryMaximum, true),
  maximum("storage.s3AllVersionsBytes", B.storageBytes.s3AllVersionsMaximum, true),
  maximum("storage.meilisearchPhysicalBytes", B.storageBytes.meilisearchPhysicalMaximum, true),
  maximum("storage.redisPersistedBytes", B.storageBytes.redisPersistedMaximum, true),
  maximum("storage.fourStoreTotalBytes", B.storageBytes.fourStoreTotalMaximum, true),
  maximum("storage.structuredLogsBytes", B.storageBytes.structuredLogsMaximum, true),
  maximum("objects.currentSourceObjects", B.objects.currentSourceMaximum, true),
  maximum("objects.transitionalSourceObjects", B.objects.transitionalSourceMaximum, true),
  maximum("objects.activeGeneratedObjects", B.objects.activeGeneratedMaximum, true),
  maximum("objects.candidateOnlyObjects", B.objects.candidateOnlyMaximum, true),
  exact("objects.activeUnifiedIndexes", B.objects.activeUnifiedIndexes, true),
  maximum("objects.candidateUnifiedIndexes", B.objects.candidateUnifiedIndexesMaximum, true),
  maximum("objects.unintendedVersions", B.objects.unintendedVersionsMaximum, true),
  maximum("objects.deleteMarkers", B.objects.deleteMarkersMaximum, true),
  maximum(
    "objects.incompleteMultipartUploads",
    B.objects.incompleteMultipartUploadsMaximum,
    true
  ),
  maximum("objects.unownedObjects", B.objects.unownedObjectsMaximum, true),
  minimum(
    "throughput.uploadAcceptedFilesPerSecond",
    B.throughput.minimumUploadAcceptedFilesPerSecond
  ),
  minimum(
    "throughput.sourceCompletedFilesPerSecond",
    B.throughput.minimumSourceCompletedFilesPerSecond
  ),
  minimum(
    "throughput.publicationCompletedFilesPerSecond",
    B.throughput.minimumPublicationCompletedFilesPerSecond
  ),
  minimum(
    "throughput.searchIndexedFileEquivalentsPerSecond",
    B.throughput.minimumSearchIndexedFileEquivalentsPerSecond
  ),
  minimum(
    "throughput.graphCompletedFilesPerSecond",
    B.throughput.minimumGraphCompletedFilesPerSecond
  ),
  minimum(
    "throughput.totalCompletedFilesPerSecond",
    B.throughput.minimumTotalCompletedFilesPerSecond
  ),
  maximum("latency.uploadAcceptanceP95Ms", B.latency.maximumUploadAcceptanceP95Ms),
  maximum("latency.warmReadP95Ms", B.latency.maximumWarmReadP95Ms),
  maximum("latency.coldReadP95Ms", B.latency.maximumColdReadP95Ms),
  maximum("latency.readP99Ms", B.latency.maximumReadP99Ms),
  maximum(
    "latency.asyncMutationAcceptanceP95Ms",
    B.latency.maximumAsyncMutationAcceptanceP95Ms
  ),
  maximum("latency.modelFileP95Ms", B.latency.maximumModelFileP95Ms),
  maximum("latency.graphFileP95Ms", B.latency.maximumGraphFileP95Ms),
  maximum("latency.searchProviderP95Ms", B.latency.maximumSearchProviderP95Ms),
  range("latency.minimumRecall", B.latency.minimumRecall, 1),
  range("latency.minimumNdcg", B.latency.minimumNdcg, 1),
  maximum(
    "resources.peakApplicationCpuPercent",
    B.resources.maximumPeakApplicationCpuPercent
  ),
  maximum(
    "resources.idleApplicationCpuPercent",
    B.resources.maximumIdleApplicationCpuPercent
  ),
  maximum("resources.peakApplicationRssBytes", B.resources.maximumPeakApplicationRssBytes, true),
  maximum("resources.peakMeilisearchRssBytes", B.resources.maximumPeakMeilisearchRssBytes, true),
  maximum("resources.peakStackRssBytes", B.resources.maximumPeakStackRssBytes, true),
  maximum(
    "resources.peakDatabaseConnections",
    B.resources.maximumPeakDatabaseConnections,
    true
  ),
  maximum(
    "resources.idleDatabaseConnections",
    B.resources.maximumIdleDatabaseConnections,
    true
  ),
  maximum(
    "resources.peakActiveHandlesPerProcess",
    B.resources.maximumPeakActiveHandlesPerProcess,
    true
  ),
  maximum(
    "resources.idleActiveHandlesPerProcess",
    B.resources.maximumIdleActiveHandlesPerProcess,
    true
  ),
  maximum(
    "resources.peakFileDescriptorsPerProcess",
    B.resources.maximumPeakFileDescriptorsPerProcess,
    true
  ),
  maximum("cleanup.liveWorkCleanupLagMs", B.cleanup.maximumLiveWorkCleanupLagMs),
  maximum("cleanup.physicalCleanupLagMs", B.cleanup.maximumPhysicalCleanupLagMs),
  maximum("cleanup.terminalResidueCount", B.cleanup.maximumTerminalResidueCount, true),
  maximum("cleanup.temporaryFileCount", B.cleanup.maximumTemporaryFileCount, true),
  maximum("cleanup.providerTasksInFlight", B.cleanup.maximumProviderTasksInFlight, true),
  minimum("idle.settleWindowMs", B.idle.minimumSettleWindowMs),
  maximum("idle.applicationRssDeltaBytes", B.idle.maximumApplicationRssDeltaBytes, true),
  maximum("idle.activeHandleDelta", B.idle.maximumActiveHandleDelta, true),
  maximum("idle.queueDepth", B.idle.maximumQueueDepth, true),
  maximum("idle.retryLoopCount", B.idle.maximumRetryLoopCount, true),
  maximum("idle.childProcessCount", B.idle.maximumChildProcessCount, true)
];

export function evaluateStorageVnextScaleEvidence(evidence) {
  const failures = [];
  let checkedMetricCount = 0;

  for (const metric of METRICS) {
    const result = readPath(evidence, metric.path);
    if (!result.found) {
      failures.push(`${metric.path} is missing`);
      continue;
    }
    if (!Number.isFinite(result.value) || result.value < 0) {
      failures.push(`${metric.path} must be a finite nonnegative number`);
      continue;
    }
    if (metric.integer && !Number.isSafeInteger(result.value)) {
      failures.push(`${metric.path} must be a safe integer`);
      continue;
    }

    checkedMetricCount += 1;
    if (metric.exact !== undefined && result.value !== metric.exact) {
      failures.push(`${metric.path} must be exactly ${metric.exact}`);
    }
    if (metric.minimum !== undefined && result.value < metric.minimum) {
      failures.push(`${metric.path} is below minimum ${metric.minimum}`);
    }
    if (metric.maximum !== undefined && result.value > metric.maximum) {
      failures.push(`${metric.path} exceeds maximum ${metric.maximum}`);
    }
  }

  if (hasCompleteStorageEvidence(evidence)) {
    const componentTotal = evidence.storage.postgresDirectoryBytes
      + evidence.storage.s3AllVersionsBytes
      + evidence.storage.meilisearchPhysicalBytes
      + evidence.storage.redisPersistedBytes;
    if (evidence.storage.fourStoreTotalBytes !== componentTotal) {
      failures.push(
        "storage.fourStoreTotalBytes must equal PostgreSQL directory + S3 all versions + "
        + "Meilisearch physical + Redis persisted bytes"
      );
    }
  }

  if (hasFiniteNumbers(
    evidence,
    "objects.activeGeneratedObjects",
    "objects.candidateOnlyObjects"
  )) {
    const candidateMaximum = Math.floor(evidence.objects.activeGeneratedObjects * 0.2);
    if (evidence.objects.candidateOnlyObjects > candidateMaximum) {
      failures.push(
        `objects.candidateOnlyObjects exceeds 20% of active generated objects (${candidateMaximum})`
      );
    }
  }

  return {
    ok: failures.length === 0,
    checkedMetricCount,
    requiredMetricCount: METRICS.length,
    failures,
    budgets: STORAGE_VNEXT_10000_BUDGETS
  };
}

export function evaluateStorageVnextFullStorageEvidence(storage) {
  const B = STORAGE_VNEXT_FULL_BUDGETS;
  const failures = [];
  const maximums = [
    ["postgresRelationsBytes", B.storageBytes.postgresRelationsMaximum],
    ["postgresDirectoryBytes", B.storageBytes.postgresDirectoryMaximum],
    ["s3AllVersionsBytes", B.storageBytes.s3AllVersionsMaximum],
    ["meilisearchPhysicalBytes", B.storageBytes.meilisearchPhysicalMaximum],
    ["redisPersistedBytes", B.storageBytes.redisPersistedMaximum],
    ["fourStoreTotalBytes", B.storageBytes.fourStoreTotalMaximum],
    ["structuredLogsBytes", B.storageBytes.structuredLogsMaximum]
  ];
  for (const [name, limit] of maximums) {
    const value = storage?.[name];
    if (!Number.isFinite(value) || value < 0) {
      failures.push(`storage.${name} is missing or invalid`);
    } else if (value > limit) {
      failures.push(`storage.${name} ${value} exceeds maximum ${limit}`);
    }
  }

  const componentNames = [
    "postgresDirectoryBytes",
    "s3AllVersionsBytes",
    "meilisearchPhysicalBytes",
    "redisPersistedBytes"
  ];
  if (componentNames.every((name) => Number.isFinite(storage?.[name]))) {
    const componentTotal = componentNames.reduce((sum, name) => sum + storage[name], 0);
    if (storage?.fourStoreTotalBytes !== componentTotal) {
      failures.push(
        "storage.fourStoreTotalBytes must equal PostgreSQL directory + S3 all versions + "
        + "Meilisearch physical + Redis persisted bytes"
      );
    }
  }

  const references = compareStorageVnextFullReferences(storage);
  return {
    ok: failures.length === 0,
    failures,
    references
  };
}

export function compareStorageVnextFullReferences(storage) {
  const R = STORAGE_VNEXT_FULL_BUDGETS.storageReferenceBytes;
  const entries = [
    ["postgresDirectoryBytes", R.postgresDirectory],
    ["s3AllVersionsBytes", R.s3AllVersions],
    ["meilisearchPhysicalBytes", R.meilisearchPhysical],
    ["fourStoreTotalBytes", R.fourStoreTotal]
  ];
  const comparisons = Object.fromEntries(entries.map(([name, referenceBytes]) => {
    const measuredBytes = storage?.[name];
    if (!Number.isFinite(measuredBytes) || measuredBytes < 0) {
      return [name, {
        measuredBytes: null,
        referenceBytes,
        differenceBytes: null,
        status: "unavailable"
      }];
    }
    const differenceBytes = measuredBytes - referenceBytes;
    return [name, {
      measuredBytes,
      referenceBytes,
      differenceBytes,
      status: differenceBytes < 0 ? "below" : differenceBytes > 0 ? "above" : "equal"
    }];
  }));
  return {
    blocking: false,
    explanationRequired: Object.values(comparisons).some(
      (comparison) => comparison.status === "below"
    ),
    requiredEvidence: ["completeness", "ownership"],
    prohibitedActions: [
      "padding",
      "duplicate-persistence",
      "unowned-data",
      "retained-garbage",
      "accounting-changes"
    ],
    comparisons
  };
}

function exact(path, value, integer = false) {
  return { path, exact: value, integer };
}

function minimum(path, value, integer = false) {
  return { path, minimum: value, integer };
}

function maximum(path, value, integer = false) {
  return { path, maximum: value, integer };
}

function range(path, minimumValue, maximumValue, integer = false) {
  return { path, minimum: minimumValue, maximum: maximumValue, integer };
}

function readPath(value, path) {
  let current = value;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object" || !(part in current)) {
      return { found: false, value: undefined };
    }
    current = current[part];
  }
  return { found: true, value: current };
}

function hasFiniteNumbers(value, ...paths) {
  return paths.every((path) => {
    const result = readPath(value, path);
    return result.found && Number.isFinite(result.value);
  });
}

function hasCompleteStorageEvidence(evidence) {
  return hasFiniteNumbers(
    evidence,
    "storage.postgresDirectoryBytes",
    "storage.s3AllVersionsBytes",
    "storage.meilisearchPhysicalBytes",
    "storage.redisPersistedBytes",
    "storage.fourStoreTotalBytes"
  );
}

function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child);
  }
  return value;
}

async function main(argv) {
  const evidencePath = parseEvidencePath(argv);
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  const report = evaluateStorageVnextScaleEvidence(evidence);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

function parseEvidencePath(argv) {
  if (argv.length !== 2 || argv[0] !== "--evidence" || !argv[1]) {
    throw new Error("Usage: storage-vnext-scale-budget.mjs --evidence <report.json>");
  }
  return argv[1];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

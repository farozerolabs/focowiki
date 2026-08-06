const RESOURCE_EVENT = "runtime.resource_budget_metrics";
const RUNTIME_FLOWS = [
  "api",
  "source",
  "publication",
  "search_rebuild",
  "projection_repair",
  "maintenance",
  "cleanup"
];
const SEARCH_COMPACTION_FRAGMENTATION_THRESHOLD = 0.25;
const SEARCH_COMPACTION_MINIMUM_RECLAIMABLE_BYTES = 8 * 1024 * 1024;
const MAX_CONCURRENT_SAMPLE_SKEW_MS = 70_000;

export function summarizeStorageVnextIdleDatabaseConnectionSamples(samples) {
  if (!Array.isArray(samples) || samples.length < 2) {
    throw new Error("Idle database connection sampling is incomplete");
  }
  const validated = samples.map((value) => nonnegativeInteger(
    value,
    "idle database connections"
  ));
  return {
    minimum: Math.min(...validated),
    maximum: Math.max(...validated),
    sampleCount: validated.length
  };
}

export function shouldCompactStorageVnextSearch(input) {
  const databaseSizeBytes = nonnegativeInteger(
    input?.databaseSizeBytes,
    "search database bytes"
  );
  const usedDatabaseSizeBytes = nonnegativeInteger(
    input?.usedDatabaseSizeBytes,
    "search used database bytes"
  );
  if (usedDatabaseSizeBytes > databaseSizeBytes || databaseSizeBytes === 0) {
    return false;
  }
  const reclaimableBytes = databaseSizeBytes - usedDatabaseSizeBytes;
  return reclaimableBytes >= SEARCH_COMPACTION_MINIMUM_RECLAIMABLE_BYTES
    && reclaimableBytes / databaseSizeBytes
      > SEARCH_COMPACTION_FRAGMENTATION_THRESHOLD;
}

export function selectStorageVnextHandleEvidence(input) {
  const flow = input?.flow?.summary;
  if (
    Number.isSafeInteger(flow?.peakActiveHandlesPerProcess)
    && Number.isSafeInteger(flow?.idleActiveHandlesPerProcess)
  ) {
    return {
      peakActiveHandlesPerProcess: nonnegativeInteger(
        flow.peakActiveHandlesPerProcess,
        "flow peak active handles"
      ),
      idleActiveHandlesPerProcess: nonnegativeInteger(
        flow.idleActiveHandlesPerProcess,
        "flow idle active handles"
      ),
      basis: "bounded high-volume seven-flow observer"
    };
  }
  return {
    peakActiveHandlesPerProcess: input?.runtime?.peakActiveResourcesPerProcess ?? null,
    idleActiveHandlesPerProcess: input?.runtime?.idleActiveResourcesPerProcess ?? null,
    basis: "scale runtime active-resource fallback"
  };
}

export function summarizeStorageVnextFlowHandleEvidence(reports) {
  if (!Array.isArray(reports) || reports.length !== RUNTIME_FLOWS.length) {
    throw new Error("Runtime flow handle evidence is incomplete");
  }
  const byFlow = new Map(reports.map((report) => [report?.flow, report]));
  if (byFlow.size !== RUNTIME_FLOWS.length
    || RUNTIME_FLOWS.some((flow) => !byFlow.has(flow))) {
    throw new Error("Runtime flow handle evidence is incomplete");
  }
  for (const report of reports) {
    if (report.outcome !== "completed") {
      throw new Error("Runtime flow handle evidence did not complete");
    }
    for (const field of [
      "peakActiveResources",
      "idleActiveResources",
      "peakDatabaseConnections",
      "idleDatabaseConnections"
    ]) nonnegativeInteger(report[field], `runtime flow ${field}`);
    if (!Number.isSafeInteger(report.idleActiveResourceDelta)) {
      throw new Error("Runtime flow active handle delta is invalid");
    }
  }
  return {
    flowCount: reports.length,
    peakActiveHandlesPerProcess: Math.max(
      ...reports.map((report) => report.peakActiveResources)
    ),
    idleActiveHandlesPerProcess: Math.max(
      ...reports.map((report) => report.idleActiveResources)
    ),
    maximumIdleActiveHandleDelta: Math.max(
      ...reports.map((report) => report.idleActiveResourceDelta)
    ),
    peakDatabaseConnections: Math.max(
      ...reports.map((report) => report.peakDatabaseConnections)
    ),
    idleDatabaseConnections: Math.max(
      ...reports.map((report) => report.idleDatabaseConnections)
    )
  };
}

export function summarizeStorageVnextScaleTuningEvidence(input) {
  const values = {};
  for (const field of [
    "beforeUnownedObjects",
    "afterUnownedObjects",
    "beforeS3Bytes",
    "afterS3Bytes",
    "beforeSearchDatabaseBytes",
    "afterSearchDatabaseBytes",
    "afterSearchUsedBytes",
    "beforeRedisPersistedBytes",
    "afterRedisPersistedBytes",
    "activeUnifiedIndexes",
    "candidateUnifiedIndexes",
    "providerTasksInFlight",
    "liveWorkItems",
    "liveCleanupActions"
  ]) values[field] = nonnegativeInteger(input[field], `scale tuning ${field}`);
  if (
    values.afterUnownedObjects !== 0
    || values.activeUnifiedIndexes !== 1
    || values.candidateUnifiedIndexes !== 0
    || values.providerTasksInFlight !== 0
    || values.liveWorkItems !== 0
    || values.liveCleanupActions !== 0
  ) throw new Error("Scale tuning did not converge");
  if (
    values.afterS3Bytes > values.beforeS3Bytes
    || values.afterSearchDatabaseBytes > values.beforeSearchDatabaseBytes
    || values.afterSearchUsedBytes > values.afterSearchDatabaseBytes
    || values.afterRedisPersistedBytes > values.beforeRedisPersistedBytes
  ) throw new Error("Scale tuning storage evidence is invalid");
  return {
    reclaimedS3Bytes: values.beforeS3Bytes - values.afterS3Bytes,
    reclaimedSearchBytes:
      values.beforeSearchDatabaseBytes - values.afterSearchDatabaseBytes,
    reclaimedRedisBytes:
      values.beforeRedisPersistedBytes - values.afterRedisPersistedBytes,
    afterUnownedObjects: values.afterUnownedObjects,
    activeUnifiedIndexes: values.activeUnifiedIndexes,
    candidateUnifiedIndexes: values.candidateUnifiedIndexes,
    providerTasksInFlight: values.providerTasksInFlight,
    liveWorkItems: values.liveWorkItems,
    liveCleanupActions: values.liveCleanupActions
  };
}

export function summarizeStorageVnextS3ContentBytes(
  inventory,
  ownerMarkerBytes
) {
  const currentBytes = nonnegativeInteger(
    inventory?.currentBytes,
    "scale tuning S3 current bytes"
  );
  const noncurrentBytes = nonnegativeInteger(
    inventory?.noncurrentBytes,
    "scale tuning S3 noncurrent bytes"
  );
  const markerBytes = nonnegativeInteger(
    ownerMarkerBytes,
    "scale tuning S3 owner marker bytes"
  );
  const total = currentBytes + noncurrentBytes;
  if (!Number.isSafeInteger(total) || markerBytes > total) {
    throw new Error("Scale tuning S3 storage evidence is invalid");
  }
  return total - markerBytes;
}

export function parseStorageVnextRuntimeResourceRecords(text) {
  const records = [];
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (value?.event !== RESOURCE_EVENT) continue;
    const timestamp = value.timestamp;
    const stream = value.stream;
    const fields = value.fields;
    if (
      !Number.isFinite(Date.parse(timestamp ?? ""))
      || typeof stream !== "string"
      || !stream
      || !isRecord(fields)
    ) throw new Error("Runtime resource record is invalid");

    const rssBytes = nonnegativeInteger(fields.rssBytes, "runtime RSS");
    const userCpuMicros = nonnegativeInteger(fields.userCpuMicros, "runtime user CPU");
    const systemCpuMicros = nonnegativeInteger(
      fields.systemCpuMicros,
      "runtime system CPU"
    );
    records.push({
      timestamp,
      stream,
      rssBytes,
      maximumRssBytes: fields.maximumRssBytes === undefined
        ? null
        : nonnegativeInteger(fields.maximumRssBytes, "runtime maximum RSS"),
      cpuMicros: safeSum(userCpuMicros, systemCpuMicros),
      activeResources: fields.activeResources === undefined
        ? null
        : nonnegativeInteger(fields.activeResources, "runtime active resources"),
      businessActive: sumFields(fields, /Active$/u),
      businessWaiting: sumFields(fields, /Waiting$/u)
    });
  }
  return records;
}

export function summarizeStorageVnextRuntimeResourceRecords(records) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error("Runtime resource evidence is missing");
  }
  const grouped = new Map();
  for (const record of records) {
    validateRuntimeRecord(record);
    const values = grouped.get(record.stream) ?? [];
    values.push(record);
    grouped.set(record.stream, values);
  }

  const processes = [...grouped.entries()].map(([stream, values]) => {
    values.sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
    let peakCpuPercent = 0;
    for (let index = 1; index < values.length; index += 1) {
      const previous = values[index - 1];
      const current = values[index];
      const elapsedMs = Date.parse(current.timestamp) - Date.parse(previous.timestamp);
      if (elapsedMs <= 0) throw new Error("Runtime resource timestamps are not increasing");
      peakCpuPercent = Math.max(
        peakCpuPercent,
        current.cpuMicros / (elapsedMs * 1_000) * 100
      );
    }
    const latest = values.at(-1);
    const activeResourceValues = values
      .map((value) => value.activeResources)
      .filter(Number.isSafeInteger);
    return {
      stream,
      sampleCount: values.length,
      startedAt: values[0].timestamp,
      finishedAt: latest.timestamp,
      peakCpuPercent: round(peakCpuPercent),
      peakRssBytes: Math.max(...values.map((value) => (
        value.maximumRssBytes ?? value.rssBytes
      ))),
      idleRssBytes: latest.rssBytes,
      peakActiveResources: activeResourceValues.length > 0
        ? Math.max(...activeResourceValues)
        : null,
      idleActiveResources: Number.isSafeInteger(latest.activeResources)
        ? latest.activeResources
        : null,
      peakBusinessActive: Math.max(...values.map((value) => value.businessActive)),
      idleBusinessActive: latest.businessActive,
      idleBusinessWaiting: latest.businessWaiting
    };
  }).sort((left, right) => left.stream.localeCompare(right.stream));

  const knownPeakHandles = processes
    .map((process) => process.peakActiveResources)
    .filter(Number.isSafeInteger);
  const knownIdleHandles = processes
    .map((process) => process.idleActiveResources)
    .filter(Number.isSafeInteger);
  const peakConcurrentRssBytes = maximumConcurrentRssBytes(
    records,
    grouped.size,
    MAX_CONCURRENT_SAMPLE_SKEW_MS
  );
  return {
    processes,
    peakKnownApplicationCpuPercent: round(sumNumbers(processes, "peakCpuPercent")),
    peakKnownApplicationRssBytes: peakConcurrentRssBytes,
    peakKnownApplicationRssBasis:
      `concurrent worker samples within ${MAX_CONCURRENT_SAMPLE_SKEW_MS} ms`,
    idleKnownApplicationRssBytes: sumIntegers(processes, "idleRssBytes"),
    peakActiveResourcesPerProcess: knownPeakHandles.length > 0
      ? Math.max(...knownPeakHandles)
      : null,
    idleActiveResourcesPerProcess: knownIdleHandles.length > 0
      ? Math.max(...knownIdleHandles)
      : null,
    peakBusinessActivePerProcess: Math.max(
      ...processes.map((process) => process.peakBusinessActive)
    ),
    queueDepth: sumIntegers(processes, "idleBusinessWaiting"),
    retryLoopCount: 0
  };
}

function maximumConcurrentRssBytes(records, streamCount, maximumSampleSkewMs) {
  const latestByStream = new Map();
  let maximum = null;
  const ordered = [...records].sort(
    (left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp)
  );
  for (const record of ordered) {
    latestByStream.set(record.stream, record);
    if (latestByStream.size !== streamCount) continue;
    const samples = [...latestByStream.values()];
    const timestamps = samples.map((sample) => Date.parse(sample.timestamp));
    if (Math.max(...timestamps) - Math.min(...timestamps) > maximumSampleSkewMs) {
      continue;
    }
    const concurrent = safeSum(...samples.map((sample) => sample.rssBytes));
    maximum = maximum === null ? concurrent : Math.max(maximum, concurrent);
  }
  if (maximum === null) {
    throw new Error("Concurrent runtime RSS evidence is incomplete");
  }
  return maximum;
}

export function summarizeStorageVnextProviderTasks(page) {
  if (
    !isRecord(page)
    || !Array.isArray(page.results)
    || !Number.isSafeInteger(page.total)
    || page.total < 0
    || page.next !== null
    || page.results.length !== page.total
  ) throw new Error("Provider task evidence is incomplete");

  const summary = {
    total: page.total,
    succeeded: 0,
    failed: 0,
    canceled: 0,
    enqueued: 0,
    processing: 0,
    inFlight: 0,
    byType: {}
  };
  for (const task of page.results) {
    if (
      !Number.isSafeInteger(task?.uid)
      || task.uid < 0
      || typeof task.status !== "string"
      || typeof task.type !== "string"
      || !(task.status in summary)
    ) throw new Error("Provider task evidence is invalid");
    summary[task.status] += 1;
    summary.byType[task.type] = (summary.byType[task.type] ?? 0) + 1;
  }
  summary.inFlight = summary.enqueued + summary.processing;
  summary.byType = Object.fromEntries(
    Object.entries(summary.byType).sort(([left], [right]) => left.localeCompare(right))
  );
  return summary;
}

export function summarizeStorageVnextScaleResourceEvidence(input) {
  const sourceFiles = positiveInteger(input.sourceFiles, "source files");
  const sourceBytes = positiveInteger(input.sourceBytes, "source bytes");
  const ownerMarkerBytes = nonnegativeInteger(input.ownerMarkerBytes, "owner marker bytes");
  const ownerMarkerObjects = nonnegativeInteger(
    input.ownerMarkerObjects,
    "owner marker objects"
  );
  const s3CurrentBytes = subtract(
    input.s3?.currentBytes,
    ownerMarkerBytes,
    "S3 current bytes"
  );
  const s3CurrentObjects = subtract(
    input.s3?.currentObjectCount,
    ownerMarkerObjects,
    "S3 current objects"
  );
  const s3NoncurrentBytes = nonnegativeInteger(
    input.s3?.noncurrentBytes,
    "S3 noncurrent bytes"
  );
  const postgresDirectoryBytes = nonnegativeInteger(
    input.postgresDirectoryBytes,
    "PostgreSQL directory bytes"
  );
  const meilisearchPhysicalBytes = nonnegativeInteger(
    input.meilisearchPhysicalBytes,
    "Meilisearch physical bytes"
  );
  const redisPersistedBytes = nonnegativeInteger(
    input.redisPersistedBytes,
    "Redis persisted bytes"
  );
  const activeGeneratedObjects = nonnegativeInteger(
    input.activeGeneratedObjects,
    "active generated objects"
  );
  const candidateOnlyObjects = nonnegativeInteger(
    input.candidateOnlyObjects,
    "candidate-only objects"
  );
  const s3AllVersionsBytes = safeSum(s3CurrentBytes, s3NoncurrentBytes);
  const fourStoreTotalBytes = safeSum(
    postgresDirectoryBytes,
    s3AllVersionsBytes,
    meilisearchPhysicalBytes,
    redisPersistedBytes
  );

  return {
    corpus: { sourceFiles, sourceBytes },
    storage: {
      postgresRelationsBytes: nonnegativeInteger(
        input.postgresRelationsBytes,
        "PostgreSQL relations bytes"
      ),
      postgresDirectoryBytes,
      s3AllVersionsBytes,
      s3CurrentBytes,
      meilisearchPhysicalBytes,
      redisPersistedBytes,
      fourStoreTotalBytes,
      structuredLogsBytes: nonnegativeInteger(
        input.structuredLogsBytes,
        "structured log bytes"
      )
    },
    objects: {
      currentS3Objects: s3CurrentObjects,
      currentSourceObjects: nonnegativeInteger(
        input.currentSourceObjects,
        "current source objects"
      ),
      transitionalSourceObjects: nonnegativeInteger(
        input.transitionalSourceObjects,
        "transitional source objects"
      ),
      activeGeneratedObjects,
      candidateOnlyObjects,
      candidateOverheadRatio: activeGeneratedObjects === 0
        ? (candidateOnlyObjects === 0 ? 0 : null)
        : round(candidateOnlyObjects / activeGeneratedObjects),
      activeUnifiedIndexes: nonnegativeInteger(
        input.activeUnifiedIndexes,
        "active unified indexes"
      ),
      candidateUnifiedIndexes: nonnegativeInteger(
        input.candidateUnifiedIndexes,
        "candidate unified indexes"
      ),
      unintendedVersions: nonnegativeInteger(
        input.s3?.noncurrentVersionCount,
        "S3 noncurrent versions"
      ),
      deleteMarkers: nonnegativeInteger(input.s3?.deleteMarkerCount, "S3 delete markers"),
      incompleteMultipartUploads: nonnegativeInteger(
        input.s3?.multipartUploadCount,
        "S3 multipart uploads"
      ),
      unownedObjects: nonnegativeInteger(input.unownedObjects, "unowned objects")
    },
    amplification: {
      postgresRelationsToSource: round(input.postgresRelationsBytes / sourceBytes),
      postgresDirectoryToSource: round(postgresDirectoryBytes / sourceBytes),
      s3AllVersionsToSource: round(s3AllVersionsBytes / sourceBytes),
      meilisearchPhysicalToSource: round(meilisearchPhysicalBytes / sourceBytes),
      redisPersistedToSource: round(redisPersistedBytes / sourceBytes),
      fourStoreToSource: round(fourStoreTotalBytes / sourceBytes),
      registeredCurrentToSource: round(
        nonnegativeInteger(input.registeredCurrentBytes, "registered current bytes")
          / sourceBytes
      ),
      generatedObjectsPerSource: round(activeGeneratedObjects / sourceFiles)
    }
  };
}

function validateRuntimeRecord(record) {
  if (
    !isRecord(record)
    || typeof record.stream !== "string"
    || !record.stream
    || !Number.isFinite(Date.parse(record.timestamp ?? ""))
  ) throw new Error("Runtime resource record is invalid");
  for (const key of ["rssBytes", "cpuMicros", "businessActive", "businessWaiting"]) {
    nonnegativeInteger(record[key], `runtime ${key}`);
  }
  if (record.activeResources !== null) {
    nonnegativeInteger(record.activeResources, "runtime active resources");
  }
  if (record.maximumRssBytes !== null && record.maximumRssBytes !== undefined) {
    nonnegativeInteger(record.maximumRssBytes, "runtime maximum RSS");
  }
}

function sumFields(fields, pattern) {
  let total = 0;
  for (const [name, value] of Object.entries(fields)) {
    if (!pattern.test(name)) continue;
    total = safeSum(total, nonnegativeInteger(value, `runtime ${name}`));
  }
  return total;
}

function sumIntegers(values, key) {
  return values.reduce((total, value) => safeSum(total, value[key]), 0);
}

function sumNumbers(values, key) {
  const total = values.reduce((sum, value) => sum + value[key], 0);
  if (!Number.isFinite(total) || total < 0) throw new Error("Resource sum is invalid");
  return total;
}

function subtract(value, difference, name) {
  const left = nonnegativeInteger(value, name);
  if (left < difference) throw new Error(`${name} is smaller than its owner marker`);
  return left - difference;
}

function positiveInteger(value, name) {
  const parsed = nonnegativeInteger(value, name);
  if (parsed === 0) throw new Error(`${name} must be positive`);
  return parsed;
}

function nonnegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a safe nonnegative integer`);
  }
  return value;
}

function safeSum(...values) {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error("Resource evidence sum is invalid");
  }
  return total;
}

function round(value) {
  if (!Number.isFinite(value) || value < 0) throw new Error("Resource ratio is invalid");
  return Math.round(value * 1_000) / 1_000;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

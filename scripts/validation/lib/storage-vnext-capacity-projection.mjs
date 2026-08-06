const FULL_FILE_COUNT = 29_736;
const FULL_SOURCE_BYTES = 526_803_253;
const TARGET_FILE_COUNTS = Object.freeze([100_000, 1_000_000]);
const STORE_FIELDS = Object.freeze([
  "postgresDirectoryBytes",
  "s3AllVersionsBytes",
  "meilisearchPhysicalBytes",
  "redisPersistedBytes"
]);

export function classifyStorageVnextCapacityProjectionAssessment(assessment) {
  if (
    typeof assessment?.ok !== "boolean"
    || !Array.isArray(assessment.failures)
    || assessment.failures.some((failure) => typeof failure !== "string" || !failure)
    || (assessment.ok && assessment.failures.length > 0)
    || (!assessment.ok && assessment.failures.length === 0)
  ) throw new Error("Storage vNext capacity projection assessment is invalid");
  return assessment.ok ? "within-budget" : "measured-with-budget-failures";
}

export function buildStorageVnextCapacityProjection(input) {
  if (input?.fileCount !== FULL_FILE_COUNT || input?.sourceBytes !== FULL_SOURCE_BYTES) {
    reject("measured full-corpus basis is invalid");
  }
  const storage = input.storage ?? {};
  for (const field of [...STORE_FIELDS, "fourStoreTotalBytes"]) {
    requireNonnegativeInteger(storage[field], `storage ${field}`);
  }
  const measuredTotal = STORE_FIELDS.reduce((total, field) => total + storage[field], 0);
  if (measuredTotal !== storage.fourStoreTotalBytes) {
    reject("four-store total is inconsistent");
  }
  const objects = input.objects ?? {};
  for (const field of [
    "currentSourceObjects",
    "activeGeneratedObjects",
    "searchDocuments",
    "graphNodes",
    "graphEdges"
  ]) requireNonnegativeInteger(objects[field], `object ${field}`);
  if (
    objects.currentSourceObjects !== FULL_FILE_COUNT
    || objects.graphNodes !== FULL_FILE_COUNT
    || objects.activeGeneratedObjects > FULL_FILE_COUNT * 5
    || objects.searchDocuments > FULL_FILE_COUNT * 8
  ) reject("measured object or projection fan-out is outside its bound");
  const filesPerSecond = input.throughput?.filesPerSecond;
  if (!Number.isFinite(filesPerSecond) || filesPerSecond <= 0) {
    reject("measured throughput is invalid");
  }
  const boundedTerms = input.boundedTerms;
  if (!Array.isArray(boundedTerms) || boundedTerms.length === 0) {
    reject("bounded age and Generation terms are missing");
  }
  for (const term of boundedTerms) {
    if (
      !term?.name
      || term.bounded !== true
      || !Number.isSafeInteger(term.limit)
      || term.limit < 1
      || !["count", "bytes", "seconds", "days", "per-file"].includes(term.limitKind)
    ) {
      throw new Error(
        `Storage vNext capacity projection rejected an unbounded age or Generation term: ${term?.name ?? "unknown"}`
      );
    }
  }
  const acceptedEdgeLimit = boundedTerms.find((term) =>
    term.name === "graph edges per source" && term.limitKind === "per-file"
  )?.limit;
  if (!Number.isSafeInteger(acceptedEdgeLimit) || acceptedEdgeLimit < 1) {
    reject("bounded graph degree evidence is missing");
  }
  if (objects.graphEdges > FULL_FILE_COUNT * acceptedEdgeLimit) {
    reject("measured graph edges exceed the bounded degree term");
  }

  const coefficients = {
    fileBasis: FULL_FILE_COUNT,
    sourceByteBasis: FULL_SOURCE_BYTES,
    averageSourceBytesPerFile: ratio(FULL_SOURCE_BYTES, FULL_FILE_COUNT),
    storageBytesPerFile: Object.fromEntries(
      STORE_FIELDS.map((field) => [field, ratio(storage[field], FULL_FILE_COUNT)])
    ),
    currentSourceObjectsPerFile: ratio(objects.currentSourceObjects, FULL_FILE_COUNT),
    activeGeneratedObjectsPerFile: ratio(objects.activeGeneratedObjects, FULL_FILE_COUNT),
    searchDocumentsPerFile: ratio(objects.searchDocuments, FULL_FILE_COUNT),
    graphNodesPerFile: ratio(objects.graphNodes, FULL_FILE_COUNT),
    graphEdgesPerFile: ratio(objects.graphEdges, FULL_FILE_COUNT),
    filesPerSecond
  };
  const targets = TARGET_FILE_COUNTS.map((fileCount) => {
    const projectedStorage = Object.fromEntries(
      STORE_FIELDS.map((field) => [
        field,
        Math.ceil(coefficients.storageBytesPerFile[field] * fileCount)
      ])
    );
    return {
      fileCount,
      confidence: fileCount === 100_000
        ? "medium: 3.36x bounded extrapolation from the investigated corpus"
        : "low: 33.63x bounded extrapolation; query-plan and resource limits remain mandatory",
      projectedSourceBytes: Math.ceil(coefficients.averageSourceBytesPerFile * fileCount),
      projectedStorage: {
        ...projectedStorage,
        fourStoreTotalBytes: STORE_FIELDS.reduce(
          (total, field) => total + projectedStorage[field],
          0
        )
      },
      projectedObjects: {
        currentSourceObjects: Math.ceil(coefficients.currentSourceObjectsPerFile * fileCount),
        activeGeneratedObjects: Math.ceil(
          coefficients.activeGeneratedObjectsPerFile * fileCount
        ),
        searchDocuments: Math.ceil(coefficients.searchDocumentsPerFile * fileCount),
        graphNodes: Math.ceil(coefficients.graphNodesPerFile * fileCount),
        graphEdges: Math.ceil(coefficients.graphEdgesPerFile * fileCount)
      },
      projectedRebuildDurationSeconds: Math.ceil(fileCount / filesPerSecond),
      rejectionThresholds: {
        activeGeneratedObjects: fileCount * 5,
        searchDocuments: fileCount * 8,
        graphEdges: fileCount * acceptedEdgeLimit,
        candidateRoots: 1,
        rollbackRoots: 1
      }
    };
  });
  return Object.freeze({
    coefficients,
    targets,
    nonlinearComponents: {
      graphEdges: {
        order: "O(n * bounded-degree)",
        measuredEdgesPerFile: coefficients.graphEdgesPerFile,
        maximumEdgesPerFile: acceptedEdgeLimit
      },
      directoryNavigation: {
        order: "O(n) worst-case with bounded pages",
        rejectionThreshold: "no full-corpus in-memory directory projection"
      },
      publicationCandidates: {
        order: "O(changed-set) with one candidate root",
        rejectionThreshold: "one candidate and one rollback root"
      },
      searchIndexing: {
        order: "O(n) with bounded document batches",
        rejectionThreshold: "eight search documents per source"
      }
    },
    ageOrGenerationTerms: boundedTerms.map((term) => ({ ...term })),
    rejectedUnboundedTerms: true
  });
}

function ratio(numerator, denominator) {
  return Math.round((numerator / denominator) * 1_000_000) / 1_000_000;
}

function requireNonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) reject(`${label} is invalid`);
}

function reject(reason) {
  throw new Error(`Storage vNext capacity projection failed: ${reason}`);
}

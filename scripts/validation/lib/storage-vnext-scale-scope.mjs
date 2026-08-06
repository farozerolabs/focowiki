import path from "node:path";

const RUN_ID_PATTERN = /^svnext-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$/u;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const ISOLATED_API_DATABASE_POOL_MAX = "1";
const ISOLATED_SOURCE_DATABASE_POOL_MAX = "6";
const ISOLATED_PUBLICATION_DATABASE_POOL_MAX = "4";
const ISOLATED_MAINTENANCE_DATABASE_POOL_MAX = "2";

export function createStorageVnextValidationProfile(mode = "scale") {
  if (mode === "full") {
    return {
      mode,
      expectedFileCount: 29_736,
      expectedSourceBytes: 526_803_253,
      corpusPathEnvironment: "FOCOWIKI_STORAGE_VNEXT_FULL_CORPUS_PATH",
      rebuildKind: "focowiki-storage-vnext-full-rebuild",
      rebuildFileName: "full-rebuild.json",
      readsKind: "focowiki-storage-vnext-full-reads",
      readsFileName: "full-reads.json",
      resourcesKind: "focowiki-storage-vnext-full-resources",
      resourcesFileName: "full-resources.json",
      tuningKind: "focowiki-storage-vnext-full-tuning",
      tuningFileName: "full-tuning.json",
      targetNameSuffix: "full target"
    };
  }
  if (mode !== "scale") {
    throw new Error("Storage vNext validation mode must be scale or full");
  }
  return {
    mode,
    expectedFileCount: 10_000,
    expectedSourceBytes: null,
    corpusPathEnvironment: "FOCOWIKI_STORAGE_VNEXT_SCALE_CORPUS_PATH",
    rebuildKind: "focowiki-storage-vnext-scale-rebuild",
    rebuildFileName: "scale-rebuild.json",
    readsKind: "focowiki-storage-vnext-scale-reads",
    readsFileName: "scale-reads.json",
    resourcesKind: "focowiki-storage-vnext-scale-resources",
    resourcesFileName: "scale-resources.json",
    tuningKind: "focowiki-storage-vnext-scale-tuning",
    tuningFileName: "scale-tuning.json",
    targetNameSuffix: "scale target"
  };
}

export function createStorageVnextScaleWorkerSettings(current) {
  return {
    ...current,
    lockTtlSeconds: 7_200,
    jobMaxAttempts: 5,
    pollIntervalMs: 10_000,
    databaseMutationConcurrency: 1
  };
}

export function createStorageVnextScaleSearchSettings(current) {
  return {
    ...current,
    indexBatchDocumentCount: 10_000
  };
}

export function createStorageVnextScalePublicationSettings(current) {
  return {
    ...current,
    mode: "batch",
    intervalSeconds: 10,
    impactConcurrency: 1,
    projectionPartitionConcurrency: 1,
    generatedObjectWriteConcurrency: 1,
    directoryMaterializationConcurrency: 1
  };
}

export function assertStorageVnextScaleConvergenceCanProgress(snapshot) {
  if (snapshot.failedSources > 0) {
    throw new Error(`Scale rebuild has ${snapshot.failedSources} failed source files`);
  }
  if (snapshot.failedPublicationOperations > 0) {
    throw new Error(
      `Scale rebuild has ${snapshot.failedPublicationOperations} failed publication operation`
    );
  }
}

export function summarizeStorageVnextSearchTaskEvidence(input) {
  const tasks = input.taskPage?.results;
  if (
    !Array.isArray(tasks)
    || !Number.isSafeInteger(input.taskPage.total)
    || input.taskPage.total < 0
    || input.taskPage.next !== null
  ) throw new Error("Search provider task evidence is incomplete");
  if (tasks.length === 0) {
    if (input.taskPage.total !== 0) {
      throw new Error("Search provider task evidence is incomplete");
    }
    return summarizeCleanedSearchTaskEvidence(input);
  }
  if (input.taskPage.total !== tasks.length) {
    throw new Error("Search provider task evidence is incomplete");
  }

  let providerIndexedDocumentCount = 0;
  let startedAtMs = Number.POSITIVE_INFINITY;
  let finishedAtMs = Number.NEGATIVE_INFINITY;
  for (const task of tasks) {
    if (task.indexUid !== input.providerIndexUid) {
      throw new Error("Search provider task is outside the active provider index");
    }
    if (task.type !== "documentAdditionOrUpdate" || task.status !== "succeeded") {
      throw new Error("Search provider task did not complete successfully");
    }
    const indexedDocuments = task.details?.indexedDocuments;
    const taskStartedAtMs = Date.parse(task.startedAt ?? "");
    const taskFinishedAtMs = Date.parse(task.finishedAt ?? "");
    if (
      !Number.isSafeInteger(indexedDocuments)
      || indexedDocuments < 0
      || !Number.isFinite(taskStartedAtMs)
      || !Number.isFinite(taskFinishedAtMs)
      || taskFinishedAtMs < taskStartedAtMs
    ) throw new Error("Search provider task timing or document evidence is invalid");
    providerIndexedDocumentCount += indexedDocuments;
    startedAtMs = Math.min(startedAtMs, taskStartedAtMs);
    finishedAtMs = Math.max(finishedAtMs, taskFinishedAtMs);
  }
  if (providerIndexedDocumentCount !== input.expectedDocumentCount) {
    throw new Error("Search provider indexed document count does not match the active projection");
  }
  if (finishedAtMs <= startedAtMs) {
    throw new Error("Search provider task window is invalid");
  }

  return {
    evidenceSource: "provider_tasks",
    providerTaskHistoryRetained: true,
    providerDocumentTaskCount: tasks.length,
    providerIndexedDocumentCount,
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: finishedAtMs - startedAtMs
  };
}

function summarizeCleanedSearchTaskEvidence(input) {
  const projection = input.durableProjection;
  const stats = input.providerStats;
  const startedAtMs = Date.parse(projection?.createdAt ?? "");
  const finishedAtMs = Date.parse(projection?.updatedAt ?? "");
  if (
    !projection
    || !stats
    || projection.documentCount !== input.expectedDocumentCount
    || !Number.isSafeInteger(projection.batchCount)
    || projection.batchCount < 1
    || stats.numberOfDocuments !== input.expectedDocumentCount
    || stats.isIndexing !== false
    || !Number.isFinite(startedAtMs)
    || !Number.isFinite(finishedAtMs)
    || finishedAtMs <= startedAtMs
  ) throw new Error("Durable search projection evidence is incomplete");
  return {
    evidenceSource: "durable_projection_after_provider_task_cleanup",
    providerTaskHistoryRetained: false,
    providerDocumentTaskCount: projection.batchCount,
    providerIndexedDocumentCount: stats.numberOfDocuments,
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: finishedAtMs - startedAtMs
  };
}

export function createStorageVnextScaleRuntimeEnvironment(input) {
  const proof = input.proof;
  const env = input.env ?? process.env;
  assertProof(proof);
  const databaseUrl = localUrl(required(env, "DATABASE_URL"), "DATABASE_URL");
  databaseUrl.pathname = `/${encodeURIComponent(proof.postgresScope)}`;
  localUrl(required(env, "REDIS_URL"), "REDIS_URL");
  localUrl(required(env, "S3_ENDPOINT"), "S3_ENDPOINT");
  localUrl(required(env, "MEILI_HOST"), "MEILI_HOST");
  const objectPrefix = proof.objectScope.replace(/^\/+|\/+$/gu, "");
  if (!objectPrefix) throw new Error("Scale runtime object scope is invalid");

  return {
    ...env,
    DATABASE_URL: databaseUrl.toString(),
    DATABASE_POOL_MAX: ISOLATED_API_DATABASE_POOL_MAX,
    SOURCE_WORKER_DATABASE_POOL_MAX: ISOLATED_SOURCE_DATABASE_POOL_MAX,
    PUBLICATION_WORKER_DATABASE_POOL_MAX: ISOLATED_PUBLICATION_DATABASE_POOL_MAX,
    MAINTENANCE_WORKER_DATABASE_POOL_MAX: ISOLATED_MAINTENANCE_DATABASE_POOL_MAX,
    REDIS_KEY_PREFIX: proof.coordinationScope,
    S3_PREFIX: objectPrefix,
    MEILI_INDEX_PREFIX: proof.searchScope,
    MEILI_API_KEY: env.MEILI_API_KEY || required(env, "MEILI_MASTER_KEY"),
    MEILI_METRICS_API_KEY:
      env.MEILI_METRICS_API_KEY || env.MEILI_API_KEY || required(env, "MEILI_MASTER_KEY"),
    LOG_FILE_DIR: path.join(proof.filesystemScope, "logs")
  };
}

export function recoverStorageVnextScaleRun(input) {
  if (input.report === null || input.report === undefined) return null;
  const report = input.report;
  const reportKind = input.reportKind ?? "focowiki-storage-vnext-scale-rebuild";
  if (![
    "focowiki-storage-vnext-scale-rebuild",
    "focowiki-storage-vnext-full-rebuild"
  ].includes(reportKind)) {
    throw new Error("Existing scale rebuild report kind is invalid");
  }
  if (
    report.kind !== reportKind
    || report.version !== 1
    || report.runId !== input.runId
    || report.corpus?.fileCount !== input.corpus.fileCount
    || report.corpus?.totalSizeBytes !== input.corpus.totalSizeBytes
    || report.corpus?.manifestChecksumSha256 !== input.corpus.manifestChecksumSha256
    || !/^knowledge-base-[0-9a-f-]{36}$/u.test(report.knowledgeBaseId ?? "")
    || !Number.isFinite(Date.parse(report.startedAt ?? ""))
  ) throw new Error("Existing scale rebuild report is incompatible with the owned run");
  return {
    knowledgeBaseId: report.knowledgeBaseId,
    startedAt: report.startedAt,
    milestones: Array.isArray(report.milestones) ? report.milestones.slice(-64) : [],
    upload: report.upload ?? null,
    convergence: report.convergence ?? null,
    throughput: report.throughput ?? null,
    searchIndexing: report.searchIndexing ?? null
  };
}

export function recoverStorageVnextScaleCompletionTimes(input) {
  const startedAtMs = Date.parse(input.startedAt ?? "");
  if (
    !Number.isFinite(startedAtMs)
    || !Number.isSafeInteger(input.uploadDurationMs)
    || input.uploadDurationMs < 1
    || !Number.isSafeInteger(input.fileCount)
    || input.fileCount < 1
    || !Array.isArray(input.milestones)
  ) throw new Error("Scale rebuild completion timing evidence is invalid");
  const uploadCompletedAtMs = startedAtMs + input.uploadDurationMs;
  const graphCompletedAtMs = firstMilestoneAt(input.milestones, (milestone) =>
    milestone.graphNodes === input.fileCount);
  const sourceCompletedAtMs = firstMilestoneAt(input.milestones, (milestone) =>
    milestone.readySources === input.fileCount && milestone.liveSourceWork === 0);
  const activationCompletedAtMs = firstMilestoneAt(input.milestones, (milestone) =>
    milestone.activeSnapshots === 1
    && milestone.activeSourceCatalogEntries === input.fileCount);
  const publicationCompletedAtMs = firstMilestoneAt(input.milestones, (milestone) =>
    milestone.activeSnapshots === 1
    && milestone.activeSourceCatalogEntries === input.fileCount
    && milestone.livePublicationWork === 0
    && milestone.liveSearchWork === 0);
  const totalCompletedAtMs = publicationCompletedAtMs;
  const times = {
    uploadCompletedAtMs,
    sourceCompletedAtMs,
    graphCompletedAtMs,
    publicationCompletedAtMs,
    activationCompletedAtMs,
    totalCompletedAtMs
  };
  if (Object.values(times).some((value) =>
    !Number.isFinite(value) || value < uploadCompletedAtMs)) {
    throw new Error("Scale rebuild completion timing evidence is incomplete");
  }
  return times;
}

function firstMilestoneAt(milestones, predicate) {
  for (const milestone of milestones) {
    if (!predicate(milestone)) continue;
    const at = Date.parse(milestone?.at ?? "");
    if (Number.isFinite(at)) return at;
  }
  return Number.NaN;
}

function assertProof(proof) {
  if (
    !proof
    || !RUN_ID_PATTERN.test(proof.runId ?? "")
    || !path.isAbsolute(proof.filesystemScope ?? "")
    || path.basename(proof.filesystemScope) !== proof.runId
    || typeof proof.postgresScope !== "string"
    || !proof.postgresScope.startsWith("focowiki_svnext_")
    || typeof proof.objectScope !== "string"
    || !proof.objectScope.includes(proof.runId)
    || typeof proof.searchScope !== "string"
    || !proof.searchScope.startsWith("svnext_")
    || typeof proof.coordinationScope !== "string"
    || !proof.coordinationScope.includes(proof.runId)
  ) throw new Error("Scale runtime proof scope is invalid");
}

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for scale runtime`);
  return value;
}

function localUrl(value, name) {
  const url = new URL(value);
  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new Error(`${name} must use an isolated loopback endpoint`);
  }
  return url;
}

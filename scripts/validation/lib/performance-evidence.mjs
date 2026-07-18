import { spawnSync } from "node:child_process";

const DEFAULT_MAX_ENDPOINT_MS = 5_000;
const DEFAULT_MAX_MUTATION_ENDPOINT_MS = 30_000;
const DEFAULT_MAX_SOURCE_FILE_DURATION_MS = 900_000;
const DEFAULT_MAX_MEMORY_DELTA_MB = 512;
const MAX_RECORDED_ENDPOINTS = 200;

export function createPerformanceEvidence(env = process.env) {
  return {
    budgets: {
      maxEndpointMs: readPositiveInteger(env.FOCOWIKI_VALIDATION_MAX_ENDPOINT_MS, DEFAULT_MAX_ENDPOINT_MS),
      maxMutationEndpointMs: readPositiveInteger(
        env.FOCOWIKI_VALIDATION_MAX_MUTATION_ENDPOINT_MS,
        DEFAULT_MAX_MUTATION_ENDPOINT_MS
      ),
      maxSourceFileDurationMs: readPositiveInteger(
        env.FOCOWIKI_VALIDATION_MAX_SOURCE_FILE_DURATION_MS ?? env.FOCOWIKI_VALIDATION_MAX_TASK_DURATION_MS,
        DEFAULT_MAX_SOURCE_FILE_DURATION_MS
      ),
      maxMemoryDeltaMb: readPositiveInteger(
        env.FOCOWIKI_VALIDATION_MAX_MEMORY_DELTA_MB,
        DEFAULT_MAX_MEMORY_DELTA_MB
      )
    },
    endpointTimings: [],
    sourceFileDurations: [],
    pagination: [],
    operationalSnapshots: [],
    runtimeResources: [],
    memory: {
      startHeapMb: currentHeapMb(),
      startRssMb: currentRssMb(),
      endHeapMb: null,
      endRssMb: null,
      deltaHeapMb: null,
      deltaRssMb: null
    }
  };
}

export function recordEndpointTiming(evidence, input) {
  if (!evidence || evidence.endpointTimings.length >= MAX_RECORDED_ENDPOINTS) {
    return;
  }

  evidence.endpointTimings.push({
    method: String(input.method ?? "GET").toUpperCase(),
    pathname: redactRuntimePath(input.pathname),
    status: Number(input.status ?? 0),
    durationMs: Math.round(Number(input.durationMs ?? 0))
  });
}

export function recordSourceFileDuration(evidence, sourceFile) {
  if (!evidence || !sourceFile?.processingStartedAt || !sourceFile?.processingEndedAt) {
    return;
  }

  const startedAt = Date.parse(sourceFile.processingStartedAt);
  const endedAt = Date.parse(sourceFile.processingEndedAt);

  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt) {
    return;
  }

  evidence.sourceFileDurations.push({
    fileId: sourceFile.id || sourceFile.fileId ? "<source-file>" : null,
    status: sourceFile.state ?? "unknown",
    durationMs: endedAt - startedAt
  });
}

export function recordPaginationEvidence(evidence, name, details = {}) {
  if (!evidence) {
    return;
  }

  evidence.pagination.push({
    name,
    expectedSourceCount: safeNumber(details.expectedSourceCount),
    observedPages: safeNumber(details.observedPages),
    itemCount: safeNumber(details.itemCount)
  });
}

export function recordOperationalSnapshot(evidence, name, details = {}) {
  if (!evidence) {
    return;
  }

  evidence.operationalSnapshots.push({
    name,
    queueDepth: safeNumber(details.queueDepth),
    runningSourceFiles: safeNumber(details.runningSourceFiles),
    completedSourceFiles: safeNumber(details.completedSourceFiles),
    failedSourceFiles: safeNumber(details.failedSourceFiles),
    visibleSourceFiles: safeNumber(details.visibleSourceFiles),
    publicationJobs: safeNumber(details.publicationJobs),
    activePublicationJobs: safeNumber(details.activePublicationJobs),
    releaseCount: safeNumber(details.releaseCount)
  });
}

export function recordConfiguredRuntimeResources(evidence, env = process.env) {
  recordProcessResource(evidence, "api", env.FOCOWIKI_VALIDATION_API_PID);
  recordProcessResource(evidence, "worker", env.FOCOWIKI_VALIDATION_WORKER_PID);
}

export function finalizePerformanceEvidence(evidence, run = {}) {
  evidence.memory.endHeapMb = currentHeapMb();
  evidence.memory.endRssMb = currentRssMb();
  evidence.memory.deltaHeapMb = roundMb(evidence.memory.endHeapMb - evidence.memory.startHeapMb);
  evidence.memory.deltaRssMb = roundMb(evidence.memory.endRssMb - evidence.memory.startRssMb);

  const batchMinimum = Number(run.largeScaleMinBatchFiles ?? 0);

  if (
    run.profile === "large-scale" &&
    Number.isSafeInteger(batchMinimum) &&
    batchMinimum > 0 &&
    run.batchSampleCount < batchMinimum
  ) {
    throw new Error(`Large-scale validation requires at least ${batchMinimum} batch files.`);
  }

  const endpointDurations = evidence.endpointTimings.map((item) => item.durationMs);
  const readEndpointDurations = evidence.endpointTimings
    .filter((item) => isReadEndpoint(item.method))
    .map((item) => item.durationMs);
  const mutationEndpointDurations = evidence.endpointTimings
    .filter((item) => !isReadEndpoint(item.method))
    .map((item) => item.durationMs);
  const sourceFileDurations = evidence.sourceFileDurations.map((item) => item.durationMs);
  const maxEndpointMs = max(endpointDurations);
  const maxReadEndpointMs = max(readEndpointDurations);
  const maxMutationEndpointMs = max(mutationEndpointDurations);
  const maxSourceFileDurationMs = max(sourceFileDurations);
  const budgetFailures = [];

  if (maxReadEndpointMs > evidence.budgets.maxEndpointMs) {
    budgetFailures.push("endpoint latency");
  }

  if (maxMutationEndpointMs > evidence.budgets.maxMutationEndpointMs) {
    budgetFailures.push("mutation endpoint latency");
  }

  if (maxSourceFileDurationMs > evidence.budgets.maxSourceFileDurationMs) {
    budgetFailures.push("source-file duration");
  }

  if (evidence.memory.deltaHeapMb > evidence.budgets.maxMemoryDeltaMb) {
    budgetFailures.push("memory growth");
  }

  return {
    ok: budgetFailures.length === 0,
    budgets: evidence.budgets,
    endpointTimings: {
      count: endpointDurations.length,
      maxMs: maxEndpointMs,
      maxReadMs: maxReadEndpointMs,
      maxMutationMs: maxMutationEndpointMs,
      p50Ms: percentile(endpointDurations, 0.5),
      p95Ms: percentile(endpointDurations, 0.95),
      readP50Ms: percentile(readEndpointDurations, 0.5),
      readP95Ms: percentile(readEndpointDurations, 0.95),
      mutationP50Ms: percentile(mutationEndpointDurations, 0.5),
      mutationP95Ms: percentile(mutationEndpointDurations, 0.95),
      averageMs: average(endpointDurations),
      slowest: [...evidence.endpointTimings]
        .sort((left, right) => right.durationMs - left.durationMs)
        .slice(0, 10)
    },
    sourceFileDurations: {
      count: sourceFileDurations.length,
      maxMs: maxSourceFileDurationMs,
      p50Ms: percentile(sourceFileDurations, 0.5),
      p95Ms: percentile(sourceFileDurations, 0.95),
      averageMs: average(sourceFileDurations),
      items: evidence.sourceFileDurations
    },
    pagination: evidence.pagination,
    operationalSnapshots: evidence.operationalSnapshots,
    runtimeResources: evidence.runtimeResources,
    memory: evidence.memory,
    budgetFailures
  };
}

function recordProcessResource(evidence, name, rawPid) {
  if (!evidence || !rawPid) {
    return;
  }

  const pid = Number(rawPid);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    evidence.runtimeResources.push({ name, pid: null, rssMb: null, status: "invalid_pid" });
    return;
  }

  const result = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], {
    encoding: "utf8"
  });
  const rssKb = Number(result.stdout.trim());

  evidence.runtimeResources.push({
    name,
    pid,
    rssMb: Number.isFinite(rssKb) && rssKb > 0 ? roundMb(rssKb / 1024) : null,
    status: result.status === 0 ? "ok" : "unavailable"
  });
}

function readPositiveInteger(value, fallback) {
  const parsed = Number(value ?? fallback);

  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function safeNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function max(values) {
  return values.length ? Math.max(...values) : 0;
}

function average(values) {
  if (!values.length) {
    return 0;
  }

  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function percentile(values, rank) {
  if (!values.length) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil(sorted.length * rank) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))] ?? 0;
}

function isReadEndpoint(method) {
  return ["GET", "HEAD", "OPTIONS"].includes(String(method).toUpperCase());
}

function currentHeapMb() {
  return roundMb(process.memoryUsage().heapUsed / 1024 / 1024);
}

function currentRssMb() {
  return roundMb(process.memoryUsage().rss / 1024 / 1024);
}

function roundMb(value) {
  return Math.round(value * 100) / 100;
}

function redactRuntimePath(pathname) {
  return String(pathname ?? "")
    .replace(/[0-9a-f]{8,}-[0-9a-f-]{8,}/gi, "<id>")
    .replace(/\/source-[A-Za-z0-9-]+/g, "/<source>")
    .replace(/\/kb-[A-Za-z0-9-]+/g, "/<kb>")
    .replace(/(cursor|sourceCursor)=[^&]+/gi, "$1=<cursor>");
}

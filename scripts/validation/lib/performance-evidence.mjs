const DEFAULT_MAX_ENDPOINT_MS = 5_000;
const DEFAULT_MAX_TASK_DURATION_MS = 900_000;
const DEFAULT_MAX_MEMORY_DELTA_MB = 512;
const MAX_RECORDED_ENDPOINTS = 200;

export function createPerformanceEvidence(env = process.env) {
  return {
    budgets: {
      maxEndpointMs: readPositiveInteger(env.FOCOWIKI_VALIDATION_MAX_ENDPOINT_MS, DEFAULT_MAX_ENDPOINT_MS),
      maxTaskDurationMs: readPositiveInteger(
        env.FOCOWIKI_VALIDATION_MAX_TASK_DURATION_MS,
        DEFAULT_MAX_TASK_DURATION_MS
      ),
      maxMemoryDeltaMb: readPositiveInteger(
        env.FOCOWIKI_VALIDATION_MAX_MEMORY_DELTA_MB,
        DEFAULT_MAX_MEMORY_DELTA_MB
      )
    },
    endpointTimings: [],
    taskDurations: [],
    pagination: [],
    memory: {
      startHeapMb: currentHeapMb(),
      endHeapMb: null,
      deltaHeapMb: null
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

export function recordTaskDuration(evidence, task) {
  if (!evidence || !task?.startedAt || !task?.endedAt) {
    return;
  }

  const startedAt = Date.parse(task.startedAt);
  const endedAt = Date.parse(task.endedAt);

  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt) {
    return;
  }

  evidence.taskDurations.push({
    operation: task.operation ?? "unknown",
    sourceCount: Number.isSafeInteger(task.sourceCount) ? task.sourceCount : null,
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

export function finalizePerformanceEvidence(evidence, run = {}) {
  evidence.memory.endHeapMb = currentHeapMb();
  evidence.memory.deltaHeapMb = roundMb(evidence.memory.endHeapMb - evidence.memory.startHeapMb);

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
  const taskDurations = evidence.taskDurations.map((item) => item.durationMs);
  const maxEndpointMs = max(endpointDurations);
  const maxTaskDurationMs = max(taskDurations);
  const budgetFailures = [];

  if (maxEndpointMs > evidence.budgets.maxEndpointMs) {
    budgetFailures.push("endpoint latency");
  }

  if (maxTaskDurationMs > evidence.budgets.maxTaskDurationMs) {
    budgetFailures.push("task duration");
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
      averageMs: average(endpointDurations),
      slowest: [...evidence.endpointTimings]
        .sort((left, right) => right.durationMs - left.durationMs)
        .slice(0, 10)
    },
    taskDurations: {
      count: taskDurations.length,
      maxMs: maxTaskDurationMs,
      averageMs: average(taskDurations),
      items: evidence.taskDurations
    },
    pagination: evidence.pagination,
    memory: evidence.memory,
    budgetFailures
  };
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

function currentHeapMb() {
  return roundMb(process.memoryUsage().heapUsed / 1024 / 1024);
}

function roundMb(value) {
  return Math.round(value * 100) / 100;
}

function redactRuntimePath(pathname) {
  return String(pathname ?? "")
    .replace(/[0-9a-f]{8,}-[0-9a-f-]{8,}/gi, "<id>")
    .replace(/\/task-[A-Za-z0-9-]+/g, "/<task>")
    .replace(/\/kb-[A-Za-z0-9-]+/g, "/<kb>")
    .replace(/(cursor|sourceCursor)=[^&]+/gi, "$1=<cursor>");
}

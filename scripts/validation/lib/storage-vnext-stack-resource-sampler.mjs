const CONTAINER_SERVICES = Object.freeze([
  "postgres",
  "redis",
  "meilisearch",
  "minio"
]);
const RUNTIME_PROCESSES = Object.freeze([
  "/apps/api/runtime/main.mjs",
  "/apps/api/runtime/source-worker.mjs",
  "/apps/api/runtime/publication-worker.mjs",
  "/apps/api/runtime/maintenance-worker.mjs"
]);
const COVERAGE_TOLERANCE_MS = 1_000;

export function createStorageVnextStackResourceSampler(input) {
  if (typeof input?.capture !== "function") {
    throw new Error("Stack resource sampler capture is required");
  }
  const intervalMs = positiveInteger(input.intervalMs, "stack resource sample interval");
  const samples = [];
  let timer = null;
  let captureChain = Promise.resolve();
  let failure = null;
  let started = false;
  let stopped = false;

  function queueCapture() {
    captureChain = captureChain.then(async () => {
      if (failure) return;
      try {
        samples.push(validateSample(await input.capture()));
      } catch (error) {
        failure = error;
      }
    });
    return captureChain;
  }

  return {
    async start() {
      if (started) throw new Error("Stack resource sampler already started");
      started = true;
      await queueCapture();
      if (failure) throw failure;
      timer = setInterval(() => void queueCapture(), intervalMs);
      timer.unref();
    },
    async stop() {
      if (!started) throw new Error("Stack resource sampler was not started");
      if (stopped) throw new Error("Stack resource sampler already stopped");
      stopped = true;
      clearInterval(timer);
      await queueCapture();
      if (failure) throw failure;
      return summarizeStorageVnextStackResourceSamples(samples);
    }
  };
}

export async function captureStorageVnextStackResourceSample(input) {
  if (typeof input?.execFile !== "function") {
    throw new Error("Stack resource sampler execFile is required");
  }
  const project = requiredString(input.composeProject, "stack resource compose project");
  const composeFile = requiredString(input.composeFile, "stack resource compose file");
  const cwd = requiredString(input.cwd, "stack resource working directory");
  const [processResult, ...containerResults] = await Promise.all([
    input.execFile("ps", ["-ax", "-o", "rss=,command="], {
      cwd,
      env: input.env,
      maxBuffer: 10 * 1024 * 1024
    }),
    ...CONTAINER_SERVICES.map((service) => input.execFile("docker", [
      "compose", "-p", project, "-f", composeFile,
      "exec", "-T", service, "cat", "/sys/fs/cgroup/memory.current"
    ], {
      cwd,
      env: input.env,
      maxBuffer: 1024 * 1024
    }))
  ]);
  const applicationRssBytes = parseApplicationRssBytes(processResult.stdout);
  const containers = Object.fromEntries(CONTAINER_SERVICES.map((service, index) => [
    service,
    { currentMemoryBytes: nonnegativeInteger(containerResults[index].stdout.trim(), service) }
  ]));
  return validateSample({
    at: new Date().toISOString(),
    applicationRssBytes,
    containers
  });
}

export function summarizeStorageVnextStackResourceSamples(samples) {
  if (!Array.isArray(samples) || samples.length < 2) {
    throw new Error("At least two concurrent stack resource samples are required");
  }
  const validated = samples.map(validateSample);
  const ordered = [...validated].sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  const maximum = ordered.reduce((current, sample) => (
    sample.stackRssBytes > current.stackRssBytes ? sample : current
  ));
  return Object.freeze({
    kind: "focowiki-storage-vnext-concurrent-stack-resources",
    version: 1,
    sampleCount: ordered.length,
    startedAt: ordered[0].at,
    finishedAt: ordered.at(-1).at,
    maximumStackRssBytes: maximum.stackRssBytes,
    maximumApplicationRssBytes: Math.max(...ordered.map((sample) => sample.applicationRssBytes)),
    maximumMeilisearchRssBytes: Math.max(
      ...ordered.map((sample) => sample.containers.meilisearch.currentMemoryBytes)
    ),
    maximumSample: maximum
  });
}

export function mergeStorageVnextStackResourceSampleSummaries(summaries) {
  if (!Array.isArray(summaries) || summaries.length < 1) {
    throw new Error("At least one stack resource sampling segment is required");
  }
  const validated = summaries.map(validateSummary);
  const maximum = validated.reduce((current, summary) => (
    summary.maximumStackRssBytes > current.maximumStackRssBytes ? summary : current
  ));
  return Object.freeze({
    kind: "focowiki-storage-vnext-concurrent-stack-resources",
    version: 1,
    segmentCount: validated.reduce(
      (total, summary) => total + summary.segmentCount,
      0
    ),
    sampleCount: validated.reduce((total, summary) => total + summary.sampleCount, 0),
    startedAt: validated.reduce((earliest, summary) => (
      Date.parse(summary.startedAt) < Date.parse(earliest) ? summary.startedAt : earliest
    ), validated[0].startedAt),
    finishedAt: validated.reduce((latest, summary) => (
      Date.parse(summary.finishedAt) > Date.parse(latest) ? summary.finishedAt : latest
    ), validated[0].finishedAt),
    maximumStackRssBytes: maximum.maximumStackRssBytes,
    maximumApplicationRssBytes: Math.max(
      ...validated.map((summary) => summary.maximumApplicationRssBytes)
    ),
    maximumMeilisearchRssBytes: Math.max(
      ...validated.map((summary) => summary.maximumMeilisearchRssBytes)
    ),
    maximumSample: maximum.maximumSample
  });
}

export function selectStorageVnextPeakStackEvidence(input) {
  if (hasCompleteCoverage(
    input.sampling,
    input.rebuildStartedAt,
    input.rebuildFinishedAt
  )) {
    return {
      peakApplicationRssBytes: input.sampling.maximumApplicationRssBytes,
      peakStackRssBytes: input.sampling.maximumStackRssBytes,
      basis: "concurrent full-rebuild samples",
      acceptanceReady: true
    };
  }
  const peakApplicationRssBytes = nonnegativeInteger(
    input.peakApplicationRssBytes,
    "peak application RSS"
  );
  const peakStackRssBytes = nonnegativeInteger(
    peakApplicationRssBytes,
    "peak application RSS"
  ) + Object.values(input.containers ?? {}).reduce(
    (total, container) => total + nonnegativeInteger(
      container?.peakMemoryBytes,
      "container peak memory"
    ),
    0
  );
  return {
    peakApplicationRssBytes,
    peakStackRssBytes,
    basis: "non-concurrent historical peak upper bound",
    acceptanceReady: false
  };
}

function hasCompleteCoverage(sampling, rebuildStartedAt, rebuildFinishedAt) {
  if (
    sampling?.kind !== "focowiki-storage-vnext-concurrent-stack-resources"
    || sampling.version !== 1
    || !Number.isSafeInteger(sampling.sampleCount)
    || sampling.sampleCount < 2
    || !Number.isSafeInteger(sampling.maximumStackRssBytes)
    || sampling.maximumStackRssBytes < 0
  ) return false;
  const sampleStart = Date.parse(sampling.startedAt);
  const sampleEnd = Date.parse(sampling.finishedAt);
  const rebuildStart = Date.parse(rebuildStartedAt);
  const rebuildEnd = Date.parse(rebuildFinishedAt);
  return [sampleStart, sampleEnd, rebuildStart, rebuildEnd].every(Number.isFinite)
    && sampleStart <= rebuildStart + COVERAGE_TOLERANCE_MS
    && sampleEnd >= rebuildEnd - COVERAGE_TOLERANCE_MS;
}

function validateSummary(summary) {
  if (
    summary?.kind !== "focowiki-storage-vnext-concurrent-stack-resources"
    || summary.version !== 1
  ) throw new Error("Stack resource sampling segment is invalid");
  const sampleCount = positiveInteger(summary.sampleCount, "stack resource sample count");
  const segmentCount = summary.segmentCount === undefined
    ? 1
    : positiveInteger(summary.segmentCount, "stack resource segment count");
  const startedAt = requiredString(summary.startedAt, "stack resource sampling start");
  const finishedAt = requiredString(summary.finishedAt, "stack resource sampling finish");
  if (
    !Number.isFinite(Date.parse(startedAt))
    || !Number.isFinite(Date.parse(finishedAt))
    || Date.parse(startedAt) > Date.parse(finishedAt)
  ) throw new Error("Stack resource sampling segment timestamps are invalid");
  const maximumSample = validateSample(summary.maximumSample);
  const maximumStackRssBytes = nonnegativeInteger(
    summary.maximumStackRssBytes,
    "maximum stack RSS"
  );
  if (maximumSample.stackRssBytes !== maximumStackRssBytes) {
    throw new Error("Stack resource sampling maximum is inconsistent");
  }
  return {
    sampleCount,
    segmentCount,
    startedAt,
    finishedAt,
    maximumStackRssBytes,
    maximumApplicationRssBytes: nonnegativeInteger(
      summary.maximumApplicationRssBytes,
      "maximum application RSS"
    ),
    maximumMeilisearchRssBytes: nonnegativeInteger(
      summary.maximumMeilisearchRssBytes,
      "maximum Meilisearch RSS"
    ),
    maximumSample
  };
}

function validateSample(sample) {
  const at = requiredString(sample?.at, "stack resource sample timestamp");
  if (!Number.isFinite(Date.parse(at))) {
    throw new Error("Stack resource sample timestamp is invalid");
  }
  const applicationRssBytes = nonnegativeInteger(
    sample.applicationRssBytes,
    "application RSS"
  );
  const containers = Object.fromEntries(CONTAINER_SERVICES.map((service) => [
    service,
    {
      currentMemoryBytes: nonnegativeInteger(
        sample.containers?.[service]?.currentMemoryBytes,
        `${service} current memory`
      )
    }
  ]));
  return Object.freeze({
    at,
    applicationRssBytes,
    containers,
    stackRssBytes: applicationRssBytes + Object.values(containers).reduce(
      (total, container) => total + container.currentMemoryBytes,
      0
    )
  });
}

function parseApplicationRssBytes(output) {
  const matches = [];
  for (const line of String(output).split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/u);
    if (!match || !RUNTIME_PROCESSES.some((suffix) => match[2].includes(suffix))) continue;
    matches.push(nonnegativeInteger(match[1], "application RSS") * 1_024);
  }
  if (matches.length !== RUNTIME_PROCESSES.length) {
    throw new Error("Stack resource sampler did not find every runtime process");
  }
  return matches.reduce((total, value) => total + value, 0);
}

function nonnegativeInteger(value, label) {
  const parsed = typeof value === "string" && /^\d+$/u.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function positiveInteger(value, label) {
  const parsed = nonnegativeInteger(value, label);
  if (parsed < 1) throw new Error(`${label} must be positive`);
  return parsed;
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

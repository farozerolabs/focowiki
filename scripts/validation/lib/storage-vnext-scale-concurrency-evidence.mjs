const REQUIRED_SURFACES = Object.freeze([
  "admin-poll",
  "openapi-poll",
  "public-read"
]);
const REQUIRED_LIFECYCLES = Object.freeze([
  "upload",
  "modification",
  "deletion",
  "maintenance"
]);
const MINIMUM_SAMPLES_PER_SURFACE = 10;

export function summarizeStorageVnextScaleConcurrencyEvidence(input) {
  if (input.childExitCode !== 0) {
    throw new Error("Scale interleaved lifecycle process failed");
  }
  assertScenario(input.scenario);
  if (!Array.isArray(input.samples) || input.samples.some((sample) => !sample.ok)) {
    throw new Error("Scale concurrent polling request failed");
  }

  const scenarioStartedAtMs = Date.parse(input.scenario.startedAt);
  const scenarioCompletedAtMs = Date.parse(input.scenario.completedAt);
  const surfaces = REQUIRED_SURFACES.map((surface) => {
    const samples = input.samples.filter((sample) => sample.surface === surface);
    if (samples.length < MINIMUM_SAMPLES_PER_SURFACE) {
      throw new Error("Scale concurrent polling surface is incomplete");
    }
    for (const sample of samples) {
      if (
        !Number.isFinite(sample.durationMs)
        || sample.durationMs < 0
        || !Number.isFinite(Date.parse(sample.startedAt))
        || !Number.isFinite(Date.parse(sample.finishedAt))
      ) throw new Error("Scale concurrent polling sample is invalid");
    }
    const firstStartedAtMs = Math.min(...samples.map((sample) => Date.parse(sample.startedAt)));
    const lastFinishedAtMs = Math.max(...samples.map((sample) => Date.parse(sample.finishedAt)));
    if (
      firstStartedAtMs > scenarioStartedAtMs
      || lastFinishedAtMs < scenarioCompletedAtMs
    ) throw new Error("Scale concurrent polling does not cover the lifecycle window");
    return {
      surface,
      requestCount: samples.length,
      p95Ms: round(percentile(samples.map((sample) => sample.durationMs), 0.95)),
      maximumMs: round(Math.max(...samples.map((sample) => sample.durationMs)))
    };
  });

  return {
    scenarioId: input.scenario.scenarioId,
    scenarioOutcome: input.scenario.outcome,
    requestCount: surfaces.reduce((sum, surface) => sum + surface.requestCount, 0),
    failedRequestCount: 0,
    surfaces
  };
}

function assertScenario(scenario) {
  const startedAtMs = Date.parse(scenario?.startedAt ?? "");
  const completedAtMs = Date.parse(scenario?.completedAt ?? "");
  if (
    !scenario?.scenarioId
    || !["succeeded", "conflicted"].includes(scenario.outcome)
    || scenario.errorCode !== null
    || !Number.isFinite(startedAtMs)
    || !Number.isFinite(completedAtMs)
    || completedAtMs < startedAtMs
  ) throw new Error("Scale interleaved lifecycle scenario failed");
  const lifecycleOutcomes = scenario.lifecycleOutcomes;
  const lifecycles = Array.isArray(lifecycleOutcomes)
    ? lifecycleOutcomes.map((item) => item.lifecycle)
    : [];
  if (
    lifecycles.length !== REQUIRED_LIFECYCLES.length
    || new Set(lifecycles).size !== lifecycles.length
    || REQUIRED_LIFECYCLES.some((lifecycle) => !lifecycles.includes(lifecycle))
    || lifecycleOutcomes.some((item) => !["completed", "failed"].includes(item.state))
  ) throw new Error("Scale interleaved lifecycle evidence is incomplete");
  if (lifecycleOutcomes.find((item) => item.lifecycle === "upload")?.state !== "completed") {
    throw new Error("Scale interleaved upload did not complete");
  }
  if (
    lifecycleOutcomes.find((item) => item.lifecycle === "maintenance")?.state
      !== "completed"
  ) throw new Error("Scale interleaved maintenance did not complete");
}

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}

function round(value) {
  return Math.round(value * 1_000) / 1_000;
}

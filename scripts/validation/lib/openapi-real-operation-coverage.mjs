const HTTP_METHODS = new Set(["delete", "get", "patch", "post", "put"]);
const AUTHORIZATION_MODES = new Set(["authenticated", "unauthenticated"]);
const PERFORMANCE_PHASES = new Set(["cold", "warm", "concurrent"]);

export function createOpenApiOperationCoverage(openApiDocument) {
  const operations = collectOperations(openApiDocument);
  const attemptsByOperation = new Map(
    operations.map((operation) => [operation.operationId, []])
  );

  return {
    operationCount: operations.length,

    record(input) {
      const method = String(input.method ?? "GET").toUpperCase();
      const pathname = new URL(String(input.pathname), "http://openapi.local").pathname;
      const authorization = String(input.authorization ?? "");
      const status = Number(input.status);
      if (!AUTHORIZATION_MODES.has(authorization)) {
        throw new Error(`Unsupported OpenAPI authorization mode: ${authorization}`);
      }
      if (!Number.isSafeInteger(status) || status < 100 || status > 599) {
        throw new Error(`Invalid OpenAPI response status: ${input.status}`);
      }
      const operation = operations.find(
        (candidate) => candidate.method === method && candidate.pattern.test(pathname)
      );
      if (!operation) {
        throw new Error(`${method} ${pathname} does not match a released OpenAPI operation.`);
      }
      const measurementPhase = input.measurementPhase ?? null;
      if (measurementPhase !== null && !PERFORMANCE_PHASES.has(measurementPhase)) {
        throw new Error(`Unsupported OpenAPI performance phase: ${measurementPhase}`);
      }
      const durationMs = measurementPhase === null
        ? null
        : finiteNonnegativeNumber(input.durationMs, "OpenAPI durationMs");
      const measurementWindowMs = input.measurementWindowMs === undefined
        ? null
        : finitePositiveNumber(input.measurementWindowMs, "OpenAPI measurementWindowMs");
      attemptsByOperation.get(operation.operationId).push({
        authorization,
        status,
        measurementPhase,
        durationMs,
        measurementWindowMs
      });
      return operation.operationId;
    },

    summary(options = {}) {
      const acceptedStatuses = options.acceptedAuthenticatedStatuses ?? {};
      const concurrentApplicable = new Set(
        options.concurrentApplicableOperationIds ?? []
      );
      const operationResults = operations.map((operation) => {
        const attempts = attemptsByOperation.get(operation.operationId);
        const unauthenticatedStatuses = uniqueStatuses(attempts, "unauthenticated");
        const authenticatedStatuses = uniqueStatuses(attempts, "authenticated");
        const authenticationVerified = unauthenticatedStatuses.includes(401);
        const operationAcceptedStatuses = acceptedStatuses[operation.operationId] ?? [];
        const businessPathVerified = authenticatedStatuses.some(
          (status) => (status >= 200 && status < 300)
            || operationAcceptedStatuses.includes(status)
        );
        const performance = summarizePerformance(
          attempts,
          operationAcceptedStatuses
        );
        return {
          operationId: operation.operationId,
          method: operation.method,
          path: operation.path,
          authenticationVerified,
          businessPathVerified,
          unauthenticatedStatuses,
          authenticatedStatuses,
          performance
        };
      });
      const missingAuthentication = operationResults
        .filter((operation) => !operation.authenticationVerified)
        .map((operation) => operation.operationId);
      const missingBusinessPath = operationResults
        .filter((operation) => !operation.businessPathVerified)
        .map((operation) => operation.operationId);
      const missingPerformance = operationResults.flatMap((operation) => {
        const missing = [];
        if (operation.performance.cold === null) missing.push("cold");
        if (operation.performance.warm === null) missing.push("warm");
        if (
          concurrentApplicable.has(operation.operationId)
          && operation.performance.concurrent === null
        ) missing.push("concurrent");
        return missing.map((phase) => `${operation.operationId}:${phase}`);
      });
      const performanceComplete = missingPerformance.length === 0;
      const requirePerformanceMeasurements =
        options.requirePerformanceMeasurements === true;
      return {
        operationCount: operationResults.length,
        complete: missingAuthentication.length === 0
          && missingBusinessPath.length === 0
          && (!requirePerformanceMeasurements || performanceComplete),
        missingAuthentication,
        missingBusinessPath,
        performanceComplete,
        missingPerformance,
        operations: operationResults
      };
    }
  };
}

function summarizePerformance(attempts, acceptedStatuses) {
  const measurements = attempts.filter((attempt) =>
    attempt.authorization === "authenticated"
      && attempt.measurementPhase !== null
      && attempt.durationMs !== null
  );
  return Object.fromEntries([...PERFORMANCE_PHASES].map((phase) => [
    phase,
    summarizePerformancePhase(
      measurements.filter((measurement) => measurement.measurementPhase === phase),
      acceptedStatuses,
      phase
    )
  ]));
}

function summarizePerformancePhase(measurements, acceptedStatuses, phase) {
  if (measurements.length === 0) return null;
  const durations = measurements.map((measurement) => measurement.durationMs);
  const acceptedCount = measurements.filter((measurement) =>
    (measurement.status >= 200 && measurement.status < 300)
      || acceptedStatuses.includes(measurement.status)
  ).length;
  const measurementWindowMs = phase === "concurrent"
    ? Math.max(...measurements.map((measurement) =>
      measurement.measurementWindowMs ?? measurement.durationMs))
    : durations.reduce((sum, duration) => sum + duration, 0);
  return {
    count: measurements.length,
    p50Ms: percentile(durations, 0.5),
    p90Ms: percentile(durations, 0.9),
    p95Ms: percentile(durations, 0.95),
    p99Ms: percentile(durations, 0.99),
    maxMs: Math.max(...durations),
    throughputPerSecond: round(
      measurementWindowMs === 0
        ? 0
        : measurements.length * 1_000 / measurementWindowMs
    ),
    errorRate: round((measurements.length - acceptedCount) / measurements.length),
    samples: measurements.map((measurement) => ({
      status: measurement.status,
      durationMs: round(measurement.durationMs),
      measurementWindowMs: measurement.measurementWindowMs === null
        ? null
        : round(measurement.measurementWindowMs)
    }))
  };
}

function percentile(values, rank) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * rank) - 1);
  return round(sorted[index]);
}

function finiteNonnegativeNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`${name} must be a finite nonnegative number.`);
  }
  return number;
}

function finitePositiveNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${name} must be a finite positive number.`);
  }
  return number;
}

function round(value) {
  return Number(Number(value).toFixed(3));
}

function collectOperations(document) {
  const operations = [];
  for (const [pathname, pathItem] of Object.entries(document?.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem ?? {})) {
      if (!HTTP_METHODS.has(method) || !operation?.operationId) continue;
      const parameterCount = (pathname.match(/\{[^}]+\}/gu) ?? []).length;
      operations.push({
        operationId: operation.operationId,
        method: method.toUpperCase(),
        path: pathname,
        pattern: compilePathPattern(pathname),
        parameterCount,
        literalLength: pathname.replace(/\{[^}]+\}/gu, "").length
      });
    }
  }
  operations.sort((left, right) =>
    left.parameterCount - right.parameterCount
      || right.literalLength - left.literalLength
      || left.operationId.localeCompare(right.operationId)
  );
  return operations;
}

function compilePathPattern(pathname) {
  const segments = pathname.split("/").map((segment) =>
    /^\{[^}]+\}$/u.test(segment) ? "[^/]+" : escapeRegularExpression(segment)
  );
  return new RegExp(`^${segments.join("/")}$`, "u");
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function uniqueStatuses(attempts, authorization) {
  return [...new Set(
    attempts
      .filter((attempt) => attempt.authorization === authorization)
      .map((attempt) => attempt.status)
  )].sort((left, right) => left - right);
}

const HTTP_METHODS = new Set(["delete", "get", "patch", "post", "put"]);

export function summarizeComprehensiveOpenApiPerformance(input) {
  const operations = collectOperations(input.document);
  const missing = [];
  validateLifecycleReport(input.coldReport, operations, "cold", missing);
  validateLifecycleReport(input.warmReport, operations, "warm", missing);
  if (!Array.isArray(input.concurrentReports) || input.concurrentReports.length < 1) {
    missing.push("*:concurrent");
  } else {
    for (const report of input.concurrentReports) {
      validateLifecycleReport(report, operations, "concurrent", missing);
    }
  }
  if (missing.length > 0) {
    throw new Error(`OpenAPI performance evidence is incomplete: ${[...new Set(missing)].join(", ")}`);
  }

  const concurrentWindowMs = measurementWindow(input.concurrentReports);
  const rows = operations.map((operation) => {
    const cold = requirePhase(input.coldReport, operation.operationId, "cold");
    const warm = requirePhase(input.warmReport, operation.operationId, "warm");
    const concurrentPhases = input.concurrentReports.map((report) =>
      requirePhase(report, operation.operationId, "concurrent"));
    const concurrentSamples = concurrentPhases.flatMap((phase) => phase.samples);
    const documentedStatuses = operation.documentedStatuses;
    const coldSummary = summarizeSamples(cold.samples, documentedStatuses);
    const warmSummary = summarizeSamples(warm.samples, documentedStatuses);
    const concurrentSummary = summarizeSamples(
      concurrentSamples,
      documentedStatuses,
      concurrentWindowMs
    );
    const maximumBudgetMs = operation.method === "GET" ? 5_000 : 30_000;
    const budgetPassed = [coldSummary, warmSummary, concurrentSummary]
      .every((summary) => summary.maxMs <= maximumBudgetMs);
    return {
      operationId: operation.operationId,
      method: operation.method,
      path: operation.path,
      maximumBudgetMs,
      budgetPassed,
      cold: coldSummary,
      warm: warmSummary,
      concurrent: concurrentSummary
    };
  });
  const failures = rows.flatMap((row) => {
    const failures = [];
    if (!row.budgetPassed) failures.push(`${row.operationId}:latency_budget`);
    for (const phase of ["cold", "warm", "concurrent"]) {
      if (row[phase].nominalErrorRate > 0) {
        failures.push(`${row.operationId}:${phase}:nominal_error`);
      }
    }
    return failures;
  });
  return {
    kind: "focowiki-comprehensive-openapi-operation-performance",
    version: 1,
    ok: failures.length === 0,
    operationCount: operations.length,
    completedOperationCount: rows.length,
    concurrentClientCount: input.concurrentReports.length,
    concurrentWindowMs,
    missing: [],
    failures,
    operations: rows
  };
}

function collectOperations(document) {
  const operations = [];
  for (const [routePath, pathItem] of Object.entries(document?.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem ?? {})) {
      if (!HTTP_METHODS.has(method) || !operation?.operationId) continue;
      operations.push({
        operationId: operation.operationId,
        method: method.toUpperCase(),
        path: routePath,
        documentedStatuses: new Set(
          Object.keys(operation.responses ?? {})
            .filter((status) => /^\d{3}$/u.test(status))
            .map(Number)
        )
      });
    }
  }
  return operations.sort((left, right) =>
    left.operationId.localeCompare(right.operationId, "en"));
}

function validateLifecycleReport(report, operations, phase, missing) {
  if (report?.ok !== true || report?.operationCoverage?.complete !== true) {
    throw new Error(`OpenAPI ${phase} lifecycle report is not complete`);
  }
  const rows = report.operationCoverage.operations ?? [];
  const byId = new Map(rows.map((row) => [row.operationId, row]));
  if (rows.length !== operations.length || byId.size !== operations.length) {
    for (const operation of operations) {
      if (!byId.has(operation.operationId)) missing.push(`${operation.operationId}:${phase}`);
    }
  }
  for (const operation of operations) {
    const measurement = byId.get(operation.operationId)?.performance?.[phase];
    if (!measurement || !Array.isArray(measurement.samples) || measurement.samples.length < 1) {
      missing.push(`${operation.operationId}:${phase}`);
    }
  }
}

function requirePhase(report, operationId, phase) {
  const row = report.operationCoverage.operations.find((operation) =>
    operation.operationId === operationId);
  return row.performance[phase];
}

function summarizeSamples(samples, documentedStatuses, windowMs = null) {
  const durations = samples.map((sample) => finiteNonnegative(
    sample.durationMs,
    "OpenAPI performance duration"
  ));
  const nominalErrors = samples.filter((sample) => {
    const status = Number(sample.status);
    return !(status >= 200 && status < 300)
      && !documentedStatuses.has(status);
  }).length;
  const effectiveWindowMs = windowMs ?? durations.reduce((sum, value) => sum + value, 0);
  return {
    count: samples.length,
    p50Ms: percentile(durations, 0.5),
    p90Ms: percentile(durations, 0.9),
    p95Ms: percentile(durations, 0.95),
    p99Ms: percentile(durations, 0.99),
    maxMs: round(Math.max(...durations)),
    throughputPerSecond: round(
      effectiveWindowMs === 0 ? 0 : samples.length * 1_000 / effectiveWindowMs
    ),
    nominalErrorRate: round(nominalErrors / samples.length)
  };
}

function measurementWindow(reports) {
  const starts = reports.map((report) => Date.parse(report.startedAt));
  const finishes = reports.map((report) => Date.parse(report.finishedAt));
  if ([...starts, ...finishes].some((value) => !Number.isFinite(value))) {
    throw new Error("OpenAPI concurrent measurement window is invalid");
  }
  const windowMs = Math.max(...finishes) - Math.min(...starts);
  if (windowMs <= 0) throw new Error("OpenAPI concurrent measurement window is empty");
  return windowMs;
}

function percentile(values, rank) {
  const sorted = [...values].sort((left, right) => left - right);
  return round(sorted[Math.max(0, Math.ceil(sorted.length * rank) - 1)]);
}

function finiteNonnegative(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${name} is invalid`);
  return number;
}

function round(value) {
  return Number(Number(value).toFixed(3));
}

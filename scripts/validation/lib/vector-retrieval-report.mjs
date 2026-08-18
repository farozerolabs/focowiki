import { rename, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ABSOLUTE_GATES = {
  ndcg10: { minimum: 0.85, code: "ndcg_at_10" },
  recall20: { minimum: 0.95, code: "recall_at_20" },
  mrr10: { minimum: 0.85, code: "mrr_at_10" },
  annRecall10: { minimum: 0.95, code: "ann_recall_at_10" },
  annRecall50: { minimum: 0.95, code: "ann_recall_at_50" },
  exactPathRecall10: { minimum: 1, code: "exact_path_recall_at_10" },
  exactTitleRecall10: { minimum: 1, code: "exact_title_recall_at_10" },
  noResultFalsePositiveRate: {
    maximum: 0.05,
    code: "no_result_false_positive_rate"
  },
  nominalErrorRate: { maximum: 0, code: "nominal_error_rate" }
};

const ABSOLUTE_REGRESSION_BUDGETS = {
  ndcg10: { tolerance: 0.01, code: "ndcg_at_10" },
  recall20: { tolerance: 0.01, code: "recall_at_20" },
  mrr10: { tolerance: 0.01, code: "mrr_at_10" },
  annRecall10: { tolerance: 0.01, code: "ann_recall_at_10" },
  annRecall50: { tolerance: 0.01, code: "ann_recall_at_50" },
  precision10: { tolerance: 0.02, code: "precision_at_10" },
  map10: { tolerance: 0.02, code: "map_at_10" }
};

const RELATIVE_REGRESSION_BUDGETS = {
  warmP95Ms: { direction: "increase", tolerance: 0.1, code: "warm_p95" },
  throughput: { direction: "decrease", tolerance: 0.1, code: "throughput" },
  peakCpuPercent: { direction: "increase", tolerance: 0.1, code: "peak_cpu" },
  peakRssBytes: { direction: "increase", tolerance: 0.1, code: "peak_rss" }
};

export function compareBenchmarkRun({ baseline, candidate }) {
  const baselineMetrics = requireMetrics(baseline?.metrics, "baseline");
  const candidateMetrics = requireMetrics(candidate?.metrics, "candidate");
  const comparability = baseline?.fingerprint?.sha256
    && baseline.fingerprint.sha256 === candidate?.fingerprint?.sha256
    ? "comparable"
    : "incomparable";
  const failures = new Set();

  for (const [field, gate] of Object.entries(ABSOLUTE_GATES)) {
    const value = requireMetric(candidateMetrics, field, "candidate");
    if (gate.minimum !== undefined && value < gate.minimum) failures.add(gate.code);
    if (gate.maximum !== undefined && value > gate.maximum) failures.add(gate.code);
  }

  if (comparability === "comparable") {
    for (const [field, budget] of Object.entries(ABSOLUTE_REGRESSION_BUDGETS)) {
      if (
        requireMetric(candidateMetrics, field, "candidate")
        < requireMetric(baselineMetrics, field, "baseline") - budget.tolerance
      ) failures.add(budget.code);
    }
    for (const [field, budget] of Object.entries(RELATIVE_REGRESSION_BUDGETS)) {
      const baselineValue = requireMetric(baselineMetrics, field, "baseline");
      const candidateValue = requireMetric(candidateMetrics, field, "candidate");
      const failed = budget.direction === "increase"
        ? candidateValue > baselineValue * (1 + budget.tolerance)
        : candidateValue < baselineValue * (1 - budget.tolerance);
      if (failed) failures.add(budget.code);
    }
    if (requireMetric(candidateMetrics, "exactTitleRecall10", "candidate")
      < requireMetric(baselineMetrics, "exactTitleRecall10", "baseline")) {
      failures.add("exact_title_recall_at_10");
    }
    if (requireMetric(candidateMetrics, "nominalErrorRate", "candidate")
      > requireMetric(baselineMetrics, "nominalErrorRate", "baseline")) {
      failures.add("nominal_error_rate");
    }
  }

  const failedBudgets = [...failures].sort();
  return Object.freeze({
    comparability,
    passed: failedBudgets.length === 0,
    failedBudgets
  });
}

export async function writeBenchmarkRunReport(input) {
  const root = requireRoot(input?.root);
  const runId = requireSafeName(input?.runId, "runId");
  const status = input?.status;
  if (status !== "passed" && status !== "failed") {
    throw new Error("Benchmark status must be passed or failed");
  }
  const runDirectory = join(root, "runs", runId);
  await mkdir(join(root, "runs"), { recursive: true });
  await mkdir(runDirectory, { recursive: false });
  const report = {
    format: "focowiki-vector-retrieval-run-v1",
    runId,
    status,
    createdAt: new Date().toISOString(),
    fingerprint: sanitizeFingerprint(input?.fingerprint),
    metrics: sanitizeNumberRecord(input?.metrics, "metrics"),
    thresholds: sanitizeNumberRecord(input?.thresholds ?? {}, "thresholds"),
    comparisons: sanitizeStructuredEvidence(input?.comparisons ?? {}),
    queryRegressions: sanitizeQueryRegressions(input?.queryRegressions ?? [])
  };
  await writeAtomicJson(join(runDirectory, "report.json"), report);
  await writeAtomicText(join(runDirectory, "summary.md"), renderSummary(report));
  await writeAtomicJson(join(root, "latest.json"), {
    format: "focowiki-vector-retrieval-latest-v1",
    runId,
    status,
    fingerprintSha256: report.fingerprint.sha256
  });
  return Object.freeze(report);
}

export async function promoteAcceptedBenchmarkBaseline(input) {
  const root = requireRoot(input?.root);
  const runIds = input?.runIds;
  if (!Array.isArray(runIds) || runIds.length !== 3) {
    throw new Error("Exactly three benchmark rounds are required for baseline promotion");
  }
  const safeRunIds = runIds.map((runId) => requireSafeName(runId, "runId"));
  if (new Set(safeRunIds).size !== safeRunIds.length) {
    throw new Error("Benchmark baseline rounds must be unique");
  }
  const reports = await Promise.all(safeRunIds.map(async (runId) =>
    JSON.parse(await readFile(join(root, "runs", runId, "report.json"), "utf8"))
  ));
  if (reports.some((report) => report.status !== "passed")) {
    throw new Error("Every promoted benchmark round must pass");
  }
  const fingerprintSha256 = reports[0]?.fingerprint?.sha256;
  if (!fingerprintSha256 || reports.some((report) =>
    report.fingerprint?.sha256 !== fingerprintSha256
  )) {
    throw new Error("Promoted benchmark rounds must have identical fingerprints");
  }
  const latest = reports.at(-1);
  const baseline = {
    format: "focowiki-vector-retrieval-baseline-v1",
    runId: latest.runId,
    promotedAt: new Date().toISOString(),
    promotedFromRunIds: safeRunIds,
    fingerprint: latest.fingerprint,
    metrics: latest.metrics
  };
  await writeAtomicJson(join(root, "accepted-baseline.json"), baseline);
  return Object.freeze(baseline);
}

function requireMetrics(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} metrics are required`);
  }
  return value;
}

function requireMetric(metrics, field, owner) {
  const value = metrics[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${owner} metric ${field} must be finite`);
  }
  return value;
}

function sanitizeFingerprint(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Benchmark fingerprint is required");
  }
  if (typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(value.sha256)) {
    throw new Error("Benchmark fingerprint SHA-256 is invalid");
  }
  return sanitizeStructuredEvidence(value);
}

function sanitizeNumberRecord(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return Object.fromEntries(Object.entries(value).map(([key, number]) => {
    requireSafeName(key, `${name} key`);
    if (typeof number !== "number" || !Number.isFinite(number)) {
      throw new Error(`${name}.${key} must be finite`);
    }
    return [key, number];
  }));
}

function sanitizeQueryRegressions(value) {
  if (!Array.isArray(value)) throw new Error("queryRegressions must be an array");
  return value.map((item) => {
    const result = { queryId: requireSafeName(item?.queryId, "query regression ID") };
    for (const field of ["delta", "beforeRank", "afterRank"]) {
      if (item?.[field] === undefined) continue;
      if (typeof item[field] !== "number" || !Number.isFinite(item[field])) {
        throw new Error(`Query regression ${field} must be finite`);
      }
      result[field] = item[field];
    }
    return result;
  });
}

function sanitizeStructuredEvidence(value, depth = 0) {
  if (depth > 8) throw new Error("Benchmark evidence nesting is too deep");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Benchmark evidence number must be finite");
    return value;
  }
  if (typeof value === "string") {
    if (value.length > 512 || /\p{C}|[\\/]|:\/\/|bearer\s|(?:password|secret|token|api[_-]?key)\s*=/iu.test(value)) {
      throw new Error("Benchmark evidence contains unsafe text");
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 1_000) throw new Error("Benchmark evidence array is too large");
    return value.map((item) => sanitizeStructuredEvidence(item, depth + 1));
  }
  if (!value || typeof value !== "object") {
    throw new Error("Benchmark evidence contains an unsupported value");
  }
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
    requireSafeName(key, "benchmark evidence key"),
    sanitizeStructuredEvidence(nested, depth + 1)
  ]));
}

function requireRoot(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Benchmark report root is required");
  }
  return value;
}

function requireSafeName(value, name) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

async function writeAtomicJson(path, value) {
  await writeAtomicText(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeAtomicText(path, value) {
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, value, { encoding: "utf8", flag: "wx" });
  await rename(temporaryPath, path);
}

function renderSummary(report) {
  return [
    "# Vector retrieval benchmark",
    "",
    `- Run: \`${report.runId}\``,
    `- Status: ${report.status}`,
    `- Fingerprint: \`${report.fingerprint.sha256}\``,
    "",
    "## Metrics",
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    ...Object.entries(report.metrics).map(([key, value]) => `| ${key} | ${value} |`),
    ""
  ].join("\n");
}

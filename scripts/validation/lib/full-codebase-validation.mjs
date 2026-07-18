import fs from "node:fs";
import path from "node:path";
import { redactReportText } from "./redaction.mjs";

export const DEFAULT_FULL_CODEBASE_REPORT_DIR =
  "ReferenceDocs/implement-incremental-sharded-publication";

const BASE_SURFACES = [
  {
    id: "admin-ui",
    owner: "admin app",
    coverage: ["browser", "i18n", "build"],
    boundedness: "Visible UI checks and cursor-backed Admin API calls only."
  },
  {
    id: "admin-api",
    owner: "api admin module",
    coverage: ["http", "unit", "safe-errors"],
    boundedness: "Requests must use pagination, filters, or exact identifiers."
  },
  {
    id: "developer-openapi",
    owner: "developer openapi module",
    coverage: ["http", "contract", "field-continuity", "rate-limit"],
    boundedness: "Requests must reuse returned identifiers and avoid Admin-only lookup."
  },
  {
    id: "runtime-config",
    owner: "api runtime config",
    coverage: ["unit", "env-template"],
    boundedness: "Config validation must report missing field names without printing values."
  },
  {
    id: "database-repositories",
    owner: "database repositories",
    coverage: ["unit", "bounded-diagnostics", "query-plan"],
    boundedness: "Diagnostics must be scoped by run ID, knowledge base ID, cursor, or exact IDs."
  },
  {
    id: "redis-coordination",
    owner: "redis coordination",
    coverage: ["unit", "bounded-diagnostics"],
    boundedness: "Diagnostics must avoid full Redis keyspace scans."
  },
  {
    id: "s3-storage",
    owner: "s3 storage",
    coverage: ["bounded-diagnostics", "safe-paths"],
    boundedness: "Object checks must use validation-owned keys or exact generated paths."
  },
  {
    id: "worker-queues",
    owner: "worker queue modules",
    coverage: ["unit", "queue-lifecycle", "cancellation"],
    boundedness: "Queue checks must use counts, IDs, and bounded batches."
  },
  {
    id: "publication",
    owner: "publication modules",
    coverage: ["unit", "generation-visibility", "incremental-shards"],
    boundedness: "Publication checks must inspect validation-owned generations only."
  },
  {
    id: "okf-generation",
    owner: "okf package",
    coverage: ["unit", "content"],
    boundedness: "Generated output checks must sample files and indexes, not load full corpora."
  },
  {
    id: "graph-and-search-indexes",
    owner: "okf package and search modules",
    coverage: ["content", "search-read-model", "pagination"],
    boundedness: "Search checks must use limits, cursors, and sampled content."
  },
  {
    id: "logging-audit",
    owner: "logging and audit modules",
    coverage: ["unit", "redaction"],
    boundedness: "Log checks must inspect bounded snippets and redacted reports."
  },
  {
    id: "docs-openapi",
    owner: "docs and openapi scripts",
    coverage: ["docs-build", "openapi-validation", "links"],
    boundedness: "Generated docs must not contain local paths or secrets."
  },
  {
    id: "runtime-packaging",
    owner: "api runtime build and Dockerfile",
    coverage: ["runtime-build", "compose-config"],
    boundedness: "Runtime smoke checks are optional when Docker is unavailable."
  },
  {
    id: "ci-scripts",
    owner: "package.json + .github/workflows",
    coverage: ["local-commands", "no-local-paths"],
    boundedness: "Local validation commands must not require production credentials by default."
  }
];

export function buildFullCodebaseValidationMatrix(config = {}) {
  return BASE_SURFACES.map((surface) => ({
    ...surface,
    status: surfaceStatus(surface, config),
    executable:
      surface.id !== "admin-ui" || config.includeBrowser
        ? surface.id !== "runtime-packaging" || config.includeDocker
          ? "configured"
          : "docker-optional"
        : "browser-optional"
  }));
}

export function summarizeFullCodebaseMatrix(matrix) {
  const surfaceCount = matrix.length;
  const configuredCount = matrix.filter((surface) => surface.executable === "configured").length;
  const optionalCount = surfaceCount - configuredCount;

  return {
    surfaceCount,
    configuredCount,
    optionalCount,
    surfaces: matrix.map((surface) => surface.id)
  };
}

export function createFullCodebaseReport(config, steps) {
  const matrix = buildFullCodebaseValidationMatrix(config);

  return {
    kind: "full-codebase-e2e",
    change: config.changeId,
    runId: config.runId,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    ok: false,
    command: config.command,
    profile: config.largeProfile ? "large-scale" : "default",
    source: {
      env: config.sampleSourceEnv,
      redactedRoot: `<${config.sampleSourceEnv}>`
    },
    config: {
      includeBrowser: config.includeBrowser,
      includeRepositoryChecks: config.includeRepositoryChecks,
      includeDocker: config.includeDocker,
      requireModel: config.requireModel,
      reportDir: "<FOCOWIKI_FULL_FLOW_REPORT_DIR>"
    },
    matrix,
    matrixSummary: summarizeFullCodebaseMatrix(matrix),
    resources: {
      currentRunOnly: true,
      knowledgeBases: [],
      sourceFiles: [],
      generatedFiles: [],
      webhooks: []
    },
    steps: steps.map((step) => ({
      id: step.id,
      layer: step.layer,
      command: step.safeCommand,
      status: "pending",
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      reportPath: step.safeReportPath ?? null
    })),
    checks: [],
    bugFixes: [],
    failures: [],
    cleanup: {
      currentRunOnly: true,
      deleted: [],
      skipped: [],
      unresolved: []
    },
    remainingRisks: [
      "External S3-compatible storage and model provider availability can affect full-flow runtime.",
      "Browser and Docker checks are controlled by explicit validation flags when local prerequisites are unavailable."
    ]
  };
}

export function writeFullCodebaseReport(reportDir, report) {
  fs.mkdirSync(reportDir, { recursive: true });
  const safeReport = JSON.parse(redactReportText(JSON.stringify(report, null, 2)));
  fs.writeFileSync(
    path.join(reportDir, "full-codebase-e2e-report.json"),
    `${JSON.stringify(safeReport, null, 2)}\n`
  );
  fs.writeFileSync(path.join(reportDir, "full-codebase-e2e-report.md"), renderMarkdown(safeReport));
}

function surfaceStatus(surface, config) {
  if (surface.id === "admin-ui" && !config.includeBrowser) {
    return "covered-by-build-and-optional-browser";
  }

  if (surface.id === "runtime-packaging" && !config.includeDocker) {
    return "runtime-build-covered-docker-optional";
  }

  return "covered";
}

function renderMarkdown(report) {
  return [
    "# Full-Codebase E2E Validation Report",
    "",
    `- Change: ${report.change}`,
    `- Run ID: ${report.runId}`,
    `- Kind: ${report.kind}`,
    `- Started at: ${report.startedAt}`,
    `- Finished at: ${report.finishedAt || "not-finished"}`,
    `- Result: ${report.ok ? "pass" : "fail"}`,
    `- Profile: ${report.profile}`,
    "",
    "## Matrix",
    "",
    `- Surfaces: ${report.matrixSummary.surfaceCount}`,
    `- Configured surfaces: ${report.matrixSummary.configuredCount}`,
    `- Optional surfaces: ${report.matrixSummary.optionalCount}`,
    "",
    ...report.matrix.map(
      (surface) =>
        `- ${surface.id}: ${surface.status}; owner ${surface.owner}; coverage ${surface.coverage.join(", ")}`
    ),
    "",
    "## Runtime",
    "",
    ...Object.entries(report.config).map(([key, value]) => `- ${key}: ${String(value)}`),
    "",
    "## Source",
    "",
    `- env: ${report.source.env}`,
    `- root: ${report.source.redactedRoot}`,
    "",
    "## Steps",
    "",
    ...report.steps.map(
      (step) =>
        `- ${step.status.toUpperCase()} ${step.id}: ${step.command}${
          step.durationMs === null ? "" : ` (${step.durationMs}ms)`
        }`
    ),
    "",
    "## Checks",
    "",
    ...(report.checks.length
      ? report.checks.map((check) => `- ${check.ok ? "PASS" : "FAIL"} [${check.layer}] ${check.name}: ${check.message}`)
      : ["- None recorded."]),
    "",
    "## Bug Fixes",
    "",
    ...(report.bugFixes.length ? report.bugFixes.map((item) => `- ${item}`) : ["- None recorded."]),
    "",
    "## Cleanup",
    "",
    `- Current-run only: ${report.cleanup.currentRunOnly ? "yes" : "no"}`,
    `- Deleted: ${report.cleanup.deleted.length}`,
    `- Skipped: ${report.cleanup.skipped.length}`,
    `- Unresolved: ${report.cleanup.unresolved.length}`,
    "",
    "## Failures",
    "",
    ...(report.failures.length ? report.failures.map((item) => `- ${item}`) : ["- None recorded."]),
    "",
    "## Remaining Risks",
    "",
    ...(report.remainingRisks.length ? report.remainingRisks.map((item) => `- ${item}`) : ["- None recorded."]),
    ""
  ].join("\n");
}

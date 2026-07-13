import fs from "node:fs";
import path from "node:path";
import { redactReportText } from "./redaction.mjs";

export const DEFAULT_LARGE_SCALE_FULL_SYSTEM_CHANGE_ID = "validate-large-scale-full-e2e";
export const DEFAULT_LARGE_SCALE_FULL_SYSTEM_REPORT_DIR =
  "ReferenceDocs/validate-large-scale-full-e2e";
export const ALLOW_CONFIGURED_EXTERNALS_ENV =
  "FOCOWIKI_LARGE_SCALE_FULL_SYSTEM_ALLOW_CONFIGURED_EXTERNALS";
export const FORCE_RERUN_ENV = "FOCOWIKI_LARGE_SCALE_FULL_SYSTEM_FORCE_RERUN";

export const ERROR_BOUNDARY_MATRIX = [
  {
    id: "admin-ui-boundary",
    surface: "Admin UI",
    cases: [
      "denied-session",
      "invalid-route",
      "failed-list-load",
      "failed-preview-load",
      "failed-mutation-response",
      "toast-recovery"
    ]
  },
  {
    id: "api-boundary",
    surface: "Admin API and Developer OpenAPI",
    cases: [
      "malformed-json",
      "invalid-multipart",
      "missing-required-fields",
      "invalid-identifiers",
      "invalid-cursors",
      "conflicting-operations",
      "canceled-request",
      "unsupported-content-type"
    ]
  },
  {
    id: "worker-publication-boundary",
    surface: "Worker and publication",
    cases: [
      "retryable-worker-failure",
      "non-retryable-source-file-failure",
      "publication-failure",
      "graph-failure",
      "cleanup-failure",
      "file-scoped-continue"
    ]
  },
  {
    id: "external-dependency-boundary",
    surface: "External dependencies",
    cases: [
      "model-timeout",
      "model-schema-failure",
      "s3-timeout",
      "redis-timeout",
      "postgres-timeout",
      "network-timeout",
      "bounded-retry"
    ]
  }
];

export const RESOURCE_EVIDENCE_MATRIX = [
  "api-memory",
  "worker-memory",
  "cpu-snapshots",
  "event-loop-delay",
  "postgres-sessions",
  "redis-indicators",
  "queue-depth",
  "publication-jobs",
  "source-file-throughput",
  "visible-file-throughput",
  "endpoint-latency"
];

export function readLargeScaleFullSystemConfig(command = "all", env = process.env) {
  const normalizedCommand = normalizeCommand(command);
  const sampleCount = readPositiveInteger(
    env.FOCOWIKI_LARGE_SCALE_SAMPLE_COUNT ?? env.FOCOWIKI_VALIDATION_SAMPLE_COUNT,
    200
  );
  const batchSampleCount = readPositiveInteger(
    env.FOCOWIKI_LARGE_SCALE_BATCH_SAMPLE_COUNT ?? env.FOCOWIKI_VALIDATION_BATCH_SAMPLE_COUNT,
    Math.max(sampleCount - 1, 1)
  );
  const minBatchFiles = readPositiveInteger(
    env.FOCOWIKI_LARGE_SCALE_MIN_BATCH_FILES ?? env.FOCOWIKI_VALIDATION_MIN_BATCH_FILES,
    Math.max(batchSampleCount, 1)
  );

  return {
    command: normalizedCommand,
    changeId:
      env.FOCOWIKI_LARGE_SCALE_FULL_SYSTEM_CHANGE_ID?.trim() ||
      env.FOCOWIKI_FULL_FLOW_CHANGE_ID?.trim() ||
      DEFAULT_LARGE_SCALE_FULL_SYSTEM_CHANGE_ID,
    reportDir: path.resolve(
      env.FOCOWIKI_LARGE_SCALE_FULL_SYSTEM_REPORT_DIR?.trim() ||
        env.FOCOWIKI_FULL_FLOW_REPORT_DIR?.trim() ||
        env.FOCOWIKI_VALIDATION_REPORT_DIR?.trim() ||
        DEFAULT_LARGE_SCALE_FULL_SYSTEM_REPORT_DIR
    ),
    sampleCount,
    batchSampleCount,
    minBatchFiles,
    contentSampleCount: readPositiveInteger(
      env.FOCOWIKI_LARGE_SCALE_CONTENT_SAMPLE_COUNT ?? env.FOCOWIKI_VALIDATION_CONTENT_SAMPLE_COUNT,
      Math.min(30, sampleCount)
    ),
    requireModel: readBoolean(env.FOCOWIKI_VALIDATION_REQUIRE_MODEL, false),
    includeBrowser: readBoolean(env.FOCOWIKI_FULL_FLOW_INCLUDE_BROWSER, true),
    includeRepositoryChecks: readBoolean(env.FOCOWIKI_FULL_FLOW_INCLUDE_REPOSITORY, true),
    includeDocker: readBoolean(env.FOCOWIKI_FULL_FLOW_INCLUDE_DOCKER, false),
    includeUploadPressure: readBoolean(
      env.FOCOWIKI_LARGE_SCALE_INCLUDE_UPLOAD_PRESSURE,
      true
    ),
    includeReadPressure: readBoolean(env.FOCOWIKI_LARGE_SCALE_INCLUDE_READ_PRESSURE, true),
    includeErrorBoundaries: readBoolean(
      env.FOCOWIKI_LARGE_SCALE_INCLUDE_ERROR_BOUNDARIES,
      true
    ),
    allowConfiguredExternals:
      readBoolean(env[ALLOW_CONFIGURED_EXTERNALS_ENV], false) ||
      readBoolean(env.FOCOWIKI_VALIDATION_ALLOW_CONFIGURED_EXTERNALS, false),
    forceRerun: readBoolean(env[FORCE_RERUN_ENV], false)
  };
}

export function buildLargeScaleFullSystemPlan(config) {
  if (config.command === "plan") {
    return [];
  }

  const sharedEnv = {
    FOCOWIKI_VALIDATION_CHANGE_ID: config.changeId,
    FOCOWIKI_FULL_FLOW_CHANGE_ID: config.changeId,
    FOCOWIKI_VALIDATION_REPORT_DIR: config.reportDir,
    FOCOWIKI_FULL_FLOW_REPORT_DIR: config.reportDir,
    FOCOWIKI_VALIDATION_PROFILE: "large-scale-full-system",
    FOCOWIKI_VALIDATION_SAMPLE_COUNT: String(config.sampleCount),
    FOCOWIKI_VALIDATION_BATCH_SAMPLE_COUNT: String(config.batchSampleCount),
    FOCOWIKI_VALIDATION_MIN_BATCH_FILES: String(config.minBatchFiles),
    FOCOWIKI_VALIDATION_CONTENT_SAMPLE_COUNT: String(config.contentSampleCount),
    FOCOWIKI_VALIDATION_MAX_MUTATION_ENDPOINT_MS: "60000",
    FOCOWIKI_VALIDATION_REQUIRE_MODEL: config.requireModel ? "true" : "false",
    FOCOWIKI_FULL_FLOW_INCLUDE_BROWSER: config.includeBrowser ? "true" : "false",
    FOCOWIKI_FULL_FLOW_INCLUDE_REPOSITORY: config.includeRepositoryChecks ? "true" : "false",
    FOCOWIKI_FULL_FLOW_INCLUDE_DOCKER: config.includeDocker ? "true" : "false"
  };

  const steps = [
    validationStep("full-flow-large-system", {
      args: ["scripts/validation/full-flow-e2e.mjs", "large"],
      extraEnv: sharedEnv,
      layer: "mixed",
      touchesConfiguredExternals: true,
      safeReportPath: "<change-dir>/full-codebase-e2e-report.json"
    }),
    validationStep("generated-content-review", {
      args: ["scripts/validation/generated-okf-file-inspection.mjs"],
      extraEnv: {
        ...sharedEnv,
        FOCOWIKI_VALIDATION_ALLOW_CONFIGURED_EXTERNALS: config.allowConfiguredExternals
          ? "true"
          : "false",
        FOCOWIKI_VALIDATION_FORCE_RERUN: config.forceRerun ? "true" : "false"
      },
      layer: "mixed",
      touchesConfiguredExternals: true,
      safeReportPath: "<change-dir>/file-inspection-report.json"
    })
  ];

  if (config.includeRepositoryChecks) {
    steps.push(
      pnpmStep("validation-unit-tests", ["test:validation"]),
      pnpmStep("openapi-contract", ["openapi:validate"]),
      pnpmStep("docs-contract", ["docs:validate"]),
      pnpmStep("no-local-paths", ["validate:no-local-paths"])
    );
  }

  return steps;
}

export function createLargeScaleFullSystemReport(config, steps) {
  return {
    kind: "large-scale-full-system-e2e",
    change: config.changeId,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    ok: false,
    command: config.command,
    profile: "large-scale-full-system",
    source: {
      env: "FOCOWIKI_VALIDATION_MARKDOWN_DIR",
      redactedRoot: "<FOCOWIKI_VALIDATION_MARKDOWN_DIR>"
    },
    sample: {
      sampleCount: config.sampleCount,
      batchSampleCount: config.batchSampleCount,
      minBatchFiles: config.minBatchFiles,
      contentSampleCount: config.contentSampleCount
    },
    config: {
      requireModel: config.requireModel,
      includeBrowser: config.includeBrowser,
      includeRepositoryChecks: config.includeRepositoryChecks,
      includeDocker: config.includeDocker,
      includeUploadPressure: config.includeUploadPressure,
      includeReadPressure: config.includeReadPressure,
      includeErrorBoundaries: config.includeErrorBoundaries,
      allowConfiguredExternals: config.allowConfiguredExternals,
      forceRerun: config.forceRerun
    },
    architecture: {
      surfaces: [
        "admin-ui",
        "admin-api",
        "developer-openapi",
        "worker",
        "publication",
        "runtime-settings",
        "postgres",
        "redis",
        "s3-compatible-storage",
        "graph-generation",
        "validation-tooling"
      ],
      boundaryPolicy:
        "Read paths, worker processing, publication, runtime settings, and validation tooling must use explicit contracts and bounded queries."
    },
    errorBoundaries: config.includeErrorBoundaries ? ERROR_BOUNDARY_MATRIX : [],
    resourceEvidence: RESOURCE_EVIDENCE_MATRIX,
    pressure: {
      upload: config.includeUploadPressure,
      read: config.includeReadPressure
    },
    steps: steps.map((step) => ({
      id: step.id,
      layer: step.layer,
      command: step.safeCommand,
      touchesConfiguredExternals: step.touchesConfiguredExternals,
      status: "pending",
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      reportPath: step.safeReportPath ?? null
    })),
    checks: [
      {
        layer: "plan",
        name: "large-scale-full-system-scope",
        ok: true,
        message:
          "Large-scale full-system validation scope includes black-box, white-box, architecture, pressure, security, error-boundary, and content gates."
      }
    ],
    bugFixes: [],
    failures: [],
    remainingRisks: [
      "Configured S3-compatible storage, model service, Docker daemon state, and local machine capacity can affect runtime evidence.",
      "Pressure results describe the current machine unless the same profile is run on the target server."
    ]
  };
}

export function writeLargeScaleFullSystemReport(reportDir, report) {
  fs.mkdirSync(reportDir, { recursive: true });
  const safeReport = JSON.parse(redactReportText(JSON.stringify(report, null, 2)));
  fs.writeFileSync(
    path.join(reportDir, "large-scale-full-system-e2e-report.json"),
    `${JSON.stringify(safeReport, null, 2)}\n`
  );
  fs.writeFileSync(
    path.join(reportDir, "large-scale-full-system-e2e-report.md"),
    renderMarkdown(safeReport)
  );
}

export function applyResumeState(report, existingReport) {
  if (!isResumeCompatible(report, existingReport)) {
    return;
  }

  const passedSteps = new Map(
    existingReport.steps
      .filter((step) => step.status === "passed")
      .map((step) => [step.id, step])
  );

  for (const step of report.steps) {
    const existingStep = passedSteps.get(step.id);
    if (!existingStep) {
      continue;
    }

    Object.assign(step, {
      status: "passed",
      startedAt: existingStep.startedAt ?? null,
      finishedAt: existingStep.finishedAt ?? null,
      durationMs: existingStep.durationMs ?? null
    });
    report.checks.push({
      layer: "resume",
      name: step.id,
      ok: true,
      message: `${step.id} reused from a compatible passed run.`
    });
  }
}

export function readExistingLargeScaleFullSystemReport(reportDir) {
  const filePath = path.join(reportDir, "large-scale-full-system-e2e-report.json");

  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function assertStepAllowed(step, config) {
  if (!step.touchesConfiguredExternals || config.allowConfiguredExternals) {
    return;
  }

  throw new Error(
    `${ALLOW_CONFIGURED_EXTERNALS_ENV}=true is required before running ${step.id}, because it uses configured S3/model/runtime dependencies.`
  );
}

function validationStep(id, input) {
  return {
    id,
    layer: input.layer,
    command: process.execPath,
    args: input.args,
    extraEnv: input.extraEnv,
    touchesConfiguredExternals: input.touchesConfiguredExternals,
    safeCommand: `${path.basename(process.execPath)} ${input.args.join(" ")}`,
    safeReportPath: input.safeReportPath
  };
}

function pnpmStep(id, args) {
  return {
    id,
    layer: "verification",
    command: "pnpm",
    args,
    extraEnv: {},
    touchesConfiguredExternals: false,
    safeCommand: `pnpm ${args.join(" ")}`,
    safeReportPath: null
  };
}

function isResumeCompatible(report, existingReport) {
  if (!existingReport || existingReport.kind !== report.kind) {
    return false;
  }

  return (
    existingReport.change === report.change &&
    existingReport.command === report.command &&
    existingReport.profile === report.profile &&
    existingReport.sample?.sampleCount === report.sample.sampleCount &&
    existingReport.sample?.batchSampleCount === report.sample.batchSampleCount &&
    existingReport.sample?.minBatchFiles === report.sample.minBatchFiles &&
    existingReport.config?.requireModel === report.config.requireModel &&
    existingReport.config?.includeBrowser === report.config.includeBrowser &&
    existingReport.config?.includeRepositoryChecks === report.config.includeRepositoryChecks &&
    existingReport.config?.includeDocker === report.config.includeDocker
  );
}

function renderMarkdown(report) {
  return [
    "# Large-Scale Full-System E2E Validation Report",
    "",
    `- Change: ${report.change}`,
    `- Command: ${report.command}`,
    `- Profile: ${report.profile}`,
    `- Started at: ${report.startedAt}`,
    `- Finished at: ${report.finishedAt ?? "not-finished"}`,
    `- Result: ${report.ok ? "pass" : "fail"}`,
    "",
    "## Sample Plan",
    "",
    `- Sample count: ${report.sample.sampleCount}`,
    `- Batch sample count: ${report.sample.batchSampleCount}`,
    `- Minimum batch files: ${report.sample.minBatchFiles}`,
    `- Content sample count: ${report.sample.contentSampleCount}`,
    "",
    "## Architecture Boundaries",
    "",
    ...report.architecture.surfaces.map((surface) => `- ${surface}`),
    "",
    "## Error Boundaries",
    "",
    ...(report.errorBoundaries.length
      ? report.errorBoundaries.map(
          (boundary) => `- ${boundary.id}: ${boundary.surface}; cases ${boundary.cases.join(", ")}`
        )
      : ["- Disabled for this run."]),
    "",
    "## Resource Evidence",
    "",
    ...report.resourceEvidence.map((item) => `- ${item}`),
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
    "## Failures",
    "",
    ...(report.failures.length ? report.failures.map((item) => `- ${item}`) : ["- None recorded."]),
    "",
    "## Remaining Risks",
    "",
    ...report.remainingRisks.map((risk) => `- ${risk}`),
    ""
  ].join("\n");
}

function normalizeCommand(command) {
  if (["all", "plan"].includes(command)) {
    return command;
  }

  throw new Error("Large-scale full-system validation command must be all or plan.");
}

function readPositiveInteger(value, fallback) {
  const parsed = Number(value ?? fallback);

  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readBoolean(value, fallback = false) {
  const raw = String(value ?? "").trim();

  if (!raw) {
    return fallback;
  }

  return /^(1|true|yes|on)$/i.test(raw);
}

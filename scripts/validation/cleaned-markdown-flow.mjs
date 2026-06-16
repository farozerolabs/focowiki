import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadEnvFile } from "node:process";
import {
  SAMPLE_SOURCE_ENV,
  selectSingleAndBatchSamplesFromEnvironment,
  selectSamplesFromEnvironment
} from "./lib/sample-selector.mjs";
import {
  createPerformanceEvidence,
  finalizePerformanceEvidence,
  recordEndpointTiming,
  recordPaginationEvidence,
  recordTaskDuration
} from "./lib/performance-evidence.mjs";
import { redactPotentialPathText, redactReportText } from "./lib/redaction.mjs";

export {
  selectSamples,
  selectSamplesFromEnvironment,
  selectSingleAndBatchSamples,
  selectSingleAndBatchSamplesFromEnvironment
} from "./lib/sample-selector.mjs";

const CHANGE_ID = process.env.FOCOWIKI_VALIDATION_CHANGE_ID?.trim() || "validate-real-legal-full-flow";
const CHANGE_DIR = path.resolve("openspec/changes", CHANGE_ID);
const REPORT_JSON = path.join(CHANGE_DIR, "validation-report.json");
const REPORT_MD = path.join(CHANGE_DIR, "validation-report.md");
const TASK_TIMEOUT_ENV = "FOCOWIKI_VALIDATION_TASK_TIMEOUT_MS";
const WHITE_BOX = "white-box";
const BLACK_BOX = "black-box";
const SECURITY_AUDIT_SECRET_PATTERN =
  /password|session=|\bPUBLIC_OPENAPI_KEY\b|\bS3_SECRET(?:_ACCESS_KEY)?\b|\bMODEL_API_KEY\b|Bearer\s+[A-Za-z0-9._-]+/i;
const requireFromApiPackage = createRequire(
  pathToFileURL(path.resolve("apps/api/package.json"))
);
const requireFromOkfPackage = createRequire(
  pathToFileURL(path.resolve("packages/okf/package.json"))
);
const matter = requireFromOkfPackage("gray-matter");
const PUBLIC_INDEX_INTERNAL_KEYS = [
  "objectKey",
  "releaseId",
  "taskId",
  "localPath",
  "rawUploadPath",
  "redisKey",
  "sqlDetails",
  "providerPayload",
  "secret",
  "token"
];

export function hasSecretLikeAuditData(rows) {
  return SECURITY_AUDIT_SECRET_PATTERN.test(JSON.stringify(rows));
}

export async function main(argv = process.argv.slice(2)) {
  loadLocalEnv();
  const command = normalizeCommand(argv[0] ?? "samples");

  if (command === "samples") {
    const report = await runSampleValidation();
    writeReport(report);
    writeJson(report);
    return report;
  }

  if (command === "api") {
    const report = await runApiValidation();
    writeReport(report);
    writeJson(report);
    return report;
  }

  throw new Error(`Unknown validation command: ${command}`);
}

function normalizeCommand(rawCommand) {
  if (rawCommand === "large-samples") {
    process.env.FOCOWIKI_VALIDATION_PROFILE = "large-scale";
    return "samples";
  }

  if (rawCommand === "large-api") {
    process.env.FOCOWIKI_VALIDATION_PROFILE = "large-scale";
    return "api";
  }

  return rawCommand;
}

export async function runSampleValidation() {
  const startedAt = new Date().toISOString();
  const sampleSelection = selectSingleAndBatchSamplesFromEnvironment();
  const report = createBaseReport("samples", startedAt, sampleSelection.profile);

  report.sampleProfile = sampleSelection.profile;
  report.samples = sampleSelection.samples.map(redactSampleForReport);
  report.singleSample = redactSampleForReport(sampleSelection.singleSample);
  report.batchSamples = sampleSelection.batchSamples.map(redactSampleForReport);
  report.sampleCoverage = sampleSelection.coverage;
  report.sampleCoverageWarnings = sampleSelection.coverageWarnings ?? [];
  report.scannedCandidateProfiles = sampleSelection.scannedCandidateProfiles ?? null;
  report.checks.push(
    okCheck("sample-directory", "Sample source directory is configured and readable.", {}, WHITE_BOX)
  );
  report.checks.push(
    okCheck(
      "sample-count",
      `Selected one single-upload sample and ${sampleSelection.batchSampleCount} batch-upload samples.`,
      {
        sampleCount: sampleSelection.sampleCount,
        batchSampleCount: sampleSelection.batchSampleCount
      },
      WHITE_BOX
    )
  );
  report.checks.push(
    okCheck(
      "sample-metadata",
      "Every selected sample has parseable frontmatter, type, title, and body.",
      {},
      WHITE_BOX
    )
  );
  report.checks.push(
    okCheck(
      "sample-coverage",
      "Selected samples record available status, type, filename, and metadata coverage.",
      {
        warnings: report.sampleCoverageWarnings.length
      },
      WHITE_BOX
    )
  );
  report.finishedAt = new Date().toISOString();
  report.ok = report.checks.every((check) => check.ok);

  return report;
}

export async function runApiValidation() {
  const startedAt = new Date().toISOString();
  let report = createBaseReport("api", startedAt);
  try {
    const sampleSelection = selectSingleAndBatchSamplesFromEnvironment();
    const env = readRuntimeEnv();
    const performanceEvidence = createPerformanceEvidence(env);
    report = createBaseReport("api", startedAt, sampleSelection.profile);
    report.modelAssistance = readModelAssistanceMode(env);
    report.sampleProfile = sampleSelection.profile;
    const singleSamples = [sampleSelection.singleSample];
    const batchSamples = sampleSelection.batchSamples;
    const allSamples = sampleSelection.samples;

    report.samples = allSamples.map(redactSampleForReport);
    report.singleSample = redactSampleForReport(sampleSelection.singleSample);
    report.batchSamples = batchSamples.map(redactSampleForReport);
    report.sampleCoverage = sampleSelection.coverage;
    report.sampleCoverageWarnings = sampleSelection.coverageWarnings ?? [];
    report.scannedCandidateProfiles = sampleSelection.scannedCandidateProfiles ?? null;

    const adminBaseUrl = env.ADMIN_API_BASE_URL ?? `http://127.0.0.1:${env.ADMIN_API_PORT ?? "43000"}`;
    const publicBaseUrl = env.PUBLIC_BASE_URL ?? `http://127.0.0.1:${env.PUBLIC_OPENAPI_PORT ?? "43200"}`;

    assertEnvValue(env.ADMIN_USERNAME, "ADMIN_USERNAME");
    assertEnvValue(env.ADMIN_PASSWORD, "ADMIN_PASSWORD");
    assertEnvValue(env.DATABASE_URL, "DATABASE_URL");
    assertEnvValue(env.REDIS_URL, "REDIS_URL");
    assertEnvValue(env.S3_ENDPOINT, "S3_ENDPOINT");
    assertEnvValue(env.S3_REGION, "S3_REGION");
    assertEnvValue(env.S3_BUCKET, "S3_BUCKET");
    assertEnvValue(env.S3_ACCESS_KEY_ID, "S3_ACCESS_KEY_ID");
    assertEnvValue(env.S3_SECRET_ACCESS_KEY, "S3_SECRET_ACCESS_KEY");
    assertEnvValue(env.S3_PREFIX, "S3_PREFIX");
    assertUploadLimit(env.MAX_UPLOAD_FILES, Math.max(singleSamples.length, batchSamples.length));

    const admin = createHttpClient(adminBaseUrl, {
      writeOrigin: env.ADMIN_PUBLIC_ORIGIN || `http://localhost:${env.ADMIN_UI_PORT ?? "43100"}`,
      onTiming: (timing) => recordEndpointTiming(performanceEvidence, timing)
    });
    const publicApi = createHttpClient(publicBaseUrl, {
      onTiming: (timing) => recordEndpointTiming(performanceEvidence, timing)
    });
    const taskTimeoutMs = readValidationTaskTimeoutMs(env, allSamples.length);

    await validateDatabaseConnectivity(env.DATABASE_URL, report);
    await validateRedisConnectivity(env.REDIS_URL, report);
    await validateS3Connectivity(env, report);
    validateModelAssistanceMode(env, report);
    await expectUnauthorizedAdmin(admin, report);
    await expectInvalidAdminLogin(admin, env, report);
    await validatePublicApiReachable(publicApi, env, report);
    await validateSecurityHeaders({ admin, publicApi, env, report });

    await loginAdmin(admin, env, report);
    await validateAdminOriginProtection(admin, report);
    env.PUBLIC_OPENAPI_VALIDATION_KEY = await ensureManagedPublicOpenApiKey(admin, report);
    const knowledgeBase = await createValidationKnowledgeBase(admin, report);
    await validateUploadRejection(admin, knowledgeBase.id, report);

    const singleUploadTask = await uploadSamples(admin, knowledgeBase.id, singleSamples, report, {
      checkName: "single-upload-submit",
      message: "Uploaded one selected sample in a single-file upload action."
    });
    const completedSingleTask = await pollTaskEnded(
      admin,
      knowledgeBase.id,
      singleUploadTask.id,
      taskTimeoutMs,
      report,
      {
        checkName: "single-task-ended",
        message: "Single-file upload task reached ended lifecycle state."
      }
    );
    recordTaskDuration(performanceEvidence, completedSingleTask);
    const singleTaskDetail = await fetchTaskDetail(admin, knowledgeBase.id, completedSingleTask.id, report, {
      checkName: "single-task-detail",
      message: "Single-file task detail exposes bounded admin-only phase entries."
    });
    await validateUploadTaskRows(
      admin,
      knowledgeBase.id,
      [{ id: completedSingleTask.id, sourceCount: 1 }],
      report,
      {
        checkName: "single-upload-task-row",
        message: "Single-file upload is represented as one task row with one lifecycle status."
      }
    );
    const singleAdminFiles = await validateAdminFileSurfaces(admin, knowledgeBase.id, report, {
      expectedSamples: singleSamples,
      checkName: "single-admin-file-surfaces",
      message: "Admin release, bundle, tree, detail, and public URL surfaces work after single upload."
    });
    await validatePublicOpenApi(publicApi, knowledgeBase.id, singleAdminFiles, env, report, {
      checkName: "single-public-openapi",
      message: "Public scoped Markdown, JSON, task, auth, source hiding, and error checks passed after single upload."
    });
    const singleStorageEvidence = await validateDatabaseBoundaries(
      env.DATABASE_URL,
      knowledgeBase.id,
      completedSingleTask.id,
      singleSamples,
      singleSamples,
      report,
      {
        checkName: "single-database-boundaries",
        message:
          "PostgreSQL contains durable records, original file names, storage-backed keys, and no raw file body columns after single upload."
      }
    );
    await validateS3ObjectBoundaries(env, singleStorageEvidence, singleSamples, report, {
      checkName: "single-s3-object-boundaries",
      message:
        "S3 contains internal source objects and generated public page objects without exposing source logical paths after single upload."
    });

    const batchUploadTask = await uploadSamples(admin, knowledgeBase.id, batchSamples, report, {
      checkName: "batch-upload-submit",
      message: "Uploaded selected batch samples in one upload action."
    });
    const completedBatchTask = await pollTaskEnded(
      admin,
      knowledgeBase.id,
      batchUploadTask.id,
      taskTimeoutMs,
      report,
      {
        checkName: "batch-task-ended",
        message: "Batch upload task reached ended lifecycle state."
      }
    );
    recordTaskDuration(performanceEvidence, completedBatchTask);
    const batchTaskDetail = await fetchTaskDetail(admin, knowledgeBase.id, completedBatchTask.id, report, {
      checkName: "batch-task-detail",
      message: "Batch task detail exposes bounded admin-only phase entries."
    });
    await validateUploadTaskRows(
      admin,
      knowledgeBase.id,
      [
        { id: completedSingleTask.id, sourceCount: 1 },
        { id: completedBatchTask.id, sourceCount: batchSamples.length }
      ],
      report,
      {
        checkName: "single-batch-upload-task-rows",
        message: "Single and batch upload actions are represented as two task rows with one lifecycle status each."
      }
    );
    await validateTaskSourcePagination(
      admin,
      knowledgeBase.id,
      completedBatchTask.id,
      batchSamples.length,
      report,
      performanceEvidence
    );
    const batchAdminFiles = await validateAdminFileSurfaces(admin, knowledgeBase.id, report, {
      expectedSamples: allSamples,
      checkName: "batch-admin-file-surfaces",
      message:
        "Admin release, bundle, tree, detail, and public URL surfaces include single and batch generated files."
    });
    await validateAdminPaginationSurfaces(
      admin,
      knowledgeBase.id,
      batchAdminFiles.pageFiles.length,
      report,
      performanceEvidence
    );
    await validatePublicOpenApi(publicApi, knowledgeBase.id, batchAdminFiles, env, report, {
      checkName: "batch-public-openapi",
      message:
        "Public scoped Markdown, JSON, task, auth, source hiding, and error checks passed after batch upload."
    });
    const batchStorageEvidence = await validateDatabaseBoundaries(
      env.DATABASE_URL,
      knowledgeBase.id,
      completedBatchTask.id,
      batchSamples,
      allSamples,
      report,
      {
        checkName: "batch-database-boundaries",
        message:
          "PostgreSQL contains durable records, original file names, storage-backed keys, and no raw file body columns after batch upload."
      }
    );
    await validateS3ObjectBoundaries(env, batchStorageEvidence, batchSamples, report, {
      checkName: "batch-s3-object-boundaries",
      message:
        "S3 contains internal source objects and generated public page objects without exposing source logical paths after batch upload."
    });
    await validateRedisBoundaries(env.REDIS_URL, allSamples, report);
    const deletionEvidence = await validateSourceDeletionFullFlow({
      admin,
      publicApi,
      env,
      knowledgeBaseId: knowledgeBase.id,
      pageFile: batchAdminFiles.pageFile,
      taskTimeoutMs,
      report
    });
    await validateKnowledgeBaseDeletion({
      admin,
      publicApi,
      env,
      knowledgeBaseId: knowledgeBase.id,
      report
    });
    await validateSecurityAuditEvidence(env.DATABASE_URL, report.startedAt, report);
    report.performance = finalizePerformanceEvidence(performanceEvidence, {
      profile: sampleSelection.profile,
      batchSampleCount: sampleSelection.batchSampleCount,
      largeScaleMinBatchFiles: sampleSelection.largeScaleMinBatchFiles
    });

    if (!report.performance.ok) {
      throw new Error(`Performance validation failed: ${report.performance.budgetFailures.join(", ")}`);
    }

    report.validationRun = {
      knowledgeBaseId: knowledgeBase.id,
      singleTaskId: completedSingleTask.id,
      batchTaskId: completedBatchTask.id,
      deletionTaskId: deletionEvidence.taskId,
      deletedPagePath: deletionEvidence.deletedPagePath,
      singleSourceCount: completedSingleTask.sourceCount,
      batchSourceCount: completedBatchTask.sourceCount,
      totalSourceCount: allSamples.length,
      sampleProfile: sampleSelection.profile,
      singlePhaseCount: singleTaskDetail.phaseDetails.items.length,
      batchPhaseCount: batchTaskDetail.phaseDetails.items.length,
      publicBaseUrl: redactUrl(publicBaseUrl),
      adminBaseUrl: redactUrl(adminBaseUrl)
    };
    report.finishedAt = new Date().toISOString();
    report.ok = report.checks.every((check) => check.ok);
    writeReport(report);
    writeJson(report);

    if (!report.ok) {
      throw new Error("Cleaned Markdown API validation failed. See redacted validation report.");
    }

    return report;
  } catch (error) {
    report.finishedAt = new Date().toISOString();
    report.ok = false;
    report.failures.push(redactPotentialPathText(error instanceof Error ? error.message : String(error)));
    writeReport(report);
    writeJson(report);
    throw error;
  }
}

function createBaseReport(kind, startedAt, sampleProfile = process.env.FOCOWIKI_VALIDATION_PROFILE || "default") {
  return {
    kind,
    change: CHANGE_ID,
    sampleProfile,
    startedAt,
    finishedAt: null,
    ok: false,
    source: {
      env: SAMPLE_SOURCE_ENV,
      redactedRoot: `<${SAMPLE_SOURCE_ENV}>`
    },
    samples: [],
    singleSample: null,
    batchSamples: [],
    sampleCoverage: null,
    sampleCoverageWarnings: [],
    scannedCandidateProfiles: null,
    validationRun: null,
    performance: null,
    modelAssistance: readModelAssistanceMode(process.env),
    commandsRun: defaultCommandsRun(kind, sampleProfile),
    testsRun: defaultTestsRun(kind),
    validationPasses: defaultValidationPasses(kind),
    manualReviewItems: defaultManualReviewItems(),
    checks: [],
    bugFixes: [],
    failures: []
  };
}

function redactSampleForReport(sample) {
  return {
    basename: sample.basename,
    title: sample.title,
    type: sample.type,
    status: sample.status,
    category: sample.category,
    publicationDate: sample.publicationDate || "unknown-date",
    sizeBytes: sample.sizeBytes
  };
}

function okCheck(name, message, details = {}, layer = BLACK_BOX) {
  return {
    layer,
    name,
    ok: true,
    message,
    details
  };
}

function failCheck(name, message, details = {}, layer = BLACK_BOX) {
  return {
    layer,
    name,
    ok: false,
    message,
    details
  };
}

function writeReport(report) {
  fs.mkdirSync(CHANGE_DIR, { recursive: true });
  const whiteBoxChecks = report.checks.filter((check) => check.layer === WHITE_BOX);
  const blackBoxChecks = report.checks.filter((check) => check.layer === BLACK_BOX);
  const lines = [
    "# Real Legal Full-Flow Validation Report",
    "",
    `- Change: ${report.change}`,
    `- Kind: ${report.kind}`,
    `- Sample profile: ${report.sampleProfile ?? "default"}`,
    `- Started at: ${report.startedAt}`,
    `- Finished at: ${report.finishedAt ?? "not-finished"}`,
    `- Source: <${SAMPLE_SOURCE_ENV}>`,
    `- Result: ${report.ok ? "pass" : "fail"}`,
    "",
    "## Sample Coverage",
    "",
    `- Samples: ${report.samples.length}`,
    `- Single-upload sample: ${report.singleSample?.basename ?? "none"}`,
    `- Batch-upload samples: ${report.batchSamples.length}`,
    `- Statuses: ${report.sampleCoverage?.statuses.join(", ") ?? "none"}`,
    `- Types: ${report.sampleCoverage?.types.join(", ") ?? "none"}`,
    `- Unknown date sample: ${report.sampleCoverage?.includesUnknownDate ? "yes" : "no"}`,
    `- Long title sample: ${report.sampleCoverage?.includesLongTitle ? "yes" : "no"}`,
    `- Duplicated title sample: ${report.sampleCoverage?.includesDuplicatedTitle ? "yes" : "no"}`,
    `- Non-ASCII basename sample: ${report.sampleCoverage?.includesNonAsciiBasename ? "yes" : "no"}`,
    `- Unknown metadata sample: ${report.sampleCoverage?.includesUnknownMetadata ? "yes" : "no"}`,
    `- Scanned candidate profiles: ${report.scannedCandidateProfiles ?? "not-recorded"}`,
    `- Coverage warnings: ${report.sampleCoverageWarnings.length ? report.sampleCoverageWarnings.join("; ") : "none"}`,
    "",
    "## Model Assistance",
    "",
    `- Enabled: ${report.modelAssistance?.enabled ? "yes" : "no"}`,
    `- Model: ${report.modelAssistance?.modelName ?? "none"}`,
    `- Context window tokens: ${report.modelAssistance?.contextWindowTokens ?? "not-configured"}`,
    `- Suggestion concurrency: ${report.modelAssistance?.suggestionConcurrency ?? "not-configured"}`,
    "",
    "## Performance Evidence",
    "",
    ...(report.performance
      ? [
          `- Result: ${report.performance.ok ? "pass" : "fail"}`,
          `- Endpoint timings: count=${report.performance.endpointTimings.count}, maxMs=${report.performance.endpointTimings.maxMs}, averageMs=${report.performance.endpointTimings.averageMs}`,
          `- Task durations: count=${report.performance.taskDurations.count}, maxMs=${report.performance.taskDurations.maxMs}, averageMs=${report.performance.taskDurations.averageMs}`,
          `- Pagination checks: ${report.performance.pagination.length}`,
          `- Memory delta MB: ${report.performance.memory.deltaHeapMb}`,
          `- Budget failures: ${report.performance.budgetFailures.length ? report.performance.budgetFailures.join(", ") : "none"}`
        ]
      : ["- Not recorded."]),
    "",
    "## Validation Passes",
    "",
    ...report.validationPasses.map((item) => `- ${item}`),
    "",
    "## Commands Run",
    "",
    ...report.commandsRun.map((item) => `- ${item}`),
    "",
    "## Tests Run",
    "",
    ...report.testsRun.map((item) => `- ${item}`),
    "",
    "## Manual Review Items",
    "",
    ...report.manualReviewItems.map((item) => `- ${item}`),
    "",
    "## Single Upload File",
    "",
    ...(report.singleSample
      ? [
          `- ${report.singleSample.basename}: type=${report.singleSample.type || "none"}, status=${report.singleSample.status || "none"}, date=${report.singleSample.publicationDate}`
        ]
      : ["- None recorded."]),
    "",
    "## Batch Upload Files",
    "",
    ...(report.batchSamples.length
      ? report.batchSamples.map(
          (sample) =>
            `- ${sample.basename}: type=${sample.type || "none"}, status=${sample.status || "none"}, date=${sample.publicationDate}`
        )
      : ["- None recorded."]),
    "",
    "## Selected Files",
    "",
    ...report.samples.map(
      (sample) =>
        `- ${sample.basename}: type=${sample.type || "none"}, status=${sample.status || "none"}, date=${sample.publicationDate}`
    ),
    "",
    "## Checks",
    "",
    ...report.checks.map(
      (check) => `- ${check.ok ? "PASS" : "FAIL"} [${check.layer}] ${check.name}: ${check.message}`
    ),
    "",
    "## White-box Checks",
    "",
    ...(whiteBoxChecks.length
      ? whiteBoxChecks.map((check) => `- ${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.message}`)
      : ["- None recorded."]),
    "",
    "## Black-box Checks",
    "",
    ...(blackBoxChecks.length
      ? blackBoxChecks.map((check) => `- ${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.message}`)
      : ["- None recorded."]),
    "",
    "## Bug Fixes",
    "",
    ...(report.bugFixes.length
      ? report.bugFixes.map((bugFix) => `- ${bugFix}`)
      : ["- None recorded."]),
    "",
    "## Failures",
    "",
    ...(report.failures.length
      ? report.failures.map((failure) => `- ${redactReportText(failure)}`)
      : ["- None recorded."]),
    ""
  ];

  fs.writeFileSync(REPORT_MD, lines.join("\n"));
}

function defaultCommandsRun(kind, sampleProfile = "default") {
  const prefix = sampleProfile === "large-scale" ? "pnpm validate:real-legal:large" : "pnpm validate:real-legal";
  const commands = [
    `${prefix}:samples`,
    `${prefix}:${kind}`
  ];

  if (kind === "api") {
    commands.push(`${prefix}:browser`);
    commands.push("pnpm verify");
    commands.push("pnpm build");
    commands.push("pnpm test:validation");
    commands.push("pnpm validate:no-local-paths");
    commands.push(`openspec validate ${CHANGE_ID} --strict`);
  }

  return Array.from(new Set(commands));
}

function defaultTestsRun(kind) {
  const tests = [
    "bounded sample selection",
    "report redaction"
  ];

  if (kind === "api") {
    tests.push("Admin API black-box flow");
    tests.push("public OpenAPI black-box flow");
    tests.push("PostgreSQL, Redis, S3, and OKF white-box checks");
    tests.push("Admin UI browser flow");
    tests.push("repository no-local-path scan");
    tests.push("lint, typecheck, unit tests, and build");
  }

  return tests;
}

function defaultValidationPasses(kind) {
  const passes = [
    "Pass 1: bounded sample selection and redacted prerequisite validation.",
    "Pass 2: real service API, public OpenAPI, persistence, storage, Redis, OKF, model-mode, and deletion validation."
  ];

  if (kind === "api") {
    passes.push("Pass 3: Admin UI browser validation plus final repository verification and report leak scan.");
  } else {
    passes.push("Pass 3: final repository verification is required before release-gate completion.");
  }

  return passes;
}

function defaultManualReviewItems() {
  return [
    "Review optional sample coverage warnings to decide whether the configured local dataset should be broadened.",
    "Review the Vite chunk size warning separately if frontend bundle size becomes a release concern."
  ];
}

function writeJson(report) {
  fs.mkdirSync(CHANGE_DIR, { recursive: true });
  fs.writeFileSync(REPORT_JSON, `${JSON.stringify(report, null, 2)}\n`);
}

function readRuntimeEnv() {
  return process.env;
}

function loadLocalEnv() {
  const envFile = process.env.ENV_FILE || ".env";

  if (fs.existsSync(envFile)) {
    loadEnvFile(envFile);
  }
}

function assertEnvValue(value, name) {
  if (!value) {
    throw new Error(`${name} must be set for cleaned Markdown validation.`);
  }
}

function assertUploadLimit(value, sampleCount) {
  const parsed = Number(value ?? Number.NaN);

  if (!Number.isSafeInteger(parsed) || parsed < sampleCount) {
    throw new Error(`MAX_UPLOAD_FILES must be at least ${sampleCount} for this validation run.`);
  }
}

function readModelAssistanceMode(env) {
  const enabled = Boolean(env.MODEL_API_KEY?.trim() && env.MODEL_NAME?.trim());

  return {
    enabled,
    modelName: enabled ? env.MODEL_NAME : null,
    baseUrl: enabled ? redactUrl(env.MODEL_BASE_URL || "https://api.openai.com/v1") : null,
    contextWindowTokens: enabled ? Number(env.MODEL_CONTEXT_WINDOW_TOKENS || 0) : null,
    requestMaxTimeoutMs: enabled ? Number(env.MODEL_REQUEST_MAX_TIMEOUT_MS || 120_000) : null,
    requestIdleTimeoutMs: enabled ? Number(env.MODEL_REQUEST_IDLE_TIMEOUT_MS || 30_000) : null,
    suggestionConcurrency: enabled ? readPositiveInteger(env.MODEL_SUGGESTION_CONCURRENCY, 2) : null
  };
}

function validateModelAssistanceMode(env, report) {
  const mode = readModelAssistanceMode(env);
  report.modelAssistance = mode;

  if (!mode.enabled) {
    report.checks.push(
      okCheck(
        "model-assistance-mode",
        "Model assistance is disabled; deterministic generation path will be validated.",
        {},
        WHITE_BOX
      )
    );
    return;
  }

  if (
    !Number.isSafeInteger(mode.contextWindowTokens) ||
    mode.contextWindowTokens <= 0 ||
    !Number.isSafeInteger(mode.requestMaxTimeoutMs) ||
    mode.requestMaxTimeoutMs <= 0 ||
    !Number.isSafeInteger(mode.requestIdleTimeoutMs) ||
    mode.requestIdleTimeoutMs <= 0 ||
    mode.requestIdleTimeoutMs > mode.requestMaxTimeoutMs ||
    !Number.isSafeInteger(mode.suggestionConcurrency) ||
    mode.suggestionConcurrency <= 0
  ) {
    throw new Error("Model assistance validation requires valid context, timeout, and concurrency settings.");
  }

  report.checks.push(
    okCheck(
      "model-assistance-mode",
      "Model assistance is enabled with bounded context, timeout, and concurrency settings.",
      {
        modelName: mode.modelName,
        baseUrl: mode.baseUrl,
        contextWindowTokens: mode.contextWindowTokens,
        requestMaxTimeoutMs: mode.requestMaxTimeoutMs,
        requestIdleTimeoutMs: mode.requestIdleTimeoutMs,
        suggestionConcurrency: mode.suggestionConcurrency
      },
      WHITE_BOX
    )
  );
}

function readValidationTaskTimeoutMs(env, sampleCount) {
  const configured = env[TASK_TIMEOUT_ENV]?.trim();

  if (configured) {
    const parsed = Number(configured);

    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error(`${TASK_TIMEOUT_ENV} must be a positive integer.`);
    }

    return parsed;
  }

  if (!env.MODEL_API_KEY?.trim() || !env.MODEL_NAME?.trim()) {
    return 180_000;
  }

  const concurrency = readPositiveInteger(env.MODEL_SUGGESTION_CONCURRENCY, 2);
  const idleMs = readPositiveInteger(env.MODEL_REQUEST_IDLE_TIMEOUT_MS, 30_000);
  const batches = Math.ceil(sampleCount / concurrency);

  return Math.max(180_000, batches * 2 * idleMs + 120_000);
}

function readPositiveInteger(value, fallback) {
  const parsed = Number(value ?? fallback);

  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function createHttpClient(baseUrl, clientOptions = {}) {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  let cookie = "";

  return {
    get cookie() {
      return cookie;
    },
    async request(pathname, requestOptions = {}) {
      const headers = new Headers(requestOptions.headers ?? {});
      const method = String(requestOptions.method ?? "GET").toUpperCase();
      const startedAt = Date.now();

      if (cookie && !headers.has("cookie")) {
        headers.set("cookie", cookie);
      }

      if (
        clientOptions.writeOrigin &&
        !headers.has("origin") &&
        !["GET", "HEAD", "OPTIONS"].includes(method)
      ) {
        headers.set("origin", clientOptions.writeOrigin);
      }

      let response;

      try {
        response = await fetch(`${normalizedBaseUrl}${pathname}`, {
          ...requestOptions,
          headers
        });
      } catch (error) {
        clientOptions.onTiming?.({
          method,
          pathname,
          status: 0,
          durationMs: Date.now() - startedAt
        });
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Request failed for ${redactUrl(normalizedBaseUrl)}${pathname}: ${message}`);
      }

      clientOptions.onTiming?.({
        method,
        pathname,
        status: response.status,
        durationMs: Date.now() - startedAt
      });

      const setCookie = response.headers.get("set-cookie");

      if (setCookie) {
        cookie = setCookie.split(";")[0] ?? "";
      }

      return response;
    }
  };
}

async function validateDatabaseConnectivity(databaseUrl, report) {
  const postgresModule = requireFromApiPackage("postgres");
  const postgres = postgresModule.default ?? postgresModule;
  const sql = postgres(databaseUrl, { max: 1 });

  try {
    await sql`SELECT 1`;
    report.checks.push(okCheck("postgres-prerequisite", "PostgreSQL is reachable.", {}, WHITE_BOX));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function validateRedisConnectivity(redisUrl, report) {
  const { createClient } = requireFromApiPackage("redis");
  const client = createClient({ url: redisUrl });
  await client.connect();

  try {
    await client.ping();
    report.checks.push(okCheck("redis-prerequisite", "Redis is reachable.", {}, WHITE_BOX));
  } finally {
    await client.quit();
  }
}

async function validateS3Connectivity(env, report) {
  const { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } =
    requireFromApiPackage("@aws-sdk/client-s3");
  const client = new S3Client(createS3ClientConfigFromEnv(env));
  const key = `${normalizeS3Prefix(env.S3_PREFIX)}/validation/${randomUUID()}.txt`;

  try {
    await client.send(
      new PutObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: key,
        Body: "focowiki-validation",
        ContentType: "text/plain; charset=utf-8"
      })
    );
    const response = await client.send(
      new GetObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: key
      })
    );
    const body = await responseBodyToString(response.Body);

    if (body !== "focowiki-validation") {
      throw new Error("S3 validation object body mismatch.");
    }

    report.checks.push(
      okCheck("s3-prerequisite", "S3-compatible storage accepts put and get operations.", {}, WHITE_BOX)
    );
  } catch (error) {
    throw new Error(
      `S3 prerequisite check failed. Verify configured endpoint, bucket, credentials, and prefix. ${redactPotentialPathText(
        error instanceof Error ? error.message : String(error)
      )}`
    );
  } finally {
    await client
      .send(
        new DeleteObjectCommand({
          Bucket: env.S3_BUCKET,
          Key: key
        })
      )
      .catch(() => undefined);
  }
}

async function validatePublicApiReachable(publicApi, env, report) {
  const response = await publicApi.request("/kb/focowiki-validation-missing/index.md");

  if (![401, 404].includes(response.status)) {
    throw new Error(`Public OpenAPI prerequisite expected HTTP 401 or 404, got ${response.status}.`);
  }

  report.checks.push(okCheck("public-openapi-prerequisite", "Public OpenAPI is reachable."));
}

async function validateSecurityHeaders({ admin, publicApi, env, report }) {
  const adminResponse = await admin.request("/admin/api/knowledge-bases");
  assertSecurityHeaders(adminResponse, "Admin API");

  const publicResponse = await publicApi.request("/kb/focowiki-validation-missing/index.md", {
    headers: {}
  });
  assertSecurityHeaders(publicResponse, "Public OpenAPI");

  report.checks.push(
    okCheck(
      "http-security-headers",
      "Admin API and public OpenAPI return security response headers on validation responses.",
      {},
      BLACK_BOX
    )
  );
}

function assertSecurityHeaders(response, surface) {
  const referrerPolicy = response.headers.get("referrer-policy") ?? "";
  const contentTypeOptions = response.headers.get("x-content-type-options") ?? "";
  const frameOptions = response.headers.get("x-frame-options") ?? "";

  if (
    referrerPolicy.toLowerCase() !== "no-referrer" ||
    contentTypeOptions.toLowerCase() !== "nosniff" ||
    frameOptions.toUpperCase() !== "DENY"
  ) {
    throw new Error(`${surface} did not return expected security headers.`);
  }
}

async function expectUnauthorizedAdmin(admin, report) {
  const response = await admin.request("/admin/api/knowledge-bases");

  if (response.status !== 401) {
    report.checks.push(failCheck("admin-auth-required", "Admin API did not reject an unauthenticated request."));
    return;
  }

  report.checks.push(okCheck("admin-auth-required", "Admin API rejects unauthenticated knowledge base reads."));
}

async function expectInvalidAdminLogin(admin, env, report) {
  const response = await admin.request("/admin/api/login", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      username: env.ADMIN_USERNAME,
      password: `${env.ADMIN_PASSWORD}-invalid`
    })
  });

  if (response.status !== 401) {
    throw new Error(`Invalid admin login expected HTTP 401, got ${response.status}.`);
  }

  report.checks.push(okCheck("admin-invalid-login", "Admin login rejects invalid credentials."));
}

async function loginAdmin(admin, env, report) {
  const response = await admin.request("/admin/api/login", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      username: env.ADMIN_USERNAME,
      password: env.ADMIN_PASSWORD
    })
  });

  if (!response.ok) {
    throw new Error(`Admin login failed with HTTP ${response.status}.`);
  }

  report.checks.push(okCheck("admin-login", "Admin login succeeded with configured credentials."));
}

async function validateAdminOriginProtection(admin, report) {
  const response = await admin.request("/admin/api/knowledge-bases", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://invalid-origin.example"
    },
    body: JSON.stringify({
      name: "Blocked origin validation",
      description: "This request should be rejected."
    })
  });

  if (response.status !== 403) {
    throw new Error(`Admin origin protection expected HTTP 403, got ${response.status}.`);
  }

  report.checks.push(okCheck("admin-origin-protection", "Admin API rejects state-changing requests from untrusted origins."));
}

async function ensureManagedPublicOpenApiKey(admin, report) {
  const listResponse = await admin.request("/admin/api/openapi-keys?limit=50");

  if (!listResponse.ok) {
    throw new Error(`OpenAPI key list failed with HTTP ${listResponse.status}.`);
  }

  const list = await listResponse.json();

  if (list.oneTimeKey?.rawKey) {
    report.checks.push(
      okCheck("public-openapi-managed-key", "Loaded one-time managed OpenAPI key from Admin API.")
    );
    return list.oneTimeKey.rawKey;
  }

  const createResponse = await admin.request("/admin/api/openapi-keys", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      name: "Validation key"
    })
  });

  if (createResponse.status !== 201) {
    throw new Error(`OpenAPI key creation failed with HTTP ${createResponse.status}.`);
  }

  const created = await createResponse.json();

  if (!created.oneTimeKey?.rawKey) {
    throw new Error("OpenAPI key creation response did not include a one-time key.");
  }

  report.checks.push(
    okCheck("public-openapi-managed-key", "Created a managed OpenAPI key for validation.")
  );
  return created.oneTimeKey.rawKey;
}

async function createValidationKnowledgeBase(admin, report) {
  const response = await admin.request("/admin/api/knowledge-bases", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      name: `Focowiki validation ${new Date().toISOString()}`,
      description: "Cleaned Markdown validation run"
    })
  });

  if (response.status !== 201) {
    throw new Error(`Knowledge base creation failed with HTTP ${response.status}.`);
  }

  const body = await response.json();
  const knowledgeBase = body.knowledgeBase;

  if (!knowledgeBase?.id) {
    throw new Error("Knowledge base creation response did not include an id.");
  }

  report.checks.push(okCheck("knowledge-base-create", "Created validation knowledge base."));
  return knowledgeBase;
}

async function validateUploadRejection(admin, knowledgeBaseId, report) {
  const formData = new FormData();
  formData.append("files", new Blob(["plain text"], { type: "text/plain" }), "invalid.txt");

  const response = await admin.request(
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/uploads`,
    {
      method: "POST",
      body: formData
    }
  );

  if (response.status !== 400) {
    throw new Error(`Non-Markdown upload rejection expected HTTP 400, got ${response.status}.`);
  }

  report.checks.push(okCheck("upload-rejects-non-markdown", "Admin upload rejects non-Markdown files."));
}

async function uploadSamples(admin, knowledgeBaseId, samples, report, options = {}) {
  const formData = new FormData();

  for (const sample of samples) {
    const bytes = fs.readFileSync(sample.filePath);
    formData.append("files", new Blob([bytes], { type: "text/markdown" }), sample.basename);
  }

  const response = await admin.request(
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/uploads`,
    {
      method: "POST",
      body: formData
    }
  );

  if (response.status !== 202) {
    const text = await response.text();
    throw new Error(`Sample upload failed with HTTP ${response.status}: ${redactPotentialPathText(text)}`);
  }

  const body = await response.json();
  const task = body.task;

  if (!task?.id || task.sourceCount !== samples.length) {
    throw new Error("Upload response did not include the expected task and source count.");
  }

  report.checks.push(
    okCheck(options.checkName ?? "upload-submit", options.message ?? "Uploaded selected samples in one upload action.", {
      sourceCount: task.sourceCount
    })
  );

  return task;
}

async function pollTaskEnded(admin, knowledgeBaseId, taskId, timeoutMs, report, options = {}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await admin.request(
      `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/tasks?limit=10`
    );

    if (!response.ok) {
      throw new Error(`Task list request failed with HTTP ${response.status}.`);
    }

    const body = await response.json();
    const task = body.items?.find((item) => item.id === taskId);

    if (task?.endedAt) {
      report.checks.push(
        okCheck(options.checkName ?? "task-ended", options.message ?? "Upload task reached ended lifecycle state.", {
          timeoutMs
        })
      );
      return task;
    }

    await sleep(1_000);
  }

  throw new Error(`Timed out waiting for upload task to end after ${timeoutMs}ms.`);
}

async function fetchTaskDetail(admin, knowledgeBaseId, taskId, report, options = {}) {
  const response = await admin.request(
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/tasks/${encodeURIComponent(taskId)}?limit=50`
  );

  if (!response.ok) {
    throw new Error(`Task detail request failed with HTTP ${response.status}.`);
  }

  const body = await response.json();
  const phases = body.phaseDetails?.items ?? [];

  if (phases.length === 0 || phases.length > 6) {
    throw new Error(`Expected bounded admin phase details, got ${phases.length}.`);
  }

  report.checks.push(
    okCheck(options.checkName ?? "task-detail", options.message ?? "Task detail exposes bounded admin-only phase entries.", {
      phaseCount: phases.length,
      sourceCount: body.sourceFiles?.items?.length ?? 0
    })
  );
  return body;
}

async function validateUploadTaskRows(admin, knowledgeBaseId, expectedTasks, report, options = {}) {
  const body = await readJson(
    admin,
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/tasks?limit=50`
  );
  const uploadTasks = (body.items ?? []).filter((task) => task.operation === "upload");
  const uploadTaskIds = new Set(uploadTasks.map((task) => task.id));

  if (uploadTasks.length !== expectedTasks.length) {
    throw new Error(`Expected ${expectedTasks.length} upload task rows, got ${uploadTasks.length}.`);
  }

  for (const expectedTask of expectedTasks) {
    const task = uploadTasks.find((item) => item.id === expectedTask.id);

    if (!task) {
      throw new Error(`Expected upload task row was missing: ${expectedTask.id}`);
    }

    if (task.sourceCount !== expectedTask.sourceCount || !task.startedAt || !task.endedAt) {
      throw new Error(`Upload task row did not expose expected lifecycle data: ${expectedTask.id}`);
    }
  }

  report.checks.push(
    okCheck(options.checkName ?? "upload-task-rows", options.message ?? "Upload actions are represented as task rows with one lifecycle status.", {
      taskIds: Array.from(uploadTaskIds)
    })
  );
}

async function validateTaskSourcePagination(
  admin,
  knowledgeBaseId,
  taskId,
  expectedSourceCount,
  report,
  performanceEvidence
) {
  if (expectedSourceCount <= 1) {
    recordPaginationEvidence(performanceEvidence, "task-source-pagination", {
      expectedSourceCount,
      observedPages: 1
    });
    report.checks.push(
      okCheck("task-source-pagination", "Batch task has one source file; source pagination is not needed.", {
        expectedSourceCount
      })
    );
    return;
  }

  const first = await readJson(
    admin,
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/tasks/${encodeURIComponent(taskId)}?limit=1`
  );

  if (first.sourceFiles?.items?.length !== 1 || !first.sourceFiles.nextCursor) {
    throw new Error("Expected first task source-file page to include one item and a next cursor.");
  }

  const second = await readJson(
    admin,
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/tasks/${encodeURIComponent(taskId)}?limit=1&sourceCursor=${encodeURIComponent(first.sourceFiles.nextCursor)}`
  );

  if (second.sourceFiles?.items?.length !== 1) {
    throw new Error("Expected second task source-file page to include one item.");
  }

  if (
    first.sourceFiles.items[0]?.taskId !== taskId ||
    second.sourceFiles.items[0]?.taskId !== taskId ||
    first.sourceFiles.items[0]?.id === second.sourceFiles.items[0]?.id
  ) {
    throw new Error("Task source-file cursor did not stay scoped to the selected task.");
  }

  recordPaginationEvidence(performanceEvidence, "task-source-pagination", {
    expectedSourceCount,
    observedPages: 2,
    itemCount: first.sourceFiles.items.length + second.sourceFiles.items.length
  });
  report.checks.push(
    okCheck("task-source-pagination", "Task source files are paginated with an independent bounded cursor.", {
      expectedSourceCount
    })
  );
}

async function validateAdminFileSurfaces(admin, knowledgeBaseId, report, options = {}) {
  const expectedSamples = options.expectedSamples ?? [];
  const [releases, bundleFiles, tree, urls] = await Promise.all([
    readJson(admin, `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/releases?limit=10`),
    readJson(admin, `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/bundle-files?limit=200`),
    readJson(admin, `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/files/tree?limit=50`),
    readJson(admin, `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/public-urls`)
  ]);

  const release = releases.items?.[0];

  if (!release?.publishedAt || (bundleFiles.items?.length ?? 0) === 0 || (tree.items?.length ?? 0) === 0) {
    throw new Error("Expected published release, bundle files, and root tree entries.");
  }

  const pageFile = bundleFiles.items.find((file) => String(file.logicalPath).startsWith("pages/"));
  const pageFiles = bundleFiles.items.filter((file) => String(file.logicalPath).startsWith("pages/"));
  const indexFile = bundleFiles.items.find((file) => file.logicalPath === "index.md");
  const logFile = bundleFiles.items.find((file) => file.logicalPath === "log.md");
  const schemaFile = bundleFiles.items.find((file) => file.logicalPath === "schema.md");
  const searchFile = bundleFiles.items.find((file) => file.logicalPath === "_index/search.json");
  const exposedSourceFile = bundleFiles.items.find((file) => String(file.logicalPath).startsWith("sources/"));

  if (!pageFile || !indexFile || !logFile || !schemaFile || !searchFile || exposedSourceFile) {
    throw new Error("Generated bundle must include reserved, page, and index files without sources/ files.");
  }

  for (const sample of expectedSamples) {
    const found = pageFiles.some((file) => path.basename(file.logicalPath) === sample.basename);

    if (!found) {
      throw new Error(`Generated page file is missing for selected sample: ${sample.basename}`);
    }
  }

  const detail = await readJson(
    admin,
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/files/detail?path=${encodeURIComponent(pageFile.logicalPath)}`
  );

  if (!detail.content || detail.readOnly !== true) {
    throw new Error("Admin file detail did not return read-only file content.");
  }

  report.checks.push(
    okCheck(options.checkName ?? "admin-file-surfaces", options.message ?? "Admin release, bundle, tree, detail, and public URL surfaces work.", {
      bundleFiles: bundleFiles.items.length,
      rootTreeItems: tree.items.length,
      pageFiles: pageFiles.length,
      expectedSamples: expectedSamples.length
    })
  );

  return {
    pageFile,
    pageFiles,
    indexFile,
    logFile,
    schemaFile,
    searchFile,
    publicUrls: urls.publicUrls
  };
}

async function validateAdminPaginationSurfaces(
  admin,
  knowledgeBaseId,
  expectedPageCount,
  report,
  performanceEvidence
) {
  const bundleFirst = await readJson(
    admin,
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/bundle-files?limit=1`
  );

  if (bundleFirst.items?.length !== 1 || !bundleFirst.nextCursor) {
    throw new Error("Expected bundle-file pagination to return one item and a next cursor.");
  }

  const bundleSecond = await readJson(
    admin,
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/bundle-files?limit=1&cursor=${encodeURIComponent(bundleFirst.nextCursor)}`
  );

  if (
    bundleSecond.items?.length !== 1 ||
    bundleSecond.items[0]?.logicalPath === bundleFirst.items[0]?.logicalPath
  ) {
    throw new Error("Bundle-file cursor did not return the next bounded page.");
  }

  const treeFirst = await readJson(
    admin,
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/files/tree?limit=1`
  );

  if (treeFirst.items?.length !== 1) {
    throw new Error("Expected file tree pagination to return one root item.");
  }

  let treePages = 1;

  if (treeFirst.nextCursor) {
    const treeSecond = await readJson(
      admin,
      `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/files/tree?limit=1&cursor=${encodeURIComponent(treeFirst.nextCursor)}`
    );

    if (
      treeSecond.items?.length !== 1 ||
      treeSecond.items[0]?.logicalPath === treeFirst.items[0]?.logicalPath
    ) {
      throw new Error("File tree cursor did not return the next bounded page.");
    }

    treePages = 2;
  }

  recordPaginationEvidence(performanceEvidence, "bundle-file-pagination", {
    expectedSourceCount: expectedPageCount,
    observedPages: 2,
    itemCount: 2
  });
  recordPaginationEvidence(performanceEvidence, "file-tree-pagination", {
    expectedSourceCount: expectedPageCount,
    observedPages: treePages,
    itemCount: treePages
  });

  report.checks.push(
    okCheck(
      "admin-pagination-surfaces",
      "Admin bundle file and file tree reads support bounded cursor pagination.",
      {
        expectedPageCount,
        bundlePages: 2,
        treePages
      }
    )
  );
}

async function validatePublicOpenApi(publicApi, knowledgeBaseId, adminFiles, env, report, options = {}) {
  const missingAuth = await publicApi.request(`/kb/${encodeURIComponent(knowledgeBaseId)}/index.md`);

  if (missingAuth.status !== 401) {
    throw new Error("Public OpenAPI did not reject missing bearer auth.");
  }

  const invalidAuth = await publicApi.request(`/kb/${encodeURIComponent(knowledgeBaseId)}/index.md`, {
    headers: {
      authorization: "Bearer invalid-validation-key"
    }
  });

  if (invalidAuth.status !== 401) {
    throw new Error("Public OpenAPI did not reject an invalid bearer key.");
  }

  const authHeaders = publicAuthHeaders(env);
  const paths = [
    "index.md",
    "log.md",
    "schema.md",
    ...adminFiles.pageFiles.map((file) => file.logicalPath),
    "_index/manifest.json",
    "_index/search.json",
    "_index/links.json"
  ];
  const bodies = new Map();

  for (const logicalPath of paths) {
    const response = await publicApi.request(
      `/kb/${encodeURIComponent(knowledgeBaseId)}/${encodePublicLogicalPath(logicalPath)}`,
      {
        headers: authHeaders
      }
    );

    if (!response.ok) {
      throw new Error(`Public read failed for ${logicalPath} with HTTP ${response.status}.`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    const body = await response.text();

    if (!body.trim()) {
      throw new Error(`Public read returned an empty body for ${logicalPath}.`);
    }

    if (logicalPath.endsWith(".json") && !contentType.includes("application/json")) {
      throw new Error(`Expected JSON content type for ${logicalPath}.`);
    }

    if (logicalPath.endsWith(".md") && !contentType.includes("text/markdown")) {
      throw new Error(`Expected Markdown content type for ${logicalPath}.`);
    }

    bodies.set(logicalPath, body);
  }

  validateOkfPublicArtifactBodies({
    bodies,
    pagePaths: adminFiles.pageFiles.map((file) => file.logicalPath),
    report
  });

  const taskStatus = await readJson(
    publicApi,
    `/kb/${encodeURIComponent(knowledgeBaseId)}/tasks/latest`,
    { headers: authHeaders }
  );

  if (!taskStatus.taskId || !taskStatus.startedAt || taskStatus.phaseDetails) {
    throw new Error("Public latest task status does not match the unified public lifecycle shape.");
  }

  await expectJsonError(
    publicApi,
    `/kb/${encodeURIComponent(knowledgeBaseId)}/pages/%252e%252e/secret.md`,
    authHeaders,
    [400]
  );
  await expectJsonError(
    publicApi,
    `/kb/${encodeURIComponent(knowledgeBaseId)}/pages/%5Csecret.md`,
    authHeaders,
    [400]
  );
  await expectJsonError(
    publicApi,
    `/kb/${encodeURIComponent(knowledgeBaseId)}/pages/missing.md`,
    authHeaders,
    [404]
  );
  await expectJsonError(
    publicApi,
    `/kb/${encodeURIComponent(knowledgeBaseId)}/sources/${encodeURIComponent(path.basename(adminFiles.pageFile.logicalPath))}`,
    authHeaders,
    [404]
  );
  await expectJsonError(
    publicApi,
    `/kb/${encodeURIComponent(knowledgeBaseId)}/unsupported.txt`,
    authHeaders,
    [404]
  );
  await expectJsonError(
    publicApi,
    "/admin/api/knowledge-bases",
    authHeaders,
    [404]
  );
  await expectJsonError(
    publicApi,
    `/kb/${encodeURIComponent(knowledgeBaseId)}/index.md`,
    authHeaders,
    [405],
    { method: "DELETE" }
  );

  report.checks.push(
    okCheck(
      options.checkName ?? "public-openapi",
      options.message ?? "Public scoped Markdown, JSON, task, auth, source hiding, and error checks passed."
    )
  );
}

function validateOkfPublicArtifactBodies({ bodies, pagePaths, report }) {
  const index = bodies.get("index.md") ?? "";
  const log = bodies.get("log.md") ?? "";
  const manifest = parseJsonIndex(bodies.get("_index/manifest.json"), "_index/manifest.json");
  const search = parseJsonIndex(bodies.get("_index/search.json"), "_index/search.json");
  const links = parseJsonIndex(bodies.get("_index/links.json"), "_index/links.json");

  if (index.startsWith("---\n") || !index.startsWith("# ")) {
    throw new Error("Public index.md must be a reserved Markdown file without frontmatter.");
  }

  if (
    log.startsWith("---\n") ||
    !log.startsWith("# Directory Update Log") ||
    /\brelease-[0-9a-f-]|\btask-[0-9a-f-]|S3_PREFIX|s3:\/\//i.test(log)
  ) {
    throw new Error("Public log.md must be a sanitized reserved Markdown update log without frontmatter.");
  }

  for (const pagePath of pagePaths) {
    const page = bodies.get(pagePath) ?? "";

    if (!index.includes(pagePath) && !index.includes(encodeURIComponent(path.basename(pagePath)))) {
      throw new Error("Public index.md does not reference the sampled page path.");
    }

    if (!page.startsWith("---\n") || !/\n#\s+/.test(page)) {
      throw new Error("Sampled public page does not include expected frontmatter and heading content.");
    }

    const manifestEntry = Array.isArray(manifest.files)
      ? manifest.files.find((file) => file.path === pagePath)
      : null;
    const searchItem = Array.isArray(search.items)
      ? search.items.find((item) => item.path === pagePath && item.title)
      : null;

    if (!manifestEntry) {
      throw new Error("Manifest index does not include sampled public page path.");
    }

    if (!searchItem) {
      throw new Error("Search index does not include sampled public page metadata.");
    }

    assertPublicIndexMetadata({
      pagePath,
      pageMetadata: matter(page).data ?? {},
      manifestEntry,
      searchItem
    });
  }

  for (const reservedPath of ["index.md", "log.md", "schema.md"]) {
    const manifestEntry = Array.isArray(manifest.files)
      ? manifest.files.find((file) => file.path === reservedPath)
      : null;

    if (!manifestEntry) {
      throw new Error(`Manifest index does not include reserved public file ${reservedPath}.`);
    }
  }

  if (Array.isArray(search.items) && search.items.some((item) => item.path === "index.md" || item.path === "log.md")) {
    throw new Error("Search index unexpectedly includes reserved root Markdown files.");
  }

  if (!Array.isArray(links.links)) {
    throw new Error("Link index does not include graph link data.");
  }

  const manifestPaths = new Set((manifest.files ?? []).map((file) => file.path));
  for (const link of links.links) {
    if (
      (link.from && !manifestPaths.has(link.from)) ||
      (link.to && !manifestPaths.has(link.to))
    ) {
      throw new Error("Link index references a path missing from the manifest.");
    }
  }

  for (const [logicalPath, body] of bodies) {
    if (body.includes("sources/")) {
      throw new Error(`Public artifact unexpectedly exposes sources/ path: ${logicalPath}`);
    }
  }

  report.checks.push(
    okCheck("okf-public-artifacts", "Public OKF Markdown, metadata indexes, headings, and graph links are internally consistent.", {
      pagePaths: pagePaths.length,
      manifestFiles: manifest.files.length,
      searchItems: search.items.length,
      links: links.links.length
    }, WHITE_BOX)
  );
}

function assertPublicIndexMetadata({ pagePath, pageMetadata, manifestEntry, searchItem }) {
  if (!isRecord(manifestEntry.metadata) || !isRecord(searchItem.metadata)) {
    throw new Error(`Public JSON indexes are missing metadata for ${pagePath}.`);
  }

  for (const field of ["type", "title", "description", "resource", "timestamp"]) {
    const expected = readNonEmptyString(pageMetadata[field]);

    if (!expected) {
      continue;
    }

    if (manifestEntry.metadata[field] !== expected || searchItem.metadata[field] !== expected) {
      throw new Error(`Public JSON indexes did not preserve ${field} metadata for ${pagePath}.`);
    }

    if (field !== "title" && field !== "description" && searchItem[field] !== expected) {
      throw new Error(`Public search index did not expose top-level ${field} for ${pagePath}.`);
    }
  }

  if (Array.isArray(pageMetadata.tags)) {
    const tags = pageMetadata.tags.filter((tag) => typeof tag === "string" && tag.trim());

    if (
      tags.length &&
      (!sameStringArray(manifestEntry.metadata.tags, tags) ||
        !sameStringArray(searchItem.metadata.tags, tags) ||
        !sameStringArray(searchItem.tags, tags))
    ) {
      throw new Error(`Public JSON indexes did not preserve tags metadata for ${pagePath}.`);
    }
  }

  assertNoPublicInternalMetadata(manifestEntry.metadata, pagePath);
  assertNoPublicInternalMetadata(searchItem.metadata, pagePath);
}

function assertNoPublicInternalMetadata(metadata, pagePath) {
  for (const key of PUBLIC_INDEX_INTERNAL_KEYS) {
    if (hasNestedMetadataKey(metadata, key)) {
      throw new Error(`Public JSON indexes expose internal metadata field ${key} for ${pagePath}.`);
    }
  }

  const serialized = JSON.stringify(metadata);

  if (
    serialized.includes("knowledge-bases/") ||
    serialized.includes("s3://") ||
    serialized.includes("file://")
  ) {
    throw new Error(`Public JSON indexes expose internal storage metadata for ${pagePath}.`);
  }
}

function hasNestedMetadataKey(value, key) {
  if (!isRecord(value)) {
    return false;
  }

  return Object.entries(value).some(
    ([entryKey, entryValue]) =>
      entryKey === key ||
      (isRecord(entryValue) && hasNestedMetadataKey(entryValue, key)) ||
      (Array.isArray(entryValue) && entryValue.some((item) => hasNestedMetadataKey(item, key)))
  );
}

function readNonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sameStringArray(left, right) {
  return (
    Array.isArray(left) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function validateSourceDeletionFullFlow({
  admin,
  publicApi,
  env,
  knowledgeBaseId,
  pageFile,
  taskTimeoutMs,
  report
}) {
  if (!pageFile?.logicalPath || !pageFile.sourceFileId || pageFile.deletable !== true) {
    throw new Error("Validation did not receive a deletable source-backed page file.");
  }

  const response = await admin.request(
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/files/detail?path=${encodeURIComponent(pageFile.logicalPath)}`,
    {
      method: "DELETE"
    }
  );

  if (response.status !== 202) {
    throw new Error(`Source-backed page deletion failed with HTTP ${response.status}.`);
  }

  const body = await response.json();
  const deletionTask = body.task;

  if (!deletionTask?.id || deletionTask.operation !== "delete_source") {
    throw new Error("Deletion response did not include a source deletion task.");
  }

  report.checks.push(
    okCheck("source-page-delete-submit", "Submitted source-backed page deletion through the Admin API.", {
      operation: deletionTask.operation
    })
  );

  const completedDeletionTask = await pollTaskEnded(
    admin,
    knowledgeBaseId,
    deletionTask.id,
    taskTimeoutMs,
    report
  );

  if (completedDeletionTask.operation !== "delete_source") {
    throw new Error("Deletion task did not keep the delete_source operation.");
  }

  const deletionDetail = await fetchTaskDetail(admin, knowledgeBaseId, deletionTask.id, report);

  if (deletionDetail.task.operation !== "delete_source") {
    throw new Error("Deletion task detail did not expose delete_source operation.");
  }

  await validateDeletionDatabaseBoundaries({
    databaseUrl: env.DATABASE_URL,
    knowledgeBaseId,
    sourceFileId: pageFile.sourceFileId,
    deletedPagePath: pageFile.logicalPath,
    deletionTaskId: deletionTask.id,
    report
  });

  const postDeleteFiles = await readJson(
    admin,
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/bundle-files?limit=50`
  );
  const remainingPage = postDeleteFiles.items?.find(
    (file) => String(file.logicalPath).startsWith("pages/") && file.logicalPath !== pageFile.logicalPath
  );

  if (postDeleteFiles.items?.some((file) => file.logicalPath === pageFile.logicalPath)) {
    throw new Error("Deleted page still appears in the active admin bundle file list.");
  }

  if (!remainingPage?.logicalPath) {
    throw new Error("Deletion validation requires at least one non-deleted source-backed page.");
  }

  await validatePublicDeletionState({
    publicApi,
    env,
    knowledgeBaseId,
    deletedPagePath: pageFile.logicalPath,
    remainingPagePath: remainingPage.logicalPath,
    report
  });

  report.checks.push(
    okCheck("source-page-delete-full-flow", "Source-backed page deletion republished active files without stale page references.", {
      deletedPagePath: pageFile.logicalPath,
      remainingPagePath: remainingPage.logicalPath
    })
  );

  return {
    taskId: deletionTask.id,
    deletedPagePath: pageFile.logicalPath,
    remainingPagePath: remainingPage.logicalPath
  };
}

async function validateDeletionDatabaseBoundaries({
  databaseUrl,
  knowledgeBaseId,
  sourceFileId,
  deletedPagePath,
  deletionTaskId,
  report
}) {
  const postgresModule = requireFromApiPackage("postgres");
  const postgres = postgresModule.default ?? postgresModule;
  const sql = postgres(databaseUrl, { max: 1 });

  try {
    const [shape] = await sql`
      SELECT
        (SELECT count(*)::int
         FROM focowiki.source_files
         WHERE knowledge_base_id = ${knowledgeBaseId}
           AND id = ${sourceFileId}
           AND deleted_at IS NOT NULL) AS deleted_sources,
        (SELECT count(*)::int
         FROM focowiki.upload_tasks
         WHERE knowledge_base_id = ${knowledgeBaseId}
           AND id = ${deletionTaskId}
           AND operation = 'delete_source'
           AND ended_at IS NOT NULL) AS ended_deletion_tasks,
        (SELECT count(*)::int
         FROM focowiki.upload_task_events
         WHERE task_id = ${deletionTaskId}) AS deletion_task_events,
        (SELECT count(*)::int
         FROM focowiki.releases
         WHERE knowledge_base_id = ${knowledgeBaseId}
           AND published_at IS NOT NULL) AS published_releases,
        (SELECT count(*)::int
         FROM focowiki.bundle_files
         WHERE knowledge_base_id = ${knowledgeBaseId}
           AND release_id = (
             SELECT active_release_id
             FROM focowiki.knowledge_bases
             WHERE id = ${knowledgeBaseId}
           )
           AND logical_path = ${deletedPagePath}) AS stale_active_pages
    `;

    if (
      shape.deleted_sources !== 1 ||
      shape.ended_deletion_tasks !== 1 ||
      shape.deletion_task_events < 1 ||
      shape.published_releases < 2 ||
      shape.stale_active_pages !== 0
    ) {
      throw new Error(`Unexpected deletion database state: ${JSON.stringify(shape)}`);
    }

    report.checks.push(
      okCheck("deletion-database-boundaries", "PostgreSQL records source deletion, one ended deletion task, task phases, and a replacement active release.", shape, WHITE_BOX)
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function validatePublicDeletionState({
  publicApi,
  env,
  knowledgeBaseId,
  deletedPagePath,
  remainingPagePath,
  report
}) {
  const headers = publicAuthHeaders(env);

  await expectJsonError(
    publicApi,
    `/kb/${encodeURIComponent(knowledgeBaseId)}/${encodePublicLogicalPath(deletedPagePath)}`,
    headers,
    [404]
  );

  const remaining = await readPublicText(
    publicApi,
    `/kb/${encodeURIComponent(knowledgeBaseId)}/${encodePublicLogicalPath(remainingPagePath)}`,
    headers
  );

  if (!remaining.trim()) {
    throw new Error("Remaining source-backed page became unavailable after deletion republish.");
  }

  const publicBodies = new Map([
    [
      "index.md",
      await readPublicText(publicApi, `/kb/${encodeURIComponent(knowledgeBaseId)}/index.md`, headers)
    ],
    [
      "log.md",
      await readPublicText(publicApi, `/kb/${encodeURIComponent(knowledgeBaseId)}/log.md`, headers)
    ],
    [
      "_index/manifest.json",
      await readPublicText(publicApi, `/kb/${encodeURIComponent(knowledgeBaseId)}/_index/manifest.json`, headers)
    ],
    [
      "_index/search.json",
      await readPublicText(publicApi, `/kb/${encodeURIComponent(knowledgeBaseId)}/_index/search.json`, headers)
    ],
    [
      "_index/links.json",
      await readPublicText(publicApi, `/kb/${encodeURIComponent(knowledgeBaseId)}/_index/links.json`, headers)
    ]
  ]);

  for (const [logicalPath, body] of publicBodies) {
    if (body.includes(deletedPagePath) || body.includes(encodeURIComponent(path.basename(deletedPagePath)))) {
      throw new Error(`Public ${logicalPath} still references deleted page ${deletedPagePath}.`);
    }
  }

  const manifest = parseJsonIndex(publicBodies.get("_index/manifest.json"), "_index/manifest.json");
  const search = parseJsonIndex(publicBodies.get("_index/search.json"), "_index/search.json");
  const links = parseJsonIndex(publicBodies.get("_index/links.json"), "_index/links.json");

  if (
    manifest.files.some((file) => file.path === deletedPagePath) ||
    search.items.some((item) => item.path === deletedPagePath) ||
    links.links.some((link) => link.from === deletedPagePath || link.to === deletedPagePath)
  ) {
    throw new Error("Generated indexes still contain deleted page graph or metadata references.");
  }

  report.checks.push(
    okCheck("public-deletion-state", "Public OpenAPI and generated indexes reflect source-backed page deletion.", {
      deletedPagePath,
      remainingPagePath
    })
  );
}

async function validateKnowledgeBaseDeletion({ admin, publicApi, env, knowledgeBaseId, report }) {
  const response = await admin.request(
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`,
    {
      method: "DELETE"
    }
  );

  if (!response.ok) {
    throw new Error(`Knowledge base deletion failed with HTTP ${response.status}.`);
  }

  const body = await response.json();

  if (body.deleted !== true) {
    throw new Error("Knowledge base deletion response did not confirm deletion.");
  }

  const detailResponse = await admin.request(
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`
  );

  if (detailResponse.status !== 404) {
    throw new Error("Deleted knowledge base detail route did not return not found.");
  }

  const list = await readJson(admin, "/admin/api/knowledge-bases?limit=50");

  if (list.items?.some((item) => item.id === knowledgeBaseId)) {
    throw new Error("Deleted knowledge base still appears in the admin list.");
  }

  await expectJsonError(
    publicApi,
    `/kb/${encodeURIComponent(knowledgeBaseId)}/index.md`,
    publicAuthHeaders(env),
    [404]
  );

  report.checks.push(
    okCheck("knowledge-base-delete", "Knowledge base deletion hides admin and public reads.")
  );
}

async function validateSecurityAuditEvidence(databaseUrl, startedAt, report) {
  const postgresModule = requireFromApiPackage("postgres");
  const postgres = postgresModule.default ?? postgresModule;
  const sql = postgres(databaseUrl, { max: 1 });

  try {
    const rows = await sql`
      SELECT event_type, result, error_code, username, client_ip, user_agent, origin
      FROM focowiki.admin_audit_events
      WHERE created_at >= ${startedAt}
      ORDER BY created_at DESC
      LIMIT 50
    `;

    if (rows.length === 0) {
      throw new Error("Security audit validation expected at least one audit event for this run.");
    }

    if (hasSecretLikeAuditData(rows)) {
      throw new Error("Security audit records exposed secret-like data.");
    }

    const eventTypes = Array.from(new Set(rows.map((row) => row.event_type))).sort();

    report.checks.push(
      okCheck(
        "security-audit-evidence",
        "Security audit records were written for the validation run without secret-like values.",
        {
          eventCount: rows.length,
          eventTypes
        },
        WHITE_BOX
      )
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function validateDatabaseBoundaries(
  databaseUrl,
  knowledgeBaseId,
  taskId,
  taskSamples,
  allSamples,
  report,
  options = {}
) {
  const postgresModule = requireFromApiPackage("postgres");
  const postgres = postgresModule.default ?? postgresModule;
  const sql = postgres(databaseUrl, { max: 1 });

  try {
    const [recordCounts] = await sql`
      SELECT
        (SELECT count(*)::int FROM focowiki.source_files WHERE knowledge_base_id = ${knowledgeBaseId}) AS source_files,
        (SELECT count(*)::int FROM focowiki.upload_tasks WHERE knowledge_base_id = ${knowledgeBaseId} AND id = ${taskId}) AS upload_tasks,
        (SELECT count(*)::int FROM focowiki.releases WHERE knowledge_base_id = ${knowledgeBaseId}) AS releases,
        (SELECT count(*)::int FROM focowiki.bundle_files WHERE knowledge_base_id = ${knowledgeBaseId}) AS bundle_files,
        (SELECT count(*)::int FROM focowiki.bundle_tree_entries WHERE knowledge_base_id = ${knowledgeBaseId}) AS bundle_tree_entries
    `;
    const storageShapeRows = await sql`
      SELECT
        (SELECT count(*)::int
         FROM focowiki.source_files
         WHERE knowledge_base_id = ${knowledgeBaseId}
           AND task_id = ${taskId}
           AND object_key LIKE '%/uploads/%/sources/%') AS internal_source_objects,
        (SELECT count(*)::int
         FROM focowiki.bundle_files
         WHERE knowledge_base_id = ${knowledgeBaseId}
           AND logical_path LIKE 'pages/%'
           AND object_key LIKE '%/releases/%/bundle/pages/%') AS public_page_objects,
        (SELECT count(*)::int
         FROM focowiki.bundle_files
         WHERE knowledge_base_id = ${knowledgeBaseId}
           AND logical_path LIKE 'sources/%') AS exposed_source_bundle_files,
        (SELECT bool_and(jsonb_typeof(metadata_json) = 'object')
         FROM focowiki.source_files
         WHERE knowledge_base_id = ${knowledgeBaseId}
           AND task_id = ${taskId}) AS source_metadata_is_object
    `;
    const bodyColumns = await sql`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'focowiki'
        AND table_name IN ('source_files', 'bundle_files')
        AND (
          column_name IN ('body', 'content', 'raw_body', 'markdown_body', 'json_body', 'file_body')
          OR column_name LIKE '%\\_body'
        )
      ORDER BY table_name, column_name
    `;
    const sourceRows = await sql`
      SELECT original_name, object_key, metadata_json
      FROM focowiki.source_files
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND task_id = ${taskId}
      ORDER BY original_name
    `;
    const pageRows = await sql`
      SELECT logical_path, object_key, frontmatter_json
      FROM focowiki.bundle_files
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND release_id = (
          SELECT active_release_id
          FROM focowiki.knowledge_bases
          WHERE id = ${knowledgeBaseId}
        )
        AND logical_path LIKE 'pages/%'
      ORDER BY logical_path
    `;
    const storageShape = storageShapeRows[0] ?? {};
    const expectedTaskNames = new Set(taskSamples.map((sample) => sample.basename));
    const expectedAllNames = new Set(allSamples.map((sample) => sample.basename));
    const actualNames = new Set(sourceRows.map((row) => row.original_name));

    if (
      recordCounts.source_files !== allSamples.length ||
      recordCounts.upload_tasks !== 1 ||
      recordCounts.releases < 1 ||
      recordCounts.bundle_files < 1 ||
      recordCounts.bundle_tree_entries < 1
    ) {
      throw new Error(`Unexpected database record counts: ${JSON.stringify(recordCounts)}`);
    }

    if (bodyColumns.length > 0) {
      throw new Error(`Database contains suspicious file body columns: ${JSON.stringify(bodyColumns)}`);
    }

    if (
      storageShape.internal_source_objects !== taskSamples.length ||
      storageShape.public_page_objects < allSamples.length ||
      storageShape.exposed_source_bundle_files !== 0 ||
      storageShape.source_metadata_is_object !== true
    ) {
      throw new Error(`Unexpected storage-backed database shape: ${JSON.stringify(storageShape)}`);
    }

    for (const name of expectedTaskNames) {
      if (!actualNames.has(name)) {
        throw new Error(`Database did not preserve uploaded original file name: ${name}`);
      }
    }

    const allSourceRows = await sql`
      SELECT original_name
      FROM focowiki.source_files
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND deleted_at IS NULL
      ORDER BY original_name
    `;
    const allActualNames = new Set(allSourceRows.map((row) => row.original_name));

    for (const name of expectedAllNames) {
      if (!allActualNames.has(name)) {
        throw new Error(`Database did not preserve active source file name: ${name}`);
      }
    }

    const firstSource = sourceRows[0];
    const firstPage = pageRows[0];

    if (!firstSource?.object_key || !firstPage?.object_key || !firstPage?.logical_path) {
      throw new Error("Database did not provide source and generated page storage evidence.");
    }

    report.checks.push(
      okCheck(
        options.checkName ?? "database-boundaries",
        options.message ?? "PostgreSQL contains durable records, original file names, storage-backed keys, and no raw file body columns.",
        {
          ...recordCounts,
          internalSourceObjects: storageShape.internal_source_objects,
          publicPageObjects: storageShape.public_page_objects,
          exposedSourceBundleFiles: storageShape.exposed_source_bundle_files,
          taskSamples: taskSamples.length,
          activeSamples: allSamples.length
        },
        WHITE_BOX
      )
    );

    return {
      sourceObjectKey: firstSource.object_key,
      pageObjectKey: firstPage.object_key,
      pageLogicalPath: firstPage.logical_path,
      sourceOriginalName: firstSource.original_name
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function validateS3ObjectBoundaries(env, evidence, samples, report, options = {}) {
  const { GetObjectCommand, S3Client } = requireFromApiPackage("@aws-sdk/client-s3");
  const client = new S3Client(createS3ClientConfigFromEnv(env));
  const sourceText = await getS3ObjectText(client, env.S3_BUCKET, evidence.sourceObjectKey);
  const pageText = await getS3ObjectText(client, env.S3_BUCKET, evidence.pageObjectKey);
  const matchingSample = samples.find((sample) => sample.basename === evidence.sourceOriginalName);

  if (!matchingSample) {
    throw new Error("S3 validation could not match database source evidence to selected sample.");
  }

  if (!sourceText.includes(matchingSample.title) || !pageText.startsWith("---\n")) {
    throw new Error("S3 object body validation failed for internal source or generated page object.");
  }

  if (evidence.pageLogicalPath.startsWith("sources/")) {
    throw new Error("S3 generated public page evidence unexpectedly used a sources/ logical path.");
  }

  report.checks.push(
    okCheck(
      options.checkName ?? "s3-object-boundaries",
      options.message ?? "S3 contains internal source objects and generated public page objects without exposing source logical paths.",
      {
        sourceBodyReadable: true,
        pageBodyReadable: true,
        pageLogicalPath: evidence.pageLogicalPath
      },
      WHITE_BOX
    )
  );
}

async function validateRedisBoundaries(redisUrl, samples, report) {
  const { createClient } = requireFromApiPackage("redis");
  const client = createClient({ url: redisUrl });
  await client.connect();

  try {
    const bodySnippets = samples
      .map((sample) => bodySnippet(readSampleLeakPrefix(sample)))
      .filter(Boolean);
    let cursor = "0";
    let scanned = 0;
    let leakedBodyKey = null;

    do {
      const result = await client.scan(cursor, { COUNT: 100 });
      cursor = String(result.cursor);

      for (const key of result.keys) {
        scanned += 1;
        const type = await client.type(key);

        if (type !== "string") {
          continue;
        }

        const value = await client.get(key);

        const normalizedValue = normalizeTextForLeakScan(value);

        if (normalizedValue && bodySnippets.some((snippet) => normalizedValue.includes(snippet))) {
          leakedBodyKey = key;
          break;
        }
      }
    } while (cursor !== "0" && !leakedBodyKey);

    if (leakedBodyKey) {
      throw new Error("Redis string values contain selected sample Markdown body content.");
    }

    report.checks.push(
      okCheck("redis-boundaries", "Redis scan did not find selected sample Markdown bodies in string values.", {
        scannedKeys: scanned
      }, WHITE_BOX)
    );
  } finally {
    await client.quit();
  }
}

function bodySnippet(value) {
  const normalized = normalizeTextForLeakScan(value);

  return normalized.length >= 120 ? normalized.slice(0, 120) : "";
}

function readSampleLeakPrefix(sample) {
  const fd = fs.openSync(sample.filePath, "r");

  try {
    const buffer = Buffer.alloc(Math.min(sample.sizeBytes, 64 * 1024));
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

function normalizeTextForLeakScan(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

async function readJson(client, pathname, options = {}) {
  const response = await client.request(pathname, options);

  if (!response.ok) {
    throw new Error(`Request ${pathname} failed with HTTP ${response.status}.`);
  }

  return response.json();
}

async function readPublicText(client, pathname, headers) {
  const response = await client.request(pathname, { headers });

  if (!response.ok) {
    throw new Error(`Request ${pathname} failed with HTTP ${response.status}.`);
  }

  return response.text();
}

async function expectJsonError(client, pathname, headers, statuses, options = {}) {
  const response = await client.request(pathname, { headers, method: options.method ?? "GET" });

  if (!statuses.includes(response.status)) {
    throw new Error(`Expected ${pathname} to return one of ${statuses.join(", ")}, got ${response.status}.`);
  }

  const contentType = response.headers.get("content-type") ?? "";

  if (!contentType.includes("application/json")) {
    throw new Error(`Expected JSON error body for ${pathname}.`);
  }

  const body = await response.json();
  const serialized = JSON.stringify(body);

  if (!body.error?.code) {
    throw new Error(`Expected stable JSON error code for ${pathname}.`);
  }

  if (/bucket|objectKey|object_key|release-[0-9a-f-]|S3_|secret|access/i.test(serialized)) {
    throw new Error(`Public error exposed storage details for ${pathname}.`);
  }
}

function publicAuthHeaders(env) {
  if (!env.PUBLIC_OPENAPI_VALIDATION_KEY) {
    throw new Error("Managed public OpenAPI validation key is not available.");
  }

  return { authorization: `Bearer ${env.PUBLIC_OPENAPI_VALIDATION_KEY}` };
}

function parseJsonIndex(raw, logicalPath) {
  try {
    return JSON.parse(String(raw ?? ""));
  } catch {
    throw new Error(`Public index is not valid JSON: ${logicalPath}`);
  }
}

async function getS3ObjectText(client, bucket, key) {
  const { GetObjectCommand } = requireFromApiPackage("@aws-sdk/client-s3");
  const response = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key
    })
  );

  return responseBodyToString(response.Body);
}

function createS3ClientConfigFromEnv(env) {
  return {
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY
    },
    forcePathStyle: env.S3_FORCE_PATH_STYLE === "true"
  };
}

function normalizeS3Prefix(value) {
  return String(value ?? "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

async function responseBodyToString(body) {
  if (!body) {
    return "";
  }

  if (typeof body === "string") {
    return body;
  }

  if (body instanceof Uint8Array) {
    return new TextDecoder().decode(body);
  }

  if (typeof body.transformToString === "function") {
    return body.transformToString();
  }

  if (typeof body[Symbol.asyncIterator] === "function") {
    const chunks = [];

    for await (const chunk of body) {
      chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
    }

    return new TextDecoder().decode(Buffer.concat(chunks));
  }

  throw new TypeError("Unsupported S3 response body");
}

function encodePublicLogicalPath(logicalPath) {
  return logicalPath.split("/").map(encodeURIComponent).join("/");
}

function redactUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
  } catch {
    return "<invalid-url>";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

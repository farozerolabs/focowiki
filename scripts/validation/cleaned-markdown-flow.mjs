import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
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
  recordConfiguredRuntimeResources,
  recordOperationalSnapshot,
  recordPaginationEvidence,
  recordSourceFileDuration
} from "./lib/performance-evidence.mjs";
import { redactPotentialPathText, redactReportText } from "./lib/redaction.mjs";
import {
  readContentQualitySampleLimit,
  validateGeneratedContentQuality
} from "./lib/content-quality.mjs";

export {
  selectSamples,
  selectSamplesFromEnvironment,
  selectSingleAndBatchSamples,
  selectSingleAndBatchSamplesFromEnvironment
} from "./lib/sample-selector.mjs";

const CHANGE_ID = process.env.FOCOWIKI_VALIDATION_CHANGE_ID?.trim() || "validate-real-legal-full-flow";
const REPORT_DIR_ENV = "FOCOWIKI_VALIDATION_REPORT_DIR";
const TASK_TIMEOUT_ENV = "FOCOWIKI_VALIDATION_TASK_TIMEOUT_MS";
const HTTP_TIMEOUT_ENV = "FOCOWIKI_VALIDATION_HTTP_TIMEOUT_MS";
const REQUIRE_MODEL_ENV = "FOCOWIKI_VALIDATION_REQUIRE_MODEL";
const WHITE_BOX = "white-box";
const BLACK_BOX = "black-box";
const EXPECTED_UPLOAD_PHASE_KEYS = new Set([
  "upload_storage",
  "source_deletion",
  "metadata_resolution",
  "llm_suggestion",
  "graph_generation",
  "bundle_generation",
  "okf_validation",
  "index_publication",
  "release_activation"
]);
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

    const admin = createHttpClient(adminBaseUrl, {
      writeOrigin: env.ADMIN_PUBLIC_ORIGIN || `http://localhost:${env.ADMIN_UI_PORT ?? "43100"}`,
      onTiming: (timing) => recordEndpointTiming(performanceEvidence, timing)
    });
    const publicApi = createHttpClient(publicBaseUrl, {
      onTiming: (timing) => recordEndpointTiming(performanceEvidence, timing)
    });
    const processingTimeoutMs = readValidationTaskTimeoutMs(env, allSamples.length);

    logValidationStep("prerequisites");
    await validateDatabaseConnectivity(env.DATABASE_URL, report);
    await validateRedisConnectivity(env.REDIS_URL, report);
    await validateS3Connectivity(env, report);
    await expectUnauthorizedAdmin(admin, report);
    await expectInvalidAdminLogin(admin, env, report);
    await validatePublicApiReachable(publicApi, env, report);
    await validateSecurityHeaders({ admin, publicApi, env, report });

    logValidationStep("admin-auth");
    await loginAdmin(admin, env, report);
    await validateRuntimeUploadGenerationSettings(
      admin,
      Math.max(singleSamples.length, batchSamples.length),
      report
    );
    await validateModelAssistanceMode(admin, env, report);
    await validateAdminOriginProtection(admin, report);
    env.PUBLIC_OPENAPI_VALIDATION_KEY = await ensureManagedPublicOpenApiKey(admin, report);
    await validateDeveloperOpenApiWebhooks(publicApi, env, report);
    logValidationStep("developer-openapi-continuity");
    await validateDeveloperOpenApiUploadContinuity({
      publicApi,
      env,
      sample: sampleSelection.singleSample,
      processingTimeoutMs,
      report
    });
    logValidationStep("knowledge-base-create");
    const knowledgeBase = await createValidationKnowledgeBase(admin, report);
    await validateUploadRejection(admin, knowledgeBase.id, report);

    logValidationStep("single-upload");
    const singleSourceFiles = await uploadSamples(admin, knowledgeBase.id, singleSamples, report, {
      checkName: "single-upload-submit",
      message: "Uploaded one selected sample in a single-file upload action."
    });
    const completedSingleFiles = await pollSourceFilesCompleted(
      admin,
      knowledgeBase.id,
      singleSourceFiles.map((file) => file.id),
      processingTimeoutMs,
      report,
      {
        checkName: "single-source-file-completed",
        message: "Single source file reached completed lifecycle state."
      }
    );
    for (const file of completedSingleFiles) {
      recordSourceFileDuration(performanceEvidence, file);
    }
    const singleFileDetail = await fetchSourceFileDetail(admin, knowledgeBase.id, completedSingleFiles[0].id, report, {
      checkName: "single-source-file-detail",
      message: "Single source-file detail exposes bounded file events."
    });
    validateSourceFileModelEvidence(completedSingleFiles, singleSamples, env, report, {
      checkName: "single-source-file-llm-detail",
      message: "Single source-file rows expose LLM stage and model invocation summary."
    });
    await validateSourceFileRows(
      admin,
      knowledgeBase.id,
      completedSingleFiles,
      report,
      {
        checkName: "single-source-file-row",
        message: "Single-file upload is represented as one source-file row with one lifecycle status."
      }
    );
    const singleAdminFiles = await validateAdminFileSurfaces(admin, knowledgeBase.id, report, {
      expectedSamples: singleSamples,
      checkName: "single-admin-file-surfaces",
      message: "Admin release, bundle, tree, detail, and Developer OpenAPI URL surfaces work after single upload."
    });
    await validatePublicOpenApi(publicApi, knowledgeBase.id, singleAdminFiles, env, report, {
      sourceFileId: completedSingleFiles[0].id,
      expectedSamples: singleSamples,
      checkName: "single-public-openapi",
      message: "Public scoped Markdown, JSON, source-file, auth, source hiding, and error checks passed after single upload."
    });
    const singleStorageEvidence = await validateDatabaseBoundaries(
      env.DATABASE_URL,
      knowledgeBase.id,
      completedSingleFiles.map((file) => file.id),
      singleSamples,
      singleSamples,
      report,
      {
        checkName: "single-database-boundaries",
        message:
          "PostgreSQL contains durable records, original file names, storage-backed keys, and no raw file body columns after single upload."
      }
    );
    await validateModelInvocationBoundaries(
      env.DATABASE_URL,
      knowledgeBase.id,
      completedSingleFiles.map((file) => file.id),
      singleSamples,
      env,
      report,
      {
        checkName: "single-model-invocation-boundaries",
        message: "PostgreSQL contains terminal model invocation records for the single-file upload."
      }
    );
    await validateS3ObjectBoundaries(env, singleStorageEvidence, singleSamples, report, {
      checkName: "single-s3-object-boundaries",
      message:
        "S3 contains internal source objects and generated public page objects without exposing source logical paths after single upload."
    });

    logValidationStep("batch-upload");
    const batchSourceFiles = await uploadSamples(admin, knowledgeBase.id, batchSamples, report, {
      checkName: "batch-upload-submit",
      message: "Uploaded selected batch samples in one upload action."
    });
    const completedBatchFiles = await pollSourceFilesCompleted(
      admin,
      knowledgeBase.id,
      batchSourceFiles.map((file) => file.id),
      processingTimeoutMs,
      report,
      {
        checkName: "batch-source-files-completed",
        message: "Batch source files reached completed lifecycle state."
      }
    );
    for (const file of completedBatchFiles) {
      recordSourceFileDuration(performanceEvidence, file);
    }
    const batchFileDetail = await fetchSourceFileDetail(admin, knowledgeBase.id, completedBatchFiles[0].id, report, {
      checkName: "batch-source-file-detail",
      message: "Batch source-file detail exposes bounded file events."
    });
    validateSourceFileModelEvidence(completedBatchFiles, batchSamples, env, report, {
      checkName: "batch-source-file-llm-detail",
      message: "Batch source-file rows expose LLM stage and model invocation summaries."
    });
    await validateSourceFileRows(
      admin,
      knowledgeBase.id,
      [
        ...completedSingleFiles,
        ...completedBatchFiles
      ],
      report,
      {
        checkName: "single-batch-source-file-rows",
        message: "Single and batch upload actions are represented as source-file rows with one lifecycle status each."
      }
    );
    await validateSourceFilePagination(
      admin,
      knowledgeBase.id,
      allSamples.length,
      report,
      performanceEvidence
    );
    await validateAdminSourceFileFilters(admin, knowledgeBase.id, completedBatchFiles[0], report);
    await validateAdminProcessingSummary(admin, knowledgeBase.id, report);
    const batchAdminFiles = await validateAdminFileSurfaces(admin, knowledgeBase.id, report, {
      expectedSamples: allSamples,
      checkName: "batch-admin-file-surfaces",
      message:
        "Admin release, bundle, tree, detail, and Developer OpenAPI URL surfaces include single and batch generated files."
    });
    await validateAdminPaginationSurfaces(
      admin,
      knowledgeBase.id,
      batchAdminFiles.pageFiles.length,
      report,
      performanceEvidence
    );
    await validateAdminTreeSearch(admin, knowledgeBase.id, batchAdminFiles.pageFile, report);
    await validatePublicOpenApi(publicApi, knowledgeBase.id, batchAdminFiles, env, report, {
      sourceFileId: completedBatchFiles[0].id,
      expectedSamples: allSamples,
      checkName: "batch-public-openapi",
      message:
        "Public scoped Markdown, JSON, source-file, auth, source hiding, and error checks passed after batch upload."
    });
    const batchStorageEvidence = await validateDatabaseBoundaries(
      env.DATABASE_URL,
      knowledgeBase.id,
      completedBatchFiles.map((file) => file.id),
      batchSamples,
      allSamples,
      report,
      {
        checkName: "batch-database-boundaries",
        message:
          "PostgreSQL contains durable records, original file names, storage-backed keys, and no raw file body columns after batch upload."
      }
    );
    await validateModelInvocationBoundaries(
      env.DATABASE_URL,
      knowledgeBase.id,
      completedBatchFiles.map((file) => file.id),
      batchSamples,
      env,
      report,
      {
        checkName: "batch-model-invocation-boundaries",
        message: "PostgreSQL contains terminal model invocation records for the batch upload."
      }
    );
    await validateS3ObjectBoundaries(env, batchStorageEvidence, batchSamples, report, {
      checkName: "batch-s3-object-boundaries",
      message:
        "S3 contains internal source objects and generated public page objects without exposing source logical paths after batch upload."
    });
    logValidationStep("redis-boundaries");
    await validateRedisBoundaries(env.REDIS_URL, allSamples, report);
    logValidationStep("source-deletion");
    const deletionEvidence = await validateSourceDeletionFullFlow({
      admin,
      publicApi,
      env,
      knowledgeBaseId: knowledgeBase.id,
      pageFile: batchAdminFiles.pageFile,
      processingTimeoutMs,
      report
    });
    await validateAdminSourceFileTaskDeletion({
      admin,
      knowledgeBaseId: knowledgeBase.id,
      sourceFileId: selectTaskDeletionCandidate(completedBatchFiles, deletionEvidence.sourceFileId),
      report
    });
    logValidationStep("knowledge-base-deletion");
    await validateKnowledgeBaseDeletion({
      admin,
      publicApi,
      env,
      knowledgeBaseId: knowledgeBase.id,
      report
    });
    logValidationStep("security-audit");
    await validateSecurityAuditEvidence(env.DATABASE_URL, report.startedAt, report);
    await recordOperationalPerformanceSnapshot(env.DATABASE_URL, knowledgeBase.id, performanceEvidence, report);
    recordConfiguredRuntimeResources(performanceEvidence, env);
    logValidationStep("performance-summary");
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
      singleSourceFileIds: completedSingleFiles.map((file) => file.id),
      batchSourceFileIds: completedBatchFiles.map((file) => file.id),
      deletedPagePath: deletionEvidence.deletedPagePath,
      singleSourceCount: completedSingleFiles.length,
      batchSourceCount: completedBatchFiles.length,
      totalSourceCount: allSamples.length,
      sampleProfile: sampleSelection.profile,
      singleEventCount: singleFileDetail.events.items.length,
      batchEventCount: batchFileDetail.events.items.length,
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
    contentQuality: [],
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
    checksumSha256: sampleChecksum(sample),
    title: sample.title,
    type: sample.type,
    status: sample.status,
    category: sample.category,
    publicationDate: sample.publicationDate || "unknown-date",
    sizeBytes: sample.sizeBytes
  };
}

function sampleChecksum(sample) {
  return createHash("sha256").update(fs.readFileSync(sample.filePath)).digest("hex");
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

function logValidationStep(name) {
  console.error(`[validation] ${name}`);
}

function writeReport(report) {
  const reportDir = resolveReportDir();
  fs.mkdirSync(reportDir, { recursive: true });
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
    `- Required: ${report.modelAssistance?.required ? "yes" : "no"}`,
    `- Enabled: ${report.modelAssistance?.enabled ? "yes" : "no"}`,
    `- API mode: ${report.modelAssistance?.apiMode ?? "not-configured"}`,
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
          `- Source-file durations: count=${report.performance.sourceFileDurations.count}, maxMs=${report.performance.sourceFileDurations.maxMs}, averageMs=${report.performance.sourceFileDurations.averageMs}`,
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
    "## Content Quality",
    "",
    ...(report.contentQuality?.length
      ? report.contentQuality.flatMap((quality) => [
          `- Scope: ${quality.scope}`,
          `  - Structural samples: ${quality.structuralSamples}`,
          `  - Semantic samples: ${quality.semanticSamples}`,
          `  - Source-supported pages: ${quality.sourceSupportedPages}`,
          `  - Model-checked pages: ${quality.modelCheckedPages}`,
          `  - Graph links: ${quality.graphLinks}`,
          `  - Questionable graph links: ${quality.questionableGraphLinks}`,
          `  - Pages with graph links: ${quality.pagesWithGraphLinks}`,
          `  - Warnings: ${quality.warnings.length ? quality.warnings.join("; ") : "none"}`
        ])
      : ["- Not recorded."]),
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

  fs.writeFileSync(path.join(reportDir, "validation-report.md"), lines.join("\n"));
}

function defaultCommandsRun(kind, sampleProfile = "default") {
  if (CHANGE_ID === "validate-large-legal-e2e-full-coverage") {
    const command =
      kind === "samples"
        ? "pnpm validate:large-legal:full-coverage:samples"
        : "FOCOWIKI_VALIDATION_ALLOW_CONFIGURED_EXTERNALS=true pnpm validate:large-legal:full-coverage:api";

    return Array.from(new Set([
      "pnpm validate:large-legal:full-coverage:samples",
      command,
      "pnpm test:validation",
      `openspec validate ${CHANGE_ID} --strict`
    ]));
  }

  const prefix = readBooleanEnv(process.env[REQUIRE_MODEL_ENV])
    ? "pnpm validate:legal-llm"
    : sampleProfile === "large-scale"
      ? "pnpm validate:real-legal:large"
      : "pnpm validate:real-legal";
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
    tests.push("Developer OpenAPI black-box flow");
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
    "Pass 2: real service API, Developer OpenAPI, persistence, storage, Redis, OKF, model-mode, and deletion validation."
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
  const reportDir = resolveReportDir();
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, "validation-report.json"), `${JSON.stringify(report, null, 2)}\n`);
}

function resolveReportDir() {
  const configured = process.env[REPORT_DIR_ENV]?.trim();

  if (configured) {
    return path.resolve(configured);
  }

  return path.resolve("openspec/changes", CHANGE_ID);
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

function readModelAssistanceMode(env) {
  const required = readBooleanEnv(env[REQUIRE_MODEL_ENV]);

  return {
    required,
    enabled: false,
    apiMode: null,
    modelName: null,
    baseUrl: null,
    contextWindowTokens: null,
    requestMaxTimeoutMs: null,
    requestIdleTimeoutMs: null,
    suggestionConcurrency: null
  };
}

async function readRuntimeSettings(admin) {
  const response = await admin.request("/admin/api/settings/runtime");

  if (!response.ok) {
    throw new Error(`Runtime settings request failed with HTTP ${response.status}.`);
  }

  return response.json();
}

async function validateRuntimeUploadGenerationSettings(admin, sampleCount, report) {
  const body = await readRuntimeSettings(admin);
  const uploadGeneration = body.settings?.uploadGeneration;

  if (!uploadGeneration) {
    throw new Error("Runtime settings response did not include upload-generation settings.");
  }

  for (const [field, value] of Object.entries(uploadGeneration)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Runtime upload-generation setting ${field} must be a positive integer.`);
    }
  }

  if (uploadGeneration.maxFiles < sampleCount) {
    throw new Error(`Admin UI upload-generation maxFiles must be at least ${sampleCount} for this validation run.`);
  }

  report.checks.push(
    okCheck(
      "runtime-upload-generation-settings",
      "Admin UI runtime upload-generation settings are persisted and large enough for validation samples.",
      {
        maxFiles: uploadGeneration.maxFiles,
        sampleCount,
        generationBatchSize: uploadGeneration.generationBatchSize,
        fileProcessingConcurrency: uploadGeneration.fileProcessingConcurrency,
        storageConcurrency: uploadGeneration.storageConcurrency
      },
      WHITE_BOX
    )
  );

  return uploadGeneration;
}

async function readRuntimeModelAssistanceMode(admin, env) {
  const mode = readModelAssistanceMode(env);
  const body = await readRuntimeSettings(admin);
  const activeModel = body.settings?.activeModel;

  if (!activeModel) {
    return mode;
  }

  return {
    ...mode,
    enabled: true,
    apiMode: ["responses", "chat_completions"].includes(activeModel.apiMode)
      ? activeModel.apiMode
      : null,
    modelName: activeModel.modelName ?? null,
    baseUrl: activeModel.baseUrl ? redactUrl(activeModel.baseUrl) : null,
    contextWindowTokens: Number(activeModel.contextWindowTokens ?? 0),
    requestMaxTimeoutMs: Number(activeModel.requestMaxTimeoutMs ?? 0),
    requestIdleTimeoutMs: Number(activeModel.requestIdleTimeoutMs ?? 0),
    suggestionConcurrency: Number(activeModel.suggestionConcurrency ?? 0)
  };
}

async function validateModelAssistanceMode(admin, env, report) {
  const mode = await readRuntimeModelAssistanceMode(admin, env);
  report.modelAssistance = mode;

  if (!mode.enabled) {
    if (mode.required) {
      throw new Error(`${REQUIRE_MODEL_ENV}=true requires an active model in Admin UI runtime settings.`);
    }

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
    !["responses", "chat_completions"].includes(mode.apiMode) ||
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
    throw new Error("Model assistance validation requires valid API mode, context, timeout, and concurrency settings.");
  }

  report.checks.push(
    okCheck(
      "model-assistance-mode",
      "Model assistance is enabled with bounded context, timeout, and concurrency settings.",
      {
        modelName: mode.modelName,
        apiMode: mode.apiMode,
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

function readBooleanEnv(value) {
  return /^(1|true|yes)$/i.test(String(value ?? "").trim());
}

export function readValidationTaskTimeoutMs(env, sampleCount) {
  const configured = env[TASK_TIMEOUT_ENV]?.trim();

  if (configured) {
    const parsed = Number(configured);

    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error(`${TASK_TIMEOUT_ENV} must be a positive integer.`);
    }

    return parsed;
  }

  return Math.max(180_000, sampleCount * 120_000 + 180_000);
}

function readPositiveInteger(value, fallback) {
  const parsed = Number(value ?? fallback);

  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function createHttpClient(baseUrl, clientOptions = {}) {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  const timeoutMs =
    clientOptions.timeoutMs ?? readPositiveInteger(process.env[HTTP_TIMEOUT_ENV], 180_000);
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

      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort(), timeoutMs);
      let response;

      try {
        response = await fetch(`${normalizedBaseUrl}${pathname}`, {
          ...requestOptions,
          headers,
          signal: requestOptions.signal ?? abortController.signal
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
      } finally {
        clearTimeout(timeout);
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
    await sendS3Command(
      client,
      new PutObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: key,
        Body: "focowiki-validation",
        ContentType: "text/plain; charset=utf-8"
      }),
      "S3 put validation object"
    );
    const response = await sendS3Command(
      client,
      new GetObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: key
      }),
      "S3 get validation object"
    );
    const body = await withTimeout(responseBodyToString(response.Body), "S3 validation body read");

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
    await sendS3Command(
      client,
        new DeleteObjectCommand({
          Bucket: env.S3_BUCKET,
          Key: key
        }),
        "S3 delete validation object"
      )
      .catch(() => undefined);
  }
}

async function validatePublicApiReachable(publicApi, env, report) {
  const response = await publicApi.request("/openapi/v1/health");

  if (![200, 401].includes(response.status)) {
    throw new Error(`Developer OpenAPI prerequisite expected HTTP 200 or 401, got ${response.status}.`);
  }

  report.checks.push(okCheck("developer-openapi-prerequisite", "Developer OpenAPI is reachable."));
}

async function validateSecurityHeaders({ admin, publicApi, env, report }) {
  const adminResponse = await admin.request("/admin/api/knowledge-bases");
  assertSecurityHeaders(adminResponse, "Admin API");

  const publicResponse = await publicApi.request("/openapi/v1/health", {
    headers: {}
  });
  assertSecurityHeaders(publicResponse, "Developer OpenAPI");

  report.checks.push(
    okCheck(
      "http-security-headers",
      "Admin API and Developer OpenAPI return security response headers on validation responses.",
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

  if (response.status !== 401 && response.status !== 429) {
    throw new Error(`Invalid admin login expected HTTP 401 or 429, got ${response.status}.`);
  }

  report.checks.push(
    okCheck(
      "admin-invalid-login",
      response.status === 429
        ? "Admin login rate limiting blocks repeated invalid credentials."
        : "Admin login rejects invalid credentials."
    )
  );
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
  const files = Array.isArray(body.files) ? body.files : [];

  if (files.length !== samples.length || files.some((file) => !file?.id || file.processingStatus !== "queued")) {
    throw new Error("Upload response did not include the expected source-file records.");
  }

  report.checks.push(
    okCheck(options.checkName ?? "upload-submit", options.message ?? "Uploaded selected samples in one upload action.", {
      sourceCount: files.length
    })
  );

  return files;
}

async function pollSourceFilesCompleted(admin, knowledgeBaseId, sourceFileIds, timeoutMs, report, options = {}) {
  const deadline = Date.now() + timeoutMs;
  const expectedIds = new Set(sourceFileIds);

  while (Date.now() < deadline) {
    const files = await listAdminSourceFiles(admin, knowledgeBaseId, 50);
    const selectedFiles = files.filter((file) => expectedIds.has(file.id));
    const failedFile = selectedFiles.find((file) => file.processingStatus === "failed");

    if (failedFile) {
      throw new Error(`Source file processing failed for ${failedFile.id}: ${failedFile.processingErrorCode ?? "UNKNOWN"}.`);
    }

    if (
      selectedFiles.length === expectedIds.size &&
      selectedFiles.every(
        (file) => file.processingStatus === "completed" && file.generatedOutputStatus === "visible"
      )
    ) {
      report.checks.push(
        okCheck(options.checkName ?? "source-files-completed", options.message ?? "Source files reached completed lifecycle state.", {
          timeoutMs,
          generatedOutputStatus: "visible"
        })
      );
      return selectedFiles;
    }

    await sleep(1_000);
  }

  throw new Error(`Timed out waiting for source files to complete after ${timeoutMs}ms.`);
}

async function listAdminSourceFiles(admin, knowledgeBaseId, limit = 50) {
  const files = [];
  let cursor = null;

  do {
    const pathWithCursor = `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-files?limit=${limit}${
      cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
    }`;
    const body = await readJson(admin, pathWithCursor);
    files.push(...(body.items ?? []));
    cursor = body.nextCursor ?? null;
  } while (cursor);

  return files;
}

async function listAdminBundleFiles(admin, knowledgeBaseId, limit = 100) {
  const files = [];
  let cursor = null;

  do {
    const pathWithCursor = `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/bundle-files?limit=${limit}${
      cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
    }`;
    const body = await readJson(admin, pathWithCursor);
    files.push(...(body.items ?? []));
    cursor = body.nextCursor ?? null;
  } while (cursor);

  return {
    items: files,
    nextCursor: null
  };
}

async function fetchSourceFileDetail(admin, knowledgeBaseId, sourceFileId, report, options = {}) {
  const response = await admin.request(
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-files/${encodeURIComponent(sourceFileId)}?limit=50`
  );

  if (!response.ok) {
    throw new Error(`Source-file detail request failed with HTTP ${response.status}.`);
  }

  const body = await response.json();
  const events = body.events?.items ?? [];

  if (!body.file?.id || body.file.id !== sourceFileId || events.length === 0 || events.length > EXPECTED_UPLOAD_PHASE_KEYS.size * 2) {
    throw new Error(`Expected bounded admin source-file events, got ${events.length}.`);
  }

  const unknownEvent = events.find((event) => !EXPECTED_UPLOAD_PHASE_KEYS.has(event.stageKey));

  if (unknownEvent) {
    throw new Error(`Source-file detail returned an unexpected stage key: ${unknownEvent.stageKey}.`);
  }

  report.checks.push(
    okCheck(options.checkName ?? "source-file-detail", options.message ?? "Source-file detail exposes bounded file events.", {
      eventCount: events.length,
      sourceFileId
    })
  );
  return body;
}

function validateSourceFileModelEvidence(files, samples, env, report, options = {}) {
  const mode = report.modelAssistance ?? readModelAssistanceMode(env);

  if (!mode.enabled) {
    report.checks.push(
      okCheck(
        options.checkName ?? "source-file-llm-detail",
        "Model assistance is disabled; source-file model evidence is not required for this run.",
        { expectedSamples: samples.length },
        WHITE_BOX
      )
    );
    return;
  }

  const expectedNames = new Set(samples.map((sample) => sample.basename));
  const matchingFiles = files.filter((file) => expectedNames.has(file.originalName));

  if (matchingFiles.length !== samples.length) {
    throw new Error(`Source-file list returned ${matchingFiles.length} model-checked files, expected ${samples.length}.`);
  }

  const missingModel = matchingFiles.filter((file) => !file.modelInvocationStatus);
  const skipped = matchingFiles.filter((file) => file.modelInvocationStatus === "skipped");
  const failed = matchingFiles.filter((file) => file.modelInvocationStatus === "failed");
  const completed = matchingFiles.filter((file) => file.modelInvocationStatus === "completed");

  if (failed.length > 0) {
    report.manualReviewItems.push(
      `Model provider returned warnings for ${failed.length} source file(s); generated files used deterministic fallback and model output quality could not be judged for those files.`
    );
  }

  if (missingModel.length > 0 || skipped.length > 0 || completed.length + failed.length !== samples.length) {
    throw new Error(
      `Source-file model evidence is incomplete: missing=${missingModel.length}, skipped=${skipped.length}, failed=${failed.length}, completed=${completed.length}.`
    );
  }

  if (matchingFiles.some((file) => file.modelInvocationModelName !== mode.modelName)) {
    throw new Error("Source-file model evidence did not preserve the configured model name.");
  }

  report.checks.push(
    okCheck(
      options.checkName ?? "source-file-llm-detail",
      options.message ?? "Source-file rows expose terminal LLM stage and model invocation summaries.",
      {
        expectedSamples: samples.length,
        completed: completed.length,
        skipped: skipped.length,
        failed: failed.length
      },
      WHITE_BOX
    )
  );
}

async function validateSourceFileRows(admin, knowledgeBaseId, expectedFiles, report, options = {}) {
  const sourceFiles = await listAdminSourceFiles(admin, knowledgeBaseId, 50);
  const sourceFileIds = new Set(sourceFiles.map((file) => file.id));

  for (const expectedFile of expectedFiles) {
    const file = sourceFiles.find((item) => item.id === expectedFile.id);

    if (!file) {
      throw new Error(`Expected source-file row was missing: ${expectedFile.id}`);
    }

    if (file.processingStatus !== "completed" || !file.processingStartedAt || !file.processingEndedAt) {
      throw new Error(`Source-file row did not expose expected lifecycle data: ${expectedFile.id}`);
    }
  }

  report.checks.push(
    okCheck(options.checkName ?? "source-file-rows", options.message ?? "Upload actions are represented as source-file rows with one lifecycle status.", {
      sourceFileIds: Array.from(sourceFileIds)
    })
  );
}

async function validateSourceFilePagination(
  admin,
  knowledgeBaseId,
  expectedSourceCount,
  report,
  performanceEvidence
) {
  if (expectedSourceCount <= 1) {
    recordPaginationEvidence(performanceEvidence, "source-file-pagination", {
      expectedSourceCount,
      observedPages: 1
    });
    report.checks.push(
      okCheck("source-file-pagination", "Knowledge base has one source file; source-file pagination is not needed.", {
        expectedSourceCount
      })
    );
    return;
  }

  const first = await readJson(
    admin,
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-files?limit=1`
  );

  if (first.items?.length !== 1 || !first.nextCursor) {
    throw new Error("Expected first source-file page to include one item and a next cursor.");
  }

  const second = await readJson(
    admin,
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-files?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`
  );

  if (second.items?.length !== 1) {
    throw new Error("Expected second source-file page to include one item.");
  }

  if (
    first.items[0]?.id === second.items[0]?.id ||
    !first.items[0]?.processingStatus ||
    !second.items[0]?.processingStatus
  ) {
    throw new Error("Source-file cursor did not return stable source-file rows.");
  }

  recordPaginationEvidence(performanceEvidence, "source-file-pagination", {
    expectedSourceCount,
    observedPages: 2,
    itemCount: first.items.length + second.items.length
  });
  report.checks.push(
    okCheck("source-file-pagination", "Source files are paginated with a bounded cursor.", {
      expectedSourceCount
    })
  );
}

async function validateAdminSourceFileFilters(admin, knowledgeBaseId, expectedFile, report) {
  if (!expectedFile?.id || !expectedFile.originalName) {
    throw new Error("Admin source-file filter validation requires a completed source-file row.");
  }

  const nameToken = createSearchTokenFromFilename(expectedFile.originalName);
  const filteredByName = await readJson(
    admin,
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-files?limit=5&fileNameQuery=${encodeURIComponent(nameToken)}`
  );

  if (!filteredByName.items?.some((file) => file.id === expectedFile.id)) {
    throw new Error("Admin source-file fileNameQuery filter did not return the expected source-file row.");
  }

  const filteredByStatus = await readJson(
    admin,
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-files?limit=5&processingStatus=completed`
  );

  if (
    !filteredByStatus.items?.length ||
    filteredByStatus.items.some((file) => file.processingStatus !== "completed")
  ) {
    throw new Error("Admin source-file processingStatus filter returned unexpected rows.");
  }

  const filteredByStage = await readJson(
    admin,
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-files?limit=5&processingStage=release_activation`
  );

  if (
    !filteredByStage.items?.length ||
    filteredByStage.items.some((file) => file.processingStage !== "release_activation")
  ) {
    throw new Error("Admin source-file processingStage filter returned unexpected rows.");
  }

  const invalidFilter = await admin.request(
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-files?processingStatus=invalid`
  );

  if (invalidFilter.status !== 400) {
    throw new Error(`Admin source-file invalid filter expected HTTP 400, got ${invalidFilter.status}.`);
  }

  report.checks.push(
    okCheck("admin-source-file-filters", "Admin source-file list filters use bounded database-backed queries.", {
      filterKinds: ["fileNameQuery", "processingStatus", "processingStage"]
    })
  );
}

async function validateAdminTreeSearch(admin, knowledgeBaseId, pageFile, report) {
  if (!pageFile?.logicalPath) {
    throw new Error("Admin tree search validation requires a generated page file.");
  }

  const query = createSearchTokenFromFilename(path.basename(pageFile.logicalPath));
  const search = await readJson(
    admin,
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/files/tree/search?limit=5&query=${encodeURIComponent(query)}`
  );
  const match = search.items?.find((item) => item.entry?.logicalPath === pageFile.logicalPath);

  if (!match) {
    throw new Error("Admin file-tree search did not return the expected page file.");
  }

  if (!match.ancestors?.some((ancestor) => ancestor.logicalPath === "pages")) {
    throw new Error("Admin file-tree search did not include the expected parent directory ancestor.");
  }

  const folderSearch = await readJson(
    admin,
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/files/tree/search?limit=5&query=pages`
  );

  if (!folderSearch.items?.some((item) => item.entry?.entryType === "directory" && item.entry.logicalPath === "pages")) {
    throw new Error("Admin file-tree search did not return a matching folder entry.");
  }

  report.checks.push(
    okCheck("admin-file-tree-search", "Admin file-tree search returns matching files with ancestors and matching folders.")
  );
}

async function validateAdminProcessingSummary(admin, knowledgeBaseId, report) {
  const summary = await readJson(
    admin,
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/processing-summary`
  );

  for (const key of ["sourceFileJobs", "publicationJobs"]) {
    const item = summary[key];

    if (
      !item ||
      !Number.isFinite(item.queuedCount) ||
      !Number.isFinite(item.runningCount) ||
      !Number.isFinite(item.completedCount) ||
      !Number.isFinite(item.failedCount) ||
      !Number.isFinite(item.deadLetterCount)
    ) {
      throw new Error(`Admin processing summary returned an invalid ${key} shape.`);
    }
  }

  if (
    !summary.dirtySourceFiles ||
    !Number.isFinite(summary.dirtySourceFiles.count) ||
    !(
      summary.dirtySourceFiles.oldestDirtyAt === null ||
      typeof summary.dirtySourceFiles.oldestDirtyAt === "string"
    )
  ) {
    throw new Error("Admin processing summary returned an invalid dirtySourceFiles shape.");
  }

  report.checks.push(
    okCheck(
      "admin-processing-summary",
      "Admin processing summary exposes bounded queue and dirty-file counters without reading task lists."
    )
  );
}

async function validateAdminFileSurfaces(admin, knowledgeBaseId, report, options = {}) {
  const expectedSamples = options.expectedSamples ?? [];
  const [releases, bundleFiles, tree, urls] = await Promise.all([
    readJson(admin, `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/releases?limit=10`),
    listAdminBundleFiles(admin, knowledgeBaseId),
    readJson(admin, `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/files/tree?limit=50`),
    readJson(admin, `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/public-urls`)
  ]);

  const release = releases.items?.[0];

  if (!release?.publishedAt || bundleFiles.items.length === 0 || (tree.items?.length ?? 0) === 0) {
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
    okCheck(options.checkName ?? "admin-file-surfaces", options.message ?? "Admin release, bundle, tree, detail, and Developer OpenAPI URL surfaces work.", {
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

async function validateDeveloperOpenApiUploadContinuity({ publicApi, env, sample, processingTimeoutMs, report }) {
  const headers = publicAuthHeaders(env);
  const knowledgeBaseName = `Focowiki OpenAPI validation ${new Date().toISOString()}`;
  let knowledgeBaseId = null;

  try {
    const created = await readJson(publicApi, "/openapi/v1/knowledge-bases", {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        name: knowledgeBaseName,
        description: "Developer OpenAPI validation run"
      })
    });
    knowledgeBaseId = created.knowledgeBase?.knowledgeBaseId;

    if (!knowledgeBaseId) {
      throw new Error("Developer OpenAPI create knowledge base response did not include knowledgeBaseId.");
    }

    const formData = new FormData();
    formData.append(
      "files",
      new Blob([fs.readFileSync(sample.filePath)], { type: "text/markdown" }),
      sample.basename
    );
    const uploadResponse = await publicApi.request(
      `/openapi/v1/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/uploads`,
      {
        method: "POST",
        headers,
        body: formData
      }
    );

    if (uploadResponse.status !== 202) {
      throw new Error(`Developer OpenAPI upload expected HTTP 202, got ${uploadResponse.status}.`);
    }

    const upload = await uploadResponse.json();
    const fileId = upload.files?.[0]?.fileId;

    if (upload.knowledgeBaseId !== knowledgeBaseId || !fileId || upload.files?.[0]?.originalFilename !== sample.basename) {
      throw new Error("Developer OpenAPI upload response did not return continuous knowledgeBaseId, fileId, and originalFilename fields.");
    }

    const sourceFile = await pollDeveloperSourceFileCompleted(publicApi, knowledgeBaseId, fileId, headers, processingTimeoutMs);

    if (sourceFile.fileId !== fileId || sourceFile.knowledgeBaseId !== knowledgeBaseId || sourceFile.processingState !== "completed") {
      throw new Error("Developer OpenAPI source-file detail did not accept the upload fileId or return completed lifecycle state.");
    }

    const sourceFileEvents = await readJson(
      publicApi,
      developerSourceFileEventsPath(knowledgeBaseId, fileId),
      { headers }
    );

    if (!Array.isArray(sourceFileEvents.items) || sourceFileEvents.items.length === 0) {
      throw new Error("Developer OpenAPI source-file events did not expose reusable fileId progress evidence.");
    }

    const sourceFileDetail = await readJson(
      publicApi,
      developerSourceFilePath(knowledgeBaseId, fileId),
      { headers }
    );

    if (sourceFileDetail.file?.fileId !== fileId || sourceFileDetail.file?.originalFilename !== sample.basename) {
      throw new Error("Developer OpenAPI source-file detail did not preserve the upload response fileId.");
    }

    const rootTree = await readJson(
      publicApi,
      `/openapi/v1/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/tree?limit=50`,
      { headers }
    );
    const pagesTree = await readJson(
      publicApi,
      `/openapi/v1/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/tree?parentPath=pages&limit=50`,
      { headers }
    );
    const pageEntry = pagesTree.items?.find((item) => item.path === `pages/${sample.basename}`);

    if (!rootTree.items?.some((item) => item.path === "index.md") || !pageEntry?.fileId) {
      throw new Error("Developer OpenAPI tree did not expose generated root and page file identifiers.");
    }

    const fileDetail = await readJson(
      publicApi,
      `/openapi/v1/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/files/${encodeURIComponent(pageEntry.fileId)}`,
      { headers }
    );

    if (fileDetail.file?.fileId !== pageEntry.fileId || fileDetail.file?.path !== pageEntry.path) {
      throw new Error("Developer OpenAPI file detail did not accept the tree fileId.");
    }

    const contentById = await readPublicText(
      publicApi,
      `/openapi/v1/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/files/${encodeURIComponent(pageEntry.fileId)}/content`,
      headers
    );
    const contentByPath = await readPublicText(
      publicApi,
      developerFileContentPath(knowledgeBaseId, pageEntry.path),
      headers
    );

    if (!contentById.includes(sample.title) || contentById !== contentByPath) {
      throw new Error("Developer OpenAPI file content reads by ID and path did not return the same generated Markdown.");
    }

    await validateDeveloperSourceFileFiltersAndTaskDeletion({
      publicApi,
      knowledgeBaseId,
      sourceFileId: fileId,
      sample,
      pagePath: pageEntry.path,
      authHeaders: headers,
      report
    });

    report.checks.push(
      okCheck(
        "developer-openapi-upload-continuity",
        "Developer OpenAPI create, upload, source-file detail, tree, filters, task deletion, file detail, and content calls preserve reusable identifiers.",
        {
          uploadedFiles: 1,
          processingState: sourceFile.processingState,
          checkedPath: pageEntry.path
        },
        BLACK_BOX
      )
    );
  } finally {
    if (knowledgeBaseId) {
      await publicApi
        .request(`/openapi/v1/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`, {
          method: "DELETE",
          headers
        })
        .catch(() => undefined);
    }
  }
}

async function validateDeveloperOpenApiWebhooks(publicApi, env, report) {
  const headers = publicAuthHeaders(env);
  const listBefore = await readJson(publicApi, "/openapi/v1/webhooks?limit=10", { headers });

  if (!Array.isArray(listBefore.items)) {
    throw new Error("Developer OpenAPI webhook list did not return a paginated item array.");
  }

  const created = await readJson(publicApi, "/openapi/v1/webhooks", {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      name: "Validation webhook",
      url: "https://hooks.example.com/focowiki-validation",
      events: ["source_file.completed", "source_file.failed", "release.published"]
    })
  });
  const webhookId = created.webhook?.webhookId;

  if (!webhookId || !created.signingSecret || created.webhook.endpointHost !== "hooks.example.com") {
    throw new Error("Developer OpenAPI webhook creation did not return webhookId, endpoint host, and one-time signing secret.");
  }

  const listAfterCreate = await readJson(publicApi, "/openapi/v1/webhooks?limit=50", { headers });

  if (!listAfterCreate.items?.some((webhook) => webhook.webhookId === webhookId)) {
    throw new Error("Developer OpenAPI webhook list did not include the created webhookId.");
  }

  const deliveries = await readJson(publicApi, "/openapi/v1/webhook-deliveries?limit=5", { headers });

  if (!Array.isArray(deliveries.items)) {
    throw new Error("Developer OpenAPI webhook delivery list did not return a paginated item array.");
  }

  const delivery = deliveries.items.find((item) => item.deliveryId);

  if (delivery) {
    const redelivery = await readJson(
      publicApi,
      `/openapi/v1/webhook-deliveries/${encodeURIComponent(delivery.deliveryId)}/redeliver`,
      {
        method: "POST",
        headers
      }
    );

    if (redelivery.delivery?.deliveryId !== delivery.deliveryId) {
      throw new Error("Developer OpenAPI webhook redelivery did not preserve deliveryId continuity.");
    }
  } else {
    await expectJsonError(
      publicApi,
      "/openapi/v1/webhook-deliveries/delivery-validation-missing/redeliver",
      headers,
      [404],
      { method: "POST" }
    );
  }

  const deleted = await readJson(publicApi, `/openapi/v1/webhooks/${encodeURIComponent(webhookId)}`, {
    method: "DELETE",
    headers
  });

  if (deleted.deleted !== true || deleted.webhookId !== webhookId) {
    throw new Error("Developer OpenAPI webhook deletion did not preserve webhookId continuity.");
  }

  const listAfterDelete = await readJson(publicApi, "/openapi/v1/webhooks?limit=50", { headers });

  if (listAfterDelete.items?.some((webhook) => webhook.webhookId === webhookId)) {
    throw new Error("Developer OpenAPI webhook deletion left the webhook in active list results.");
  }

  report.checks.push(
    okCheck(
      "developer-openapi-webhooks",
      "Developer OpenAPI webhook create, list, delivery list, redelivery route, and delete calls preserve identifier continuity.",
      {
        deliveryRoute: delivery ? "redelivered" : "not-found-error-shape"
      },
      BLACK_BOX
    )
  );
}

async function validateDeveloperSourceFileFiltersAndTaskDeletion({
  publicApi,
  knowledgeBaseId,
  sourceFileId,
  sample,
  pagePath,
  authHeaders,
  report
}) {
  const nameToken = createSearchTokenFromFilename(sample.basename);
  const filtered = await readJson(
    publicApi,
    `/openapi/v1/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-files?limit=10&fileNameQuery=${encodeURIComponent(nameToken)}&processingStatus=completed`,
    { headers: authHeaders }
  );

  if (!filtered.items?.some((file) => file.fileId === sourceFileId)) {
    throw new Error("Developer OpenAPI source-file filters did not return the uploaded fileId.");
  }

  await expectJsonError(
    publicApi,
    `/openapi/v1/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-files?processingStatus=invalid`,
    authHeaders,
    [422]
  );

  const deletion = await readJson(
    publicApi,
    `/openapi/v1/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-files/task-deletions`,
    {
      method: "POST",
      headers: {
        ...authHeaders,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        sourceFileIds: [sourceFileId]
      })
    }
  );
  const deletionResult = deletion.results?.find((item) => item.sourceFileId === sourceFileId);

  if (deletionResult?.result !== "hidden" || deletion.summary?.hidden !== 1) {
    throw new Error("Developer OpenAPI source-file task deletion did not hide the completed source-file task.");
  }

  const afterDeletion = await readJson(
    publicApi,
    `/openapi/v1/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-files?limit=10&fileIdQuery=${encodeURIComponent(sourceFileId)}`,
    { headers: authHeaders }
  );

  if (afterDeletion.items?.some((file) => file.fileId === sourceFileId)) {
    throw new Error("Developer OpenAPI source-file task deletion left the hidden task in the source-file list.");
  }

  const contentAfterDeletion = await readPublicText(
    publicApi,
    developerFileContentPath(knowledgeBaseId, pagePath),
    authHeaders
  );

  if (!contentAfterDeletion.includes(sample.title)) {
    throw new Error("Developer OpenAPI source-file task deletion removed generated content for a completed source file.");
  }

  report.checks.push(
    okCheck(
      "developer-openapi-source-file-filters-task-deletion",
      "Developer OpenAPI source-file filters and task deletion preserve fileId continuity and keep completed generated content readable."
    )
  );
}

async function pollDeveloperSourceFileCompleted(publicApi, knowledgeBaseId, sourceFileId, headers, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const body = await readJson(
      publicApi,
      developerSourceFilePath(knowledgeBaseId, sourceFileId),
      { headers }
    );
    const file = body.file;

    if (file?.processingState === "failed") {
      throw new Error(`Developer OpenAPI source file failed with ${file.processingErrorCode ?? "UNKNOWN"}.`);
    }

    if (file?.processingState === "completed" && file?.generatedOutputStatus === "visible") {
      if (file.processingErrorCode) {
        throw new Error(`Developer OpenAPI source file completed with ${file.processingErrorCode}.`);
      }

      return file;
    }

    await sleep(1_000);
  }

  throw new Error(`Timed out waiting for Developer OpenAPI source file to complete after ${timeoutMs}ms.`);
}

async function validatePublicOpenApi(publicApi, knowledgeBaseId, adminFiles, env, report, options = {}) {
  if (!options.sourceFileId) {
    throw new Error("Developer OpenAPI validation requires a sourceFileId.");
  }

  const indexPath = developerFileContentPath(knowledgeBaseId, "index.md");
  const missingAuth = await publicApi.request(indexPath);

  if (missingAuth.status !== 401) {
    throw new Error("Developer OpenAPI did not reject missing bearer auth.");
  }

  const invalidAuth = await publicApi.request(indexPath, {
    headers: {
      authorization: "Bearer invalid-validation-key"
    }
  });

  if (invalidAuth.status !== 401) {
    throw new Error("Developer OpenAPI did not reject an invalid bearer key.");
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
    const body = await readPublicText(
      publicApi,
      developerFileContentPath(knowledgeBaseId, logicalPath),
      authHeaders
    );

    bodies.set(logicalPath, body);
  }
  const indexes = {
    manifest: await readJsonIndexWithShards({
      publicApi,
      knowledgeBaseId,
      authHeaders,
      bodies,
      rootPath: "_index/manifest.json",
      collectionKey: "files"
    }),
    search: await readJsonIndexWithShards({
      publicApi,
      knowledgeBaseId,
      authHeaders,
      bodies,
      rootPath: "_index/search.json",
      collectionKey: "items"
    }),
    links: await readJsonIndexWithShards({
      publicApi,
      knowledgeBaseId,
      authHeaders,
      bodies,
      rootPath: "_index/links.json",
      collectionKey: "links"
    })
  };

  validateOkfPublicArtifactBodies({
    bodies,
    pagePaths: adminFiles.pageFiles.map((file) => file.logicalPath),
    report,
    indexes,
    samples: options.expectedSamples ?? []
  });

  const sourceFileStatus = await readJson(
    publicApi,
    developerSourceFilePath(knowledgeBaseId, options.sourceFileId),
    { headers: authHeaders }
  );

  if (
    sourceFileStatus.file?.fileId !== options.sourceFileId ||
    !sourceFileStatus.file?.processingStartedAt ||
    sourceFileStatus.file?.phaseDetails
  ) {
    throw new Error("Developer OpenAPI source-file status does not match the file-level lifecycle shape.");
  }

  const sourceFileEvents = await readJson(
    publicApi,
    developerSourceFileEventsPath(knowledgeBaseId, options.sourceFileId),
    { headers: authHeaders }
  );

  if (!Array.isArray(sourceFileEvents.items) || sourceFileEvents.items.length === 0) {
    throw new Error("Developer OpenAPI source-file event list did not return bounded file events.");
  }

  await expectJsonError(
    publicApi,
    `/openapi/v1/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/pages/%252e%252e/secret.md`,
    authHeaders,
    [400]
  );
  await expectJsonError(
    publicApi,
    `/openapi/v1/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/pages/%5Csecret.md`,
    authHeaders,
    [400]
  );
  await expectJsonError(
    publicApi,
    developerFileContentPath(knowledgeBaseId, "pages/missing.md"),
    authHeaders,
    [404]
  );
  await expectJsonError(
    publicApi,
    developerFileContentPath(knowledgeBaseId, `sources/${path.basename(adminFiles.pageFile.logicalPath)}`),
    authHeaders,
    [422]
  );
  await expectJsonError(
    publicApi,
    developerFileContentPath(knowledgeBaseId, "unsupported.txt"),
    authHeaders,
    [422]
  );
  await expectJsonError(
    publicApi,
    "/admin/api/knowledge-bases",
    authHeaders,
    [404]
  );
  await expectJsonError(
    publicApi,
    developerFileContentPath(knowledgeBaseId, "index.md"),
    authHeaders,
    [404],
    { method: "DELETE" }
  );

  report.checks.push(
    okCheck(
      options.checkName ?? "public-openapi",
      options.message ?? "Public scoped Markdown, JSON, source-file, auth, source hiding, and error checks passed."
    )
  );
}

function validateOkfPublicArtifactBodies({ bodies, pagePaths, report, indexes, samples = [] }) {
  const index = bodies.get("index.md") ?? "";
  const log = bodies.get("log.md") ?? "";
  const manifest = indexes.manifest;
  const search = indexes.search;
  const links = indexes.links;

  if (index.startsWith("---\n") || !index.startsWith("# ")) {
    throw new Error("Public index.md must be a reserved Markdown file without frontmatter.");
  }

  if (/Focowiki knowledge base|placeholder/i.test(index)) {
    throw new Error("Public index.md contains fixed placeholder copy instead of generated source content.");
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
    const parsedPage = matter(page);

    if (!index.includes(pagePath) && !index.includes(encodeURIComponent(path.basename(pagePath)))) {
      throw new Error("Public index.md does not reference the sampled page path.");
    }

    if (!page.startsWith("---\n") || !/\n#\s+/.test(page)) {
      throw new Error("Sampled public page does not include expected frontmatter and heading content.");
    }

    if (!readNonEmptyString(parsedPage.data?.type) || !readNonEmptyString(parsedPage.data?.title)) {
      throw new Error(`Sampled public page is missing required type or title frontmatter: ${pagePath}`);
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
      pageMetadata: parsedPage.data ?? {},
      manifestEntry,
      searchItem
    });
  }

  const schema = bodies.get("schema.md") ?? "";
  const schemaMatter = matter(schema);

  if (!schema.startsWith("---\n") || !readNonEmptyString(schemaMatter.data?.type) || !readNonEmptyString(schemaMatter.data?.title)) {
    throw new Error("Public schema.md must be a concept Markdown file with type and title frontmatter.");
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

  if (samples.length > 0) {
    const summary = validateGeneratedContentQuality({
      samples,
      bodies,
      indexes,
      modelAssistance: report.modelAssistance,
      semanticSampleLimit: readContentQualitySampleLimit(process.env)
    });

    report.contentQuality.push({
      scope: pagePaths.length === samples.length ? "full-public-artifacts" : "sampled-public-artifacts",
      ...summary
    });
    report.checks.push(
      okCheck(
        "generated-content-quality",
        "Generated pages, indexes, LLM-derived fields, and graph relationships pass bounded content quality checks.",
        summary,
        WHITE_BOX
      )
    );
  }
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

function createSearchTokenFromFilename(filename) {
  const basename = path.basename(filename, path.extname(filename));
  const titleToken = basename.split("__")[0]?.trim() || basename.trim();
  const token = titleToken.replace(/\s+/g, " ").trim();

  if (token.length >= 2) {
    return token.slice(0, 32);
  }

  return basename.slice(0, 32);
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

function selectTaskDeletionCandidate(files, excludedSourceFileId) {
  const candidate = files.find((file) => file.id && file.id !== excludedSourceFileId) ?? files.find((file) => file.id);

  if (!candidate?.id) {
    throw new Error("Source-file task deletion validation requires a completed source-file id.");
  }

  return candidate.id;
}

async function validateAdminSourceFileTaskDeletion({ admin, knowledgeBaseId, sourceFileId, report }) {
  const deletion = await readJson(
    admin,
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-files/task-deletions`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        sourceFileIds: [sourceFileId]
      })
    }
  );
  const result = deletion.results?.find((item) => item.sourceFileId === sourceFileId);

  if (result?.status !== "hidden" || deletion.summary?.hidden !== 1) {
    throw new Error("Admin source-file task deletion did not hide the completed source-file task.");
  }

  const afterDeletion = await readJson(
    admin,
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-files?limit=10&fileIdQuery=${encodeURIComponent(sourceFileId)}`
  );

  if (afterDeletion.items?.some((file) => file.id === sourceFileId)) {
    throw new Error("Admin source-file task deletion left the hidden task in the source-file list.");
  }

  report.checks.push(
    okCheck("admin-source-file-task-deletion", "Admin source-file task deletion hides completed task rows without deleting generated files.", {
      sourceFileId
    })
  );
}

async function validateSourceDeletionFullFlow({
  admin,
  publicApi,
  env,
  knowledgeBaseId,
  pageFile,
  processingTimeoutMs,
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

  if (response.status !== 200) {
    throw new Error(`Source-backed page deletion failed with HTTP ${response.status}.`);
  }

  const body = await response.json();

  if (body.deleted !== true || body.publicationQueued !== true) {
    throw new Error("Deletion response did not confirm queued publication.");
  }

  report.checks.push(
    okCheck("source-page-delete-submit", "Submitted source-backed page deletion through the Admin API.", {
      publicationQueued: body.publicationQueued
    })
  );

  const { remainingPage, sawDeletedPage } = await pollSourceDeletionPublished({
    admin,
    knowledgeBaseId,
    deletedPagePath: pageFile.logicalPath,
    timeoutMs: processingTimeoutMs
  });

  const releaseId = await validateDeletionDatabaseBoundaries({
    databaseUrl: env.DATABASE_URL,
    knowledgeBaseId,
    sourceFileId: pageFile.sourceFileId,
    deletedPagePath: pageFile.logicalPath,
    report
  });

  if (sawDeletedPage) {
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
    releaseId,
    deletedPagePath: pageFile.logicalPath,
    remainingPagePath: remainingPage.logicalPath
  };
}

async function pollSourceDeletionPublished({ admin, knowledgeBaseId, deletedPagePath, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const state = await findRemainingSourceBackedPageAfterDeletion({
      admin,
      knowledgeBaseId,
      deletedPagePath
    });

    if (!state.sawDeletedPage && state.remainingPage?.logicalPath) {
      return state;
    }

    await sleep(1_000);
  }

  throw new Error(`Timed out waiting for source-page deletion publication after ${timeoutMs}ms.`);
}

async function findRemainingSourceBackedPageAfterDeletion({ admin, knowledgeBaseId, deletedPagePath }) {
  let cursor = null;
  let remainingPage = null;
  let sawDeletedPage = false;

  do {
    const body = await readJson(
      admin,
      `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/bundle-files?limit=50${
        cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
      }`
    );

    for (const file of body.items ?? []) {
      if (file.logicalPath === deletedPagePath) {
        sawDeletedPage = true;
      }

      if (!remainingPage && String(file.logicalPath).startsWith("pages/")) {
        remainingPage = file;
      }
    }

    cursor = body.nextCursor ?? null;
  } while (cursor);

  return { remainingPage, sawDeletedPage };
}

async function validateDeletionDatabaseBoundaries({
  databaseUrl,
  knowledgeBaseId,
  sourceFileId,
  deletedPagePath,
  report
}) {
  const postgresModule = requireFromApiPackage("postgres");
  const postgres = postgresModule.default ?? postgresModule;
  const sql = postgres(databaseUrl, { max: 1 });

  try {
    const [shape] = await sql`
      SELECT
        (SELECT active_release_id
         FROM focowiki.knowledge_bases
         WHERE id = ${knowledgeBaseId}) AS active_release_id,
        (SELECT count(*)::int
         FROM focowiki.source_files
         WHERE knowledge_base_id = ${knowledgeBaseId}
           AND id = ${sourceFileId}
           AND deleted_at IS NOT NULL) AS deleted_sources,
        (SELECT count(*)::int
         FROM focowiki.releases
         WHERE knowledge_base_id = ${knowledgeBaseId}
           AND id = (
             SELECT active_release_id
             FROM focowiki.knowledge_bases
             WHERE id = ${knowledgeBaseId}
           )
           AND published_at IS NOT NULL) AS published_releases,
        (SELECT count(*)::int
         FROM focowiki.source_file_events
         WHERE knowledge_base_id = ${knowledgeBaseId}
           AND source_file_id = ${sourceFileId}
           AND stage_key = 'source_deletion') AS source_deletion_events,
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
      !shape.active_release_id ||
      shape.deleted_sources !== 1 ||
      shape.published_releases !== 1 ||
      shape.source_deletion_events < 1 ||
      shape.stale_active_pages !== 0
    ) {
      throw new Error(`Unexpected deletion database state: ${JSON.stringify(shape)}`);
    }

    report.checks.push(
      okCheck("deletion-database-boundaries", "PostgreSQL records source deletion, file events, and a replacement active release.", shape, WHITE_BOX)
    );

    return shape.active_release_id;
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
    developerFileContentPath(knowledgeBaseId, deletedPagePath),
    headers,
    [404]
  );

  const remaining = await readPublicText(
    publicApi,
    developerFileContentPath(knowledgeBaseId, remainingPagePath),
    headers
  );

  if (!remaining.trim()) {
    throw new Error("Remaining source-backed page became unavailable after deletion republish.");
  }

  const publicBodies = new Map([
    [
      "index.md",
      await readPublicText(publicApi, developerFileContentPath(knowledgeBaseId, "index.md"), headers)
    ],
    [
      "log.md",
      await readPublicText(publicApi, developerFileContentPath(knowledgeBaseId, "log.md"), headers)
    ],
    [
      "_index/manifest.json",
      await readPublicText(
        publicApi,
        developerFileContentPath(knowledgeBaseId, "_index/manifest.json"),
        headers
      )
    ],
    [
      "_index/search.json",
      await readPublicText(
        publicApi,
        developerFileContentPath(knowledgeBaseId, "_index/search.json"),
        headers
      )
    ],
    [
      "_index/links.json",
      await readPublicText(
        publicApi,
        developerFileContentPath(knowledgeBaseId, "_index/links.json"),
        headers
      )
    ]
  ]);

  for (const [logicalPath, body] of publicBodies) {
    if (body.includes(deletedPagePath) || body.includes(encodeURIComponent(path.basename(deletedPagePath)))) {
      throw new Error(`Public ${logicalPath} still references deleted page ${deletedPagePath}.`);
    }
  }

  const manifest = await readJsonIndexWithShards({
    publicApi,
    knowledgeBaseId,
    authHeaders: headers,
    bodies: publicBodies,
    rootPath: "_index/manifest.json",
    collectionKey: "files"
  });
  const search = await readJsonIndexWithShards({
    publicApi,
    knowledgeBaseId,
    authHeaders: headers,
    bodies: publicBodies,
    rootPath: "_index/search.json",
    collectionKey: "items"
  });
  const links = await readJsonIndexWithShards({
    publicApi,
    knowledgeBaseId,
    authHeaders: headers,
    bodies: publicBodies,
    rootPath: "_index/links.json",
    collectionKey: "links"
  });

  if (
    manifest.files.some((file) => file.path === deletedPagePath) ||
    search.items.some((item) => item.path === deletedPagePath) ||
    links.links.some((link) => link.from === deletedPagePath || link.to === deletedPagePath)
  ) {
    throw new Error("Generated indexes still contain deleted page graph or metadata references.");
  }

  report.checks.push(
    okCheck("developer-openapi-deletion-state", "Developer OpenAPI and generated indexes reflect source-backed page deletion.", {
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
    developerFileContentPath(knowledgeBaseId, "index.md"),
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

async function recordOperationalPerformanceSnapshot(databaseUrl, knowledgeBaseId, performanceEvidence, report) {
  const postgresModule = requireFromApiPackage("postgres");
  const postgres = postgresModule.default ?? postgresModule;
  const sql = postgres(databaseUrl, { max: 1 });

  try {
    const [snapshot] = await sql`
      SELECT
        (SELECT count(*)::int
         FROM focowiki.source_files
         WHERE knowledge_base_id = ${knowledgeBaseId}
           AND deleted_at IS NULL
           AND processing_status IN ('queued', 'running')) AS queue_depth,
        (SELECT count(*)::int
         FROM focowiki.source_files
         WHERE knowledge_base_id = ${knowledgeBaseId}
           AND deleted_at IS NULL
           AND processing_status = 'running') AS running_source_files,
        (SELECT count(*)::int
         FROM focowiki.source_files
         WHERE knowledge_base_id = ${knowledgeBaseId}
           AND deleted_at IS NULL
           AND processing_status = 'completed') AS completed_source_files,
        (SELECT count(*)::int
         FROM focowiki.source_files
         WHERE knowledge_base_id = ${knowledgeBaseId}
           AND deleted_at IS NULL
           AND processing_status = 'failed') AS failed_source_files,
        (SELECT count(*)::int
         FROM focowiki.source_files
         WHERE knowledge_base_id = ${knowledgeBaseId}
           AND deleted_at IS NULL
           AND generated_output_status = 'visible') AS visible_source_files,
        (SELECT count(*)::int
         FROM focowiki.publication_jobs
         WHERE knowledge_base_id = ${knowledgeBaseId}) AS publication_jobs,
        (SELECT count(*)::int
         FROM focowiki.publication_jobs
         WHERE knowledge_base_id = ${knowledgeBaseId}
           AND status IN ('queued', 'running', 'retrying')) AS active_publication_jobs,
        (SELECT count(*)::int
         FROM focowiki.releases
         WHERE knowledge_base_id = ${knowledgeBaseId}) AS release_count
    `;

    recordOperationalSnapshot(performanceEvidence, "post-validation", {
      queueDepth: snapshot.queue_depth,
      runningSourceFiles: snapshot.running_source_files,
      completedSourceFiles: snapshot.completed_source_files,
      failedSourceFiles: snapshot.failed_source_files,
      visibleSourceFiles: snapshot.visible_source_files,
      publicationJobs: snapshot.publication_jobs,
      activePublicationJobs: snapshot.active_publication_jobs,
      releaseCount: snapshot.release_count
    });
    report.checks.push(
      okCheck(
        "operational-performance-snapshot",
        "PostgreSQL operational counters were recorded for queue depth, publication count, visible files, and failed files.",
        {
          queueDepth: snapshot.queue_depth,
          publicationJobs: snapshot.publication_jobs,
          visibleSourceFiles: snapshot.visible_source_files,
          failedSourceFiles: snapshot.failed_source_files
        },
        WHITE_BOX
      )
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function validateModelInvocationBoundaries(
  databaseUrl,
  knowledgeBaseId,
  sourceFileIds,
  samples,
  env,
  report,
  options = {}
) {
  const mode = report.modelAssistance ?? readModelAssistanceMode(env);
  const postgresModule = requireFromApiPackage("postgres");
  const postgres = postgresModule.default ?? postgresModule;
  const sql = postgres(databaseUrl, { max: 1 });

  try {
    const [shape] = await sql`
      SELECT
        (SELECT count(*)::int
         FROM focowiki.source_file_events
         WHERE source_file_id = ANY(${sourceFileIds})
           AND stage_key = 'llm_suggestion') AS llm_phase_events,
        (SELECT count(*)::int
         FROM focowiki.source_files
         WHERE knowledge_base_id = ${knowledgeBaseId}
           AND id = ANY(${sourceFileIds})) AS source_files,
        (SELECT count(*)::int
         FROM focowiki.model_invocations
         WHERE knowledge_base_id = ${knowledgeBaseId}
           AND source_file_id = ANY(${sourceFileIds})) AS invocations,
        (SELECT count(*)::int
         FROM focowiki.model_invocations
         WHERE knowledge_base_id = ${knowledgeBaseId}
           AND source_file_id = ANY(${sourceFileIds})
           AND status = 'completed') AS completed,
        (SELECT count(*)::int
         FROM focowiki.model_invocations
         WHERE knowledge_base_id = ${knowledgeBaseId}
           AND source_file_id = ANY(${sourceFileIds})
           AND status = 'failed') AS failed,
        (SELECT count(*)::int
         FROM focowiki.model_invocations
         WHERE knowledge_base_id = ${knowledgeBaseId}
           AND source_file_id = ANY(${sourceFileIds})
           AND status = 'skipped') AS skipped,
        (SELECT count(*)::int
         FROM focowiki.model_invocations
         WHERE knowledge_base_id = ${knowledgeBaseId}
           AND source_file_id = ANY(${sourceFileIds})
           AND ended_at IS NULL) AS non_terminal,
        (SELECT count(*)::int
         FROM focowiki.model_invocations
         WHERE knowledge_base_id = ${knowledgeBaseId}
           AND source_file_id = ANY(${sourceFileIds})
           AND model_name = ${mode.modelName ?? ""}) AS matching_model_name,
        (SELECT count(*)::int
         FROM focowiki.model_invocations
         WHERE knowledge_base_id = ${knowledgeBaseId}
           AND source_file_id = ANY(${sourceFileIds})
           AND api_mode = ${mode.apiMode ?? ""}) AS matching_api_mode
    `;

    if (shape.source_files !== samples.length) {
      throw new Error(`Expected ${samples.length} source files for model validation, got ${shape.source_files}.`);
    }

    if (!mode.enabled) {
      report.checks.push(
        okCheck(
          options.checkName ?? "model-invocation-boundaries",
          "Model assistance is disabled; persisted skipped invocation records are optional for this validation run.",
          shape,
          WHITE_BOX
        )
      );
      return;
    }

    const expectedLlmPhaseEvents = samples.length * 2;

    if (
      shape.llm_phase_events !== expectedLlmPhaseEvents ||
      shape.invocations !== samples.length ||
      shape.completed + shape.failed !== samples.length ||
      shape.skipped !== 0 ||
      shape.non_terminal !== 0 ||
      shape.matching_model_name !== samples.length ||
      shape.matching_api_mode !== samples.length
    ) {
      throw new Error(`Unexpected model invocation state: ${JSON.stringify(shape)}`);
    }

    if (shape.failed > 0) {
      report.manualReviewItems.push(
        `Model invocation failed for ${shape.failed} source file(s); review provider connectivity before using model-generated suggestions as quality evidence.`
      );
    }

    const rows = await sql`
      SELECT s.original_name, m.status, m.api_mode, m.model_name, m.warning_count, m.error_code, m.error_message
      FROM focowiki.model_invocations m
      JOIN focowiki.source_files s ON s.id = m.source_file_id
      WHERE m.knowledge_base_id = ${knowledgeBaseId}
        AND m.source_file_id = ANY(${sourceFileIds})
      ORDER BY s.original_name
    `;
    const expectedNames = new Set(samples.map((sample) => sample.basename));

    for (const row of rows) {
      if (!expectedNames.has(row.original_name)) {
        throw new Error(`Model invocation was linked to an unexpected source filename: ${row.original_name}`);
      }

      if (row.api_mode !== mode.apiMode) {
        throw new Error(`Model invocation used unexpected API mode: ${row.api_mode ?? "missing"}.`);
      }

      const safeSummary = JSON.stringify({ errorCode: row.error_code, errorMessage: row.error_message });

      if (hasSecretLikeAuditData([safeSummary]) || /knowledge-bases\/|uploads\/|releases\/|file:\/\//i.test(safeSummary)) {
        throw new Error("Model invocation error summary exposed internal or secret-like data.");
      }
    }

    report.checks.push(
      okCheck(
        options.checkName ?? "model-invocation-boundaries",
        options.message ?? "PostgreSQL contains terminal model invocation records for source files.",
        shape,
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
  sourceFileIds,
  selectedSamples,
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
        (SELECT count(*)::int FROM focowiki.releases WHERE knowledge_base_id = ${knowledgeBaseId}) AS releases,
        (SELECT count(*)::int FROM focowiki.bundle_files WHERE knowledge_base_id = ${knowledgeBaseId}) AS bundle_files,
        (SELECT count(*)::int FROM focowiki.bundle_tree_entries WHERE knowledge_base_id = ${knowledgeBaseId}) AS bundle_tree_entries
    `;
    const storageShapeRows = await sql`
      SELECT
        (SELECT count(*)::int
         FROM focowiki.source_files
         WHERE knowledge_base_id = ${knowledgeBaseId}
           AND id = ANY(${sourceFileIds})
           AND object_key LIKE '%/sources/%') AS internal_source_objects,
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
           AND id = ANY(${sourceFileIds})) AS source_metadata_is_object
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
        AND id = ANY(${sourceFileIds})
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
    const expectedSelectedNames = new Set(selectedSamples.map((sample) => sample.basename));
    const expectedAllNames = new Set(allSamples.map((sample) => sample.basename));
    const actualNames = new Set(sourceRows.map((row) => row.original_name));

    if (
      recordCounts.source_files !== allSamples.length ||
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
      storageShape.internal_source_objects !== selectedSamples.length ||
      storageShape.public_page_objects < allSamples.length ||
      storageShape.exposed_source_bundle_files !== 0 ||
      storageShape.source_metadata_is_object !== true
    ) {
      throw new Error(`Unexpected storage-backed database shape: ${JSON.stringify(storageShape)}`);
    }

    for (const name of expectedSelectedNames) {
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
          selectedSamples: selectedSamples.length,
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

  const body = await response.json();

  if (typeof body.content !== "string" || !body.content.trim()) {
    throw new Error(`Request ${pathname} did not return a non-empty content field.`);
  }

  return body.content;
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
    throw new Error("Managed Developer OpenAPI validation key is not available.");
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

async function readJsonIndexWithShards({
  publicApi,
  knowledgeBaseId,
  authHeaders,
  bodies,
  rootPath,
  collectionKey
}) {
  const root = parseJsonIndex(bodies.get(rootPath), rootPath);

  if (root.mode !== "sharded") {
    return root;
  }

  if (root.collection !== collectionKey || !Array.isArray(root.shards)) {
    throw new Error(`Public sharded index descriptor is malformed: ${rootPath}`);
  }

  const items = [];

  for (const shard of root.shards) {
    if (!shard || typeof shard.path !== "string") {
      throw new Error(`Public sharded index includes an invalid shard descriptor: ${rootPath}`);
    }

    const body = await readPublicText(
      publicApi,
      developerFileContentPath(knowledgeBaseId, shard.path),
      authHeaders
    );
    bodies.set(shard.path, body);
    items.push(...parseJsonLines(body, shard.path));
  }

  return {
    ...root,
    [collectionKey]: items
  };
}

function parseJsonLines(raw, logicalPath) {
  return String(raw ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`Public index shard is not valid JSONL: ${logicalPath}`);
      }
    });
}

async function getS3ObjectText(client, bucket, key) {
  const { GetObjectCommand } = requireFromApiPackage("@aws-sdk/client-s3");
  const response = await sendS3Command(
    client,
    new GetObjectCommand({
      Bucket: bucket,
      Key: key
    }),
    "S3 get validation evidence"
  );

  return withTimeout(responseBodyToString(response.Body), "S3 evidence body read");
}

async function sendS3Command(client, command, label) {
  const abortController = new AbortController();
  const timeoutMs = readPositiveInteger(process.env[HTTP_TIMEOUT_ENV], 180_000);
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);

  try {
    return await client.send(command, { abortSignal: abortController.signal });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} timed out or failed: ${message}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function withTimeout(promise, label) {
  const timeoutMs = readPositiveInteger(process.env[HTTP_TIMEOUT_ENV], 180_000);
  let timeout;

  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
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

function developerFileContentPath(knowledgeBaseId, logicalPath) {
  return `/openapi/v1/knowledge-bases/${encodeURIComponent(
    knowledgeBaseId
  )}/files/content?path=${encodeURIComponent(logicalPath)}`;
}

function developerSourceFilePath(knowledgeBaseId, sourceFileId) {
  return `/openapi/v1/knowledge-bases/${encodeURIComponent(
    knowledgeBaseId
  )}/source-files/${encodeURIComponent(sourceFileId)}`;
}

function developerSourceFileEventsPath(knowledgeBaseId, sourceFileId) {
  return `${developerSourceFilePath(knowledgeBaseId, sourceFileId)}/events?limit=50`;
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

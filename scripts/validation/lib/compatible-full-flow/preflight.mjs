import fs from "node:fs";
import path from "node:path";
import { selectSingleAndBatchSamples } from "../sample-selector.mjs";
import { compareEnvTemplateFields, assertEnvTemplateFieldsAligned } from "./env-files.mjs";
import { assertNonDestructiveValidationEnv } from "./guards.mjs";
import { assertMigrationCompatibility } from "./migration-safety.mjs";
import { missingRuntimeFields } from "./config.mjs";

export async function runCompatiblePreflight(config, report, { includeNetwork = true } = {}) {
  assertNonDestructiveValidationEnv(config.env);
  addReportCheck(report, "non-destructive-env", "Destructive validation flags are disabled.");

  const envComparison = compareEnvTemplateFields({
    envPath: config.envPath,
    templatePath: config.envTemplatePath,
    cwd: config.cwd
  });
  assertEnvTemplateFieldsAligned(envComparison);
  addReportCheck(report, "env-template-fields", "Environment files expose the same field set.", {
    fieldCount: envComparison.templateKeys.length
  });

  const missing = missingRuntimeFields(config);

  if (missing.length > 0) {
    throw new Error(`Missing required runtime fields: ${missing.join(", ")}`);
  }
  addReportCheck(report, "runtime-fields", "Required runtime fields are configured without printing values.", {
    fieldCount: missingRuntimeFields(config).length
  });

  assertMigrationCompatibility(readMigrationSql(config.cwd));
  addReportCheck(report, "migration-safety", "Migration SQL contains no destructive table, schema, column, or durable data reset operations.");

  const sampleSelection = validateSamples(config);
  report.samples.selected = sampleSelection.samples.map((sample) => ({
    basename: sample.basename,
    sizeBytes: sample.sizeBytes,
    title: sample.title,
    type: sample.type,
    status: sample.status || "unknown"
  }));
  addReportCheck(report, "markdown-samples", "Markdown samples were selected deterministically without full-body reads.", {
    sampleCount: sampleSelection.sampleCount,
    batchSampleCount: sampleSelection.batchSampleCount
  });

  if (includeNetwork) {
    await validateServiceReachability(config, report);
  }
}

export function validateSamples(config) {
  if (!config.markdownDir) {
    throw new Error("FOCOWIKI_VALIDATION_MARKDOWN_DIR or --markdown-dir is required.");
  }

  const stat = fs.statSync(config.markdownDir, { throwIfNoEntry: false });

  if (!stat?.isDirectory()) {
    throw new Error("Configured Markdown sample directory does not exist.");
  }

  return selectSingleAndBatchSamples(config.markdownDir, {
    batchSampleCount: Math.max(config.batchSampleCount, 2),
    maxCandidateProfiles: Math.max(config.sampleCount * 32, 1_000)
  });
}

async function validateServiceReachability(config, report) {
  await expectReachableJson({
    name: "admin-api-health",
    url: new URL("/healthz", withTrailingSlash(config.adminApiBaseUrl)).toString(),
    timeoutMs: config.requestTimeoutMs,
    report
  });
  await expectReachableJson({
    name: "developer-openapi-healthz",
    url: new URL("/healthz", withTrailingSlash(config.publicOpenApiBaseUrl)).toString(),
    timeoutMs: config.requestTimeoutMs,
    report
  });
  await expectReachableJson({
    name: "developer-openapi-public-health",
    url: new URL("/openapi/v1/health", withTrailingSlash(config.publicOpenApiBaseUrl)).toString(),
    timeoutMs: config.requestTimeoutMs,
    report
  });
  await expectReachableHtml({
    name: "admin-ui",
    url: config.adminUiBaseUrl,
    timeoutMs: config.requestTimeoutMs,
    report
  });
}

async function expectReachableJson({ name, url, timeoutMs, report }) {
  const response = await fetchWithTimeout(url, timeoutMs);

  if (![200, 401].includes(response.status)) {
    throw new Error(`${name} expected HTTP 200 or 401, got ${response.status}.`);
  }

  addReportCheck(report, name, `${name} responded with HTTP ${response.status}.`, {
    status: response.status
  });
}

async function expectReachableHtml({ name, url, timeoutMs, report }) {
  const response = await fetchWithTimeout(url, timeoutMs);

  if (response.status >= 500) {
    throw new Error(`${name} expected HTTP < 500, got ${response.status}.`);
  }

  addReportCheck(report, name, `${name} responded with HTTP ${response.status}.`, {
    status: response.status
  });
}

async function fetchWithTimeout(url, timeoutMs) {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);

  try {
    return await fetch(url, { signal: abortController.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function withTrailingSlash(value) {
  return `${String(value).replace(/\/+$/u, "")}/`;
}

function addReportCheck(report, name, message, details = {}) {
  report.checks.push({
    layer: "preflight",
    name,
    ok: true,
    message,
    details
  });
}

function readMigrationSql(cwd) {
  return fs.readFileSync(
    path.resolve(cwd, "apps/api/migrations/001_production_admin_web.sql"),
    "utf8"
  );
}

import path from "node:path";
import { createValidationRunId } from "./run-state.mjs";

export const DEFAULT_CHANGE_ID = "validate-compatible-full-e2e";
export const DEFAULT_REPORT_DIR = "ReferenceDocs/validate-compatible-full-e2e";

export function readCompatibleFullFlowConfig({
  command = "preflight",
  argv = [],
  env = process.env,
  cwd = process.cwd()
} = {}) {
  const cli = parseCliArgs(argv);
  const mode = normalizeMode(command);
  const reportDir = path.resolve(
    cwd,
    cli.reportDir || env.FOCOWIKI_VALIDATION_REPORT_DIR || DEFAULT_REPORT_DIR
  );
  const runId = cli.runId || env.FOCOWIKI_VALIDATION_RUN_ID || createValidationRunId();
  const markdownDir = cli.markdownDir || env.FOCOWIKI_VALIDATION_MARKDOWN_DIR || "";
  const sampleCount = readPositiveInteger(
    cli.sampleCount || env.FOCOWIKI_VALIDATION_SAMPLE_COUNT,
    24
  );
  const reportBaseName =
    mode === "cleanup-dry-run"
      ? "compatible-full-flow-cleanup-dry-run-report"
      : "compatible-full-flow-report";

  return {
    mode,
    cwd,
    changeId: env.FOCOWIKI_VALIDATION_CHANGE_ID || DEFAULT_CHANGE_ID,
    runId,
    reportDir,
    reportPath: path.join(reportDir, `${reportBaseName}.json`),
    reportMarkdownPath: path.join(reportDir, `${reportBaseName}.md`),
    evidencePath: path.join(reportDir, "compatible-pass-evidence.json"),
    runStatePath: path.join(reportDir, "run-state.json"),
    envPath: cli.envPath || env.ENV_FILE || ".env",
    envTemplatePath: cli.envTemplatePath || defaultEnvTemplatePath(env),
    markdownDir,
    sampleCount,
    batchSampleCount: readPositiveInteger(
      cli.batchSampleCount || env.FOCOWIKI_VALIDATION_BATCH_SAMPLE_COUNT,
      Math.max(sampleCount - 1, 2)
    ),
    includeBrowser: readBoolean(env.FOCOWIKI_VALIDATION_INCLUDE_BROWSER, true),
    includeWhiteBox: readBoolean(env.FOCOWIKI_VALIDATION_INCLUDE_WHITEBOX, true),
    requireModel: readBoolean(env.FOCOWIKI_VALIDATION_REQUIRE_MODEL, false),
    requestTimeoutMs: readPositiveInteger(env.FOCOWIKI_VALIDATION_HTTP_TIMEOUT_MS, 180_000),
    adminApiBaseUrl:
      cli.adminApiBaseUrl ||
      env.FOCOWIKI_VALIDATION_ADMIN_API_BASE_URL ||
      env.ADMIN_API_PUBLIC_ORIGIN ||
      `http://127.0.0.1:${env.ADMIN_API_PORT || "43000"}`,
    adminUiBaseUrl:
      cli.adminUiBaseUrl ||
      env.FOCOWIKI_VALIDATION_ADMIN_UI_BASE_URL ||
      env.ADMIN_PUBLIC_ORIGIN ||
      `http://127.0.0.1:${env.ADMIN_UI_PORT || "43100"}`,
    publicOpenApiBaseUrl:
      cli.publicOpenApiBaseUrl ||
      env.FOCOWIKI_VALIDATION_OPENAPI_BASE_URL ||
      env.PUBLIC_BASE_URL ||
      `http://127.0.0.1:${env.PUBLIC_OPENAPI_PORT || "43200"}`,
    env
  };
}

function defaultEnvTemplatePath(env) {
  return String(env.APP_ENV ?? "").trim().toLowerCase() === "production"
    ? ".env.example"
    : ".env.dev.example";
}

export function requiredRuntimeFieldNames(config) {
  const fields = [
    "APP_ENV",
    "DATABASE_URL",
    "REDIS_URL",
    "S3_ENDPOINT",
    "S3_BUCKET",
    "S3_PREFIX",
    "ADMIN_USERNAME",
    "ADMIN_PASSWORD",
    "ADMIN_SESSION_SECRET",
    "ADMIN_API_PORT",
    "PUBLIC_OPENAPI_PORT"
  ];

  if (config.requireModel) {
    fields.push("MODEL_BASE_URL", "MODEL_API_KEY", "MODEL_NAME");
  }

  return fields;
}

export function missingRuntimeFields(config) {
  return requiredRuntimeFieldNames(config).filter((key) => !String(config.env[key] ?? "").trim());
}

function normalizeMode(mode) {
  if (["preflight", "compatible", "clean-room", "cleanup-dry-run"].includes(mode)) {
    return mode;
  }

  throw new Error("Compatible full-flow command must be preflight, compatible, clean-room, or cleanup-dry-run.");
}

function parseCliArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--") {
      continue;
    }

    if (!arg?.startsWith("--")) {
      continue;
    }

    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const value = inlineValue ?? next ?? "";

    if (inlineValue === undefined) {
      index += 1;
    }

    const key = rawKey.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    parsed[key] = value;
  }

  return parsed;
}

function readBoolean(value, fallback) {
  if (value === undefined || value === "") {
    return fallback;
  }

  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function readPositiveInteger(value, fallback) {
  const parsed = Number(value ?? fallback);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";
import { redactReportText } from "./lib/redaction.mjs";

const DEFAULT_CHANGE_ID = "validate-large-legal-e2e-full-coverage";
const ALLOW_CONFIGURED_EXTERNALS_ENV = "FOCOWIKI_VALIDATION_ALLOW_CONFIGURED_EXTERNALS";
const FORCE_RERUN_ENV = "FOCOWIKI_VALIDATION_FORCE_RERUN";
const DEFAULT_REPORT_DIR = "ReferenceDocs/validate-large-legal-e2e-full-coverage";

loadLocalEnv();

export function readLargeLegalFullCoverageConfig(command = "all", env = process.env) {
  const normalizedCommand = normalizeCommand(command);
  const changeId = env.FOCOWIKI_VALIDATION_CHANGE_ID?.trim() || DEFAULT_CHANGE_ID;
  const reportDir = path.resolve(env.FOCOWIKI_VALIDATION_REPORT_DIR?.trim() || DEFAULT_REPORT_DIR);

  return {
    command: normalizedCommand,
    changeId,
    reportDir,
    sampleCount: readPositiveInteger(env.FOCOWIKI_VALIDATION_SAMPLE_COUNT, 100),
    batchSampleCount: readPositiveInteger(env.FOCOWIKI_VALIDATION_BATCH_SAMPLE_COUNT, 99),
    minBatchFiles: readPositiveInteger(env.FOCOWIKI_VALIDATION_MIN_BATCH_FILES, 99),
    contentSampleCount: readPositiveInteger(env.FOCOWIKI_VALIDATION_CONTENT_SAMPLE_COUNT, 25),
    requireModel: readBoolean(env.FOCOWIKI_VALIDATION_REQUIRE_MODEL, true),
    allowConfiguredExternals: readBoolean(env[ALLOW_CONFIGURED_EXTERNALS_ENV], false),
    includeRepositoryChecks: readBoolean(env.FOCOWIKI_LARGE_LEGAL_INCLUDE_REPOSITORY_CHECKS, false),
    forceRerun: readBoolean(env[FORCE_RERUN_ENV], false)
  };
}

export function buildLargeLegalFullCoveragePlan(config) {
  const validationEnv = {
    FOCOWIKI_VALIDATION_CHANGE_ID: config.changeId,
    FOCOWIKI_VALIDATION_REPORT_DIR: config.reportDir,
    FOCOWIKI_VALIDATION_PROFILE: "large-scale",
    FOCOWIKI_VALIDATION_SAMPLE_COUNT: String(config.sampleCount),
    FOCOWIKI_VALIDATION_BATCH_SAMPLE_COUNT: String(config.batchSampleCount),
    FOCOWIKI_VALIDATION_MIN_BATCH_FILES: String(config.minBatchFiles),
    FOCOWIKI_VALIDATION_CONTENT_SAMPLE_COUNT: String(config.contentSampleCount),
    FOCOWIKI_VALIDATION_REQUIRE_MODEL: config.requireModel ? "true" : "false"
  };
  const steps = [];

  if (config.command === "all" || config.command === "samples") {
    steps.push(
      validationStep("sample-selection", [
        process.execPath,
        ["scripts/validation/cleaned-markdown-flow.mjs", "samples"],
        validationEnv,
        false
      ])
    );
  }

  if (config.command === "all" || config.command === "api") {
    steps.push(
      validationStep("api-whitebox-blackbox-content", [
        process.execPath,
        ["scripts/validation/cleaned-markdown-flow.mjs", "api"],
        validationEnv,
        true
      ])
    );
  }

  if (config.includeRepositoryChecks) {
    steps.push(
      pnpmStep("validation-unit-tests", ["test:validation"], false),
      pnpmStep("openapi-contract", ["openapi:validate"], false),
      pnpmStep("no-local-paths", ["validate:no-local-paths"], false)
    );
  }

  return steps;
}

export function createLargeLegalFullCoverageReport(config, steps) {
  return {
    kind: "large-legal-full-coverage",
    change: config.changeId,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    ok: false,
    command: config.command,
    profile: "large-scale",
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
      allowConfiguredExternals: config.allowConfiguredExternals,
      includeRepositoryChecks: config.includeRepositoryChecks,
      forceRerun: config.forceRerun
    },
    steps: steps.map((step) => ({
      id: step.id,
      command: step.safeCommand,
      status: "pending",
      touchesConfiguredExternals: step.touchesConfiguredExternals,
      startedAt: null,
      finishedAt: null,
      durationMs: null
    })),
    checks: [],
    failures: [],
    remainingRisks: [
      "The run uses local .env dependencies, so configured S3-compatible storage and model provider availability can affect runtime.",
      "Local pressure metrics describe this machine only and are not server capacity claims."
    ]
  };
}

async function main(argv = process.argv.slice(2)) {
  const config = readLargeLegalFullCoverageConfig(argv[0] || "all");
  const steps = buildLargeLegalFullCoveragePlan(config);
  const report = createLargeLegalFullCoverageReport(config, steps);
  const existingReport = config.forceRerun ? null : readExistingLargeCoverageReport(config.reportDir);

  fs.mkdirSync(config.reportDir, { recursive: true });
  applyResumeState(report, existingReport);
  writeLargeCoverageReport(config.reportDir, report);

  for (const [index, step] of steps.entries()) {
    const reportStep = report.steps[index];

    if (reportStep.status === "passed") {
      console.log(`[skip] ${step.id} already passed. Set ${FORCE_RERUN_ENV}=true to rerun it.`);
      continue;
    }

    assertStepAllowed(step, config);
    reportStep.status = "running";
    reportStep.startedAt = new Date().toISOString();
    writeLargeCoverageReport(config.reportDir, report);
    const started = Date.now();

    try {
      await spawnCommand(step.command, step.args, { ...process.env, ...step.extraEnv });
      reportStep.status = "passed";
      report.checks.push({
        layer: step.layer,
        name: step.id,
        ok: true,
        message: `${step.id} completed.`
      });
    } catch (error) {
      reportStep.status = "failed";
      reportStep.finishedAt = new Date().toISOString();
      reportStep.durationMs = Date.now() - started;
      report.failures.push(error instanceof Error ? error.message : String(error));
      report.finishedAt = reportStep.finishedAt;
      report.ok = false;
      writeLargeCoverageReport(config.reportDir, report);
      throw error;
    }

    reportStep.finishedAt = new Date().toISOString();
    reportStep.durationMs = Date.now() - started;
    writeLargeCoverageReport(config.reportDir, report);
  }

  report.finishedAt = new Date().toISOString();
  report.ok = true;
  writeLargeCoverageReport(config.reportDir, report);
  return report;
}

function readExistingLargeCoverageReport(reportDir) {
  const filePath = path.join(reportDir, "large-legal-full-coverage-report.json");

  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function applyResumeState(report, existingReport) {
  if (!isResumeCompatible(report, existingReport)) {
    return;
  }

  const existingSteps = new Map(
    existingReport.steps
      .filter((step) => step.status === "passed")
      .map((step) => [step.id, step])
  );
  const reusableChecks = [];

  for (const step of report.steps) {
    const existingStep = existingSteps.get(step.id);

    if (!existingStep) {
      continue;
    }

    Object.assign(step, {
      status: "passed",
      startedAt: existingStep.startedAt ?? null,
      finishedAt: existingStep.finishedAt ?? null,
      durationMs: existingStep.durationMs ?? null
    });
    reusableChecks.push({
      layer: "resume",
      name: step.id,
      ok: true,
      message: `${step.id} reused from previous passed run.`
    });
  }

  report.checks.push(...reusableChecks);
}

function isResumeCompatible(report, existingReport) {
  if (!existingReport || existingReport.kind !== report.kind || existingReport.command !== report.command) {
    return false;
  }

  return (
    existingReport.change === report.change &&
    existingReport.profile === report.profile &&
    existingReport.sample?.sampleCount === report.sample.sampleCount &&
    existingReport.sample?.batchSampleCount === report.sample.batchSampleCount &&
    existingReport.sample?.minBatchFiles === report.sample.minBatchFiles &&
    existingReport.sample?.contentSampleCount === report.sample.contentSampleCount &&
    existingReport.config?.requireModel === report.config.requireModel &&
    existingReport.config?.includeRepositoryChecks === report.config.includeRepositoryChecks
  );
}

function validationStep(id, [command, args, extraEnv, touchesConfiguredExternals]) {
  return {
    id,
    layer: id === "sample-selection" ? "white-box" : "mixed",
    command,
    args,
    extraEnv,
    touchesConfiguredExternals,
    safeCommand: `${path.basename(command)} ${args.join(" ")}`
  };
}

function pnpmStep(id, args, touchesConfiguredExternals) {
  return {
    id,
    layer: "verification",
    command: "pnpm",
    args,
    extraEnv: {},
    touchesConfiguredExternals,
    safeCommand: `pnpm ${args.join(" ")}`
  };
}

function assertStepAllowed(step, config) {
  if (!step.touchesConfiguredExternals || config.allowConfiguredExternals) {
    return;
  }

  throw new Error(
    `${ALLOW_CONFIGURED_EXTERNALS_ENV}=true is required before running ${step.id}, because it uses local .env S3/model dependencies.`
  );
}

function spawnCommand(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env,
      stdio: "inherit"
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

function writeLargeCoverageReport(reportDir, report) {
  fs.mkdirSync(reportDir, { recursive: true });
  const safeReport = JSON.parse(redactReportText(JSON.stringify(report, null, 2)));
  fs.writeFileSync(
    path.join(reportDir, "large-legal-full-coverage-report.json"),
    `${JSON.stringify(safeReport, null, 2)}\n`
  );
  fs.writeFileSync(path.join(reportDir, "large-legal-full-coverage-report.md"), renderMarkdown(safeReport));
}

function renderMarkdown(report) {
  return [
    "# Large Legal Full-Coverage Validation Report",
    "",
    `- Change: ${report.change}`,
    `- Command: ${report.command}`,
    `- Profile: ${report.profile}`,
    `- Source: ${report.source.redactedRoot}`,
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
    "## Runtime Scope",
    "",
    `- Require model: ${report.config.requireModel ? "yes" : "no"}`,
    `- Configured external dependencies allowed: ${report.config.allowConfiguredExternals ? "yes" : "no"}`,
    `- Repository checks: ${report.config.includeRepositoryChecks ? "yes" : "no"}`,
    "",
    "## Steps",
    "",
    ...report.steps.map(
      (step) =>
        `- ${step.status.toUpperCase()} ${step.id}: ${step.command} (${step.durationMs ?? "not-finished"}ms)`
    ),
    "",
    "## Checks",
    "",
    ...(report.checks.length
      ? report.checks.map((check) => `- ${check.ok ? "PASS" : "FAIL"} [${check.layer}] ${check.name}: ${check.message}`)
      : ["- None recorded."]),
    "",
    "## Failures",
    "",
    ...(report.failures.length ? report.failures.map((failure) => `- ${failure}`) : ["- None recorded."]),
    "",
    "## Remaining Risks",
    "",
    ...report.remainingRisks.map((risk) => `- ${risk}`),
    ""
  ].join("\n");
}

function normalizeCommand(command) {
  if (["all", "samples", "api"].includes(command)) {
    return command;
  }

  throw new Error("Large legal full-coverage command must be all, samples, or api.");
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

  return /^(1|true|yes)$/i.test(raw);
}

function loadLocalEnv() {
  const envFile = process.env.ENV_FILE || ".env";

  if (fs.existsSync(envFile)) {
    loadEnvFile(envFile);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

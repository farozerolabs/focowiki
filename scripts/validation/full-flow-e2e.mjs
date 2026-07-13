import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";
import { createValidationRunId } from "./lib/validation-run-id.mjs";
import {
  DEFAULT_FULL_CODEBASE_REPORT_DIR,
  createFullCodebaseReport,
  writeFullCodebaseReport
} from "./lib/full-codebase-validation.mjs";

const DEFAULT_CHANGE_ID = "validate-clean-architecture-full-system";

loadLocalEnv();

export function readFullFlowConfig(command = "all", env = process.env) {
  const normalizedCommand = normalizeCommand(command);
  const changeId = env.FOCOWIKI_FULL_FLOW_CHANGE_ID?.trim() || DEFAULT_CHANGE_ID;
  const reportDir = path.resolve(
    env.FOCOWIKI_FULL_FLOW_REPORT_DIR?.trim() ||
      env.FOCOWIKI_VALIDATION_REPORT_DIR?.trim() ||
      DEFAULT_FULL_CODEBASE_REPORT_DIR
  );

  return {
    command: normalizedCommand,
    changeId,
    runId:
      env.FOCOWIKI_FULL_FLOW_RUN_ID?.trim() ||
      env.FOCOWIKI_VALIDATION_RUN_ID?.trim() ||
      createValidationRunId(),
    changeDir: path.resolve("openspec/changes", changeId),
    reportDir,
    largeProfile: normalizedCommand === "large",
    includeBrowser: readBoolean(env.FOCOWIKI_FULL_FLOW_INCLUDE_BROWSER, true),
    includeRepositoryChecks: readBoolean(env.FOCOWIKI_FULL_FLOW_INCLUDE_REPOSITORY, true),
    includeDocker: readBoolean(env.FOCOWIKI_FULL_FLOW_INCLUDE_DOCKER, false),
    requireModel: readBoolean(env.FOCOWIKI_VALIDATION_REQUIRE_MODEL, false),
    sampleSourceEnv: "FOCOWIKI_VALIDATION_MARKDOWN_DIR"
  };
}

export function buildFullFlowPlan(config) {
  if (config.command === "plan") {
    return [];
  }

  const sampleCommand = config.largeProfile ? "large-samples" : "samples";
  const apiCommand = config.largeProfile ? "large-api" : "api";
  const browserCommand = config.largeProfile ? "large-browser" : "browser";
  const validationEnv = {
    FOCOWIKI_VALIDATION_CHANGE_ID: config.changeId
  };

  if (config.largeProfile && !process.env.FOCOWIKI_VALIDATION_MAX_ENDPOINT_MS) {
    validationEnv.FOCOWIKI_VALIDATION_MAX_ENDPOINT_MS = "10000";
  }
  const steps = [
    validationStep("sample-selection", [
      process.execPath,
      ["scripts/validation/cleaned-markdown-flow.mjs", sampleCommand],
      validationEnv
    ]),
    validationStep("api-whitebox-blackbox", [
      process.execPath,
      ["scripts/validation/cleaned-markdown-flow.mjs", apiCommand],
      validationEnv
    ])
  ];

  if (config.includeBrowser) {
    steps.push(
      validationStep("admin-ui-browser", [
        process.execPath,
        ["scripts/validation/cleaned-markdown-browser.mjs", browserCommand],
        validationEnv
      ])
    );
  }

  if (config.includeRepositoryChecks) {
    steps.push(
      pnpmStep("workspace-typecheck", ["typecheck"]),
      pnpmStep("workspace-test", ["test"]),
      pnpmStep("workspace-build", ["build"]),
      pnpmStep("validation-unit-tests", ["test:validation"]),
      pnpmStep("openapi-contract", ["openapi:validate"]),
      pnpmStep("docs-contract", ["docs:validate"]),
      pnpmStep("api-runtime-build", ["--filter", "@focowiki/api", "build:runtime"]),
      pnpmStep("no-local-paths", ["validate:no-local-paths"])
    );
  }

  if (config.includeDocker) {
    steps.push(
      pnpmStep("compose-example-config", ["compose:example:config"]),
      pnpmStep("compose-dev-example-config", ["compose:dev:example:config"]),
      pnpmStep("compose-local-example-config", ["compose:local:example:config"])
    );
  }

  return steps;
}

export function createFullFlowReport(config, steps) {
  return createFullCodebaseReport(config, steps);
}

async function main(argv = process.argv.slice(2)) {
  const config = readFullFlowConfig(argv[0] || "all");

  const steps = buildFullFlowPlan(config);
  const report = createFullFlowReport(config, steps);
  writeFullFlowReport(config.reportDir, report);

  if (config.command === "plan") {
    report.finishedAt = new Date().toISOString();
    report.ok = true;
    report.checks.push({
      layer: "plan",
      name: "full-codebase-matrix",
      ok: true,
      message: "Full-codebase validation matrix was generated without touching runtime services."
    });
    writeFullFlowReport(config.reportDir, report);
    return report;
  }

  for (const [index, step] of steps.entries()) {
    const reportStep = report.steps[index];
    reportStep.status = "running";
    reportStep.startedAt = new Date().toISOString();
    writeFullFlowReport(config.changeDir, report);

    const started = Date.now();

    try {
      await runStep(step, config);
      reportStep.status = "passed";
      report.checks.push({
        layer: step.layer,
        name: step.id,
        ok: true,
        message: `${step.id} completed.`
      });
    } catch (error) {
      reportStep.status = "failed";
      report.failures.push(error instanceof Error ? error.message : String(error));
      report.finishedAt = new Date().toISOString();
      report.ok = false;
      reportStep.finishedAt = report.finishedAt;
      reportStep.durationMs = Date.now() - started;
      writeFullFlowReport(config.reportDir, report);
      throw error;
    }

    reportStep.finishedAt = new Date().toISOString();
    reportStep.durationMs = Date.now() - started;
    writeFullFlowReport(config.reportDir, report);
  }

  report.finishedAt = new Date().toISOString();
  report.ok = true;
  writeFullFlowReport(config.reportDir, report);
  return report;
}

function validationStep(id, [command, args, extraEnv]) {
  return {
    id,
    layer:
      id === "admin-ui-browser"
        ? "black-box"
        : id === "api-whitebox-blackbox"
          ? "mixed"
          : "white-box",
    command,
    args,
    extraEnv,
    safeCommand: `${path.basename(command)} ${args.join(" ")}`,
    safeReportPath: null
  };
}

function pnpmStep(id, args) {
  return {
    id,
    layer: "verification",
    command: "pnpm",
    args,
    extraEnv: {},
    safeCommand: `pnpm ${args.join(" ")}`,
    safeReportPath: null
  };
}

async function runStep(step) {
  const env = {
    ...process.env,
    ...step.extraEnv
  };

  await spawnCommand(step.command, step.args, env);
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

function writeFullFlowReport(changeDir, report) {
  writeFullCodebaseReport(changeDir, report);
}

function loadLocalEnv() {
  const envFile = process.env.ENV_FILE || ".env";

  if (fs.existsSync(envFile)) {
    loadEnvFile(envFile);
  }
}

function normalizeCommand(command) {
  if (["all", "large", "plan"].includes(command)) {
    return command;
  }

  throw new Error(`Unknown full-flow validation command: ${command}`);
}

function readBoolean(value, fallback) {
  if (value === undefined || value === "") {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

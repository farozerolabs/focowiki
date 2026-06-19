import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";
import { redactReportText } from "./lib/redaction.mjs";

const DEFAULT_CHANGE_ID = "validate-full-flow-e2e-whitebox-blackbox";
const DEMO_REPO_ENV = "FOCOWIKI_DEMO_E2E_DEMO_REPO";
const DEFAULT_DEMO_REPO = "../focowiki-demo";

loadLocalEnv();

export function readFullFlowConfig(command = "all", env = process.env) {
  const normalizedCommand = normalizeCommand(command);
  const demoRepo = path.resolve(env[DEMO_REPO_ENV]?.trim() || DEFAULT_DEMO_REPO);
  const demoRepoExists = fs.existsSync(path.join(demoRepo, "package.json"));

  return {
    command: normalizedCommand,
    changeId: env.FOCOWIKI_FULL_FLOW_CHANGE_ID?.trim() || DEFAULT_CHANGE_ID,
    changeDir: path.resolve(
      "openspec/changes",
      env.FOCOWIKI_FULL_FLOW_CHANGE_ID?.trim() || DEFAULT_CHANGE_ID
    ),
    largeProfile: normalizedCommand === "large",
    includeBrowser: readBoolean(env.FOCOWIKI_FULL_FLOW_INCLUDE_BROWSER, true),
    includeDemo: readBoolean(env.FOCOWIKI_FULL_FLOW_INCLUDE_DEMO, demoRepoExists),
    includeRepositoryChecks: readBoolean(env.FOCOWIKI_FULL_FLOW_INCLUDE_REPOSITORY, true),
    demoRepo,
    demoRepoExists,
    requireModel: readBoolean(env.FOCOWIKI_VALIDATION_REQUIRE_MODEL, false),
    sampleSourceEnv: "FOCOWIKI_VALIDATION_MARKDOWN_DIR"
  };
}

export function buildFullFlowPlan(config) {
  const sampleCommand = config.largeProfile ? "large-samples" : "samples";
  const apiCommand = config.largeProfile ? "large-api" : "api";
  const browserCommand = config.largeProfile ? "large-browser" : "browser";
  const validationEnv = {
    FOCOWIKI_VALIDATION_CHANGE_ID: config.changeId
  };

  if (config.largeProfile && !process.env.FOCOWIKI_VALIDATION_MAX_ENDPOINT_MS) {
    validationEnv.FOCOWIKI_VALIDATION_MAX_ENDPOINT_MS = "10000";
  }
  const demoEnv = {
    FOCOWIKI_DEMO_E2E_REPORT_DIR: config.changeDir,
    FOCOWIKI_DEMO_E2E_ENABLE_DEVELOPER_ROUTE_CHECKS:
      process.env.FOCOWIKI_DEMO_E2E_ENABLE_DEVELOPER_ROUTE_CHECKS ?? "true"
  };

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

  if (config.includeDemo) {
    steps.push(
      validationStep("demo-agent-e2e", [
        process.execPath,
        ["scripts/validation/demo-agent-e2e.mjs", "e2e"],
        demoEnv
      ])
    );
  }

  if (config.includeRepositoryChecks) {
    steps.push(
      pnpmStep("typecheck", ["typecheck"]),
      pnpmStep("test", ["test"]),
      pnpmStep("build", ["build"]),
      pnpmStep("validation-unit-tests", ["test:validation"]),
      pnpmStep("openapi-contract", ["openapi:validate"]),
      pnpmStep("docs-contract", ["docs:validate"]),
      pnpmStep("no-local-paths", ["validate:no-local-paths"])
    );
  }

  return steps;
}

export function createFullFlowReport(config, steps) {
  return {
    kind: "full-flow-e2e",
    change: config.changeId,
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
      includeDemo: config.includeDemo,
      includeRepositoryChecks: config.includeRepositoryChecks,
      requireModel: config.requireModel,
      demoRepo: config.includeDemo ? `<${DEMO_REPO_ENV}>` : "not-enabled"
    },
    steps: steps.map((step) => ({
      id: step.id,
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
    remainingRisks: [
      "External S3-compatible storage and model provider availability can affect full-flow runtime.",
      "Admin UI bundle size warning is tracked separately from validation pass/fail status."
    ]
  };
}

async function main(argv = process.argv.slice(2)) {
  const config = readFullFlowConfig(argv[0] || "all");

  if (config.includeDemo && !config.demoRepoExists) {
    throw new Error(`${DEMO_REPO_ENV} must point to the standalone demo backend repository.`);
  }

  const steps = buildFullFlowPlan(config);
  const report = createFullFlowReport(config, steps);
  writeFullFlowReport(config.changeDir, report);

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
      writeFullFlowReport(config.changeDir, report);
      throw error;
    }

    reportStep.finishedAt = new Date().toISOString();
    reportStep.durationMs = Date.now() - started;
    writeFullFlowReport(config.changeDir, report);
  }

  report.finishedAt = new Date().toISOString();
  report.ok = true;
  writeFullFlowReport(config.changeDir, report);
  return report;
}

function validationStep(id, [command, args, extraEnv]) {
  const reportName = id === "demo-agent-e2e" ? "demo-agent-e2e-report.json" : null;

  return {
    id,
    layer:
      id === "admin-ui-browser"
        ? "black-box"
        : id === "api-whitebox-blackbox"
          ? "mixed"
          : id === "demo-agent-e2e"
            ? "black-box"
            : "white-box",
    command,
    args,
    extraEnv,
    safeCommand: `${path.basename(command)} ${args.join(" ")}`,
    safeReportPath: reportName ? `<change-dir>/${reportName}` : null
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

async function runStep(step, config) {
  const env = {
    ...process.env,
    ...step.extraEnv
  };

  if (step.id === "demo-agent-e2e") {
    env.FOCOWIKI_DEMO_E2E_DEMO_REPO = config.demoRepo;
  }

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
  fs.mkdirSync(changeDir, { recursive: true });
  const safeReport = JSON.parse(redactReportText(JSON.stringify(report, null, 2)));
  fs.writeFileSync(
    path.join(changeDir, "full-flow-validation-report.json"),
    `${JSON.stringify(safeReport, null, 2)}\n`
  );
  fs.writeFileSync(path.join(changeDir, "full-flow-validation-report.md"), renderMarkdown(safeReport));
}

function renderMarkdown(report) {
  return [
    "# Full-Flow E2E Validation Report",
    "",
    `- Change: ${report.change}`,
    `- Kind: ${report.kind}`,
    `- Started at: ${report.startedAt}`,
    `- Finished at: ${report.finishedAt || "not-finished"}`,
    `- Result: ${report.ok ? "pass" : "fail"}`,
    `- Profile: ${report.profile}`,
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

function loadLocalEnv() {
  const envFile = process.env.ENV_FILE || ".env";

  if (fs.existsSync(envFile)) {
    loadEnvFile(envFile);
  }
}

function normalizeCommand(command) {
  if (["all", "large"].includes(command)) {
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

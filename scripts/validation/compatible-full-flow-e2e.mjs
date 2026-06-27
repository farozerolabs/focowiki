import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";
import { readCompatibleFullFlowConfig } from "./lib/compatible-full-flow/config.mjs";
import { assertLocalCleanRoomGuard } from "./lib/compatible-full-flow/guards.mjs";
import {
  createCleanupPlan,
  createRunState,
  diagnoseOlderValidationMarkers,
  readRunState,
  recordValidationCleanupResult,
  writeRunState
} from "./lib/compatible-full-flow/run-state.mjs";
import {
  addCheck,
  addFailure,
  createCompatibleReport,
  finishReport,
  writeCompatibleReport
} from "./lib/compatible-full-flow/report.mjs";
import { runCompatiblePreflight } from "./lib/compatible-full-flow/preflight.mjs";

loadLocalEnv();

export async function main(argv = process.argv.slice(2)) {
  const command = argv[0] ?? "preflight";
  const args = argv.slice(1);
  const config = readCompatibleFullFlowConfig({ command, argv: args });
  const report = createCompatibleReport(config);
  const runState = createRunState({ runId: config.runId, reportDir: config.reportDir });

  writeRunState(config.runStatePath, runState);

  try {
    if (config.mode === "cleanup-dry-run") {
      await runCleanupDryRun(config, report);
    } else if (config.mode === "clean-room") {
      await runLocalCleanRoom(config, report);
    } else {
      await runCompatiblePreflight(config, report, {
        includeNetwork: config.mode === "compatible"
      });

      if (config.mode === "compatible") {
        await runCompatibleProductFlow(config, report, runState);
        writeRunState(config.runStatePath, runState);
      }
    }

    finishReport(report, true);
    writeCompatibleReport(config, report);
    return report;
  } catch (error) {
    addFailure(report, error);
    finishReport(report, false);
    writeCompatibleReport(config, report);
    throw error;
  }
}

async function runCompatibleProductFlow(config, report, runState) {
  const validationEnv = {
    ...process.env,
    FOCOWIKI_VALIDATION_CHANGE_ID: config.changeId,
    FOCOWIKI_VALIDATION_REPORT_DIR: config.reportDir,
    FOCOWIKI_VALIDATION_MARKDOWN_DIR: config.markdownDir,
    FOCOWIKI_VALIDATION_SAMPLE_COUNT: String(config.sampleCount),
    FOCOWIKI_VALIDATION_BATCH_SAMPLE_COUNT: String(config.batchSampleCount),
    FOCOWIKI_VALIDATION_REQUIRE_MODEL: config.requireModel ? "true" : "false"
  };
  const steps = [
    ["sample-selection", process.execPath, ["scripts/validation/cleaned-markdown-flow.mjs", "samples"]],
    ["api-blackbox-whitebox", process.execPath, ["scripts/validation/cleaned-markdown-flow.mjs", "api"]]
  ];

  if (config.includeBrowser) {
    steps.push([
      "admin-ui-browser",
      process.execPath,
      ["scripts/validation/cleaned-markdown-browser.mjs", "browser"]
    ]);
  }

  for (const [name, command, args] of steps) {
    await runCommand(command, args, validationEnv);
    addCheck(report, {
      layer: name === "admin-ui-browser" ? "black-box" : "mixed",
      name,
      message: `${name} completed through existing full-flow validation slice.`
    });
  }

  recordExistingFlowResources(config, runState);
  recordValidationCleanupResult(runState);
}

async function runLocalCleanRoom(config, report) {
  const evidence = JSON.parse(fs.readFileSync(config.evidencePath, "utf8"));
  assertLocalCleanRoomGuard(config, evidence);
  let services = null;

  addCheck(report, {
    layer: "clean-room",
    name: "local-reset-guard",
    message: "Local reset guard accepted explicit local-only clean-room settings."
  });

  const setupCommands = [
    ["pnpm", ["compose:local:clean"]],
    ["pnpm", ["compose:local:up"]]
  ];

  for (const [command, args] of setupCommands) {
    await runCommand(command, args, process.env);
    addCheck(report, {
      layer: "clean-room",
      name: `command:${command} ${args.join(" ")}`,
      message: "Local clean-room setup command completed."
    });
  }

  await waitForLocalInfrastructure(config, report);
  await runCommandWithRetry("pnpm", ["--filter", "@focowiki/api", "db:migrate"], process.env, {
    attempts: 12,
    delayMs: 2_000
  });
  addCheck(report, {
    layer: "clean-room",
    name: "command:pnpm --filter @focowiki/api db:migrate",
    message: "Local clean-room database migration completed."
  });

  try {
    services = await startLocalCleanRoomServices(config, report);
    await runCompatiblePreflight(config, report, { includeNetwork: true });
    const runState = createRunState({ runId: config.runId, reportDir: config.reportDir });
    await runCompatibleProductFlow(config, report, runState);
    writeRunState(config.runStatePath, runState);
  } finally {
    await services?.stop();
  }
}

async function runCleanupDryRun(config, report) {
  const state = fs.existsSync(config.runStatePath)
    ? readRunState(config.runStatePath)
    : createRunState({ runId: config.runId, reportDir: config.reportDir });
  const plan = createCleanupPlan(state);
  const olderMarkers = diagnoseOlderValidationMarkers(
    Object.values(state.resources ?? {}).flat(),
    state.runId
  );

  report.cleanup.plan = plan;
  report.cleanup.dryRunLeftovers = olderMarkers;
  addCheck(report, {
    layer: "cleanup",
    name: "cleanup-dry-run",
    message: "Cleanup dry-run inspected run-state and did not delete resources.",
    details: {
      currentRunResourceCount: Object.values(plan.resources).flat().length,
      olderMarkerCount: olderMarkers.length
    }
  });
}

function runCommand(command, args, env) {
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

async function runCommandWithRetry(command, args, env, options) {
  let lastError = null;

  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      await runCommand(command, args, env);
      return;
    } catch (error) {
      lastError = error;

      if (attempt === options.attempts) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
  }

  throw lastError;
}

async function startLocalCleanRoomServices(config, report) {
  const services = [
    {
      name: "api",
      command: "pnpm",
      args: ["--filter", "@focowiki/api", "dev"]
    },
    {
      name: "worker",
      command: "pnpm",
      args: ["--filter", "@focowiki/api", "exec", "tsx", "src/worker-main.ts"]
    },
    {
      name: "admin",
      command: "pnpm",
      args: [
        "--filter",
        "@focowiki/admin",
        "dev",
        "--",
        "--host",
        "127.0.0.1",
        "--port",
        String(config.env.ADMIN_UI_PORT || "43100")
      ]
    }
  ];
  const children = services.map((service) => startServiceProcess(service, process.env));

  try {
    await Promise.all([
      waitForUrl(`${config.adminApiBaseUrl.replace(/\/+$/u, "")}/healthz`, "Admin API"),
      waitForUrl(`${config.publicOpenApiBaseUrl.replace(/\/+$/u, "")}/healthz`, "Developer OpenAPI"),
      waitForUrl(config.adminUiBaseUrl, "Admin UI")
    ]);

    addCheck(report, {
      layer: "clean-room",
      name: "local-clean-room-services",
      message: "Local API, worker, and Admin UI services started for clean-room validation."
    });

    return {
      async stop() {
        await stopServiceProcesses(children);
      }
    };
  } catch (error) {
    await stopServiceProcesses(children);
    throw error;
  }
}

function startServiceProcess(service, env) {
  const child = spawn(service.command, service.args, {
    cwd: process.cwd(),
    env,
    stdio: "inherit"
  });
  let exited = false;
  let exitCode = null;

  child.on("exit", (code) => {
    exited = true;
    exitCode = code;
  });

  return {
    ...service,
    child,
    isExited: () => exited,
    exitCode: () => exitCode
  };
}

async function waitForUrl(url, label) {
  const deadline = Date.now() + 120_000;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);

      if (response.ok || response.status === 401) {
        return;
      }

      lastError = new Error(`${label} returned HTTP ${response.status}.`);
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(`${label} did not become reachable: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function waitForLocalInfrastructure(config, report) {
  await Promise.all([
    waitForTcpUrl(config.env.DATABASE_URL, "PostgreSQL"),
    waitForTcpUrl(config.env.REDIS_URL, "Redis")
  ]);
  addCheck(report, {
    layer: "clean-room",
    name: "local-infrastructure-ready",
    message: "Local PostgreSQL and Redis ports are reachable after clean-room reset."
  });
}

async function waitForTcpUrl(value, label) {
  const url = new URL(value);
  const port = Number(url.port || defaultPortForProtocol(url.protocol));
  const deadline = Date.now() + 120_000;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      await openTcpSocket(url.hostname, port);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  throw new Error(`${label} did not become reachable: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function defaultPortForProtocol(protocol) {
  if (protocol === "postgres:" || protocol === "postgresql:") {
    return 5432;
  }

  if (protocol === "redis:") {
    return 6379;
  }

  return 0;
}

function openTcpSocket(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timeout = setTimeout(() => {
      socket.destroy(new Error("TCP connection timed out."));
    }, 2_000);

    socket.once("connect", () => {
      clearTimeout(timeout);
      socket.end();
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function stopServiceProcesses(children) {
  await Promise.all(
    children.map(
      (service) =>
        new Promise((resolve) => {
          if (service.isExited()) {
            resolve();
            return;
          }

          const timeout = setTimeout(() => {
            if (!service.isExited()) {
              service.child.kill("SIGTERM");
            }
            resolve();
          }, 5_000);

          service.child.once("exit", () => {
            clearTimeout(timeout);
            resolve();
          });
          service.child.kill("SIGINT");
        })
    )
  );
}

function recordExistingFlowResources(config, runState) {
  const reportPath = path.join(config.reportDir, "validation-report.json");

  if (!fs.existsSync(reportPath)) {
    return;
  }

  const existingReport = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const validationRun = existingReport.validationRun ?? {};

  if (validationRun.knowledgeBaseId) {
    runState.resources.knowledgeBases.push({
      id: validationRun.knowledgeBaseId,
      runId: runState.runId,
      marker: runState.marker,
      cleanupState: "owned-by-validation-flow"
    });
  }

  for (const sourceFileId of [
    ...(validationRun.singleSourceFileIds ?? []),
    ...(validationRun.batchSourceFileIds ?? [])
  ]) {
    runState.resources.sourceFiles.push({
      id: sourceFileId,
      runId: runState.runId,
      marker: runState.marker,
      cleanupState: "owned-by-validation-flow"
    });
  }

  runState.resources.reports.push({
    id: path.basename(reportPath),
    runId: runState.runId,
    marker: runState.marker,
    cleanupState: "local-report"
  });
  runState.updatedAt = new Date().toISOString();
}

function loadLocalEnv() {
  const envFile = process.env.ENV_FILE || ".env";

  if (fs.existsSync(envFile)) {
    loadEnvFile(envFile);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";
import { createFullSystemReport, writeFullSystemReport } from "./lib/full-system-report.mjs";
import { buildFullSystemPlan, readFullSystemConfig } from "./lib/full-system-plan.mjs";
import { createValidationRunId } from "./lib/validation-run-id.mjs";

loadLocalEnv();

export async function runFullSystemReleaseGate(command = "all") {
  const config = readFullSystemConfig(command);
  const plan = buildFullSystemPlan(config);
  const runId = process.env.FOCOWIKI_FULL_SYSTEM_RUN_ID?.trim() || createValidationRunId();
  const report = createFullSystemReport(config, plan, runId);
  writeFullSystemReport(config.reportDir, report);

  if (command === "plan") {
    report.finishedAt = new Date().toISOString();
    report.ok = true;
    writeFullSystemReport(config.reportDir, report);
    return report;
  }

  for (const [index, step] of plan.entries()) {
    const reportStep = report.steps[index];
    const started = Date.now();
    reportStep.status = "running";
    reportStep.startedAt = new Date().toISOString();
    writeFullSystemReport(config.reportDir, report);

    try {
      step.assertAllowed(config);
      const extraEnv = resolveStepEnvironment(step.extraEnv);
      await spawnCommand(step.command, step.args, { ...process.env, ...extraEnv });
      reportStep.status = "passed";
    } catch (error) {
      reportStep.status = "failed";
      report.blockers.push(error instanceof Error ? error.message : String(error));
      report.finishedAt = new Date().toISOString();
      reportStep.finishedAt = report.finishedAt;
      reportStep.durationMs = Date.now() - started;
      writeFullSystemReport(config.reportDir, report);
      throw error;
    }

    reportStep.finishedAt = new Date().toISOString();
    reportStep.durationMs = Date.now() - started;
    writeFullSystemReport(config.reportDir, report);
  }

  report.finishedAt = new Date().toISOString();
  report.ok = true;
  writeFullSystemReport(config.reportDir, report);
  return report;
}

function resolveStepEnvironment(extraEnv) {
  return Object.fromEntries(
    Object.entries(extraEnv).map(([key, value]) => [
      key,
      value === "<DATABASE_URL>" ? process.env.DATABASE_URL ?? "" : value
    ])
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
      } else {
        reject(new Error(`${path.basename(command)} ${args.join(" ")} exited with code ${code}`));
      }
    });
  });
}

function loadLocalEnv() {
  const envFile = process.env.ENV_FILE || ".env";
  if (fs.existsSync(envFile)) {
    loadEnvFile(envFile);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runFullSystemReleaseGate(process.argv[2] || "all").catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

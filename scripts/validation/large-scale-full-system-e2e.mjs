import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";
import {
  applyResumeState,
  assertStepAllowed,
  buildLargeScaleFullSystemPlan,
  createLargeScaleFullSystemReport,
  readExistingLargeScaleFullSystemReport,
  readLargeScaleFullSystemConfig,
  writeLargeScaleFullSystemReport
} from "./lib/large-scale-full-system-validation.mjs";

loadLocalEnv();

export async function main(argv = process.argv.slice(2)) {
  const config = readLargeScaleFullSystemConfig(argv[0] || "all");
  const steps = buildLargeScaleFullSystemPlan(config);
  const report = createLargeScaleFullSystemReport(config, steps);

  if (!config.forceRerun) {
    applyResumeState(report, readExistingLargeScaleFullSystemReport(config.reportDir));
  }

  writeLargeScaleFullSystemReport(config.reportDir, report);

  if (config.command === "plan") {
    report.finishedAt = new Date().toISOString();
    report.ok = true;
    report.checks.push({
      layer: "plan",
      name: "large-scale-full-system-plan",
      ok: true,
      message: "Large-scale full-system validation plan was generated without touching runtime services."
    });
    writeLargeScaleFullSystemReport(config.reportDir, report);
    return report;
  }

  for (const [index, step] of steps.entries()) {
    const reportStep = report.steps[index];

    if (reportStep.status === "passed") {
      continue;
    }

    assertStepAllowed(step, config);
    reportStep.status = "running";
    reportStep.startedAt = new Date().toISOString();
    writeLargeScaleFullSystemReport(config.reportDir, report);
    const started = Date.now();

    try {
      await runStep(step);
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
      report.finishedAt = reportStep.finishedAt;
      report.ok = false;
      report.failures.push(error instanceof Error ? error.message : String(error));
      writeLargeScaleFullSystemReport(config.reportDir, report);
      throw error;
    }

    reportStep.finishedAt = new Date().toISOString();
    reportStep.durationMs = Date.now() - started;
    writeLargeScaleFullSystemReport(config.reportDir, report);
  }

  report.finishedAt = new Date().toISOString();
  report.ok = true;
  writeLargeScaleFullSystemReport(config.reportDir, report);
  return report;
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

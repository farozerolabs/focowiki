import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  FAULT_INJECTION_CASES,
  assertStorageVnextFaultInjectionCoverage,
  buildFaultInjectionSuites
} from "./lib/storage-vnext-fault-injection-matrix.mjs";

const runId = requiredEnv("FOCOWIKI_INTERLEAVED_RUN_ID");
const reportPath = path.resolve(
  "ReferenceDocs",
  "validate-interleaved-lifecycle-e2e",
  "runs",
  runId,
  "fault-injection-results.json"
);
const coverage = assertStorageVnextFaultInjectionCoverage(FAULT_INJECTION_CASES);
const suites = buildFaultInjectionSuites(FAULT_INJECTION_CASES);
const report = {
  kind: "focowiki-storage-vnext-fault-injection",
  runId,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  ok: false,
  coverage,
  cases: FAULT_INJECTION_CASES,
  suites: []
};

for (const suite of suites) {
  if (suite.requiresOwnedDatabase) assertOwnedDatabaseEnvironment();
  const startedAt = Date.now();
  const result = await runSuite(suite);
  report.suites.push({
    id: suite.id,
    files: suite.files,
    outcome: result.code === 0 ? "passed" : "failed",
    exitCode: result.code,
    signal: result.signal,
    durationMs: Date.now() - startedAt
  });
}

report.finishedAt = new Date().toISOString();
report.ok = report.suites.every((suite) => suite.outcome === "passed");
writeJson(reportPath, report);
process.stdout.write(`${JSON.stringify({
  runId,
  caseCount: coverage.caseCount,
  suites: report.suites.map(({ id, outcome, exitCode, durationMs }) => ({
    id,
    outcome,
    exitCode,
    durationMs
  })),
  ok: report.ok
}, null, 2)}\n`);
if (!report.ok) process.exitCode = 1;

function runSuite(suite) {
  const packageRoot = suite.packageName === "@focowiki/api"
    ? "apps/api/"
    : "packages/okf/";
  const files = suite.files.map((file) => {
    if (!file.startsWith(packageRoot)) {
      throw new Error(`Fault suite file is outside ${packageRoot}: ${file}`);
    }
    return file.slice(packageRoot.length);
  });
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", [
      "--filter",
      suite.packageName,
      "exec",
      "vitest",
      "run",
      ...files,
      "--reporter=verbose"
    ], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit"
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({
      code: code ?? 1,
      signal: signal ?? null
    }));
  });
}

function assertOwnedDatabaseEnvironment() {
  requiredEnv("FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL");
  const owner = requiredEnv("FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER");
  if (!/^svnext-[a-z0-9]{8,16}$/u.test(owner)) {
    throw new Error("FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER is invalid.");
  }
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600
  });
}

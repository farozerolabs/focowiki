#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  summarizeStorageVnextFlowHandleEvidence
} from "./lib/storage-vnext-scale-resource-evidence.mjs";

const proofPath = path.resolve(requiredEnv("FOCOWIKI_STORAGE_VNEXT_PROOF_FILE"));
const proof = JSON.parse(fs.readFileSync(proofPath, "utf8"))?.proof;
if (
  !proof
  || path.dirname(proofPath) !== proof.filesystemScope
  || path.basename(proof.filesystemScope) !== proof.runId
) throw new Error("Runtime flow evidence scope is invalid");

const result = await runVitest();
const marker = result.stdout.match(/STORAGE_VNEXT_RUNTIME_FLOW_EVIDENCE (\[[^\n]+\])/u);
if (!marker) {
  process.stderr.write(result.stderr);
  throw new Error("Runtime flow evidence marker is missing");
}
const reports = JSON.parse(marker[1]);
const summary = summarizeStorageVnextFlowHandleEvidence(reports);
const report = {
  kind: "focowiki-storage-vnext-runtime-flow-evidence",
  version: 1,
  runId: proof.runId,
  capturedAt: new Date().toISOString(),
  command: "vitest storage-vnext-runtime-flow-observer.integration.test.ts",
  summary,
  reports
};
const reportPath = path.join(proof.filesystemScope, "scale-runtime-flow.json");
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({
  status: "complete",
  summary,
  reportPath
}, null, 2)}\n`);

function runVitest() {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", [
      "--filter",
      "@focowiki/api",
      "exec",
      "vitest",
      "run",
      "test/storage-vnext-runtime-flow-observer.integration.test.ts",
      "--reporter=verbose"
    ], { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 4 * 1024 * 1024) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 4 * 1024 * 1024) child.kill("SIGTERM");
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal) return reject(new Error(`Runtime flow test ended with ${signal}`));
      if (code !== 0) {
        process.stderr.write(stderr);
        return reject(new Error(`Runtime flow test failed with exit code ${code}`));
      }
      resolve({ stdout, stderr });
    });
  });
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

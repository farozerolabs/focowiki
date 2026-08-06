#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";
import {
  createRuntimeServiceSupervisor,
  RUNTIME_SERVICE_ORDER
} from "./lib/interleaved-runtime-services.mjs";
import {
  createStorageVnextScaleRuntimeEnvironment
} from "./lib/storage-vnext-scale-scope.mjs";

loadLocalEnv();
const proofPath = path.resolve(requiredEnvironment("FOCOWIKI_STORAGE_VNEXT_PROOF_FILE"));
const manifest = JSON.parse(fs.readFileSync(proofPath, "utf8"));
const proof = manifest?.proof;
const runtimeEnvironment = createStorageVnextScaleRuntimeEnvironment({
  proof,
  env: process.env
});
const supervisor = createRuntimeServiceSupervisor({
  runtimeRoot: path.resolve("apps/api/runtime"),
  evidenceDir: path.join(proof.filesystemScope, "runtime"),
  cwd: process.cwd(),
  env: runtimeEnvironment
});
let stopping = false;

try {
  await supervisor.startAll();
  await waitForHealth(
    `http://127.0.0.1:${runtimeEnvironment.ADMIN_API_PORT || "43000"}/healthz`,
    60_000
  );
  for (const serviceName of RUNTIME_SERVICE_ORDER) supervisor.assertRunning(serviceName);
  process.stdout.write(`${JSON.stringify({
    runId: proof.runId,
    services: supervisor.listRunning(),
    state: "ready"
  })}\n`);
  await waitForShutdown();
} finally {
  await stop();
}

function loadLocalEnv() {
  const envPath = process.env.ENV_FILE || ".env";
  if (fs.existsSync(envPath)) loadEnvFile(envPath);
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // Startup remains bounded by timeoutMs.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Scale validation API did not become healthy");
}

function waitForShutdown() {
  return new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}

async function stop() {
  if (stopping) return;
  stopping = true;
  await supervisor.stopAll();
}

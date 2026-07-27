import fs from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";
import {
  createRuntimeServiceSupervisor,
  RUNTIME_SERVICE_ORDER
} from "./lib/interleaved-runtime-services.mjs";

loadLocalEnv();

const runId = requiredEnv("FOCOWIKI_INTERLEAVED_RUN_ID");
const evidenceDir = path.resolve(
  "ReferenceDocs",
  "validate-interleaved-lifecycle-e2e",
  "runs",
  runId,
  "runtime"
);
const supervisor = createRuntimeServiceSupervisor({
  runtimeRoot: path.resolve("apps/api/runtime"),
  evidenceDir,
  cwd: process.cwd(),
  env: process.env
});
let stopping = false;

try {
  await supervisor.startAll();
  await waitForHealth(
    `http://127.0.0.1:${process.env.ADMIN_API_PORT || "43000"}/healthz`,
    30_000
  );
  for (const serviceName of RUNTIME_SERVICE_ORDER) {
    supervisor.assertRunning(serviceName);
  }
  process.stdout.write(
    `${JSON.stringify({
      runId,
      services: supervisor.listRunning(),
      state: "ready"
    })}\n`
  );
  await waitForShutdown();
} finally {
  await stop();
}

function loadLocalEnv() {
  const envPath = process.env.ENV_FILE || ".env";
  if (fs.existsSync(envPath)) loadEnvFile(envPath);
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
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

async function waitForHealth(url, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(1_000)
      });
      if (response.ok) return;
    } catch {
      // Startup polling remains bounded by timeoutMs.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Interleaved validation API did not become healthy.");
}

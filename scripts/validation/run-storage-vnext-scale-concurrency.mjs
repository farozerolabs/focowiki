#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { loadEnvFile } from "node:process";
import {
  createLifecycleHttpClient
} from "./lib/interleaved-lifecycle-api.mjs";
import {
  createRateLimitedFetch
} from "./lib/storage-vnext-rate-limited-fetch.mjs";
import {
  summarizeStorageVnextScaleConcurrencyEvidence
} from "./lib/storage-vnext-scale-concurrency-evidence.mjs";
import {
  createStorageVnextScaleRuntimeEnvironment
} from "./lib/storage-vnext-scale-scope.mjs";

const MINIMUM_POLL_SAMPLES = 10;
const POLL_INTERVAL_MS = 1_000;

loadLocalEnv();
const proofManifest = readJson(path.resolve(requiredEnvironment(
  "FOCOWIKI_STORAGE_VNEXT_PROOF_FILE"
)));
const proof = proofManifest?.proof;
const runtimeEnvironment = createStorageVnextScaleRuntimeEnvironment({
  proof,
  env: process.env
});
Object.assign(process.env, runtimeEnvironment);
const rebuild = readJson(path.join(proof.filesystemScope, "scale-rebuild.json"));
assertRebuildEvidence(rebuild);
const interleavedRunId = requiredEnvironment("FOCOWIKI_INTERLEAVED_RUN_ID");
const scenarioId = requiredEnvironment("FOCOWIKI_INTERLEAVED_SCENARIO_ID");
const interleavedEvidenceDir = path.resolve(
  "ReferenceDocs",
  "validate-interleaved-lifecycle-e2e",
  "runs",
  interleavedRunId
);
const statePath = path.join(interleavedEvidenceDir, "run-state.json");
assertPreparedInterleavedState(readJson(statePath));
const reportPath = path.join(proof.filesystemScope, "scale-concurrency.json");
const retryingFetch = createRateLimitedFetch({ maximumRetries: 240 });
const origin = requiredEnvironment("ADMIN_PUBLIC_ORIGIN");
const admin = createLifecycleHttpClient({
  baseUrl: `http://127.0.0.1:${runtimeEnvironment.ADMIN_API_PORT || "43000"}`,
  fetchImpl: retryingFetch
});
const developer = createLifecycleHttpClient({
  baseUrl: `http://127.0.0.1:${runtimeEnvironment.PUBLIC_OPENAPI_PORT || "43200"}`,
  fetchImpl: retryingFetch
});
const report = {
  kind: "focowiki-storage-vnext-scale-concurrency",
  version: 1,
  runId: proof.runId,
  knowledgeBaseId: rebuild.knowledgeBaseId,
  interleavedRunId,
  scenarioId,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  samples: [],
  scenario: null,
  summary: null,
  failure: null
};

let credentialId = null;
let adminLoggedIn = false;
try {
  await loginAdmin();
  adminLoggedIn = true;
  const credential = await createCredential();
  credentialId = credential.id;
  developer.authorization = `Bearer ${credential.rawKey}`;
  const runtimeSettings = await admin.json("/admin/api/settings/runtime");
  report.runtimeSettingsRevision = runtimeSettings.revision
    ?? runtimeSettings.settingsRevision
    ?? null;

  let childFinished = false;
  const childPromise = runInterleavedScenario().then((result) => {
    childFinished = true;
    return result;
  }, (error) => {
    childFinished = true;
    throw error;
  });

  while (!childFinished || !hasMinimumSamples()) {
    const batch = await Promise.all([
      timedPoll("public-read", pollPublicRead),
      timedPoll("admin-poll", pollAdmin),
      timedPoll("openapi-poll", pollOpenApi)
    ]);
    report.samples.push(...batch);
    writeReport();
    await sleep(POLL_INTERVAL_MS);
  }
  const child = await childPromise;
  const terminalBatch = await Promise.all([
    timedPoll("public-read", pollPublicRead),
    timedPoll("admin-poll", pollAdmin),
    timedPoll("openapi-poll", pollOpenApi)
  ]);
  report.samples.push(...terminalBatch);
  writeReport();
  const scenarioResult = readScenarioResult();
  const scenarioState = readScenarioState();
  report.scenario = { ...scenarioResult, ...scenarioState };
  report.summary = summarizeStorageVnextScaleConcurrencyEvidence({
    childExitCode: child.exitCode,
    scenario: report.scenario,
    samples: report.samples
  });
  report.finishedAt = new Date().toISOString();
  writeReport();
  process.stdout.write(`${JSON.stringify({
    status: "complete",
    runId: proof.runId,
    scenarioId,
    scenarioOutcome: report.summary.scenarioOutcome,
    requestCount: report.summary.requestCount,
    failedRequestCount: report.summary.failedRequestCount,
    surfaces: report.summary.surfaces,
    reportPath
  }, null, 2)}\n`);
} catch (error) {
  report.failure = {
    name: error instanceof Error ? error.name : "Error",
    message: String(error instanceof Error ? error.message : error).slice(0, 2_000)
  };
  report.finishedAt = new Date().toISOString();
  writeReport();
  throw error;
} finally {
  if (credentialId && adminLoggedIn) {
    await admin.request(`/admin/api/openapi-keys/${encodeURIComponent(credentialId)}`, {
      method: "DELETE",
      headers: { origin },
      expectedStatus: 204
    }).catch(() => undefined);
  }
  if (adminLoggedIn) {
    await admin.request("/admin/api/logout", {
      method: "POST",
      headers: { origin }
    }).catch(() => undefined);
  }
}

async function loginAdmin() {
  await admin.json("/admin/api/login", {
    method: "POST",
    headers: { origin },
    json: {
      username: requiredEnvironment("ADMIN_USERNAME"),
      password: requiredEnvironment("ADMIN_PASSWORD")
    }
  });
}

async function createCredential() {
  const response = await admin.json("/admin/api/openapi-keys", {
    method: "POST",
    headers: { origin },
    json: { name: `storage-vnext-scale-concurrency-${proof.runId}` },
    expectedStatus: 201
  });
  if (!response.key?.id || !response.oneTimeKey?.rawKey) {
    throw new Error("Scale concurrency credential was not returned");
  }
  return { id: response.key.id, rawKey: response.oneTimeKey.rawKey };
}

function runInterleavedScenario() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "scripts/validation/run-interleaved-lifecycle-e2e.mjs"
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        FOCOWIKI_INTERLEAVED_RUN_ID: interleavedRunId,
        FOCOWIKI_INTERLEAVED_SCENARIO_IDS: scenarioId,
        FOCOWIKI_INTERLEAVED_SCENARIO_LIMIT: "1",
        FOCOWIKI_INTERLEAVED_SCENARIO_DEADLINE_MS: "900000",
        FOCOWIKI_VALIDATION_MARKDOWN_DIR: requiredEnvironment(
          "FOCOWIKI_VALIDATION_MARKDOWN_DIR"
        )
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      if (signal) {
        reject(new Error(`Interleaved lifecycle process ended with signal ${signal}`));
        return;
      }
      resolve({ exitCode });
    });
  });
}

async function timedPoll(surface, poll) {
  const startedAt = new Date();
  const started = performance.now();
  try {
    const ok = await poll();
    return {
      surface,
      ok,
      durationMs: round(performance.now() - started),
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString()
    };
  } catch {
    return {
      surface,
      ok: false,
      durationMs: round(performance.now() - started),
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString()
    };
  }
}

async function pollPublicRead() {
  const response = await developer.json(openApiPath(
    "/files/search?query=%E5%AE%AA%E6%B3%95&mode=hybrid&limit=10"
  ));
  return response.searchStatus === "ok" && response.items?.length > 0;
}

async function pollAdmin() {
  const response = await admin.json("/admin/api/knowledge-bases?limit=20");
  return Array.isArray(response.items)
    && response.items.some((item) => item.id === rebuild.knowledgeBaseId);
}

async function pollOpenApi() {
  const response = await developer.json(
    `/openapi/v2/knowledge-bases/${encodeURIComponent(rebuild.knowledgeBaseId)}`
  );
  return response.knowledgeBase?.knowledgeBaseId === rebuild.knowledgeBaseId;
}

function hasMinimumSamples() {
  return ["public-read", "admin-poll", "openapi-poll"].every((surface) => (
    report.samples.filter((sample) => sample.surface === surface).length
      >= MINIMUM_POLL_SAMPLES
  ));
}

function readScenarioResult() {
  const results = readJson(path.join(interleavedEvidenceDir, "interleaved-results.json"));
  const scenario = results.scenarios?.find((item) => item.scenarioId === scenarioId);
  if (!scenario) throw new Error("Interleaved lifecycle result is missing");
  return scenario;
}

function readScenarioState() {
  const state = readJson(statePath);
  const scenario = state.scenarios?.find((item) => item.scenarioId === scenarioId);
  if (!scenario) throw new Error("Interleaved lifecycle state is missing");
  return {
    startedAt: scenario.startedAt,
    completedAt: scenario.completedAt,
    errorCode: scenario.errorCode
  };
}

function assertPreparedInterleavedState(state) {
  if (
    state?.runId !== interleavedRunId
    || state.baseline?.repositoryChecksPassed !== true
    || state.scenarios?.some((scenario) => (
      scenario.scenarioId === scenarioId && scenario.completedAt
    ))
  ) throw new Error("A prepared unused interleaved scenario is required");
}

function assertRebuildEvidence(value) {
  if (
    value?.kind !== "focowiki-storage-vnext-scale-rebuild"
    || value.runId !== proof.runId
    || value.corpus?.fileCount !== 10_000
    || value.failure !== null
    || value.convergence?.readySources !== 10_000
  ) throw new Error("Completed 10,000-file rebuild evidence is required");
}

function openApiPath(suffix) {
  return `/openapi/v2/knowledge-bases/${encodeURIComponent(rebuild.knowledgeBaseId)}${suffix}`;
}

function writeReport() {
  const temporary = `${reportPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, reportPath);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for scale concurrency`);
  return value;
}

function loadLocalEnv() {
  const envPath = process.env.ENV_FILE || ".env";
  if (fs.existsSync(envPath)) loadEnvFile(envPath);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function round(value) {
  return Math.round(value * 1_000) / 1_000;
}

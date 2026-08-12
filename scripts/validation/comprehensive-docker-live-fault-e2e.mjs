#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  createLifecycleHttpClient,
  createPublicLifecycleBarriers,
  createUploadSessionPhaseClient
} from "./lib/interleaved-lifecycle-api.mjs";
import { createInterleavedPostgresEvidence } from
  "./lib/interleaved-postgres-evidence.mjs";
import {
  selectLiveFaultInjectionCases
} from "./lib/storage-vnext-fault-injection-matrix.mjs";
import {
  buildDockerLiveFaultServiceStartArguments
} from "./lib/comprehensive-docker-live-fault-runtime.mjs";

const runId = requiredEnv("FOCOWIKI_COMPREHENSIVE_RUN_ID");
const composeProject = requiredComposeProject();
const composeEnvFile = path.resolve(
  requiredEnv("FOCOWIKI_COMPREHENSIVE_COMPOSE_ENV_FILE")
);
const composeFiles = requiredEnv("FOCOWIKI_COMPREHENSIVE_COMPOSE_FILES")
  .split(",")
  .map((value) => path.resolve(value.trim()))
  .filter(Boolean);
const provider = requiredEnv("SEARCH_PROVIDER");
const liveCases = selectLiveFaultInjectionCases(provider);
const reportPath = path.resolve(
  requiredEnv("FOCOWIKI_COMPREHENSIVE_LIVE_FAULT_REPORT")
);
const adminOrigin = requiredEnv("ADMIN_PUBLIC_ORIGIN");
const adminPort = requiredPort("ADMIN_API_PORT", 43_000);
const publicPort = requiredPort("PUBLIC_OPENAPI_PORT", 43_200);
const redisPort = requiredPort("FOCOWIKI_COMPREHENSIVE_REDIS_PORT", 56_379);
const minioPort = requiredPort("FOCOWIKI_COMPREHENSIVE_S3_PORT", 59_000);
const opensearchPort = requiredPort("OPENSEARCH_PORT", 59_200);

validateInputs();

const admin = createLifecycleHttpClient({
  baseUrl: `http://127.0.0.1:${adminPort}`
});
const developer = createLifecycleHttpClient({
  baseUrl: `http://127.0.0.1:${publicPort}`
});
const postgresEvidence = createInterleavedPostgresEvidence({
  databaseUrl: requiredEnv("FOCOWIKI_COMPREHENSIVE_DATABASE_URL")
});
const stoppedServices = new Set();
const results = [];
const report = {
  format: "focowiki-comprehensive-docker-live-fault-v1",
  runId,
  composeProject,
  provider,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  ok: false,
  cases: liveCases,
  results,
  failure: null
};
let knowledgeBaseId = null;
let keyId = null;

try {
  await waitForHttp(`http://127.0.0.1:${adminPort}/healthz`);
  await login();
  const credential = await admin.json("/admin/api/openapi-keys", {
    method: "POST",
    headers: { origin: adminOrigin },
    json: { name: `comprehensive-live-fault-${runId}` },
    expectedStatus: 201
  });
  keyId = credential.key.id;
  developer.authorization = `Bearer ${credential.oneTimeKey.rawKey}`;

  const created = await developer.json("/openapi/v2/knowledge-bases", {
    method: "POST",
    headers: { "idempotency-key": `${runId}-docker-live-fault-kb` },
    json: {
      name: `Docker live fault validation ${runId}`,
      description: "Run-owned dependency and worker recovery validation"
    },
    expectedStatus: 201
  });
  knowledgeBaseId = created.knowledgeBase.knowledgeBaseId;

  const mainBytes = Buffer.from([
    "---",
    "title: Durable recovery fixture",
    "type: reference",
    "---",
    "",
    "# Durable recovery fixture",
    "",
    "A compact general-purpose page validates durable recovery after service interruption.",
    ""
  ].join("\n"));
  const upload = createUploadSessionPhaseClient({
    client: developer,
    knowledgeBaseId,
    idempotencyPrefix: `${runId}-docker-live-fault-main`
  });
  const mainCreated = await upload.create([{
    relativePath: "recovery/durable-recovery.md",
    bytes: mainBytes
  }]);
  const mainSessionId = mainCreated.session.id;
  await upload.appendManifest(mainSessionId);

  await stopService("api");
  await waitForHttpUnavailable(`http://127.0.0.1:${adminPort}/healthz`);
  await startService("api");
  await waitForHttp(`http://127.0.0.1:${adminPort}/healthz`);
  await login();
  await upload.seal(mainSessionId);
  record("live-api-restart-pre-write", {
    recoveredSessionId: mainSessionId
  });

  await stopService("redis");
  await waitForTcpUnavailable(redisPort);
  const redisFallback = await developer.json(
    `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`
  );
  assert(
    redisFallback.knowledgeBase?.knowledgeBaseId === knowledgeBaseId,
    "The public read did not preserve ownership while Redis was unavailable."
  );
  record("live-redis-refusal-post-write", { publicReadStatus: 200 });
  await startService("redis");
  await waitForTcp(redisPort);

  const s3Bytes = Buffer.from([
    "# S3 refusal fixture",
    "",
    "This body must not become partial state when object storage is unavailable.",
    ""
  ].join("\n"));
  const s3Upload = createUploadSessionPhaseClient({
    client: developer,
    knowledgeBaseId,
    idempotencyPrefix: `${runId}-docker-live-fault-s3`
  });
  const s3Created = await s3Upload.create([{
    relativePath: "recovery/s3-refusal.md",
    bytes: s3Bytes
  }]);
  const s3SessionId = s3Created.session.id;
  await s3Upload.appendManifest(s3SessionId);
  await s3Upload.seal(s3SessionId);
  const s3Missing = await reconcileReservations(s3Upload, s3SessionId);
  const s3Entry = s3Missing.entries?.items?.[0];
  assert(s3Entry?.id, "The S3 refusal fixture returned no upload entry.");

  await stopService("minio");
  await waitForHttpUnavailable(
    `http://127.0.0.1:${minioPort}/minio/health/live`
  );
  const s3Failure = await developer.request(
    `/openapi/v2/knowledge-bases/${encodeURIComponent(
      knowledgeBaseId
    )}/upload-sessions/${encodeURIComponent(
      s3SessionId
    )}/entries/${encodeURIComponent(s3Entry.id)}/content`,
    {
      method: "PUT",
      headers: { "content-type": "text/markdown; charset=utf-8" },
      rawBody: s3Bytes
    }
  );
  const s3FailureBody = await s3Failure.text();
  assert(
    !s3Failure.ok && s3Failure.status >= 500,
    `S3 refusal returned HTTP ${s3Failure.status}.`
  );
  assert(
    !/(secret|access.?key|stack|postgres:\/\/)/iu.test(s3FailureBody),
    "S3 refusal exposed internal or credential-shaped response content."
  );
  record("live-s3-refusal-pre-write", { publicStatus: s3Failure.status });
  await startService("minio");
  await waitForHttp(`http://127.0.0.1:${minioPort}/minio/health/live`);
  await s3Upload.cancel(s3SessionId).catch(() => undefined);

  const mainSealed = await reconcileReservations(upload, mainSessionId);
  const mainEntry = mainSealed.entries?.items?.[0];
  assert(mainEntry?.sourceFileId, "The recovery upload returned no source-file ID.");
  await upload.uploadMissingContent(mainSessionId, mainSealed.entries?.items ?? []);

  await stopService("source-worker");
  await stopService(provider);
  await waitForHttpUnavailable(
    `http://127.0.0.1:${opensearchPort}/_cluster/health`
  );
  await upload.finalize(mainSessionId);
  const barriers = createPublicLifecycleBarriers({
    admin,
    developer,
    knowledgeBaseId,
    timeoutMs: 10 * 60_000,
    pollIntervalMs: 500
  });
  await barriers.upload(upload, mainSessionId, ["completed"]);
  await waitForWorkItem((item) =>
    item.workKind === "source" && item.state === "queued"
  );

  await startService("source-worker");
  const semanticRetry = await waitForSemanticStage((item) =>
    item.stageKind === "vector"
      && item.state === "retry"
      && typeof item.safeErrorCode === "string"
      && item.safeErrorCode.length > 0
  );
  record("live-worker-restart-post-write", {
    durableWorkRecovered: true,
    semanticAttemptCount: semanticRetry.attemptCount
  });
  record("live-opensearch-refusal-pre-activation", {
    stageKind: semanticRetry.stageKind,
    safeErrorCode: semanticRetry.safeErrorCode
  });

  await startService(provider);
  await waitForHttp(
    `http://127.0.0.1:${opensearchPort}/_cluster/health`,
    120_000
  );
  await barriers.sourceFile(mainEntry.sourceFileId, ["visible"]);

  assertLiveCoverage();
  report.ok = true;
} catch (error) {
  report.failure = {
    code: typeof error?.code === "string"
      ? error.code
      : "COMPREHENSIVE_DOCKER_LIVE_FAULT_FAILED",
    message: error instanceof Error
      ? error.message.slice(0, 500)
      : String(error).slice(0, 500)
  };
  throw error;
} finally {
  await restoreServices();
  await waitForHttp(`http://127.0.0.1:${adminPort}/healthz`).catch(() => undefined);
  await login().catch(() => undefined);
  if (knowledgeBaseId) {
    await admin.request(
      `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`,
      { method: "DELETE", headers: { origin: adminOrigin } }
    ).catch(() => undefined);
    await waitForNoLiveWork(knowledgeBaseId).catch(() => undefined);
  }
  if (keyId) {
    await admin.request(`/admin/api/openapi-keys/${encodeURIComponent(keyId)}`, {
      method: "DELETE",
      headers: { origin: adminOrigin }
    }).catch(() => undefined);
  }
  await admin.request("/admin/api/logout", {
    method: "POST",
    headers: { origin: adminOrigin }
  }).catch(() => undefined);
  await postgresEvidence.close().catch(() => undefined);
  report.finishedAt = new Date().toISOString();
  writeJson(reportPath, report);
  process.stdout.write(`${JSON.stringify({
    runId,
    provider,
    passed: results.length,
    expected: liveCases.length,
    ok: report.ok,
    failure: report.failure
  }, null, 2)}\n`);
}

async function login() {
  await admin.json("/admin/api/login", {
    method: "POST",
    headers: { origin: adminOrigin },
    json: {
      username: requiredEnv("ADMIN_USERNAME"),
      password: requiredEnv("ADMIN_PASSWORD")
    }
  });
}

async function reconcileReservations(upload, sessionId) {
  let snapshot = await upload.get(sessionId, {
    transferState: "missing",
    limit: 10
  });
  for (
    let attempt = 0;
    Number(snapshot.session?.counts?.waitingReservation ?? 0) > 0
      && attempt < 8;
    attempt += 1
  ) {
    snapshot = await upload.reconcile(sessionId);
  }
  assert(
    Number(snapshot.session?.counts?.waitingReservation ?? 0) === 0,
    "The upload retained path reservations."
  );
  return upload.get(sessionId, { transferState: "missing", limit: 10 });
}

async function waitForWorkItem(predicate, timeoutMs = 10 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await postgresEvidence.snapshotKnowledgeBase(knowledgeBaseId);
    const item = snapshot.workItems.find(predicate);
    if (item) return item;
    await delay(500);
  }
  throw new Error("Durable work did not reach the expected fault barrier.");
}

async function waitForSemanticStage(predicate, timeoutMs = 10 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await postgresEvidence.snapshotKnowledgeBase(knowledgeBaseId);
    const item = snapshot.semanticStages.find(predicate);
    if (item) return item;
    await delay(500);
  }
  throw new Error("Semantic work did not reach the expected provider fault barrier.");
}

async function waitForNoLiveWork(targetKnowledgeBaseId, timeoutMs = 5 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await postgresEvidence.hasLiveWorkItems(targetKnowledgeBaseId))) return;
    await delay(500);
  }
  throw new Error("Run-owned durable work did not settle during cleanup.");
}

async function stopService(service) {
  await runCommand("docker", composeArguments("stop", service));
  stoppedServices.add(service);
}

async function startService(service) {
  await runCommand(
    "docker",
    composeArguments(...buildDockerLiveFaultServiceStartArguments(service))
  );
  stoppedServices.delete(service);
}

async function restoreServices() {
  const ordered = [provider, "minio", "redis", "api", "source-worker"];
  for (const service of ordered) {
    if (stoppedServices.has(service)) {
      await startService(service).catch(() => undefined);
    }
  }
}

function composeArguments(...command) {
  const args = [
    "compose",
    "--env-file",
    composeEnvFile,
    "-p",
    composeProject
  ];
  for (const file of composeFiles) args.push("-f", file);
  args.push("--profile", provider, ...command);
  return args;
}

function record(id, details) {
  const expected = liveCases.find((item) => item.id === id);
  assert(expected, `Unknown live fault case: ${id}.`);
  assert(
    !results.some((item) => item.id === id),
    `Duplicate live fault result: ${id}.`
  );
  results.push({ ...expected, outcome: "passed", details });
}

function assertLiveCoverage() {
  const missing = liveCases
    .map((item) => item.id)
    .filter((id) => !results.some((result) => result.id === id));
  assert(missing.length === 0, `Missing live fault results: ${missing.join(", ")}.`);
}

function validateInputs() {
  assert(
    /^validation-[0-9]{14}-[a-z0-9]{8}$/u.test(runId),
    "The comprehensive run ID is invalid."
  );
  assert(
    composeFiles.length >= 1 && composeFiles.every((file) => fs.existsSync(file)),
    "The comprehensive Compose files are invalid."
  );
  assert(fs.existsSync(composeEnvFile), "The comprehensive env file is absent.");
  assert(provider === "opensearch", "This live Docker executor requires OpenSearch.");
  const normalizedReport = reportPath.split(path.sep).join("/");
  assert(
    normalizedReport.includes(
      `/ReferenceDocs/validation/comprehensive-large-scale-release/${runId}/`
    ),
    "The live fault report must stay inside the ignored run directory."
  );
}

function requiredComposeProject() {
  const value = requiredEnv("FOCOWIKI_COMPREHENSIVE_COMPOSE_PROJECT");
  if (!/^focowiki-clr-[a-z0-9-]+$/u.test(value)) {
    throw new Error("The Docker project is not validation-owned.");
  }
  return value;
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SEARCH_PROVIDER: provider,
        COMPOSE_PROFILES: provider
      },
      stdio: "inherit"
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code ?? signal}.`));
    });
  });
}

async function waitForHttp(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // Only the terminal health outcome is retained.
    }
    await delay(250);
  }
  throw new Error(`Local service did not become healthy: ${new URL(url).pathname}.`);
}

async function waitForHttpUnavailable(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(500) });
    } catch {
      return;
    }
    await delay(100);
  }
  throw new Error(`Local service did not stop: ${new URL(url).pathname}.`);
}

async function waitForTcp(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeTcp(port)) return;
    await delay(250);
  }
  throw new Error(`Local TCP service did not become healthy on port ${port}.`);
}

async function waitForTcpUnavailable(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await probeTcp(port))) return;
    await delay(100);
  }
  throw new Error(`Local TCP service did not stop on port ${port}.`);
}

function probeTcp(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const settle = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(500);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

function requiredPort(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be a valid port.`);
  }
  return value;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600
  });
}

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { loadEnvFile } from "node:process";
import {
  createLifecycleHttpClient,
  createPublicLifecycleBarriers,
  createUploadSessionPhaseClient
} from "./lib/interleaved-lifecycle-api.mjs";
import {
  createInterleavedPostgresEvidence
} from "./lib/interleaved-postgres-evidence.mjs";
import {
  createRuntimeServiceSupervisor,
  RUNTIME_SERVICE_ORDER
} from "./lib/interleaved-runtime-services.mjs";
import {
  LIVE_FAULT_INJECTION_CASES
} from "./lib/storage-vnext-fault-injection-matrix.mjs";

loadLocalEnv();

const runId = requiredEnv("FOCOWIKI_INTERLEAVED_RUN_ID");
const adminPort = requiredPort("ADMIN_API_PORT", 43_000);
const publicPort = requiredPort("PUBLIC_OPENAPI_PORT", 43_200);
const redisPort = requiredPort("FOCOWIKI_LOCAL_REDIS_PORT", 56_379);
const minioPort = requiredPort("FOCOWIKI_LOCAL_MINIO_PORT", 43_300);
const meilisearchPort = requiredPort("FOCOWIKI_LOCAL_MEILISEARCH_PORT", 57_700);
const adminOrigin = process.env.ADMIN_PUBLIC_ORIGIN || "http://127.0.0.1:43100";
const composeProject = requiredComposeProject();
const composeFile = path.resolve(
  process.env.FOCOWIKI_LOCAL_COMPOSE_FILE || "docker-compose.local.yml"
);
const composeEnvFile = path.resolve(
  process.env.FOCOWIKI_LOCAL_COMPOSE_ENV_FILE || ".env.dev.example"
);
const evidenceDir = path.resolve(
  "ReferenceDocs",
  "validate-interleaved-lifecycle-e2e",
  "runs",
  runId,
  "runtime-faults"
);
const reportPath = path.resolve(
  "ReferenceDocs",
  "validate-interleaved-lifecycle-e2e",
  "runs",
  runId,
  "fault-injection-live-results.json"
);
const supervisor = createRuntimeServiceSupervisor({
  runtimeRoot: path.resolve("apps/api/runtime"),
  evidenceDir,
  cwd: process.cwd(),
  env: process.env
});
const postgresEvidence = createInterleavedPostgresEvidence({
  databaseUrl: requiredEnv("DATABASE_URL")
});
const admin = createLifecycleHttpClient({
  baseUrl: `http://127.0.0.1:${adminPort}`
});
const developer = createLifecycleHttpClient({
  baseUrl: `http://127.0.0.1:${publicPort}`
});
const stoppedDependencies = new Set();
const results = [];
const report = {
  kind: "focowiki-storage-vnext-live-fault-injection",
  runId,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  ok: false,
  cases: LIVE_FAULT_INJECTION_CASES,
  results,
  failure: null
};
let keyId = null;
let knowledgeBaseId = null;

try {
  await supervisor.startAll();
  await waitForHttp(`http://127.0.0.1:${adminPort}/healthz`);
  await login();
  const credential = await admin.json("/admin/api/openapi-keys", {
    method: "POST",
    headers: { origin: adminOrigin },
    json: { name: `runtime-fault-${runId}` },
    expectedStatus: 201
  });
  keyId = credential.key.id;
  developer.authorization = `Bearer ${credential.oneTimeKey.rawKey}`;
  const created = await developer.json("/openapi/v2/knowledge-bases", {
    method: "POST",
    headers: { "idempotency-key": `${runId}-runtime-fault-kb` },
    json: {
      name: `Runtime fault validation ${runId}`,
      description: "Run-owned local dependency and process recovery validation"
    },
    expectedStatus: 201
  });
  knowledgeBaseId = created.knowledgeBase.knowledgeBaseId;

  const mainBytes = Buffer.from([
    "---",
    "title: Runtime recovery fixture",
    "type: reference",
    "---",
    "",
    "# Runtime recovery fixture",
    "",
    "This run-owned page validates durable recovery across local service restarts.",
    ""
  ].join("\n"));
  const upload = createUploadSessionPhaseClient({
    client: developer,
    knowledgeBaseId,
    idempotencyPrefix: `${runId}-runtime-fault-main`
  });
  const mainCreated = await upload.create([{
    relativePath: "runtime/recovery.md",
    bytes: mainBytes
  }]);
  const mainSessionId = mainCreated.session.id;
  await upload.appendManifest(mainSessionId);

  await supervisor.stop("api");
  await waitForHttpUnavailable(`http://127.0.0.1:${adminPort}/healthz`);
  await supervisor.start("api");
  await waitForHttp(`http://127.0.0.1:${adminPort}/healthz`);
  await login();
  await upload.seal(mainSessionId);
  record("live-api-restart-pre-write", {
    recoveredSessionId: mainSessionId
  });

  await stopDependency("redis");
  const redisFallback = await developer.json(
    `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`
  );
  assert(
    redisFallback.knowledgeBase?.knowledgeBaseId === knowledgeBaseId,
    "API did not preserve the run-owned read while Redis was unavailable."
  );
  record("live-redis-refusal-post-write", { publicReadStatus: 200 });
  await startDependency("redis");

  const s3Bytes = Buffer.from("# S3 refusal fixture\n\nThis body must not become partial state.\n");
  const s3Upload = createUploadSessionPhaseClient({
    client: developer,
    knowledgeBaseId,
    idempotencyPrefix: `${runId}-runtime-fault-s3`
  });
  const s3Created = await s3Upload.create([{
    relativePath: "runtime/s3-refusal.md",
    bytes: s3Bytes
  }]);
  const s3SessionId = s3Created.session.id;
  await s3Upload.appendManifest(s3SessionId);
  await s3Upload.seal(s3SessionId);
  const s3Missing = await s3Upload.get(s3SessionId, {
    transferState: "missing",
    limit: 10
  });
  const s3Entry = s3Missing.entries?.items?.[0];
  assert(s3Entry?.id, "S3 refusal fixture returned no upload entry.");
  await stopDependency("minio");
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
  assert(
    !s3Failure.ok && s3Failure.status >= 500,
    `S3 refusal returned HTTP ${s3Failure.status}.`
  );
  await s3Failure.text();
  record("live-s3-refusal-pre-write", { publicStatus: s3Failure.status });
  await startDependency("minio");
  await developer.request(
    `/openapi/v2/knowledge-bases/${encodeURIComponent(
      knowledgeBaseId
    )}/upload-sessions/${encodeURIComponent(s3SessionId)}`,
    { method: "DELETE" }
  ).catch(() => undefined);

  let mainSealed = await upload.get(mainSessionId, {
    transferState: "missing",
    limit: 10
  });
  for (
    let attempt = 0;
    mainSealed.session?.counts?.waitingReservation > 0 && attempt < 5;
    attempt += 1
  ) {
    mainSealed = await upload.reconcile(mainSessionId);
  }
  assert(
    !mainSealed.session?.counts?.waitingReservation,
    "Runtime recovery upload retained path reservations."
  );
  const mainEntry = mainSealed.entries?.items?.[0];
  assert(mainEntry?.sourceFileId, "Runtime recovery upload returned no source-file ID.");
  await upload.uploadMissingContent(mainSessionId, mainSealed.entries?.items ?? []);

  await supervisor.stop("source-worker");
  await stopDependency("meilisearch");
  await upload.finalize(mainSessionId);
  const barriers = createPublicLifecycleBarriers({
    admin,
    developer,
    knowledgeBaseId,
    timeoutMs: 5 * 60_000,
    pollIntervalMs: 200
  });
  await barriers.upload(upload, mainSessionId, ["completed"]);
  await waitForProcessingSummary((summary) =>
    Number(summary.sourceFileJobs?.queuedCount ?? 0) > 0
  );
  await supervisor.start("source-worker");
  const publicationRetry = await waitForPublicationRetry();
  record("live-worker-restart-post-write", {
    sourceQueueRecovered: true,
    publicationAttemptCount: publicationRetry.attemptCount
  });
  record("live-meilisearch-refusal-pre-activation", {
    safeErrorCode: publicationRetry.safeErrorCode
  });
  await startDependency("meilisearch");
  await barriers.sourceFile(mainEntry.sourceFileId, ["visible"]);

  assertLiveCoverage();
  report.ok = true;
} catch (error) {
  report.failure = {
    code: typeof error?.code === "string" ? error.code : "LIVE_FAULT_INJECTION_FAILED",
    message: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500)
  };
  throw error;
} finally {
  await restoreDependencies();
  for (const serviceName of RUNTIME_SERVICE_ORDER) {
    if (!supervisor.isRunning(serviceName)) {
      await supervisor.start(serviceName).catch(() => undefined);
    }
  }
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
  await supervisor.stopAll();
  report.finishedAt = new Date().toISOString();
  writeJson(reportPath, report);
  process.stdout.write(`${JSON.stringify({
    runId,
    passed: results.length,
    expected: LIVE_FAULT_INJECTION_CASES.length,
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

async function stopDependency(service) {
  await runCommand("docker", composeArguments("stop", service));
  stoppedDependencies.add(service);
  if (service === "redis") await waitForTcpUnavailable(redisPort);
  if (service === "minio") {
    await waitForHttpUnavailable(`http://127.0.0.1:${minioPort}/minio/health/live`);
  }
  if (service === "meilisearch") {
    await waitForHttpUnavailable(`http://127.0.0.1:${meilisearchPort}/health`);
  }
}

async function startDependency(service) {
  await runCommand("docker", composeArguments("up", "-d", service));
  if (service === "redis") await waitForTcp(redisPort);
  if (service === "minio") {
    await waitForHttp(`http://127.0.0.1:${minioPort}/minio/health/live`);
  }
  if (service === "meilisearch") {
    await waitForHttp(`http://127.0.0.1:${meilisearchPort}/health`);
  }
  stoppedDependencies.delete(service);
}

async function restoreDependencies() {
  for (const service of [...stoppedDependencies]) {
    await startDependency(service).catch(() => undefined);
  }
}

function composeArguments(...command) {
  return [
    "compose",
    "-f",
    composeFile,
    "--project-name",
    composeProject,
    "--env-file",
    composeEnvFile,
    ...command
  ];
}

async function waitForProcessingSummary(predicate, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const summary = await admin.json(
      `/admin/api/knowledge-bases/${encodeURIComponent(
        knowledgeBaseId
      )}/processing-summary`
    );
    if (predicate(summary)) return summary;
    await delay(200);
  }
  throw new Error("Processing summary did not reach the expected fault barrier.");
}

async function waitForPublicationRetry(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await postgresEvidence.snapshotKnowledgeBase(knowledgeBaseId);
    const publication = snapshot.workItems.find((item) =>
      item.workKind === "publication"
      && item.state === "retry"
      && item.safeErrorCode
    );
    if (publication) return publication;
    await delay(200);
  }
  throw new Error("Publication did not expose a durable Meilisearch retry.");
}

async function waitForNoLiveWork(targetKnowledgeBaseId, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await postgresEvidence.hasLiveWorkItems(targetKnowledgeBaseId))) return;
    await delay(250);
  }
  throw new Error("Run-owned live work did not settle before runtime shutdown.");
}

function record(id, details) {
  const expected = LIVE_FAULT_INJECTION_CASES.find((item) => item.id === id);
  if (!expected) throw new Error(`Unknown live fault case: ${id}`);
  if (results.some((item) => item.id === id)) {
    throw new Error(`Duplicate live fault result: ${id}`);
  }
  results.push({ ...expected, outcome: "passed", details });
}

function assertLiveCoverage() {
  const missing = LIVE_FAULT_INJECTION_CASES
    .map((item) => item.id)
    .filter((id) => !results.some((result) => result.id === id));
  if (missing.length > 0) {
    throw new Error(`Missing live fault results: ${missing.join(", ")}`);
  }
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
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
      // The bounded loop records only the terminal health outcome.
    }
    await delay(200);
  }
  throw new Error(`Local service did not become healthy: ${new URL(url).pathname}`);
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
  throw new Error(`Local service did not stop: ${new URL(url).pathname}`);
}

async function waitForTcp(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeTcp(port)) return;
    await delay(200);
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

function requiredComposeProject() {
  const value = requiredEnv("FOCOWIKI_LOCAL_COMPOSE_PROJECT");
  if (!/^focowiki-svnext-[a-z0-9]{8,16}$/u.test(value)) {
    throw new Error("FOCOWIKI_LOCAL_COMPOSE_PROJECT is invalid.");
  }
  return value;
}

function requiredPort(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be a valid port.`);
  }
  return value;
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

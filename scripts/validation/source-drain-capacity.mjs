import fs from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadEnvFile } from "node:process";
import { selectSamplesFromEnvironment } from "./lib/sample-selector.mjs";
import { calculateSourceDrainMetrics } from "./lib/source-drain-evidence.mjs";
import { buildSourceDrainProfile } from "./lib/source-drain-profile.mjs";
import { uploadMarkdownFilesWithSession } from "./lib/upload-session-client.mjs";

const DEFAULT_SAMPLE_COUNT = 150;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1_000;
const DEFAULT_STATE_PATH = "/tmp/focowiki-source-drain-state.json";
const DEFAULT_REPORT_DIR = "ReferenceDocs/performance/large-scale-ingestion/tuned-8c32g-run";
const requireFromApi = createRequire(pathToFileURL(path.resolve("apps/api/package.json")));
const postgres = requireFromApi("postgres");

loadLocalEnv();

const command = process.argv[2] ?? "measure";
const statePath = path.resolve(process.env.FOCOWIKI_SOURCE_DRAIN_STATE_PATH ?? DEFAULT_STATE_PATH);
const reportDir = path.resolve(process.env.FOCOWIKI_SOURCE_DRAIN_REPORT_DIR ?? DEFAULT_REPORT_DIR);

if (command === "prepare") {
  await prepare();
} else if (command === "measure") {
  await measure();
} else if (command === "cleanup") {
  await cleanup();
} else {
  throw new Error(`Unknown source drain capacity command: ${command}`);
}

async function prepare() {
  if (fs.existsSync(statePath)) {
    throw new Error(`Source drain state already exists: ${statePath}`);
  }
  const sampleCount = readPositiveInteger(
    process.env.FOCOWIKI_SOURCE_DRAIN_SAMPLE_COUNT,
    DEFAULT_SAMPLE_COUNT
  );
  const samples = selectSamplesFromEnvironment({
    ...process.env,
    FOCOWIKI_VALIDATION_SAMPLE_COUNT: String(sampleCount)
  }).samples;
  const admin = await createAuthenticatedAdminClient();
  const created = await requestJson(admin, "/admin/api/knowledge-bases", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: `Source drain capacity ${new Date().toISOString()}`,
      description: "Bounded model-disabled source worker capacity evidence"
    }),
    expectedStatus: 201
  });
  const knowledgeBaseId = created.knowledgeBase?.id;
  if (!knowledgeBaseId) throw new Error("Source drain knowledge base identity is missing.");

  try {
    const uploaded = await uploadMarkdownFilesWithSession({
      request: async (pathname, options) => requestJson(
        admin,
        pathnameWithQuery(pathname, options.query),
        {
          method: options.method,
          headers: {
            ...(options.headers ?? {}),
            ...(options.body ? { "content-type": "application/json" } : {})
          },
          body: options.rawBody ?? (options.body ? JSON.stringify(options.body) : undefined),
          expectedStatus: options.status ?? 200
        }
      ),
      routeBase: `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/upload-sessions`,
      files: samples.map((sample) => ({
        relativePath: sample.relativePath ?? sample.basename,
        bytes: fs.readFileSync(sample.filePath)
      })),
      finalizationTimeoutMs: readPositiveInteger(
        process.env.FOCOWIKI_SOURCE_DRAIN_PREPARE_TIMEOUT_MS,
        DEFAULT_TIMEOUT_MS
      )
    });
    if (uploaded.files.length !== sampleCount) {
      throw new Error(`Expected ${sampleCount} prepared source files, received ${uploaded.files.length}.`);
    }
    const state = {
      kind: "source-drain-capacity-state",
      preparedAt: new Date().toISOString(),
      knowledgeBaseId,
      sampleCount,
      sourceFileIds: uploaded.files.map((file) => file.sourceFileId),
      sampleManifest: samples.map((sample) => ({
        relativePath: sample.relativePath ?? sample.basename,
        checksumSha256: createHash("sha256").update(fs.readFileSync(sample.filePath)).digest("hex")
      }))
    };
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({
      status: "prepared",
      knowledgeBaseId,
      sampleCount,
      statePath
    }, null, 2));
  } catch (error) {
    await deleteKnowledgeBase(admin, knowledgeBaseId).catch(() => undefined);
    throw error;
  }
}

async function measure() {
  const state = readState();
  const database = postgres(readDatabaseUrl(), { max: 2 });
  const deadline = Date.now() + readPositiveInteger(
    process.env.FOCOWIKI_SOURCE_DRAIN_MEASURE_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS
  );
  let rows = [];
  try {
    while (Date.now() < deadline) {
      rows = await database`
        SELECT id, processing_status, processing_started_at, processing_ended_at,
               terminal_failure_code, terminal_failure_message
        FROM focowiki.source_files
        WHERE knowledge_base_id = ${state.knowledgeBaseId}
          AND id = ANY(${state.sourceFileIds})
        ORDER BY processing_ended_at NULLS LAST, id
      `;
      const failed = rows.find((row) => row.processing_status === "failed");
      if (failed) {
        throw new Error(
          `Source drain failed with ${failed.terminal_failure_code ?? "UNKNOWN"}: ${failed.terminal_failure_message ?? "No message"}`
        );
      }
      if (
        rows.length === state.sampleCount
        && rows.every((row) => row.processing_status === "completed" && row.processing_ended_at)
      ) {
        break;
      }
      await sleep(250);
    }
    if (
      rows.length !== state.sampleCount
      || rows.some((row) => row.processing_status !== "completed" || !row.processing_ended_at)
    ) {
      throw new Error("Source drain measurement timed out before every source completed.");
    }
    const workerSettings = await readWorkerSettings(database);
    const metrics = calculateSourceDrainMetrics(
      rows.map((row) => ({
        sourceFileId: row.id,
        status: row.processing_status,
        startedAt: row.processing_started_at?.toISOString() ?? null,
        endedAt: row.processing_ended_at?.toISOString() ?? null
      })),
      state.sampleCount
    );
    const report = {
      kind: "source-drain-capacity-evidence",
      generatedAt: new Date().toISOString(),
      profile: buildSourceDrainProfile({
        sampleCount: state.sampleCount,
        workerReplicas: readPositiveInteger(
          process.env.FOCOWIKI_SOURCE_DRAIN_WORKER_REPLICAS,
          1
        ),
        worker: workerSettings
      }),
      metrics,
      acceptance: {
        minimumWarmedFilesPerSecond: 15,
        maximumQuintileDriftPercent: 20,
        throughputPassed: metrics.warmedFilesPerSecond >= 15,
        driftPassed: metrics.warmedQuintileDriftPercent < 20,
        ok: metrics.warmedFilesPerSecond >= 15
          && metrics.warmedQuintileDriftPercent < 20
      }
    };
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(
      path.join(reportDir, "source-drain-capacity.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(reportDir, "source-drain-capacity.md"),
      renderMarkdown(report),
      "utf8"
    );
    console.log(JSON.stringify(report, null, 2));
    if (!report.acceptance.ok) process.exitCode = 1;
  } finally {
    await database.end({ timeout: 5 });
  }
}

async function readWorkerSettings(database) {
  const rows = await database`
    SELECT value_json
    FROM focowiki.runtime_settings
    WHERE key = 'worker'
    LIMIT 1
  `;
  if (!rows[0]?.value_json) {
    throw new Error("Persisted worker settings are missing for source drain evidence.");
  }
  return rows[0].value_json;
}

async function cleanup() {
  const state = readState();
  const admin = await createAuthenticatedAdminClient();
  await deleteKnowledgeBase(admin, state.knowledgeBaseId);
  fs.rmSync(statePath, { force: true });
  console.log(JSON.stringify({ status: "cleanup-submitted", statePath }, null, 2));
}

async function createAuthenticatedAdminClient() {
  const baseUrl = (process.env.ADMIN_API_BASE_URL
    ?? `http://127.0.0.1:${process.env.ADMIN_API_PORT ?? "43000"}`).replace(/\/+$/u, "");
  const origin = process.env.ADMIN_UI_PUBLIC_ORIGIN ?? "http://127.0.0.1:43100";
  const client = { baseUrl, origin, cookie: "" };
  const login = await requestJson(client, "/admin/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: requiredEnv("ADMIN_USERNAME"),
      password: requiredEnv("ADMIN_PASSWORD")
    })
  });
  if (!login) throw new Error("Source drain Admin login failed.");
  return client;
}

async function requestJson(client, pathname, options = {}) {
  const headers = new Headers(options.headers ?? {});
  const method = options.method ?? "GET";
  if (client.cookie) headers.set("cookie", client.cookie);
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) headers.set("origin", client.origin);
  const response = await fetch(`${client.baseUrl}${pathname}`, {
    method,
    headers,
    body: options.body
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) client.cookie = setCookie.split(";")[0] ?? "";
  if (response.status !== (options.expectedStatus ?? 200)) {
    throw new Error(`Source drain request failed with HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  return response.json();
}

async function deleteKnowledgeBase(admin, knowledgeBaseId) {
  const response = await fetch(
    `${admin.baseUrl}/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`,
    {
      method: "DELETE",
      headers: { cookie: admin.cookie, origin: admin.origin }
    }
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(`Source drain cleanup failed with HTTP ${response.status}.`);
  }
}

function readState() {
  if (!fs.existsSync(statePath)) throw new Error(`Source drain state is missing: ${statePath}`);
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

function readDatabaseUrl() {
  if (process.env.FOCOWIKI_TEST_DATABASE_URL) return process.env.FOCOWIKI_TEST_DATABASE_URL;
  if (process.env.DATABASE_URL?.includes("127.0.0.1")) return process.env.DATABASE_URL;
  const user = requiredEnv("POSTGRES_USER");
  const password = requiredEnv("POSTGRES_PASSWORD");
  const database = requiredEnv("POSTGRES_DB");
  const port = process.env.POSTGRES_HOST_PORT ?? "55432";
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${encodeURIComponent(database)}`;
}

function renderMarkdown(report) {
  const quintiles = report.metrics.quintiles.map((item) =>
    `| ${item.number} | ${item.fileCount} | ${item.completionSpanMs} | ${item.filesPerSecond} |`
  );
  return [
    "# 来源 Worker 隔离排空容量",
    "",
    `生成时间：${report.generatedAt}`,
    "",
    "150 个真实 Markdown 文件先完成上传和接收，再启动 Source Worker。计时只覆盖来源队列排空，外部上传时间与后续发布时间均不计入。",
    "",
    `- 暖态吞吐：${report.metrics.warmedFilesPerSecond} 文件/秒`,
    `- 全程吞吐：${report.metrics.filesPerSecond} 文件/秒`,
    `- 冷启动至末分位漂移：${report.metrics.coldToTailQuintileDriftPercent}%`,
    `- 预热后首尾分位漂移：${report.metrics.warmedQuintileDriftPercent}%`,
    `- 总处理墙钟：${report.metrics.wallClockMs} ms`,
    "",
    "| 五分位 | 文件数 | 完成跨度 ms | 文件/秒 |",
    "| ---: | ---: | ---: | ---: |",
    ...quintiles,
    "",
    `验收：${report.acceptance.ok ? "通过" : "未通过"}`,
    ""
  ].join("\n");
}

function pathnameWithQuery(pathname, query) {
  if (!query) return pathname;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `${pathname}?${encoded}` : pathname;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for source drain capacity evidence.`);
  return value;
}

function readPositiveInteger(value, fallback) {
  const parsed = Number(value ?? fallback);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function loadLocalEnv() {
  const envFile = process.env.ENV_FILE ?? ".env";
  if (fs.existsSync(envFile)) loadEnvFile(envFile);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

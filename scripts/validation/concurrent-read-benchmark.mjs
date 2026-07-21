import fs from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";

loadLocalEnv();

const knowledgeBaseId = requiredEnv("FOCOWIKI_BENCHMARK_KNOWLEDGE_BASE_ID");
const reportPath = path.resolve(
  process.env.FOCOWIKI_BENCHMARK_REPORT
    ?? "ReferenceDocs/concurrent-read-benchmark.json"
);
const rounds = positiveInteger(process.env.FOCOWIKI_BENCHMARK_ROUNDS ?? "20", "rounds");
const concurrency = positiveInteger(
  process.env.FOCOWIKI_BENCHMARK_CONCURRENCY ?? "8",
  "concurrency"
);
const adminBaseUrl = `http://127.0.0.1:${process.env.ADMIN_API_PORT || "43000"}`;
const openApiBaseUrl = `http://127.0.0.1:${process.env.PUBLIC_OPENAPI_PORT || "43200"}`;
const origin = process.env.ADMIN_PUBLIC_ORIGIN || "http://127.0.0.1:43100";
let cookie = "";
let keyId = null;

const report = {
  kind: "concurrent-read-benchmark",
  startedAt: new Date().toISOString(),
  finishedAt: null,
  ok: false,
  rounds,
  concurrency,
  requestCount: 0,
  endpoints: {},
  metadataAggregate: null,
  contentTransfer: null,
  aggregate: null,
  failures: []
};

try {
  await login();
  const credential = await createKey();
  keyId = credential.id;
  const openApiHeaders = { authorization: `Bearer ${credential.rawKey}` };
  const base = `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`;
  const endpointFactories = {
    adminTree: () => ({
      url: `${adminBaseUrl}/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`
        + "/files/tree?parentPath=pages&limit=100",
      headers: { cookie }
    }),
    health: () => ({ url: `${openApiBaseUrl}/openapi/v2/health`, headers: openApiHeaders }),
    knowledgeBase: () => ({ url: `${openApiBaseUrl}${base}`, headers: openApiHeaders }),
    sourceFiles: () => ({ url: `${openApiBaseUrl}${base}/source-files?limit=25`, headers: openApiHeaders }),
    tree: () => ({ url: `${openApiBaseUrl}${base}/tree?limit=100`, headers: openApiHeaders }),
    content: () => ({ url: `${openApiBaseUrl}${base}/files/content?path=index.md`, headers: openApiHeaders }),
    search: () => ({ url: `${openApiBaseUrl}${base}/files/search?query=backup&limit=10`, headers: openApiHeaders }),
    graph: () => ({ url: `${openApiBaseUrl}${base}/graph/overview`, headers: openApiHeaders }),
    operations: () => ({ url: `${openApiBaseUrl}${base}/operations?limit=25`, headers: openApiHeaders })
  };
  const work = [];
  for (let round = 0; round < rounds; round += 1) {
    for (const [name, createRequest] of Object.entries(endpointFactories)) {
      work.push({ name, ...createRequest() });
    }
  }

  const timings = new Map(Object.keys(endpointFactories).map((name) => [name, []]));
  let cursor = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < work.length) {
      const index = cursor;
      cursor += 1;
      const item = work[index];
      const startedAt = performance.now();
      const response = await fetch(item.url, { headers: item.headers });
      const body = await response.arrayBuffer();
      const durationMs = performance.now() - startedAt;
      if (!response.ok || body.byteLength === 0) {
        throw new Error(`${item.name} returned HTTP ${response.status} with ${body.byteLength} bytes`);
      }
      timings.get(item.name).push(durationMs);
    }
  }));

  const aggregate = [];
  const metadata = [];
  const contentTransfers = [];
  for (const [name, values] of timings) {
    const summary = summarize(values);
    report.endpoints[name] = summary;
    aggregate.push(...values);
    if (name === "content") contentTransfers.push(...values);
    else metadata.push(...values);
  }
  report.requestCount = aggregate.length;
  report.metadataAggregate = summarize(metadata);
  report.contentTransfer = summarize(contentTransfers);
  report.aggregate = summarize(aggregate);
  report.ok = report.aggregate.p95Ms < 2_000 && report.aggregate.maxMs < 5_000;
  if (!report.ok) report.failures.push("Concurrent read latency exceeded the validation budget.");
} catch (error) {
  report.failures.push(error instanceof Error ? error.message : String(error));
  throw error;
} finally {
  if (keyId) {
    await adminRequest(`/admin/api/openapi-keys/${encodeURIComponent(keyId)}`, {
      method: "DELETE"
    }).catch(() => undefined);
  }
  report.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

async function login() {
  const response = await adminRequest("/admin/api/login", {
    method: "POST",
    body: {
      username: requiredEnv("ADMIN_USERNAME"),
      password: requiredEnv("ADMIN_PASSWORD")
    }
  });
  cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
  if (!cookie) throw new Error("Admin login did not return a session cookie.");
}

async function createKey() {
  const response = await adminRequest("/admin/api/openapi-keys", {
    method: "POST",
    body: { name: `read-benchmark-${Date.now()}` }
  });
  const body = await response.json();
  if (!body.key?.id || !body.oneTimeKey?.rawKey) {
    throw new Error("Temporary OpenAPI key response is incomplete.");
  }
  return { id: body.key.id, rawKey: body.oneTimeKey.rawKey };
}

async function adminRequest(pathname, options = {}) {
  const response = await fetch(`${adminBaseUrl}${pathname}`, {
    method: options.method ?? "GET",
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(options.method && options.method !== "GET" ? { origin } : {}),
      ...(options.body ? { "content-type": "application/json" } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (!response.ok) throw new Error(`Admin request returned HTTP ${response.status}.`);
  return response;
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    p50Ms: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
    maxMs: round(sorted.at(-1) ?? 0),
    averageMs: round(sorted.reduce((sum, value) => sum + value, 0) / Math.max(1, sorted.length))
  };
}

function percentile(sorted, ratio) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function loadLocalEnv() {
  const envPath = path.resolve(".env");
  if (fs.existsSync(envPath)) loadEnvFile(envPath);
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

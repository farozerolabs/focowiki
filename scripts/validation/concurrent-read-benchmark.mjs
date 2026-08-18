import fs from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";

const MAXIMUM_RATE_LIMIT_RETRIES = 4;
const DEFAULT_RATE_LIMIT_RETRY_MS = 5_000;

loadLocalEnv();

const knowledgeBaseIds = benchmarkKnowledgeBaseIds();
const knowledgeBaseId = knowledgeBaseIds[0];
const benchmarkMode = benchmarkModeEnvironment();
const benchmarkPhase = process.env.FOCOWIKI_BENCHMARK_PHASE?.trim() || "unspecified";
const searchQuery = process.env.FOCOWIKI_BENCHMARK_SEARCH_QUERY?.trim() || "backup";
const representativeSourceFileId = process.env
  .FOCOWIKI_BENCHMARK_SOURCE_FILE_ID?.trim() || null;
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
const benchmarkAuthorization = loadBenchmarkAuthorization();
let cookie = "";
let keyId = null;

const report = {
  kind: "concurrent-read-benchmark",
  startedAt: new Date().toISOString(),
  finishedAt: null,
  ok: false,
  mode: benchmarkMode,
  phase: benchmarkPhase,
  knowledgeBaseIds,
  rounds,
  concurrency,
  requestCount: 0,
  benchmarkElapsedMs: 0,
  successfulQueriesPerSecond: 0,
  endpoints: {},
  metadataAggregate: null,
  contentTransfer: null,
  aggregate: null,
  failures: []
};

try {
  let authorization = benchmarkAuthorization;
  if (!authorization) {
    await login();
    const credential = await createKey();
    keyId = credential.id;
    authorization = `Bearer ${credential.rawKey}`;
  } else if (benchmarkMode !== "semantic_search") {
    throw new Error("A supplied benchmark authorization file supports semantic_search mode only");
  }
  const openApiHeaders = { authorization };
  const endpointFactories = benchmarkMode === "semantic_search"
    ? semanticSearchFactories(knowledgeBaseIds, openApiHeaders, searchQuery)
    : mixedReadFactories(
        knowledgeBaseId,
        openApiHeaders,
        searchQuery,
        representativeSourceFileId
      );
  const work = [];
  for (let round = 0; round < rounds; round += 1) {
    for (const [name, createRequest] of Object.entries(endpointFactories)) {
      work.push({ name, ...createRequest() });
    }
  }

  const timings = new Map(Object.keys(endpointFactories).map((name) => [name, []]));
  let cursor = 0;
  const benchmarkStartedAt = performance.now();
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
      if (item.knowledgeBaseId) {
        assertSemanticSearchScope(body, item.knowledgeBaseId);
      }
      timings.get(item.name).push(durationMs);
    }
  }));
  report.benchmarkElapsedMs = round(performance.now() - benchmarkStartedAt);

  const aggregate = [];
  const metadata = [];
  const contentTransfers = [];
  for (const [name, values] of timings) {
    const summary = summarize(values);
    report.endpoints[name] = summary;
    aggregate.push(...values);
    if (name === "content" || name === "originalContent") {
      contentTransfers.push(...values);
    }
    else metadata.push(...values);
  }
  report.requestCount = aggregate.length;
  report.successfulQueriesPerSecond = round(
    aggregate.length / (report.benchmarkElapsedMs / 1_000)
  );
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
  const requestBody = options.body ? JSON.stringify(options.body) : undefined;
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(`${adminBaseUrl}${pathname}`, {
      method: options.method ?? "GET",
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(options.method && options.method !== "GET" ? { origin } : {}),
        ...(requestBody ? { "content-type": "application/json" } : {})
      },
      body: requestBody
    });
    if (response.status !== 429 || attempt >= MAXIMUM_RATE_LIMIT_RETRIES) {
      if (!response.ok) {
        throw new Error(`Admin request returned HTTP ${response.status}.`);
      }
      return response;
    }
    const retryAfterSeconds = Number(response.headers.get("retry-after"));
    const retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? retryAfterSeconds * 1_000
      : DEFAULT_RATE_LIMIT_RETRY_MS;
    await response.text();
    await sleep(retryAfterMs);
  }
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    p50Ms: round(percentile(sorted, 0.5)),
    p90Ms: round(percentile(sorted, 0.9)),
    p95Ms: round(percentile(sorted, 0.95)),
    p99Ms: round(percentile(sorted, 0.99)),
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

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function loadLocalEnv() {
  const envPath = path.resolve(process.env.ENV_FILE?.trim() || ".env");
  if (fs.existsSync(envPath)) loadEnvFile(envPath);
}

function loadBenchmarkAuthorization() {
  const configured = process.env.FOCOWIKI_BENCHMARK_AUTHORIZATION_FILE?.trim();
  if (!configured) return null;
  const authorizationFile = path.resolve(configured);
  const contents = fs.readFileSync(authorizationFile, "utf8").trim();
  const match = contents.match(/^Authorization:\s+(Bearer\s+\S+)$/iu);
  if (!match?.[1]) {
    throw new Error("Benchmark authorization file must contain one Authorization: Bearer header");
  }
  return match[1];
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

function benchmarkKnowledgeBaseIds() {
  const configured = process.env.FOCOWIKI_BENCHMARK_KNOWLEDGE_BASE_IDS
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const values = configured?.length
    ? configured
    : [requiredEnv("FOCOWIKI_BENCHMARK_KNOWLEDGE_BASE_ID")];
  if (values.some((value) => value.length > 255) || new Set(values).size !== values.length) {
    throw new Error("Benchmark knowledge-base IDs must be unique bounded identifiers");
  }
  return values;
}

function benchmarkModeEnvironment() {
  const value = process.env.FOCOWIKI_BENCHMARK_MODE?.trim() || "mixed";
  if (!["mixed", "semantic_search"].includes(value)) {
    throw new Error("FOCOWIKI_BENCHMARK_MODE must be mixed or semantic_search");
  }
  return value;
}

function mixedReadFactories(
  knowledgeBaseId,
  openApiHeaders,
  query,
  sourceFileId
) {
  const base = `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`;
  return {
    adminTree: () => ({
      url: `${adminBaseUrl}/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`
        + "/files/tree?parentPath=pages&limit=100",
      headers: { cookie }
    }),
    health: () => ({ url: `${openApiBaseUrl}/openapi/v2/health`, headers: openApiHeaders }),
    adminProcessing: () => ({
      url: `${adminBaseUrl}/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`
        + "/processing-summary",
      headers: { cookie }
    }),
    knowledgeBase: () => ({ url: `${openApiBaseUrl}${base}`, headers: openApiHeaders }),
    sourceFiles: () => ({ url: `${openApiBaseUrl}${base}/source-files?limit=25`, headers: openApiHeaders }),
    tree: () => ({ url: `${openApiBaseUrl}${base}/tree?limit=100`, headers: openApiHeaders }),
    ...(sourceFileId
      ? {
          file: () => ({
            url: `${openApiBaseUrl}${base}/files/${encodeURIComponent(sourceFileId)}`,
            headers: openApiHeaders
          })
        }
      : {}),
    content: () => ({ url: `${openApiBaseUrl}${base}/files/content?path=index.md`, headers: openApiHeaders }),
    lexicalSearch: () => ({
      url: `${openApiBaseUrl}${base}/files/search?query=${encodeURIComponent(query)}`
        + "&mode=file&scope=path&limit=10&rerank=false",
      headers: openApiHeaders
    }),
    vectorSearch: () => ({
      url: `${openApiBaseUrl}${base}/files/search?query=${encodeURIComponent(query)}`
        + "&mode=file&scope=all&limit=10&rerank=false",
      headers: openApiHeaders
    }),
    hybridSearch: () => ({
      url: `${openApiBaseUrl}${base}/files/search?query=${encodeURIComponent(query)}`
        + "&mode=hybrid&scope=all&graphDepth=2&limit=10&rerank=false",
      headers: openApiHeaders
    }),
    graph: () => ({ url: `${openApiBaseUrl}${base}/graph/overview`, headers: openApiHeaders }),
    ...(sourceFileId
      ? {
          related: () => ({
            url: `${openApiBaseUrl}${base}/files/${encodeURIComponent(sourceFileId)}`
              + "/related?limit=20",
            headers: openApiHeaders
          }),
          originalContent: () => ({
            url: `${openApiBaseUrl}${base}/source-files/${encodeURIComponent(sourceFileId)}`
              + "/content",
            headers: openApiHeaders
          })
        }
      : {}),
    operations: () => ({ url: `${openApiBaseUrl}${base}/operations?limit=25`, headers: openApiHeaders })
  };
}

function semanticSearchFactories(knowledgeBaseIds, openApiHeaders, query) {
  return Object.fromEntries(knowledgeBaseIds.map((knowledgeBaseId, index) => [
    `semanticSearch${index + 1}`,
    () => ({
      url: `${openApiBaseUrl}/openapi/v2/knowledge-bases/`
        + `${encodeURIComponent(knowledgeBaseId)}/files/search?query=${encodeURIComponent(query)}`
        + "&mode=hybrid&graphDepth=2&limit=10",
      headers: openApiHeaders,
      knowledgeBaseId
    })
  ]));
}

function assertSemanticSearchScope(body, expectedKnowledgeBaseId) {
  const parsed = JSON.parse(new TextDecoder().decode(body));
  if (!Array.isArray(parsed.items)) {
    throw new Error("Semantic search response omitted its item list");
  }
  if (parsed.semanticStatus?.state !== "ready") {
    throw new Error(
      `Semantic search did not complete all lanes: ${parsed.semanticStatus?.safeCode ?? "unknown"}`
    );
  }
  for (const item of parsed.items) {
    if (item?.knowledgeBaseId !== expectedKnowledgeBaseId) {
      throw new Error("Semantic search exposed a cross-knowledge-base result");
    }
  }
}

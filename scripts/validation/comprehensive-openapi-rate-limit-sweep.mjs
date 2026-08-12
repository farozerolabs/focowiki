import fs from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";

loadLocalEnv();

const adminBaseUrl = `http://127.0.0.1:${process.env.ADMIN_API_PORT || "43000"}`;
const publicBaseUrl = `http://127.0.0.1:${process.env.PUBLIC_OPENAPI_PORT || "43200"}`;
const adminOrigin = process.env.ADMIN_PUBLIC_ORIGIN || "http://127.0.0.1:43100";
const reportPath = path.resolve(
  process.env.FOCOWIKI_COMPREHENSIVE_OPENAPI_RATE_REPORT
    || "ReferenceDocs/validation/comprehensive-large-scale-release/openapi-rate-limit-sweep.json"
);
const document = JSON.parse(fs.readFileSync("docs/public/openapi/focowiki-openapi.json", "utf8"));
const operations = collectOperations(document);
const report = {
  kind: "focowiki-comprehensive-openapi-rate-limit-sweep",
  version: 1,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  ok: false,
  operationCount: operations.length,
  rows: [],
  cleanup: {
    runtimeSettingsRestored: false,
    keyDeleted: false,
    loggedOut: false
  }
};

let cookie = "";
let keyId = "";
let rawKey = "";
let originalRateLimits = null;

try {
  assert(operations.length === 43, `Expected 43 OpenAPI operations, found ${operations.length}.`);
  await login();
  const runtime = await adminJson("GET", "/admin/api/settings/runtime");
  originalRateLimits = runtime.body?.settings?.rateLimits ?? null;
  assert(originalRateLimits, "Runtime rate-limit settings are missing.");
  ({ id: keyId, rawKey } = await createKey());
  await updateRateLimits({
    ...originalRateLimits,
    publicOpenApi: {
      max: 1,
      windowSeconds: 60
    }
  });

  for (const [index, operation] of operations.entries()) {
    const pathname = concretePath(operation.path);
    const clientIp = `203.0.113.${index + 1}`;
    const first = await publicRequest(operation.method, pathname, clientIp);
    assert(first.status !== 429, `${operation.operationId} was rate-limited on its first request.`);
    record(operation, "admitted", first);

    const limited = await publicRequest(operation.method, pathname, clientIp);
    assert(
      limited.status === 429
        && limited.body?.error?.code === "RATE_LIMITED"
        && limited.body?.error?.httpStatus === 429
        && typeof limited.body?.requestId === "string"
        && limited.headers.includes("retry-after"),
      `${operation.operationId} did not return the documented 429 envelope.`
    );
    record(operation, "rate-limited", limited);
  }

  assert(report.rows.length === operations.length * 2, "OpenAPI rate-limit row count is incomplete.");
  assert(
    new Set(report.rows.map((row) => `${row.operationId}:${row.case}`)).size === report.rows.length,
    "OpenAPI rate-limit rows are not itemized uniquely."
  );
  report.ok = true;
} finally {
  if (cookie && originalRateLimits) {
    report.cleanup.runtimeSettingsRestored = await updateRateLimits(originalRateLimits)
      .then(() => true)
      .catch(() => false);
  }
  if (cookie && keyId) {
    const deleted = await adminJson(
      "DELETE",
      `/admin/api/openapi-keys/${encodeURIComponent(keyId)}`
    ).catch(() => null);
    report.cleanup.keyDeleted = deleted?.status === 200;
    if (report.cleanup.keyDeleted) keyId = "";
  }
  if (cookie) {
    const logout = await adminJson("POST", "/admin/api/logout", { json: {} }).catch(() => null);
    report.cleanup.loggedOut = logout?.status === 200;
    cookie = "";
  }
  report.finishedAt = new Date().toISOString();
  report.ok = report.ok
    && report.cleanup.runtimeSettingsRestored
    && report.cleanup.keyDeleted
    && report.cleanup.loggedOut;
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    operationCount: report.operationCount,
    rowCount: report.rows.length,
    cleanup: report.cleanup,
    reportPath
  })}\n`);
}

if (!report.ok) throw new Error("Developer OpenAPI rate-limit sweep failed.");

async function login() {
  const response = await adminJson("POST", "/admin/api/login", {
    json: {
      username: requiredEnv("ADMIN_USERNAME"),
      password: requiredEnv("ADMIN_PASSWORD")
    }
  });
  assert(response.status === 200, `Admin login returned HTTP ${response.status}.`);
  cookie = response.setCookie.split(";", 1)[0] ?? "";
  assert(cookie, "Admin login returned no session cookie.");
}

async function createKey() {
  const response = await adminJson("POST", "/admin/api/openapi-keys", {
    json: { name: `openapi-rate-limit-${Date.now()}` }
  });
  assert(response.status === 201, `OpenAPI key creation returned HTTP ${response.status}.`);
  const id = response.body?.key?.id;
  const value = response.body?.oneTimeKey?.rawKey;
  assert(typeof id === "string" && id, "OpenAPI key ID is missing.");
  assert(typeof value === "string" && value, "OpenAPI one-time key is missing.");
  return { id, rawKey: value };
}

async function updateRateLimits(value) {
  const response = await adminJson("PUT", "/admin/api/settings/rate-limits", { json: value });
  assert(response.status === 200, `Rate-limit update returned HTTP ${response.status}.`);
}

async function adminJson(method, pathname, input = {}) {
  const response = await fetch(`${adminBaseUrl}${pathname}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(method === "GET" ? {} : { origin: adminOrigin }),
      ...(input.json === undefined ? {} : { "content-type": "application/json" })
    },
    body: input.json === undefined ? undefined : JSON.stringify(input.json)
  });
  const body = await response.json().catch(() => null);
  assertSafe(body, `admin:${method}:${pathname}`);
  return {
    status: response.status,
    body,
    setCookie: response.headers.get("set-cookie") ?? ""
  };
}

async function publicRequest(method, pathname, clientIp) {
  const startedAt = performance.now();
  const response = await fetch(`${publicBaseUrl}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${rawKey}`,
      "x-real-ip": clientIp
    }
  });
  const body = await response.json().catch(() => null);
  assertSafe(body, `${method}:${pathname}`);
  return {
    status: response.status,
    body,
    latencyMs: Number((performance.now() - startedAt).toFixed(3)),
    headers: ["content-type", "retry-after", "x-request-id"]
      .filter((name) => response.headers.has(name))
  };
}

function record(operation, testCase, result) {
  report.rows.push({
    sequence: report.rows.length + 1,
    operationId: operation.operationId,
    method: operation.method,
    path: operation.path,
    case: testCase,
    status: result.status,
    errorCode: String(result.body?.error?.code ?? ""),
    latencyMs: result.latencyMs,
    responseHeaders: result.headers,
    pass: true
  });
}

function collectOperations(openApiDocument) {
  const methods = new Set(["delete", "get", "patch", "post", "put"]);
  return Object.entries(openApiDocument.paths ?? {}).flatMap(([routePath, pathItem]) =>
    Object.entries(pathItem ?? {}).flatMap(([method, operation]) =>
      methods.has(method) && operation?.operationId
        ? [{ operationId: operation.operationId, method: method.toUpperCase(), path: routePath }]
        : []
    )
  ).sort((left, right) => left.operationId.localeCompare(right.operationId));
}

function concretePath(routePath) {
  return routePath.replace(/\{[^}]+\}/gu, "rate-limit-test-id");
}

function assertSafe(body, label) {
  const serialized = JSON.stringify(body ?? {});
  assert(
    !/(postgres(?:ql)?:\/\/|redis:\/\/|stack\s*trace|objectKey|s3_secret|sql\s+state|\/Users\/|C:\\)/iu.test(serialized),
    `${label} exposed internal data.`
  );
  assert(!rawKey || !serialized.includes(rawKey), `${label} exposed the OpenAPI key.`);
}

function loadLocalEnv() {
  const envPath = path.resolve(process.env.ENV_FILE || ".env");
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

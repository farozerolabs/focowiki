import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { loadEnvFile } from "node:process";

loadLocalEnv();

const adminBaseUrl = `http://127.0.0.1:${process.env.ADMIN_API_PORT || "43000"}`;
const publicBaseUrl = `http://127.0.0.1:${process.env.PUBLIC_OPENAPI_PORT || "43200"}`;
const adminOrigin = process.env.ADMIN_PUBLIC_ORIGIN || "http://127.0.0.1:43100";
const reportPath = path.resolve(
  process.env.FOCOWIKI_COMPREHENSIVE_OPENAPI_SECURITY_REPORT
    || "ReferenceDocs/validation/comprehensive-large-scale-release/openapi-security-sweep.json"
);
const document = JSON.parse(fs.readFileSync("docs/public/openapi/focowiki-openapi.json", "utf8"));
const operations = collectOperations(document);
const maximumBodyBytes = Number(process.env.GENERATED_CONTENT_MAX_BYTES || 10_485_760);
const report = {
  kind: "focowiki-comprehensive-openapi-security-sweep",
  version: 1,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  ok: false,
  operationCount: operations.length,
  bodyOperationCount: operations.filter((item) => item.mediaType).length,
  rows: [],
  cleanup: {
    revokedKeyDeleted: false,
    activeKeyDeleted: false,
    loggedOut: false
  }
};

let adminCookie = "";
let activeKeyId = "";
let activeRawKey = "";
let revokedKeyId = "";
let revokedRawKey = "";

try {
  assert(operations.length === 43, `Expected 43 OpenAPI operations, found ${operations.length}.`);
  assert(Number.isSafeInteger(maximumBodyBytes) && maximumBodyBytes > 0, "Invalid request body ceiling.");
  await loginAdmin();
  ({ id: activeKeyId, rawKey: activeRawKey } = await createKey("openapi-security-active"));
  ({ id: revokedKeyId, rawKey: revokedRawKey } = await createKey("openapi-security-revoked"));
  await deleteKey(revokedKeyId);
  report.cleanup.revokedKeyDeleted = true;
  revokedKeyId = "";

  for (const operation of operations) {
    const pathname = concretePath(operation.path);

    const missing = await publicRequest(operation.method, pathname, {
      clientIp: "198.51.100.20"
    });
    assertDeveloperError(operation, "missing-key", missing, 401, "UNAUTHORIZED");
    record(operation, "missing-key", missing);

    const invalid = await publicRequest(operation.method, pathname, {
      authorization: "Bearer invalid-openapi-key",
      clientIp: "198.51.100.21"
    });
    assertDeveloperError(operation, "invalid-key", invalid, 401, "UNAUTHORIZED");
    record(operation, "invalid-key", invalid);

    const revoked = await publicRequest(operation.method, pathname, {
      authorization: `Bearer ${revokedRawKey}`,
      clientIp: "198.51.100.22"
    });
    assertDeveloperError(operation, "revoked-key", revoked, 401, "UNAUTHORIZED");
    record(operation, "revoked-key", revoked);

    const credentialQuery = await publicRequest(
      operation.method,
      appendQuery(pathname, "api_key=query-credentials-are-not-supported"),
      { clientIp: "198.51.100.23" }
    );
    assertDeveloperError(operation, "credential-query", credentialQuery, 401, "UNAUTHORIZED");
    record(operation, "credential-query", credentialQuery);

    const unsupportedMethod = await publicRequest("PROPFIND", pathname, {
      authorization: `Bearer ${activeRawKey}`,
      clientIp: "198.51.100.24"
    });
    assert(
      unsupportedMethod.status === 404
        && safeCode(unsupportedMethod.body) === "UNSUPPORTED_ROUTE"
        && unsupportedMethod.body?.error?.httpStatus === 404
        && typeof unsupportedMethod.body?.requestId === "string",
      `${operation.operationId} unsupported-method returned HTTP ${unsupportedMethod.status} ${safeCode(unsupportedMethod.body)}.`
    );
    record(operation, "unsupported-method", unsupportedMethod);

    const traversal = await publicRequest(operation.method, traversalPath(pathname), {
      authorization: `Bearer ${activeRawKey}`,
      clientIp: "198.51.100.25"
    });
    assert(
      traversal.status === 400 && safeCode(traversal.body) === "INVALID_PATH",
      `${operation.operationId} traversal returned HTTP ${traversal.status} ${safeCode(traversal.body)}.`
    );
    record(operation, "traversal", traversal);

    if (!operation.mediaType) continue;

    const unsupportedMediaType = await publicRequest(operation.method, pathname, {
      authorization: `Bearer ${activeRawKey}`,
      clientIp: "198.51.100.26",
      contentType: "application/xml",
      body: operation.mediaType === "application/json" ? "{}" : "# invalid media type"
    });
    assertDeveloperError(operation, "unsupported-media-type", unsupportedMediaType, 422, "VALIDATION_ERROR");
    record(operation, "unsupported-media-type", unsupportedMediaType);

    const malformed = await publicRequest(operation.method, pathname, {
      authorization: `Bearer ${activeRawKey}`,
      clientIp: "198.51.100.27",
      contentType: operation.mediaType,
      ...(operation.mediaType === "application/json" ? { body: "{" } : {})
    });
    assertDeveloperError(operation, "malformed-body", malformed, 422, "VALIDATION_ERROR");
    record(operation, "malformed-body", malformed);

    if (operation.mediaType === "application/json") {
      const unknownField = await publicRequest(operation.method, pathname, {
        authorization: `Bearer ${activeRawKey}`,
        clientIp: "198.51.100.28",
        contentType: operation.mediaType,
        body: JSON.stringify({ unknownSecurityField: true })
      });
      assertDeveloperError(operation, "unknown-field", unknownField, 422, "VALIDATION_ERROR");
      record(operation, "unknown-field", unknownField);
    }

    const oversized = await publicDeclaredOversizedRequest(operation.method, pathname, {
      authorization: `Bearer ${activeRawKey}`,
      clientIp: "198.51.100.29",
      contentType: operation.mediaType,
      declaredBytes: maximumBodyBytes + 1
    });
    assertDeveloperError(operation, "oversized-body", oversized, 413, "PAYLOAD_TOO_LARGE");
    record(operation, "oversized-body", oversized);
  }

  assert(
    new Set(report.rows.map((row) => `${row.operationId}:${row.case}`)).size === report.rows.length,
    "OpenAPI security rows are not itemized uniquely."
  );
  report.ok = true;
} finally {
  if (revokedKeyId) {
    report.cleanup.revokedKeyDeleted = await deleteKey(revokedKeyId).then(() => true).catch(() => false);
    if (report.cleanup.revokedKeyDeleted) revokedKeyId = "";
  }
  if (activeKeyId) {
    report.cleanup.activeKeyDeleted = await deleteKey(activeKeyId).then(() => true).catch(() => false);
    if (report.cleanup.activeKeyDeleted) activeKeyId = "";
  }
  if (adminCookie) {
    const logout = await adminRequest("POST", "/admin/api/logout", { json: {} }).catch(() => null);
    report.cleanup.loggedOut = logout?.status === 200;
    adminCookie = "";
  }
  report.finishedAt = new Date().toISOString();
  report.ok = report.ok
    && report.cleanup.revokedKeyDeleted
    && report.cleanup.activeKeyDeleted
    && report.cleanup.loggedOut;
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    operationCount: report.operationCount,
    bodyOperationCount: report.bodyOperationCount,
    rowCount: report.rows.length,
    cleanup: report.cleanup,
    reportPath
  })}\n`);
}

if (!report.ok) throw new Error("Developer OpenAPI security sweep failed.");

async function loginAdmin() {
  const response = await adminRequest("POST", "/admin/api/login", {
    json: {
      username: requiredEnv("ADMIN_USERNAME"),
      password: requiredEnv("ADMIN_PASSWORD")
    }
  });
  assert(response.status === 200, `Admin login returned HTTP ${response.status}.`);
  adminCookie = response.setCookie.split(";", 1)[0] ?? "";
  assert(adminCookie, "Admin login returned no session cookie.");
}

async function createKey(name) {
  const response = await adminRequest("POST", "/admin/api/openapi-keys", {
    json: { name: `${name}-${Date.now()}` }
  });
  assert(response.status === 201, `OpenAPI key creation returned HTTP ${response.status}.`);
  const id = response.body?.key?.id;
  const rawKey = response.body?.oneTimeKey?.rawKey;
  assert(typeof id === "string" && id, "OpenAPI key ID is missing.");
  assert(typeof rawKey === "string" && rawKey, "OpenAPI one-time key is missing.");
  return { id, rawKey };
}

async function deleteKey(keyId) {
  const response = await adminRequest(
    "DELETE",
    `/admin/api/openapi-keys/${encodeURIComponent(keyId)}`
  );
  assert(response.status === 200, `OpenAPI key deletion returned HTTP ${response.status}.`);
}

async function adminRequest(method, pathname, input = {}) {
  const response = await fetch(`${adminBaseUrl}${pathname}`, {
    method,
    headers: {
      ...(adminCookie ? { cookie: adminCookie } : {}),
      ...(method === "GET" ? {} : { origin: adminOrigin }),
      ...(input.json === undefined ? {} : { "content-type": "application/json" })
    },
    body: input.json === undefined ? undefined : JSON.stringify(input.json)
  });
  const body = await readBody(response);
  assertSafeBody(body, `admin:${method}:${pathname}`);
  return {
    status: response.status,
    body,
    setCookie: response.headers.get("set-cookie") ?? ""
  };
}

async function publicRequest(method, pathname, input = {}) {
  const startedAt = performance.now();
  const response = await fetch(`${publicBaseUrl}${pathname}`, {
    method,
    headers: {
      ...(input.authorization ? { authorization: input.authorization } : {}),
      ...(input.clientIp ? { "x-real-ip": input.clientIp } : {}),
      ...(input.contentType ? { "content-type": input.contentType } : {})
    },
    body: input.body
  });
  const body = await readBody(response);
  assertSafeBody(body, `${method}:${pathname}`);
  return {
    status: response.status,
    body,
    latencyMs: Number((performance.now() - startedAt).toFixed(3)),
    responseHeaders: ["content-type", "retry-after", "x-request-id"]
      .filter((name) => response.headers.has(name))
  };
}

async function publicDeclaredOversizedRequest(method, pathname, input) {
  const startedAt = performance.now();
  return new Promise((resolve, reject) => {
    const target = new URL(pathname, publicBaseUrl);
    const request = http.request(target, {
      method,
      headers: {
        authorization: input.authorization,
        "content-type": input.contentType,
        "content-length": String(input.declaredBytes),
        "x-real-ip": input.clientIp
      }
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        clearTimeout(timeout);
        const text = Buffer.concat(chunks).toString("utf8");
        let body = null;
        if (text) {
          try {
            body = JSON.parse(text);
          } catch {
            body = { textLength: text.length };
          }
        }
        try {
          assertSafeBody(body, `${method}:${pathname}:declared-oversized`);
          resolve({
            status: response.statusCode ?? 0,
            body,
            latencyMs: Number((performance.now() - startedAt).toFixed(3)),
            responseHeaders: ["content-type", "retry-after", "x-request-id"]
              .filter((name) => response.headers[name] !== undefined)
          });
        } catch (error) {
          reject(error);
        } finally {
          request.destroy();
        }
      });
    });
    const timeout = setTimeout(() => {
      request.destroy(new Error("Declared oversized request timed out."));
    }, 10_000);
    request.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    request.flushHeaders();
  });
}

async function readBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { textLength: text.length };
  }
}

function assertDeveloperError(operation, testCase, result, status, code) {
  assert(
    result.status === status
      && safeCode(result.body) === code
      && result.body?.error?.httpStatus === status
      && typeof result.body?.requestId === "string",
    `${operation.operationId} ${testCase} returned HTTP ${result.status} ${safeCode(result.body)}.`
  );
}

function record(operation, testCase, result) {
  report.rows.push({
    sequence: report.rows.length + 1,
    operationId: operation.operationId,
    method: operation.method,
    path: operation.path,
    case: testCase,
    status: result.status,
    errorCode: safeCode(result.body),
    latencyMs: result.latencyMs,
    responseHeaders: result.responseHeaders,
    pass: true
  });
}

function collectOperations(openApiDocument) {
  const methods = new Set(["delete", "get", "patch", "post", "put"]);
  return Object.entries(openApiDocument.paths ?? {}).flatMap(([routePath, pathItem]) =>
    Object.entries(pathItem ?? {}).flatMap(([method, operation]) => {
      if (!methods.has(method) || !operation?.operationId) return [];
      const mediaTypes = Object.keys(operation.requestBody?.content ?? {});
      assert(mediaTypes.length <= 1, `${operation.operationId} has multiple request media types.`);
      return [{
        operationId: operation.operationId,
        method: method.toUpperCase(),
        path: routePath,
        mediaType: mediaTypes[0] ?? null
      }];
    })
  ).sort((left, right) => left.operationId.localeCompare(right.operationId));
}

function concretePath(routePath) {
  return routePath.replace(/\{[^}]+\}/gu, "security-test-id");
}

function appendQuery(pathname, query) {
  return `${pathname}${pathname.includes("?") ? "&" : "?"}${query}`;
}

function traversalPath(pathname) {
  return `/openapi/v2/%252e%252e${pathname}`;
}

function safeCode(body) {
  return String(body?.error?.code ?? "");
}

function assertSafeBody(body, label) {
  const serialized = JSON.stringify(body ?? {});
  assert(
    !/(postgres(?:ql)?:\/\/|redis:\/\/|stack\s*trace|objectKey|s3_secret|sql\s+state|\/Users\/|C:\\)/iu.test(serialized),
    `${label} exposed internal data.`
  );
  assert(!activeRawKey || !serialized.includes(activeRawKey), `${label} exposed the active OpenAPI key.`);
  assert(!revokedRawKey || !serialized.includes(revokedRawKey), `${label} exposed the revoked OpenAPI key.`);
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

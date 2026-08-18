import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { buildAdminApiInventory } from "./lib/comprehensive-code-inventory.mjs";

const repositoryRoot = process.cwd();
const adminBaseUrl = `http://127.0.0.1:${process.env.ADMIN_API_PORT || "43010"}`;
const publicBaseUrl = `http://127.0.0.1:${process.env.PUBLIC_OPENAPI_PORT || "43210"}`;
const adminAllowedHost = process.env.FOCOWIKI_COMPREHENSIVE_ADMIN_ALLOWED_HOST
  || "admin.validation.test";
const publicAllowedHost = process.env.FOCOWIKI_COMPREHENSIVE_PUBLIC_ALLOWED_HOST
  || "openapi.validation.test";
const unexpectedHost = "unexpected.validation.test";
const reportPath = path.resolve(
  process.env.FOCOWIKI_COMPREHENSIVE_HOST_REPORT
    || "ReferenceDocs/validation/comprehensive-large-scale-release/production-host-sweep.json"
);
const adminRoutes = buildAdminApiInventory(repositoryRoot)
  .filter((item) => item.kind === "route")
  .sort((left, right) => `${left.method}:${left.path}`.localeCompare(`${right.method}:${right.path}`));
const openApiDocument = JSON.parse(
  fs.readFileSync("docs/public/openapi/focowiki-openapi.json", "utf8")
);
const openApiOperations = collectOpenApiOperations(openApiDocument);
const report = {
  kind: "focowiki-comprehensive-production-host-sweep",
  version: 1,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  ok: false,
  adminRouteCount: adminRoutes.length,
  openApiOperationCount: openApiOperations.length,
  rows: []
};

assert(adminRoutes.length === 67, `Expected 67 Admin routes, found ${adminRoutes.length}.`);
assert(openApiOperations.length === 42,
  `Expected 42 OpenAPI operations, found ${openApiOperations.length}.`);

for (const route of adminRoutes) {
  await exercise({
    surface: "admin-api",
    itemId: `${route.method}:${route.path}`,
    method: route.method,
    pathname: concreteAdminPath(route.path),
    baseUrl: adminBaseUrl,
    allowedHost: adminAllowedHost
  });
}
for (const operation of openApiOperations) {
  await exercise({
    surface: "developer-openapi",
    itemId: operation.operationId,
    method: operation.method,
    pathname: concreteOpenApiPath(operation.path),
    baseUrl: publicBaseUrl,
    allowedHost: publicAllowedHost
  });
}

const expectedRowCount = (adminRoutes.length + openApiOperations.length) * 2;
assert(report.rows.length === expectedRowCount, "Production Host sweep rows are incomplete.");
assert(
  new Set(report.rows.map((row) => `${row.surface}:${row.itemId}:${row.case}`)).size
    === report.rows.length,
  "Production Host sweep rows are not unique."
);
report.ok = true;
report.finishedAt = new Date().toISOString();
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({
  ok: report.ok,
  adminRouteCount: report.adminRouteCount,
  openApiOperationCount: report.openApiOperationCount,
  rowCount: report.rows.length,
  reportPath
})}\n`);

async function exercise(input) {
  const rejected = await request(input, unexpectedHost);
  assert(
    rejected.status === 400 && safeCode(rejected.body) === "UNEXPECTED_HOST",
    `${input.surface}:${input.itemId} rejected Host returned HTTP ${rejected.status} ${safeCode(rejected.body)}.`
  );
  record(input, "unexpected-host", rejected);

  const admitted = await request(input, input.allowedHost);
  assert(
    safeCode(admitted.body) !== "UNEXPECTED_HOST",
    `${input.surface}:${input.itemId} rejected its allowed Host.`
  );
  record(input, "allowed-host-next-boundary", admitted);
}

async function request(input, host) {
  const startedAt = performance.now();
  const response = await new Promise((resolve, reject) => {
    const request = http.request(`${input.baseUrl}${input.pathname}`, {
      method: input.method,
      headers: { host }
    }, (result) => {
      const chunks = [];
      result.on("data", (chunk) => chunks.push(chunk));
      result.on("end", () => resolve({
        status: result.statusCode ?? 0,
        headers: result.headers,
        text: Buffer.concat(chunks).toString("utf8")
      }));
    });
    request.once("error", reject);
    request.end();
  });
  const text = response.text;
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = { textLength: text.length }; }
  }
  assertSafe(body, `${input.surface}:${input.itemId}`);
  return {
    status: response.status,
    body,
    latencyMs: Number((performance.now() - startedAt).toFixed(3)),
    securityHeadersPresent: [
      "x-content-type-options",
      "x-frame-options",
      "strict-transport-security"
    ].every((name) => response.headers[name] !== undefined)
  };
}

function record(input, testCase, result) {
  report.rows.push({
    sequence: report.rows.length + 1,
    surface: input.surface,
    itemId: input.itemId,
    method: input.method,
    case: testCase,
    status: result.status,
    errorCode: safeCode(result.body),
    securityHeadersPresent: result.securityHeadersPresent,
    latencyMs: result.latencyMs,
    pass: true
  });
}

function collectOpenApiOperations(document) {
  const methods = new Set(["delete", "get", "patch", "post", "put"]);
  return Object.entries(document.paths ?? {}).flatMap(([routePath, pathItem]) =>
    Object.entries(pathItem ?? {}).flatMap(([method, operation]) =>
      methods.has(method) && operation?.operationId
        ? [{ operationId: operation.operationId, method: method.toUpperCase(), path: routePath }]
        : []
    )
  ).sort((left, right) => left.operationId.localeCompare(right.operationId));
}

function concreteAdminPath(routePath) {
  let pathname = routePath.replace(/:([A-Za-z][A-Za-z0-9]*)/gu, (_match, name) =>
    encodeURIComponent(`${name}-host`));
  if (routePath.endsWith("/files/detail")) pathname += "?path=index.md";
  return pathname;
}

function concreteOpenApiPath(routePath) {
  return routePath.replace(/\{[^}]+\}/gu, "host-test-id");
}

function safeCode(body) {
  return String(body?.error?.code ?? "");
}

function assertSafe(body, label) {
  const serialized = JSON.stringify(body ?? {});
  assert(
    !/(postgres(?:ql)?:\/\/|redis:\/\/|stack\s*trace|objectKey|s3_secret|sql\s+state|\/Users\/|C:\\)/iu.test(serialized),
    `${label} exposed internal data.`
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

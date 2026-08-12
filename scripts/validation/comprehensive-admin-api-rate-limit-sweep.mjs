import fs from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { buildAdminApiInventory } from "./lib/comprehensive-code-inventory.mjs";

loadLocalEnv();

const repositoryRoot = process.cwd();
const baseUrl = `http://127.0.0.1:${process.env.ADMIN_API_PORT || "43000"}`;
const trustedOrigin = process.env.ADMIN_PUBLIC_ORIGIN || "http://127.0.0.1:43100";
const reportPath = path.resolve(
  process.env.FOCOWIKI_COMPREHENSIVE_ADMIN_RATE_REPORT
    || "ReferenceDocs/validation/comprehensive-large-scale-release/admin-api-rate-limit-sweep.json"
);
const routes = buildAdminApiInventory(repositoryRoot)
  .filter((item) => item.kind === "route")
  .sort((left, right) => routeId(left).localeCompare(routeId(right)));
const report = {
  kind: "focowiki-comprehensive-admin-api-rate-limit-sweep",
  version: 1,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  ok: false,
  routeCount: routes.length,
  rows: [],
  cleanup: {
    runtimeSettingsRestored: false,
    loggedOut: false
  }
};

let cookie = "";
let originalRateLimits = null;

try {
  assert(routes.length === 67, `Expected 67 Admin routes, found ${routes.length}.`);
  assert(new Set(routes.map(routeId)).size === routes.length, "Admin route IDs are not unique.");
  await login("198.18.254.1");
  const runtime = await adminRequest("GET", "/admin/api/settings/runtime", {
    clientIp: "198.18.254.2"
  });
  assert(runtime.status === 200, `Runtime settings returned HTTP ${runtime.status}.`);
  originalRateLimits = runtime.body?.settings?.rateLimits ?? null;
  assert(originalRateLimits, "Runtime rate-limit settings are missing.");
  await updateRateLimits({
    ...originalRateLimits,
    adminApi: { max: 1, windowSeconds: 60 }
  }, "198.18.254.3");

  for (const [index, route] of routes.entries()) {
    const clientIp = `198.18.0.${index + 1}`;
    const admitted = await adminRequest("GET", "/admin/api/session", { clientIp });
    assert(
      admitted.status === 200 && admitted.body?.authenticated === true,
      `${routeId(route)} admission setup returned HTTP ${admitted.status}.`
    );
    record(route, "admitted", admitted);

    const limited = await adminRequest(route.method, concretePath(route.path), {
      clientIp,
      origin: isWrite(route.method) ? trustedOrigin : null
    });
    assert(
      limited.status === 429
        && safeCode(limited.body) === "RATE_LIMITED"
        && limited.headers.includes("retry-after"),
      `${routeId(route)} did not return the Admin 429 contract.`
    );
    record(route, "rate-limited", limited);
  }

  assert(report.rows.length === routes.length * 2, "Admin rate-limit rows are incomplete.");
  assert(
    new Set(report.rows.map((row) => `${row.routeId}:${row.case}`)).size === report.rows.length,
    "Admin rate-limit rows are not itemized uniquely."
  );
  report.ok = true;
} finally {
  if (cookie && originalRateLimits) {
    report.cleanup.runtimeSettingsRestored = await updateRateLimits(
      originalRateLimits,
      "198.18.254.4"
    ).then(() => true).catch(() => false);
  }
  if (cookie) {
    const logout = await adminRequest("POST", "/admin/api/logout", {
      clientIp: "198.18.254.5",
      origin: trustedOrigin,
      json: {}
    }).catch(() => null);
    report.cleanup.loggedOut = logout?.status === 200;
    cookie = "";
  }
  report.finishedAt = new Date().toISOString();
  report.ok = report.ok
    && report.cleanup.runtimeSettingsRestored
    && report.cleanup.loggedOut;
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    routeCount: report.routeCount,
    rowCount: report.rows.length,
    cleanup: report.cleanup,
    reportPath
  })}\n`);
}

if (!report.ok) throw new Error("Admin API rate-limit sweep failed.");

async function login(clientIp) {
  const response = await adminRequest("POST", "/admin/api/login", {
    clientIp,
    origin: trustedOrigin,
    withoutCookie: true,
    json: {
      username: requiredEnv("ADMIN_USERNAME"),
      password: requiredEnv("ADMIN_PASSWORD")
    }
  });
  assert(response.status === 200, `Admin login returned HTTP ${response.status}.`);
  cookie = response.setCookie.split(";", 1)[0] ?? "";
  assert(cookie, "Admin login returned no session cookie.");
}

async function updateRateLimits(value, clientIp) {
  const response = await adminRequest("PUT", "/admin/api/settings/rate-limits", {
    clientIp,
    origin: trustedOrigin,
    json: value
  });
  assert(response.status === 200, `Rate-limit update returned HTTP ${response.status}.`);
}

async function adminRequest(method, pathname, input = {}) {
  const headers = {
    ...(cookie && !input.withoutCookie ? { cookie } : {}),
    ...(input.origin ? { origin: input.origin } : {}),
    ...(input.clientIp ? { "x-real-ip": input.clientIp } : {}),
    ...(input.json === undefined ? {} : { "content-type": "application/json" })
  };
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: input.json === undefined ? undefined : JSON.stringify(input.json)
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = { textLength: text.length }; }
  }
  assertSafe(body, `${method}:${pathname}`);
  return {
    status: response.status,
    body,
    setCookie: response.headers.get("set-cookie") ?? "",
    latencyMs: Number((performance.now() - startedAt).toFixed(3)),
    headers: ["content-type", "retry-after"]
      .filter((name) => response.headers.has(name))
  };
}

function record(route, testCase, result) {
  report.rows.push({
    sequence: report.rows.length + 1,
    routeId: routeId(route),
    method: route.method,
    path: route.path,
    case: testCase,
    status: result.status,
    errorCode: safeCode(result.body),
    latencyMs: result.latencyMs,
    responseHeaders: result.headers,
    pass: true
  });
}

function concretePath(routePath) {
  let pathname = routePath.replace(/:([A-Za-z][A-Za-z0-9]*)/gu, (_match, name) =>
    encodeURIComponent(`${name}-rate-limit`));
  if (routePath.endsWith("/files/detail")) pathname += "?path=index.md";
  return pathname;
}

function routeId(route) {
  return `${route.method}:${route.path}`;
}

function isWrite(method) {
  return method !== "GET";
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

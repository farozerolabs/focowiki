import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { buildAdminApiInventory } from "./lib/comprehensive-code-inventory.mjs";

loadLocalEnv();

const repositoryRoot = process.cwd();
const port = Number(process.env.ADMIN_API_PORT || "43000");
const baseUrl = `http://127.0.0.1:${port}`;
const trustedOrigin = process.env.ADMIN_PUBLIC_ORIGIN || "http://127.0.0.1:43100";
const reportPath = path.resolve(
  process.env.FOCOWIKI_COMPREHENSIVE_ADMIN_CANCELLATION_REPORT
    || "ReferenceDocs/validation/comprehensive-large-scale-release/admin-api-cancellation-sweep.json"
);
const routes = buildAdminApiInventory(repositoryRoot)
  .filter((item) => item.kind === "route")
  .sort((left, right) => routeId(left).localeCompare(routeId(right)));
const report = {
  kind: "focowiki-comprehensive-admin-api-cancellation-sweep",
  version: 1,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  ok: false,
  routeCount: routes.length,
  rows: [],
  cleanup: { loggedOut: false }
};

let cookie = "";

try {
  assert(routes.length === 67, `Expected 67 Admin routes, found ${routes.length}.`);
  await login();
  for (const route of routes) {
    const startedAt = performance.now();
    const stage = isWrite(route.method) ? "partial-body" : "partial-headers";
    await cancelRequest(route, stage);
    const session = await jsonRequest("GET", "/admin/api/session");
    assert(
      session.status === 200 && session.body?.authenticated === true,
      `${routeId(route)} cancellation left the Admin API unhealthy.`
    );
    report.rows.push({
      sequence: report.rows.length + 1,
      routeId: routeId(route),
      method: route.method,
      path: route.path,
      cancellationStage: stage,
      followupStatus: session.status,
      latencyMs: Number((performance.now() - startedAt).toFixed(3)),
      pass: true
    });
  }
  assert(report.rows.length === routes.length, "Admin cancellation rows are incomplete.");
  assert(new Set(report.rows.map((row) => row.routeId)).size === routes.length,
    "Admin cancellation rows are not unique.");
  report.ok = true;
} finally {
  if (cookie) {
    const logout = await jsonRequest("POST", "/admin/api/logout", { json: {} }).catch(() => null);
    report.cleanup.loggedOut = logout?.status === 200;
    cookie = "";
  }
  report.finishedAt = new Date().toISOString();
  report.ok = report.ok && report.cleanup.loggedOut;
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

if (!report.ok) throw new Error("Admin API cancellation sweep failed.");

async function login() {
  const response = await jsonRequest("POST", "/admin/api/login", {
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

async function cancelRequest(route, stage) {
  const pathname = concretePath(route.path);
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`${routeId(route)} cancellation socket timed out.`));
    }, 2_000);
    socket.once("error", (error) => {
      clearTimeout(timeout);
      if (error.code === "ECONNRESET" || error.code === "EPIPE") resolve();
      else reject(error);
    });
    socket.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once("connect", () => {
      const headers = [
        `${route.method} ${pathname} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        ...(route.path === "/admin/api/login" ? [] : [`Cookie: ${cookie}`]),
        ...(isWrite(route.method) ? [
          `Origin: ${trustedOrigin}`,
          `Content-Type: ${isMarkdownBodyRoute(route) ? "text/markdown" : "application/json"}`,
          "Content-Length: 4096"
        ] : [])
      ];
      if (stage === "partial-body") {
        socket.write(`${headers.join("\r\n")}\r\n\r\npartial-request`);
      } else {
        socket.write(`${headers.join("\r\n")}\r\n`);
      }
      setTimeout(() => socket.destroy(), 5);
    });
  });
}

async function jsonRequest(method, pathname, input = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(cookie && !input.withoutCookie ? { cookie } : {}),
      ...(method === "GET" ? {} : { origin: trustedOrigin }),
      ...(input.json === undefined ? {} : { "content-type": "application/json" })
    },
    body: input.json === undefined ? undefined : JSON.stringify(input.json)
  });
  const body = await response.json().catch(() => null);
  assertSafe(body, `${method}:${pathname}`);
  return {
    status: response.status,
    body,
    setCookie: response.headers.get("set-cookie") ?? ""
  };
}

function concretePath(routePath) {
  let pathname = routePath.replace(/:([A-Za-z][A-Za-z0-9]*)/gu, (_match, name) =>
    encodeURIComponent(`${name}-cancel`));
  if (routePath.endsWith("/files/detail")) pathname += "?path=index.md";
  return pathname;
}

function isMarkdownBodyRoute(route) {
  return route.method === "PUT" && route.path.endsWith("/content");
}

function isWrite(method) {
  return method !== "GET";
}

function routeId(route) {
  return `${route.method}:${route.path}`;
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

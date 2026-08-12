import fs from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { buildAdminApiInventory } from "./lib/comprehensive-code-inventory.mjs";

loadLocalEnv();

const repositoryRoot = process.cwd();
const baseUrl = `http://127.0.0.1:${process.env.ADMIN_API_PORT || "43000"}`;
const trustedOrigin = process.env.ADMIN_PUBLIC_ORIGIN || "http://127.0.0.1:43100";
const untrustedOrigin = "https://untrusted.example";
const expectOversizedBody = process.env.FOCOWIKI_COMPREHENSIVE_EXPECT_OVERSIZED_BODY === "true";
const configuredBodyLimit = Number(process.env.GENERATED_CONTENT_MAX_BYTES || "10485760");
const reportPath = path.resolve(
  process.env.FOCOWIKI_COMPREHENSIVE_ADMIN_SECURITY_REPORT
    || "ReferenceDocs/validation/comprehensive-large-scale-release/admin-api-security-sweep.json"
);
const routes = buildAdminApiInventory(repositoryRoot)
  .filter((item) => item.kind === "route")
  .sort((left, right) => `${left.method}:${left.path}`.localeCompare(`${right.method}:${right.path}`));
const report = {
  kind: "focowiki-comprehensive-admin-api-security-sweep",
  version: 1,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  ok: false,
  routeCount: routes.length,
  rows: [],
  cleanup: { loggedOut: false }
};
let authenticatedCookie = "";
let expiredCookie = "";

try {
  assert(routes.length > 0, "Admin API route inventory is empty.");
  assert(
    new Set(routes.map(routeId)).size === routes.length,
    "Admin API route inventory contains duplicate route identities."
  );

  authenticatedCookie = await login();
  const cookieName = authenticatedCookie.split("=", 1)[0];
  assert(cookieName, "Admin session cookie name is missing.");
  await recordInvalidLogin();
  await recordCredentialQuery(routes.find((item) => item.method === "POST" && item.path === "/admin/api/login"));

  const securityRoutes = [...routes].sort((left, right) =>
    Number(left.path === "/admin/api/logout") - Number(right.path === "/admin/api/logout"));
  for (const route of securityRoutes) {
    if (route.method === "POST" && route.path === "/admin/api/login") continue;
    const pathname = concretePath(route.path);
    const unauthenticated = await requestRoute(route, pathname, {
      cookie: "",
      origin: isWrite(route.method) ? trustedOrigin : null,
      clientIp: "198.51.100.1"
    });
    assertUnauthorized(route, unauthenticated, "missing-session");
    report.rows.push(resultRow(route, "missing-session", unauthenticated));

    const invalidSession = await requestRoute(route, pathname, {
      cookie: `${cookieName}=invalid-session-value`,
      origin: isWrite(route.method) ? trustedOrigin : null,
      clientIp: "198.51.100.2"
    });
    assertUnauthorized(route, invalidSession, "invalid-session");
    report.rows.push(resultRow(route, "invalid-session", invalidSession));

    if (isWrite(route.method)) {
      const untrusted = await requestRoute(route, pathname, {
        cookie: authenticatedCookie,
        origin: untrustedOrigin,
        clientIp: "198.51.100.3"
      });
      assert(
        untrusted.status === 403 && untrusted.body?.error?.code === "INVALID_ORIGIN",
        `${routeId(route)} untrusted-origin returned HTTP ${untrusted.status} ${safeCode(untrusted.body)}.`
      );
      report.rows.push(resultRow(route, "untrusted-origin", untrusted));
    }

    const credentialQuery = await requestRoute(route, appendQuery(pathname, "token=credential-query-rejected"), {
      cookie: authenticatedCookie,
      origin: isWrite(route.method) ? trustedOrigin : null,
      clientIp: "198.51.100.4"
    });
    assertUnauthorized(route, credentialQuery, "credential-query");
    report.rows.push(resultRow(route, "credential-query", credentialQuery));
  }

  for (const route of routes) {
    const pathname = concretePath(route.path);
    const unsupportedMethod = await rawRequest("PROPFIND", pathname, {
      cookie: authenticatedCookie,
      origin: trustedOrigin,
      clientIp: "198.51.100.5"
    });
    assert(
      unsupportedMethod.status === 404 && safeCode(unsupportedMethod.body) === "NOT_FOUND",
      `${routeId(route)} unsupported-method returned HTTP ${unsupportedMethod.status} ${safeCode(unsupportedMethod.body)}.`
    );
    report.rows.push(resultRow(route, "unsupported-method", unsupportedMethod));

    if (isWrite(route.method)) {
      const unsupportedMediaType = await rawRequest(route.method, pathname, {
        cookie: route.path === "/admin/api/login" ? "" : authenticatedCookie,
        origin: trustedOrigin,
        clientIp: "198.51.100.6",
        contentType: "application/xml",
        rawBody: "{}"
      });
      assert(
        unsupportedMediaType.status === 415
          && safeCode(unsupportedMediaType.body) === "UNSUPPORTED_MEDIA_TYPE",
        `${routeId(route)} unsupported-media-type returned HTTP ${unsupportedMediaType.status} ${safeCode(unsupportedMediaType.body)}.`
      );
      report.rows.push(resultRow(route, "unsupported-media-type", unsupportedMediaType));

      if (!isMarkdownBodyRoute(route)) {
        const malformedBody = await rawRequest(route.method, pathname, {
          cookie: route.path === "/admin/api/login" ? "" : authenticatedCookie,
          origin: trustedOrigin,
          clientIp: "198.51.100.7",
          contentType: "application/json",
          rawBody: "{"
        });
        assert(
          malformedBody.status === 400 && safeCode(malformedBody.body) === "MALFORMED_JSON",
          `${routeId(route)} malformed-body returned HTTP ${malformedBody.status} ${safeCode(malformedBody.body)}.`
        );
        report.rows.push(resultRow(route, "malformed-body", malformedBody));
      }

      if (expectOversizedBody) {
        assert(
          Number.isInteger(configuredBodyLimit) && configuredBodyLimit > 0,
          "GENERATED_CONTENT_MAX_BYTES must be a positive integer for oversized-body validation."
        );
        const oversizedBody = await rawRequest(route.method, pathname, {
          cookie: route.path === "/admin/api/login" ? "" : authenticatedCookie,
          origin: trustedOrigin,
          clientIp: "198.51.100.15",
          contentType: isMarkdownBodyRoute(route) ? "text/markdown" : "application/json",
          rawBody: "x".repeat(configuredBodyLimit + 1)
        });
        assert(
          oversizedBody.status === 413 && safeCode(oversizedBody.body) === "PAYLOAD_TOO_LARGE",
          `${routeId(route)} oversized-body returned HTTP ${oversizedBody.status} ${safeCode(oversizedBody.body)}.`
        );
        report.rows.push(resultRow(route, "oversized-body", oversizedBody));
      }
    }

    const traversal = await requestRoute(route, traversalPath(pathname), {
      cookie: route.path === "/admin/api/login" ? "" : authenticatedCookie,
      origin: isWrite(route.method) ? trustedOrigin : null,
      clientIp: "198.51.100.8"
    });
    assert(
      traversal.status === 400 && safeCode(traversal.body) === "INVALID_PATH",
      `${routeId(route)} traversal returned HTTP ${traversal.status} ${safeCode(traversal.body)}.`
    );
    report.rows.push(resultRow(route, "traversal", traversal));

    const injection = await requestRoute(
      route,
      appendQuery(pathname, "query=%27%20OR%201%3D1--%20%3Cscript%3E"),
      {
        cookie: route.path === "/admin/api/login" ? "" : authenticatedCookie,
        origin: isWrite(route.method) ? trustedOrigin : null,
        clientIp: "198.51.100.16"
      }
    );
    assert(
      injection.status < 500 && safeCode(injection.body) !== "INTERNAL_ERROR",
      `${routeId(route)} injection returned HTTP ${injection.status} ${safeCode(injection.body)}.`
    );
    report.rows.push(resultRow(route, "injection", injection));
    if (route.path === "/admin/api/logout" && injection.status === 200) {
      expiredCookie = authenticatedCookie;
      authenticatedCookie = "";
    }
  }

  if (!expiredCookie) {
    expiredCookie = authenticatedCookie;
    const expiredLogout = await rawRequest("POST", "/admin/api/logout", {
      cookie: expiredCookie,
      origin: trustedOrigin,
      clientIp: "198.51.100.9",
      json: {}
    });
    assert(expiredLogout.status === 200, `Admin session expiry setup returned HTTP ${expiredLogout.status}.`);
    authenticatedCookie = "";
  }
  for (const route of routes) {
    if (route.path === "/admin/api/login") continue;
    const expired = await requestRoute(route, concretePath(route.path), {
      cookie: expiredCookie,
      origin: isWrite(route.method) ? trustedOrigin : null,
      clientIp: "198.51.100.10"
    });
    assertUnauthorized(route, expired, "expired-session");
    report.rows.push(resultRow(route, "expired-session", expired));
  }
  authenticatedCookie = await login("198.51.100.11");

  assert(
    new Set(report.rows.map((row) => `${row.routeId}:${row.case}`)).size === report.rows.length,
    "Admin API security rows are not itemized uniquely."
  );
  report.ok = true;
} finally {
  if (authenticatedCookie) {
    const logout = await rawRequest("POST", "/admin/api/logout", {
      cookie: authenticatedCookie,
      origin: trustedOrigin,
      json: {}
    }).catch(() => null);
    report.cleanup.loggedOut = logout?.status === 200;
  }
  report.finishedAt = new Date().toISOString();
  report.ok = report.ok && report.cleanup.loggedOut;
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600
  });
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    routeCount: report.routeCount,
    rowCount: report.rows.length,
    cleanup: report.cleanup,
    reportPath
  })}\n`);
}

async function recordInvalidLogin() {
  const result = await rawRequest("POST", "/admin/api/login", {
    origin: trustedOrigin,
    clientIp: "198.51.100.12",
    json: { username: "invalid", password: "invalid" }
  });
  assert(
    [401, 429].includes(result.status)
      && ["UNAUTHORIZED", "RATE_LIMITED"].includes(safeCode(result.body)),
    `POST:/admin/api/login invalid-login returned HTTP ${result.status} ${safeCode(result.body)}.`
  );
  const route = routes.find((item) => item.method === "POST" && item.path === "/admin/api/login");
  assert(route, "Admin login route is absent from the inventory.");
  report.rows.push(resultRow(route, "invalid-credentials", result));
}

async function recordCredentialQuery(route) {
  assert(route, "Admin login route is absent from the inventory.");
  const result = await rawRequest("POST", "/admin/api/login?password=credential-query-rejected", {
    origin: trustedOrigin,
    clientIp: "198.51.100.13",
    json: {}
  });
  assert(
    result.status === 400 && safeCode(result.body) === "CREDENTIALS_IN_URL_NOT_ALLOWED",
    `POST:/admin/api/login credential-query returned HTTP ${result.status} ${safeCode(result.body)}.`
  );
  report.rows.push(resultRow(route, "credential-query", result));
}

async function login(clientIp = "198.51.100.14") {
  const result = await rawRequest("POST", "/admin/api/login", {
    origin: trustedOrigin,
    clientIp,
    json: {
      username: requiredEnv("ADMIN_USERNAME"),
      password: requiredEnv("ADMIN_PASSWORD")
    }
  });
  assert(result.status === 200, `Admin login returned HTTP ${result.status}.`);
  const cookie = result.setCookie.split(";", 1)[0] ?? "";
  assert(cookie, "Admin login returned no session cookie.");
  return cookie;
}

async function requestRoute(route, pathname, input) {
  return rawRequest(route.method, pathname, {
    cookie: input.cookie,
    origin: input.origin,
    clientIp: input.clientIp,
    ...(!isWrite(route.method)
      ? {}
      : route.method === "PUT" && route.path.endsWith("/content")
      ? { contentType: "text/markdown", rawBody: "# security sweep" }
      : { json: {} })
  });
}

async function rawRequest(method, pathname, input = {}) {
  const headers = {
    ...(input.cookie ? { cookie: input.cookie } : {}),
    ...(input.origin ? { origin: input.origin } : {}),
    ...(input.clientIp ? { "x-real-ip": input.clientIp } : {}),
    ...(input.contentType ? { "content-type": input.contentType } : {}),
    ...(input.json !== undefined ? { "content-type": "application/json" } : {})
  };
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: input.rawBody ?? (input.json === undefined ? undefined : JSON.stringify(input.json))
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { textLength: text.length };
    }
  }
  assertSafeBody(body, `${method}:${pathname}`);
  return {
    status: response.status,
    body,
    setCookie: response.headers.get("set-cookie") ?? "",
    latencyMs: Number((performance.now() - startedAt).toFixed(3))
  };
}

function resultRow(route, testCase, result) {
  return {
    routeId: routeId(route),
    method: route.method,
    path: route.path,
    source: route.source,
    case: testCase,
    status: result.status,
    errorCode: safeCode(result.body),
    latencyMs: result.latencyMs,
    pass: true
  };
}

function concretePath(routePath) {
  const replacements = {
    knowledgeBaseId: "knowledge-base-security-sweep",
    sourceFileId: "source-file-security-sweep",
    directoryId: "source-directory-security-sweep",
    operationId: "operation-security-sweep",
    sessionId: "upload-session-security-sweep",
    entryId: "upload-entry-security-sweep",
    keyId: "openapi-key-security-sweep",
    configurationId: "configuration-security-sweep",
    modelId: "model-security-sweep",
    action: "activate"
  };
  let pathname = routePath.replace(/:([A-Za-z][A-Za-z0-9]*)/gu, (_match, name) =>
    encodeURIComponent(replacements[name] ?? `${name}-security-sweep`));
  if (routePath.endsWith("/files/detail")) pathname += "?path=index.md";
  return pathname;
}

function appendQuery(pathname, query) {
  return `${pathname}${pathname.includes("?") ? "&" : "?"}${query}`;
}

function traversalPath(pathname) {
  const suffix = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `/admin/api/%252e%252e${suffix}`;
}

function assertUnauthorized(route, result, testCase) {
  assert(
    result.status === 401 && safeCode(result.body) === "UNAUTHORIZED",
    `${routeId(route)} ${testCase} returned HTTP ${result.status} ${safeCode(result.body)}.`
  );
}

function assertSafeBody(body, label) {
  const serialized = JSON.stringify(body ?? {});
  assert(
    !/(postgres(?:ql)?:\/\/|redis:\/\/|stack\s*trace|objectKey|s3_secret|sql\s+state)/iu.test(serialized),
    `${label} exposed internal data.`
  );
}

function routeId(route) {
  return `${route.method}:${route.path}`;
}

function safeCode(body) {
  return String(body?.error?.code ?? "");
}

function isWrite(method) {
  return method !== "GET";
}

function isMarkdownBodyRoute(route) {
  return route.method === "PUT" && route.path.endsWith("/content");
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

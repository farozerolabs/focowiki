import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadEnvFile } from "node:process";
import { redactReportText } from "./lib/redaction.mjs";

loadLocalEnv();

const adminBaseUrl = `http://127.0.0.1:${process.env.ADMIN_API_PORT || "43000"}`;
const developerBaseUrl = `http://127.0.0.1:${process.env.PUBLIC_OPENAPI_PORT || "43200"}`;
const origin = process.env.ADMIN_PUBLIC_ORIGIN || "http://127.0.0.1:43100";
const runId = `full-system-e2e-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8)}`;
const reportDir = path.resolve(
  process.env.FOCOWIKI_FULL_SYSTEM_REPORT_DIR ||
    "ReferenceDocs/validate-focowiki-full-system-e2e"
);
const report = {
  kind: "full-system-core-blackbox",
  runId,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  ok: false,
  checks: [],
  created: { knowledgeBaseIds: [], keyIds: [] },
  failures: []
};

let adminCookie = "";
let publicKey = "";
let publicKeyId = "";

try {
  await checkHealth();
  await checkAdminAuthentication();
  const adminKnowledgeBase = await checkAdminKnowledgeBaseLifecycle();
  const key = await createDeveloperKey();
  publicKey = key.rawKey;
  publicKeyId = key.id;
  await checkDeveloperLifecycle();
  await deleteAdminKnowledgeBase(adminKnowledgeBase.id);
  await revokeDeveloperKey();
  await expectStatus(
    `${developerBaseUrl}/openapi/v2/health`,
    { headers: { authorization: `Bearer ${publicKey}` } },
    401,
    "revoked-developer-key"
  );
  await checkLogout();
  report.ok = true;
} catch (error) {
  report.failures.push(error instanceof Error ? error.message : String(error));
  throw error;
} finally {
  await cleanup();
  report.finishedAt = new Date().toISOString();
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(
    path.join(reportDir, "core-blackbox-report.json"),
    `${redactReportText(JSON.stringify(report, null, 2))}\n`
  );
}

async function checkHealth() {
  await expectStatus(`${adminBaseUrl}/healthz`, {}, 200, "admin-health");
  await expectStatus(`${developerBaseUrl}/healthz`, {}, 200, "developer-plane-health");
  await expectStatus(`${developerBaseUrl}/openapi/v2/health`, {}, 401, "developer-auth-required");
}

async function checkAdminAuthentication() {
  await expectJson(
    `${adminBaseUrl}/admin/api/login`,
    {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ username: "invalid", password: "invalid" })
    },
    401,
    "invalid-admin-login"
  );

  const login = await expectJson(
    `${adminBaseUrl}/admin/api/login`,
    {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        username: requiredEnv("ADMIN_USERNAME"),
        password: requiredEnv("ADMIN_PASSWORD")
      })
    },
    200,
    "valid-admin-login"
  );
  adminCookie = login.response.headers.get("set-cookie")?.split(";")[0] || "";
  assert(adminCookie, "Admin login did not return a session cookie.");
  await adminJson("/admin/api/session", {}, 200, "admin-session");
}

async function checkAdminKnowledgeBaseLifecycle() {
  await expectJson(
    `${adminBaseUrl}/admin/api/knowledge-bases`,
    {
      method: "POST",
      headers: {
        cookie: adminCookie,
        origin: "https://untrusted.example",
        "content-type": "application/json"
      },
      body: JSON.stringify({ name: `${runId}-rejected` })
    },
    403,
    "admin-origin-protection"
  );

  const created = await adminJson(
    "/admin/api/knowledge-bases",
    {
      method: "POST",
      body: { name: `${runId}-admin`, description: "Core black-box validation" }
    },
    201,
    "admin-create-knowledge-base"
  );
  const knowledgeBase = created.body.knowledgeBase;
  assert(knowledgeBase?.id, "Admin knowledge-base response is missing an ID.");
  report.created.knowledgeBaseIds.push(knowledgeBase.id);

  await adminJson(
    `/admin/api/knowledge-bases?query=${encodeURIComponent(runId)}&limit=10`,
    {},
    200,
    "admin-list-search"
  );
  await adminJson(
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBase.id)}`,
    {},
    200,
    "admin-get-knowledge-base"
  );

  const updated = await adminJson(
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBase.id)}`,
    {
      method: "PATCH",
      headers: { "if-match": String(knowledgeBase.resourceRevision) },
      body: { name: `${runId}-admin-updated`, description: "Updated core validation" }
    },
    200,
    "admin-update-knowledge-base"
  );
  assert(
    updated.body.knowledgeBase.resourceRevision > knowledgeBase.resourceRevision,
    "Admin metadata update did not increment resource revision."
  );
  await adminJson(
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBase.id)}`,
    {
      method: "PATCH",
      headers: { "if-match": String(knowledgeBase.resourceRevision) },
      body: { name: `${runId}-stale` }
    },
    409,
    "admin-stale-revision"
  );

  return updated.body.knowledgeBase;
}

async function createDeveloperKey() {
  const created = await adminJson(
    "/admin/api/openapi-keys",
    { method: "POST", body: { name: `${runId}-key` } },
    201,
    "admin-create-openapi-key"
  );
  const key = {
    id: created.body.key?.id,
    rawKey: created.body.oneTimeKey?.rawKey
  };
  assert(key.id && key.rawKey, "Developer key response is incomplete.");
  report.created.keyIds.push(key.id);
  await adminJson("/admin/api/openapi-keys?limit=10", {}, 200, "admin-list-openapi-keys");
  return key;
}

async function checkDeveloperLifecycle() {
  for (const [pathname, check] of [
    ["/openapi/v2/health", "developer-health"],
    ["/openapi/v2/version", "developer-version"],
    ["/openapi/v2/openapi.json", "developer-contract"],
    ["/openapi/v2/knowledge-bases?limit=10", "developer-list-knowledge-bases"]
  ]) {
    await developerJson(pathname, {}, 200, check);
  }

  const created = await developerJson(
    "/openapi/v2/knowledge-bases",
    {
      method: "POST",
      body: { name: `${runId}-developer`, description: "Developer black-box validation" }
    },
    201,
    "developer-create-knowledge-base"
  );
  const knowledgeBase = created.body.knowledgeBase;
  assert(
    knowledgeBase?.knowledgeBaseId,
    "Developer knowledge-base response is missing a knowledgeBaseId."
  );
  report.created.knowledgeBaseIds.push(knowledgeBase.knowledgeBaseId);

  await developerJson(
    `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBase.knowledgeBaseId)}`,
    {},
    200,
    "developer-get-knowledge-base"
  );
  const updated = await developerJson(
    `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBase.knowledgeBaseId)}`,
    {
      method: "PATCH",
      headers: { "if-match": String(knowledgeBase.resourceRevision) },
      body: { name: `${runId}-developer-updated` }
    },
    200,
    "developer-update-knowledge-base"
  );
  await developerJson(
    `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBase.knowledgeBaseId)}`,
    {
      method: "DELETE",
      headers: {
        "if-match": String(updated.body.knowledgeBase.resourceRevision),
        "idempotency-key": randomUUID()
      }
    },
    202,
    "developer-delete-knowledge-base"
  );
  await developerJson(
    `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBase.knowledgeBaseId)}`,
    {},
    404,
    "developer-deleted-knowledge-base"
  );
}

async function deleteAdminKnowledgeBase(knowledgeBaseId) {
  await adminJson(
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`,
    { method: "DELETE" },
    200,
    "admin-delete-knowledge-base"
  );
}

async function revokeDeveloperKey() {
  await adminJson(
    `/admin/api/openapi-keys/${encodeURIComponent(publicKeyId)}`,
    { method: "DELETE" },
    200,
    "admin-revoke-openapi-key"
  );
  publicKeyId = "";
}

async function checkLogout() {
  await adminJson("/admin/api/logout", { method: "POST" }, 200, "admin-logout");
  await adminJson("/admin/api/session", {}, 401, "admin-session-after-logout");
  adminCookie = "";
}

async function cleanup() {
  if (!adminCookie) {
    await loginForCleanup().catch(() => undefined);
  }
  if (publicKeyId) {
    await adminJson(
      `/admin/api/openapi-keys/${encodeURIComponent(publicKeyId)}`,
      { method: "DELETE" },
      200,
      "cleanup-openapi-key"
    ).catch(() => undefined);
  }
  for (const knowledgeBaseId of report.created.knowledgeBaseIds) {
    await adminJson(
      `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`,
      { method: "DELETE" },
      200,
      "cleanup-knowledge-base"
    ).catch(() => undefined);
  }
}

async function loginForCleanup() {
  const response = await fetch(`${adminBaseUrl}/admin/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({
      username: requiredEnv("ADMIN_USERNAME"),
      password: requiredEnv("ADMIN_PASSWORD")
    })
  });
  adminCookie = response.headers.get("set-cookie")?.split(";")[0] || "";
}

async function adminJson(pathname, options, expectedStatus, check) {
  const headers = {
    ...(adminCookie ? { cookie: adminCookie } : {}),
    ...(options.method && options.method !== "GET" ? { origin } : {}),
    ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
    ...(options.headers ?? {})
  };
  return expectJson(
    `${adminBaseUrl}${pathname}`,
    {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    },
    expectedStatus,
    check
  );
}

async function developerJson(pathname, options, expectedStatus, check) {
  return expectJson(
    `${developerBaseUrl}${pathname}`,
    {
      method: options.method ?? "GET",
      headers: {
        authorization: `Bearer ${publicKey}`,
        ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(options.headers ?? {})
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    },
    expectedStatus,
    check
  );
}

async function expectStatus(url, options, expectedStatus, check) {
  const response = await fetch(url, options);
  assert(response.status === expectedStatus, `${check} returned HTTP ${response.status}.`);
  recordCheck(check, response.status);
  return response;
}

async function expectJson(url, options, expectedStatus, check) {
  const response = await fetch(url, options);
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  assert(response.status === expectedStatus, `${check} returned HTTP ${response.status}.`);
  assertSafeBody(body, check);
  recordCheck(check, response.status);
  return { response, body };
}

function assertSafeBody(body, check) {
  const serialized = JSON.stringify(body ?? {});
  assert(!/(postgres(?:ql)?:\/\/|redis:\/\/|stack\s*trace|s3_secret|objectKey)/i.test(serialized), `${check} exposed internal data.`);
}

function recordCheck(name, status) {
  report.checks.push({ name, status, ok: true });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function loadLocalEnv() {
  const envFile = process.env.ENV_FILE || ".env";
  if (fs.existsSync(envFile)) loadEnvFile(envFile);
}

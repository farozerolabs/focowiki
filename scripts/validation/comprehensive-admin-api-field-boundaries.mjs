import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { buildAdminApiInventory } from "./lib/comprehensive-code-inventory.mjs";
import {
  adminRateLimitDrainWaitMs,
  createAdminBoundaryRateLimitLease,
  createPublicationIntervalLease
} from "./lib/comprehensive-admin-field-matrix.mjs";
import { uploadMarkdownFilesWithSession } from "./lib/upload-session-client.mjs";

loadLocalEnv();

const repositoryRoot = process.cwd();
const baseUrl = `http://127.0.0.1:${process.env.ADMIN_API_PORT || "43000"}`;
const origin = process.env.ADMIN_PUBLIC_ORIGIN || "http://127.0.0.1:43100";
const reportPath = path.resolve(
  process.env.FOCOWIKI_COMPREHENSIVE_ADMIN_FIELD_REPORT
    || "ReferenceDocs/validation/comprehensive-large-scale-release/admin-api-field-boundaries.json"
);
const runId = `clr-admin-fields-${randomUUID().slice(0, 8)}`;
const adminApiInventory = buildAdminApiInventory(repositoryRoot);
const requestFieldInventory = adminApiInventory
  .filter((item) => item.kind === "request-field");
const expectedRequestFieldNames = [...new Set(requestFieldInventory.map((item) => item.name))].sort();
const expectedBodyFieldNames = [...new Set(adminApiInventory
  .filter((item) => item.kind === "body-field")
  .map((item) => item.name))].sort();
const report = {
  kind: "focowiki-comprehensive-admin-api-field-boundaries",
  version: 1,
  runId,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  ok: false,
  expectedRequestFieldCount: expectedRequestFieldNames.length,
  expectedBodyFieldCount: expectedBodyFieldNames.length,
  rows: [],
  bodyCoverage: [],
  bodyFieldCoverage: [],
  referencedBodyFieldCoverage: [],
  missingBodyFields: [],
  requestFieldCoverage: [],
  missingRequestFields: [],
  referencedFieldEvidence: {
    runtimeSettings: "runtime-settings-fields.json:75 fields/1104 cases",
    generationEmbeddingReranker: "tasks 8.1-8.4 and live-model-probe-after-model-fixes.json"
  },
  cleanup: {
    uploadSessionCancelled: false,
    adminApiRateWindowWaitMs: 0,
    adminApiRequestCount: 0,
    embeddingConfigurationsDeleted: 0,
    openApiKeysDeleted: 0,
    rerankerConfigurationsDeleted: 0,
    knowledgeBasesDeleted: 0,
    publicationSettingsRestored: false,
    rateLimitsRestored: false,
    loggedOut: false
  }
};

let cookie = "";
let primaryKnowledgeBaseId = "";
let primaryResourceRevision = 0;
let uploadSessionId = "";
let existingSourceFixture = null;
let existingDirectoryFixture = null;
const knowledgeBaseIds = new Set();
const uploadSessionOwners = new Map();
const embeddingConfigurationRevisions = new Map();
const openApiKeyIds = new Set();
const rerankerConfigurationRevisions = new Map();
let originalRateLimits = null;
let originalPublicationSettings = null;
let adminApiRateWindowStartedAt = 0;
let adminApiRequestCount = 0;

try {
  assert(expectedRequestFieldNames.length === 24,
    `Expected 24 unique Admin request fields, found ${expectedRequestFieldNames.length}.`);
  adminApiRateWindowStartedAt = Date.now();
  await login();
  await prepareLoginBoundaryCapacity();

  await execute({
    id: "header:cookie:invalid",
    covers: ["header:cookie"],
    method: "GET",
    pathname: "/admin/api/session",
    cookieOverride: "focowiki_admin_session=invalid",
    expectedStatus: 401,
    expectedCode: "UNAUTHORIZED"
  });
  await execute({
    id: "header:content-type:unsupported",
    covers: ["header:content-type"],
    method: "POST",
    pathname: "/admin/api/knowledge-bases",
    contentType: "application/xml",
    rawBody: "{}",
    expectedStatus: 415,
    expectedCode: "UNSUPPORTED_MEDIA_TYPE"
  });
  await execute({
    id: "header:content-type:omitted",
    routeId: "MIDDLEWARE:admin-security",
    covers: ["header:content-type"],
    method: "POST",
    pathname: "/admin/api/knowledge-bases",
    rawBody: "{}",
    expectedStatus: 415,
    expectedCode: "UNSUPPORTED_MEDIA_TYPE"
  });

  for (const [id, body, expectedStatus, expectedCode] of [
    ["body:name:omitted", {}, 400, "INVALID_KNOWLEDGE_BASE"],
    ["body:name:null", { name: null }, 400, "INVALID_KNOWLEDGE_BASE"],
    ["body:name:wrong-type", { name: 1 }, 400, "INVALID_KNOWLEDGE_BASE"],
    ["body:name:empty", { name: "   " }, 400, "INVALID_KNOWLEDGE_BASE"],
    ["body:description:wrong-type", { name: `${runId}-invalid-description`, description: 1 }, 400, "INVALID_KNOWLEDGE_BASE"]
  ]) {
    await execute({
      id,
      coversBody: id.split(":")[1],
      method: "POST",
      pathname: "/admin/api/knowledge-bases",
      json: body,
      expectedStatus,
      expectedCode
    });
  }

  const created = await request("POST", "/admin/api/knowledge-bases", {
    json: { name: `${runId} primary`, description: null }
  });
  assert(created.status === 201, `Knowledge-base setup returned HTTP ${created.status}.`);
  primaryKnowledgeBaseId = created.body?.knowledgeBase?.id ?? "";
  primaryResourceRevision = Number(created.body?.knowledgeBase?.resourceRevision ?? 0);
  assert(primaryKnowledgeBaseId, "Knowledge-base setup returned no ID.");
  assert(primaryResourceRevision > 0, "Knowledge-base setup returned no resource revision.");
  knowledgeBaseIds.add(primaryKnowledgeBaseId);
  report.bodyCoverage.push("description:null");
  existingSourceFixture = await findExistingSourceFixture();
  existingDirectoryFixture = await findExistingDirectoryFixture();

  await executeQueryAndPathCases();
  await executeTreeSearchQueryCases();
  await executeMutationHeaderCases();
  await executeJsonBodyOccurrenceCases();
  await executeUploadCases();
  await executePaginatedFieldOccurrenceCases();
  await executeOptionalQueryOccurrenceCases();
  await executeMutationPreconditionOccurrenceCases();
  await executeResourceConflictOccurrenceCases();
  await executeIdempotencyOccurrenceCases();
  await executeIdentifierOccurrenceCases();
  await executeSettingsConfigurationOccurrenceCases();
  await executeSettingsIdentifierCases();

  const covered = new Set(report.rows.flatMap((row) => row.covers));
  report.requestFieldCoverage = expectedRequestFieldNames.map((name) => ({
    name,
    caseCount: report.rows.filter((row) => row.covers.includes(name)).length
  }));
  report.missingRequestFields = expectedRequestFieldNames.filter((name) => !covered.has(name));
  assert(
    report.missingRequestFields.length === 0,
    `Admin request-field coverage is incomplete: ${report.missingRequestFields.join(", ")}`
  );
  report.referencedBodyFieldCoverage = readReferencedBodyFieldCoverage();
  const liveBodyFields = new Set(report.rows
    .map((row) => row.bodyField)
    .filter((value) => typeof value === "string"));
  const referencedBodyFields = new Set(report.referencedBodyFieldCoverage
    .map((item) => item.name));
  report.bodyFieldCoverage = expectedBodyFieldNames.map((name) => ({
    name,
    liveCaseCount: report.rows.filter((row) => row.bodyField === name).length,
    referencedEvidenceCount: report.referencedBodyFieldCoverage
      .filter((item) => item.name === name).length
  }));
  report.missingBodyFields = expectedBodyFieldNames
    .filter((name) => !liveBodyFields.has(name) && !referencedBodyFields.has(name));
  assert(
    report.missingBodyFields.length === 0,
    `Admin body-field coverage is incomplete: ${report.missingBodyFields.join(", ")}`
  );
  assert(new Set(report.rows.map((row) => row.id)).size === report.rows.length,
    "Admin field-boundary row IDs are not unique.");
  report.ok = true;
} finally {
  if (cookie) {
    for (const [sessionId, knowledgeBaseId] of uploadSessionOwners) {
      const cancelled = await request(
        "DELETE",
        `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/upload-sessions/${encodeURIComponent(sessionId)}`
      ).catch(() => null);
      if (cancelled?.status === 200 || cancelled?.status === 404) {
        uploadSessionOwners.delete(sessionId);
        if (sessionId === uploadSessionId) uploadSessionId = "";
      }
    }
    report.cleanup.uploadSessionCancelled = uploadSessionOwners.size === 0;
  }
  if (cookie) {
    for (const [configurationId, expectedRevision] of embeddingConfigurationRevisions) {
      const deleted = await request(
        "DELETE",
        `/admin/api/settings/embeddings/${encodeURIComponent(configurationId)}`,
        { json: { expectedRevision } }
      ).catch(() => null);
      if (deleted?.status === 200 || deleted?.status === 404) {
        embeddingConfigurationRevisions.delete(configurationId);
        report.cleanup.embeddingConfigurationsDeleted += 1;
      }
    }
    for (const [configurationId, expectedRevision] of rerankerConfigurationRevisions) {
      const deleted = await request(
        "DELETE",
        `/admin/api/settings/rerankers/${encodeURIComponent(configurationId)}`,
        { json: { expectedRevision } }
      ).catch(() => null);
      if (deleted?.status === 200 || deleted?.status === 404) {
        rerankerConfigurationRevisions.delete(configurationId);
        report.cleanup.rerankerConfigurationsDeleted += 1;
      }
    }
  }
  if (cookie) {
    for (const keyId of openApiKeyIds) {
      const deleted = await request(
        "DELETE",
        `/admin/api/openapi-keys/${encodeURIComponent(keyId)}`
      ).catch(() => null);
      if (deleted?.status === 200 || deleted?.status === 404) {
        openApiKeyIds.delete(keyId);
        report.cleanup.openApiKeysDeleted += 1;
      }
    }
  }
  if (cookie) {
    for (const knowledgeBaseId of [...knowledgeBaseIds]) {
      const deleted = await request(
        "DELETE",
        `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`
      ).catch(() => null);
      if (deleted?.status === 200 || deleted?.status === 404) {
        knowledgeBaseIds.delete(knowledgeBaseId);
        report.cleanup.knowledgeBasesDeleted += 1;
      }
    }
  }
  if (cookie) {
    if (originalPublicationSettings) {
      const restored = await request("PUT", "/admin/api/settings/publication", {
        json: originalPublicationSettings
      }).catch(() => null);
      report.cleanup.publicationSettingsRestored = restored?.status === 200;
    }
  }
  if (cookie) {
    if (originalRateLimits) {
      const waitMs = adminRateLimitDrainWaitMs({
        startedAtMs: adminApiRateWindowStartedAt,
        nowMs: Date.now(),
        windowSeconds: originalRateLimits.adminApi.windowSeconds,
        cushionMs: 250,
        requestCount: adminApiRequestCount + 2,
        restoredMaximum: originalRateLimits.adminApi.max
      });
      report.cleanup.adminApiRateWindowWaitMs = waitMs;
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      const restored = await request("PUT", "/admin/api/settings/rate-limits", {
        json: originalRateLimits
      }).catch(() => null);
      report.cleanup.rateLimitsRestored = restored?.status === 200;
    }
  }
  if (cookie) {
    const logout = await request("POST", "/admin/api/logout", { json: {} }).catch(() => null);
    report.cleanup.loggedOut = logout?.status === 200;
    cookie = "";
  }
  report.finishedAt = new Date().toISOString();
  report.cleanup.adminApiRequestCount = adminApiRequestCount;
  report.ok = report.ok
    && report.cleanup.loggedOut
    && embeddingConfigurationRevisions.size === 0
    && openApiKeyIds.size === 0
    && rerankerConfigurationRevisions.size === 0
    && knowledgeBaseIds.size === 0
    && report.cleanup.publicationSettingsRestored
    && report.cleanup.rateLimitsRestored
    && !uploadSessionId;
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    rowCount: report.rows.length,
    expectedRequestFieldCount: report.expectedRequestFieldCount,
    coveredRequestFieldCount: report.requestFieldCoverage.length - report.missingRequestFields.length,
    bodyCoverageCount: new Set(report.bodyCoverage).size,
    expectedBodyFieldCount: report.expectedBodyFieldCount,
    coveredBodyFieldCount: report.bodyFieldCoverage.length - report.missingBodyFields.length,
    cleanup: report.cleanup,
    reportPath
  })}\n`);
}

if (!report.ok) throw new Error("Admin API field-boundary validation failed.");

async function executeQueryAndPathCases() {
  const knowledgeBase = encodeURIComponent(primaryKnowledgeBaseId);
  for (const input of [
    fieldCase("query:limit:below", ["query:limit"], "GET", "/admin/api/knowledge-bases?limit=0", 400, "INVALID_PAGINATION"),
    fieldCase("query:limit:above", ["query:limit"], "GET", "/admin/api/knowledge-bases?limit=201", 400, "INVALID_PAGINATION"),
    fieldCase("query:cursor:invalid", ["query:cursor"], "GET", "/admin/api/knowledge-bases?cursor=invalid", 400, "INVALID_PAGINATION"),
    fieldCase("query:query:control", ["query:query"], "GET", "/admin/api/knowledge-bases?query=%00", 400, "INVALID_KNOWLEDGE_BASE_SEARCH_QUERY"),
    fieldCase("query:entryType:invalid", ["query:entryType"], "GET", `/admin/api/knowledge-bases/${knowledgeBase}/files/tree?entryType=invalid`, 400, "INVALID_TREE_FILTER"),
    fieldCase("query:parentPath:root", ["query:parentPath"], "GET", `/admin/api/knowledge-bases/${knowledgeBase}/files/tree?parentPath=&limit=1`, 200),
    fieldCase("query:path:omitted", ["query:path"], "GET", `/admin/api/knowledge-bases/${knowledgeBase}/files/detail`, 404, "NOT_FOUND"),
    fieldCase("query:includeRelationships:invalid-as-false", ["query:includeRelationships"], "GET", `/admin/api/knowledge-bases/${knowledgeBase}/files/detail?path=index.md&includeRelationships=invalid`, 404, "NOT_FOUND"),
    fieldCase("query:parentDirectoryId:root", ["query:parentDirectoryId"], "GET", `/admin/api/knowledge-bases/${knowledgeBase}/source-directories?parentDirectoryId=root&limit=1`, 200),
    fieldCase("query:state:invalid", ["query:state"], "GET", `/admin/api/knowledge-bases/${knowledgeBase}/operations?state=invalid`, 422, "VALIDATION_ERROR")
  ]) await execute(input);

  for (const [name, pathname] of [
    ["param:knowledgeBaseId", "/admin/api/knowledge-bases/knowledge-base-missing"],
    ["param:sourceFileId", `/admin/api/knowledge-bases/${knowledgeBase}/source-files/source-file-missing`],
    ["param:directoryId", `/admin/api/knowledge-bases/${knowledgeBase}/source-directories/source-directory-missing`],
    ["param:operationId", `/admin/api/knowledge-bases/${knowledgeBase}/operations/operation-missing`]
  ]) {
    await execute(fieldCase(`${name}:missing`, [name], "GET", pathname, 404, "NOT_FOUND"));
  }
}

async function executePaginatedFieldOccurrenceCases() {
  const primary = encodeURIComponent(primaryKnowledgeBaseId);
  const existingKnowledgeBase = encodeURIComponent(existingSourceFixture.knowledgeBaseId);
  const existingSourceFile = encodeURIComponent(existingSourceFixture.sourceFileId);
  const uploadSession = encodeURIComponent(uploadSessionId);
  const paginatedRoutes = [{
    key: "knowledge-bases",
    pathname: "/admin/api/knowledge-bases",
    maximum: 200,
    strictLimit: true
  }, {
    key: "file-tree",
    pathname: `/admin/api/knowledge-bases/${primary}/files/tree`,
    maximum: 500,
    strictLimit: true
  }, {
    key: "file-tree-search",
    pathname: `/admin/api/knowledge-bases/${primary}/files/tree/search?query=boundary`,
    maximum: 500,
    strictLimit: true
  }, {
    key: "openapi-keys",
    pathname: "/admin/api/openapi-keys",
    maximum: 200,
    strictLimit: true
  }, {
    key: "source-files",
    pathname: `/admin/api/knowledge-bases/${primary}/source-files`,
    maximum: 200,
    strictLimit: true
  }, {
    key: "source-file-detail",
    pathname: `/admin/api/knowledge-bases/${existingKnowledgeBase}/source-files/${existingSourceFile}`,
    maximum: 200,
    strictLimit: true
  }, {
    key: "operations",
    pathname: `/admin/api/knowledge-bases/${primary}/operations`,
    maximum: 200,
    strictLimit: true
  }, {
    key: "source-directories",
    pathname: `/admin/api/knowledge-bases/${primary}/source-directories`,
    maximum: 200,
    strictLimit: true
  }, {
    key: "upload-session",
    pathname: `/admin/api/knowledge-bases/${primary}/upload-sessions/${uploadSession}`,
    maximum: 500,
    strictLimit: false,
    strictCursor: false
  }];

  for (const route of paginatedRoutes) {
    for (const boundary of [
      ["omitted", null, 200, undefined],
      ["minimum", "1", 200, undefined],
      ["maximum", String(route.maximum), 200, undefined],
      ["below-minimum", "0", route.strictLimit ? 400 : 200, route.strictLimit ? "INVALID_PAGINATION" : undefined],
      ["above-maximum", String(route.maximum + 1), route.strictLimit ? 400 : 200, route.strictLimit ? "INVALID_PAGINATION" : undefined],
      ["wrong-type", "not-a-number", route.strictLimit ? 400 : 200, route.strictLimit ? "INVALID_PAGINATION" : undefined]
    ]) {
      const [caseName, value, status, code] = boundary;
      await execute(fieldCase(
        `occurrence:${route.key}:query:limit:${caseName}`,
        ["query:limit"],
        "GET",
        value === null ? route.pathname : addQuery(route.pathname, "limit", value),
        status,
        code
      ));
    }
    await execute(fieldCase(
      `occurrence:${route.key}:query:limit:duplicate`,
      ["query:limit"],
      "GET",
      addRawQuery(route.pathname, "limit=1&limit=2"),
      200
    ));
    await execute(fieldCase(
      `occurrence:${route.key}:query:cursor:omitted`,
      ["query:cursor"],
      "GET",
      route.pathname,
      200
    ));
    await execute(route.strictCursor === false
      ? fieldCase(
          `occurrence:${route.key}:query:cursor:lexical-position`,
          ["query:cursor"],
          "GET",
          addQuery(route.pathname, "cursor", "invalid"),
          200
        )
      : {
          id: `occurrence:${route.key}:query:cursor:invalid`,
          covers: ["query:cursor"],
          method: "GET",
          pathname: addQuery(route.pathname, "cursor", "invalid"),
          expectedStatuses: [400, 422],
          expectedCodes: [
            "INVALID_PAGINATION",
            "INVALID_CURSOR",
            "INVALID_UPLOAD_SESSION_CURSOR",
            "VALIDATION_ERROR"
          ]
        });
  }
}

async function executeTreeSearchQueryCases() {
  const base = `/admin/api/knowledge-bases/${encodeURIComponent(primaryKnowledgeBaseId)}/files/tree/search`;
  for (const input of [
    ["omitted", null, 400, "FILE_TREE_SEARCH_QUERY_REQUIRED"],
    ["empty", "", 400, "FILE_TREE_SEARCH_QUERY_REQUIRED"],
    ["below-minimum", "x", 400, "FILE_TREE_SEARCH_QUERY_TOO_SHORT"],
    ["minimum", "xx", 200, undefined],
    ["maximum", "x".repeat(160), 200, undefined],
    ["above-maximum", "x".repeat(161), 400, "FILE_TREE_SEARCH_QUERY_TOO_LONG"],
    ["invalid-control", "x\u0000", 400, "INVALID_FILE_TREE_SEARCH"]
  ]) {
    const [caseName, value, status, code] = input;
    await execute(fieldCase(
      `occurrence:file-tree-search:query:query:${caseName}`,
      ["query:query"],
      "GET",
      value === null ? base : addQuery(base, "query", value),
      status,
      code
    ));
  }
  await execute(fieldCase(
    "occurrence:file-tree-search:query:query:duplicate",
    ["query:query"],
    "GET",
    addRawQuery(base, "query=xx&query=yy"),
    200
  ));
}

async function executeOptionalQueryOccurrenceCases() {
  const primary = encodeURIComponent(primaryKnowledgeBaseId);
  const generatedKnowledgeBase = encodeURIComponent(existingSourceFixture.knowledgeBaseId);
  const uploadSession = encodeURIComponent(uploadSessionId);
  const tree = `/admin/api/knowledge-bases/${primary}/files/tree`;
  const generatedDetail = `/admin/api/knowledge-bases/${generatedKnowledgeBase}/files/detail`;
  const directories = `/admin/api/knowledge-bases/${primary}/source-directories`;
  const operations = `/admin/api/knowledge-bases/${primary}/operations`;
  const upload = `/admin/api/knowledge-bases/${primary}/upload-sessions/${uploadSession}`;

  for (const input of [
    fieldCase("occurrence:file-tree:query:entryType:omitted", ["query:entryType"], "GET", tree, 200),
    fieldCase("occurrence:file-tree:query:entryType:duplicate", ["query:entryType"], "GET", addRawQuery(tree, "entryType=file&entryType=directory"), 200),
    fieldCase("occurrence:file-tree:query:parentPath:unsafe", ["query:parentPath"], "GET", addQuery(tree, "parentPath", "../missing"), 200),
    fieldCase("occurrence:file-tree:query:parentPath:duplicate", ["query:parentPath"], "GET", addRawQuery(tree, "parentPath=missing-a&parentPath=missing-b"), 200),
    fieldCase("occurrence:generated-read:query:path:unsafe", ["query:path"], "GET", addQuery(generatedDetail, "path", "../missing.md"), 404, "NOT_FOUND"),
    fieldCase("occurrence:generated-read:query:path:duplicate", ["query:path"], "GET", addRawQuery(generatedDetail, "path=missing-a.md&path=missing-b.md"), 404, "NOT_FOUND"),
    fieldCase("occurrence:generated-delete:query:path:omitted", ["query:path"], "DELETE", generatedDetail, 404, "NOT_FOUND"),
    fieldCase("occurrence:generated-delete:query:path:unsafe", ["query:path"], "DELETE", addQuery(generatedDetail, "path", "../missing.md"), 404, "NOT_FOUND"),
    fieldCase("occurrence:generated-delete:query:path:duplicate", ["query:path"], "DELETE", addRawQuery(generatedDetail, "path=missing-a.md&path=missing-b.md"), 404, "NOT_FOUND"),
    { ...fieldCase("occurrence:generated-read:query:includeRelationships:omitted", ["query:includeRelationships"], "GET", addQuery(generatedDetail, "path", "index.md"), undefined), expectedStatuses: [200, 404] },
    { ...fieldCase("occurrence:generated-read:query:includeRelationships:duplicate", ["query:includeRelationships"], "GET", addRawQuery(generatedDetail, "path=index.md&includeRelationships=0&includeRelationships=1"), undefined), expectedStatuses: [200, 404] },
    fieldCase("occurrence:source-directories:query:parentDirectoryId:omitted", ["query:parentDirectoryId"], "GET", directories, 200),
    fieldCase("occurrence:source-directories:query:parentDirectoryId:missing", ["query:parentDirectoryId"], "GET", addQuery(directories, "parentDirectoryId", "source-directory-missing"), 200),
    fieldCase("occurrence:source-directories:query:parentDirectoryId:duplicate", ["query:parentDirectoryId"], "GET", addRawQuery(directories, "parentDirectoryId=root&parentDirectoryId=source-directory-missing"), 200),
    fieldCase("occurrence:operations:query:state:omitted", ["query:state"], "GET", operations, 200),
    fieldCase("occurrence:operations:query:state:duplicate", ["query:state"], "GET", addRawQuery(operations, "state=completed&state=failed"), 200),
    fieldCase("occurrence:upload-session:query:transferState:omitted", ["query:transferState"], "GET", upload, 200),
    fieldCase("occurrence:upload-session:query:transferState:duplicate", ["query:transferState"], "GET", addRawQuery(upload, "transferState=missing&transferState=failed"), 200)
  ]) await execute(input);

  await execute({
    id: "occurrence:upload-content:header:content-type:omitted",
    routeId: "PUT:/admin/api/knowledge-bases/:knowledgeBaseId/upload-sessions/:sessionId/entries/:entryId/content",
    covers: ["header:content-type"],
    method: "PUT",
    pathname: `${upload}/entries/upload-entry-missing/content`,
    rawBody: "# Missing",
    expectedStatus: 415,
    expectedCode: "UNSUPPORTED_MEDIA_TYPE"
  });
  await execute({
    id: "occurrence:upload-content:header:content-type:unsupported",
    routeId: "PUT:/admin/api/knowledge-bases/:knowledgeBaseId/upload-sessions/:sessionId/entries/:entryId/content",
    covers: ["header:content-type"],
    method: "PUT",
    pathname: `${upload}/entries/upload-entry-missing/content`,
    contentType: "application/xml",
    rawBody: "# Missing",
    expectedStatus: 415,
    expectedCode: "UNSUPPORTED_MEDIA_TYPE"
  });
  await execute({
    id: "occurrence:session:header:cookie:omitted",
    routeId: "MIDDLEWARE:admin-security",
    covers: ["header:cookie"],
    method: "GET",
    pathname: "/admin/api/session",
    withoutCookie: true,
    expectedStatus: 401,
    expectedCode: "UNAUTHORIZED"
  });
}

async function executeJsonBodyOccurrenceCases() {
  const invalidCredential = "invalid-boundary-credential";
  for (const input of [{
    id: "body:username:omitted",
    field: "username",
    json: { password: invalidCredential }
  }, {
    id: "body:username:null",
    field: "username",
    json: { username: null, password: invalidCredential }
  }, {
    id: "body:username:minimum",
    field: "username",
    json: { username: "x", password: invalidCredential }
  }, {
    id: "body:username:below-minimum",
    field: "username",
    json: { username: "", password: invalidCredential }
  }, {
    id: "body:username:wrong-type",
    field: "username",
    json: { username: 1, password: invalidCredential }
  }, {
    id: "body:password:omitted",
    field: "password",
    json: { username: invalidCredential }
  }, {
    id: "body:password:null",
    field: "password",
    json: { username: invalidCredential, password: null }
  }, {
    id: "body:password:minimum",
    field: "password",
    json: { username: invalidCredential, password: "x" }
  }, {
    id: "body:password:below-minimum",
    field: "password",
    json: { username: invalidCredential, password: "" }
  }, {
    id: "body:password:wrong-type",
    field: "password",
    json: { username: invalidCredential, password: 1 }
  }]) {
    await execute({
      id: input.id,
      routeId: "POST:/admin/api/login",
      coversBody: input.field,
      method: "POST",
      pathname: "/admin/api/login",
      withoutCookie: true,
      json: input.json,
      expectedStatus: 401,
      expectedCode: "UNAUTHORIZED"
    });
  }
  for (const input of [{
    id: "body:username:duplicate",
    field: "username",
    rawBody: `{"username":"invalid-a","username":"invalid-b","password":"${invalidCredential}"}`
  }, {
    id: "body:password:duplicate",
    field: "password",
    rawBody: `{"username":"${invalidCredential}","password":"invalid-a","password":"invalid-b"}`
  }]) {
    await execute({
      id: input.id,
      routeId: "POST:/admin/api/login",
      coversBody: input.field,
      method: "POST",
      pathname: "/admin/api/login",
      withoutCookie: true,
      contentType: "application/json",
      rawBody: input.rawBody,
      expectedStatus: 401,
      expectedCode: "UNAUTHORIZED"
    });
  }

  for (const input of [{
    id: "body:create-name:minimum",
    field: "name",
    json: { name: "x" }
  }, {
    id: "body:create-description:omitted",
    field: "description",
    json: { name: `${runId}-description-omitted` }
  }, {
    id: "body:create-description:null",
    field: "description",
    json: { name: `${runId}-description-null`, description: null }
  }, {
    id: "body:create-description:minimum",
    field: "description",
    json: { name: `${runId}-description-minimum`, description: "x" }
  }]) {
    await execute({
      id: input.id,
      routeId: "POST:/admin/api/knowledge-bases",
      coversBody: input.field,
      method: "POST",
      pathname: "/admin/api/knowledge-bases",
      json: input.json,
      expectedStatus: 201
    });
  }
  await execute({
    id: "body:create-name:duplicate",
    routeId: "POST:/admin/api/knowledge-bases",
    coversBody: "name",
    method: "POST",
    pathname: "/admin/api/knowledge-bases",
    contentType: "application/json",
    rawBody: `{"name":"${runId}-duplicate-a","name":"${runId}-duplicate-b"}`,
    expectedStatus: 201
  });

  for (const input of [{ id: "omitted", value: undefined }, { id: "null", value: null },
    { id: "below-minimum", value: "" }, { id: "wrong-type", value: 1 },
    { id: "minimum", value: "x" }]) {
    await executeOpenApiKeyNameCase(input.id, input.value);
  }
  await execute({
    id: "body:openapi-key-name:duplicate",
    routeId: "POST:/admin/api/openapi-keys",
    coversBody: "name",
    method: "POST",
    pathname: "/admin/api/openapi-keys",
    contentType: "application/json",
    rawBody: "{\"name\":\"x\",\"name\":\"y\"}",
    expectedStatus: 201
  });

  for (const input of [{
    id: "body:update-name:omitted",
    field: "name",
    body: { description: "Name omitted" },
    status: 200
  }, {
    id: "body:update-name:null",
    field: "name",
    body: { name: null },
    status: 422
  }, {
    id: "body:update-name:minimum",
    field: "name",
    body: { name: "x" },
    status: 200
  }, {
    id: "body:update-name:below-minimum",
    field: "name",
    body: { name: "" },
    status: 422
  }, {
    id: "body:update-name:wrong-type",
    field: "name",
    body: { name: 1 },
    status: 422
  }, {
    id: "body:update-description:omitted",
    field: "description",
    body: { name: "Description omitted" },
    status: 200
  }, {
    id: "body:update-description:null",
    field: "description",
    body: { description: null },
    status: 200
  }, {
    id: "body:update-description:minimum",
    field: "description",
    body: { description: "x" },
    status: 200
  }, {
    id: "body:update-description:wrong-type",
    field: "description",
    body: { description: 1 },
    status: 422
  }]) {
    await executePrimaryKnowledgeBasePatch(input.id, input.field, input.body, input.status);
  }
  const duplicateFixture = await createKnowledgeBasePatchFixture("duplicate");
  await execute({
    id: "body:update-name:duplicate",
    routeId: "PATCH:/admin/api/knowledge-bases/:knowledgeBaseId",
    coversBody: "name",
    method: "PATCH",
    pathname: `/admin/api/knowledge-bases/${encodeURIComponent(duplicateFixture.id)}`,
    headers: { "if-match": String(duplicateFixture.resourceRevision) },
    contentType: "application/json",
    rawBody: "{\"name\":\"Duplicate A\",\"name\":\"Duplicate B\"}",
    expectedStatus: 200
  });

  await executeUploadBodyCases();
  await executeSourceFileIdBodyCases();
}

async function executeOpenApiKeyNameCase(caseName, value) {
  const json = value === undefined ? {} : { name: value };
  await execute({
    id: `body:openapi-key-name:${caseName}`,
    routeId: "POST:/admin/api/openapi-keys",
    coversBody: "name",
    method: "POST",
    pathname: "/admin/api/openapi-keys",
    json,
    expectedStatus: 201
  });
}

async function executePrimaryKnowledgeBasePatch(id, field, body, expectedStatus) {
  const fixture = await createKnowledgeBasePatchFixture(
    id,
    body.description === null ? "Initial description" : null
  );
  await execute({
    id,
    routeId: "PATCH:/admin/api/knowledge-bases/:knowledgeBaseId",
    coversBody: field,
    method: "PATCH",
    pathname: `/admin/api/knowledge-bases/${encodeURIComponent(fixture.id)}`,
    headers: { "if-match": String(fixture.resourceRevision) },
    json: body,
    expectedStatus,
    ...(expectedStatus === 422 ? { expectedCode: "VALIDATION_ERROR" } : {})
  });
}

async function createKnowledgeBasePatchFixture(label, description = null) {
  const response = await request("POST", "/admin/api/knowledge-bases", {
    json: { name: `${runId} patch ${label}`, description }
  });
  assert(response.status === 201, `Knowledge-base patch fixture ${label} returned HTTP ${response.status}.`);
  const id = response.body?.knowledgeBase?.id ?? "";
  const resourceRevision = Number(response.body?.knowledgeBase?.resourceRevision ?? 0);
  assert(id, `Knowledge-base patch fixture ${label} returned no ID.`);
  assert(resourceRevision > 0, `Knowledge-base patch fixture ${label} returned no revision.`);
  knowledgeBaseIds.add(id);
  return { id, resourceRevision };
}

async function executeUploadBodyCases() {
  const base = `/admin/api/knowledge-bases/${encodeURIComponent(primaryKnowledgeBaseId)}/upload-sessions`;
  let manifestSessionId = "";
  for (const input of [{
    id: "declaredFileCount:omitted",
    field: "declaredFileCount",
    body: { declaredByteCount: 0 }, status: 400
  }, {
    id: "declaredFileCount:minimum",
    field: "declaredFileCount",
    body: { declaredFileCount: 0, declaredByteCount: 0 }, status: 201
  }, {
    id: "declaredFileCount:maximum",
    field: "declaredFileCount",
    body: { declaredFileCount: Number.MAX_SAFE_INTEGER, declaredByteCount: 0 }, status: 201
  }, {
    id: "declaredFileCount:above-maximum",
    field: "declaredFileCount",
    body: { declaredFileCount: Number.MAX_SAFE_INTEGER + 1, declaredByteCount: 0 }, status: 400
  }, {
    id: "declaredFileCount:wrong-type",
    field: "declaredFileCount",
    body: { declaredFileCount: "0", declaredByteCount: 0 }, status: 400
  }, {
    id: "declaredByteCount:omitted",
    field: "declaredByteCount",
    body: { declaredFileCount: 0 }, status: 400
  }, {
    id: "declaredByteCount:null",
    field: "declaredByteCount",
    body: { declaredFileCount: 0, declaredByteCount: null }, status: 400
  }, {
    id: "declaredByteCount:minimum",
    field: "declaredByteCount",
    body: { declaredFileCount: 0, declaredByteCount: 0 }, status: 201
  }, {
    id: "declaredByteCount:below-minimum",
    field: "declaredByteCount",
    body: { declaredFileCount: 0, declaredByteCount: -1 }, status: 400
  }, {
    id: "declaredByteCount:maximum",
    field: "declaredByteCount",
    body: { declaredFileCount: 0, declaredByteCount: Number.MAX_SAFE_INTEGER }, status: 201
  }, {
    id: "declaredByteCount:above-maximum",
    field: "declaredByteCount",
    body: { declaredFileCount: 0, declaredByteCount: Number.MAX_SAFE_INTEGER + 1 }, status: 400
  }]) {
    const response = await execute({
      id: `body:${input.id}`,
      routeId: "POST:/admin/api/knowledge-bases/:knowledgeBaseId/upload-sessions",
      coversBody: input.field,
      covers: ["header:idempotency-key"],
      method: "POST",
      pathname: base,
      headers: { "idempotency-key": `${runId}-${input.id}` },
      json: input.body,
      expectedStatus: input.status,
      ...(input.status === 400 ? { expectedCode: "INVALID_UPLOAD_SESSION" } : {})
    });
    if (input.id === "declaredFileCount:minimum") {
      manifestSessionId = response.body?.session?.id ?? "";
    }
  }

  assert(manifestSessionId, "Manifest boundary setup returned no upload-session ID.");
  const entriesPath = `${base}/${encodeURIComponent(manifestSessionId)}/entries`;
  const manifestEntry = (index) => ({
    relativePath: `boundary/${String(index).padStart(3, "0")}.md`,
    declaredSize: 0,
    checksumSha256: null
  });
  for (const input of [{ id: "omitted", body: {}, status: 400, code: "INVALID_UPLOAD_MANIFEST_PAGE" },
    { id: "null", body: { entries: null }, status: 400, code: "INVALID_UPLOAD_MANIFEST_PAGE" },
    { id: "minimum", body: { entries: [] }, status: 200 },
    { id: "maximum", body: { entries: Array.from({ length: 500 }, (_, index) => manifestEntry(index)) }, status: 400, code: "UPLOAD_MANIFEST_TOTAL_MISMATCH" },
    { id: "above-maximum", body: { entries: Array.from({ length: 501 }, (_, index) => manifestEntry(index)) }, status: 400, code: "INVALID_UPLOAD_MANIFEST_PAGE" },
    { id: "invalid-identifier", body: { entries: [{ ...manifestEntry(0), relativePath: "../escape.md" }] }, status: 400 },
    { id: "duplicate", body: { entries: [manifestEntry(0), manifestEntry(0)] }, status: 400 }]) {
    await execute({
      id: `body:entries:${input.id}`,
      routeId: "POST:/admin/api/knowledge-bases/:knowledgeBaseId/upload-sessions/:sessionId/entries",
      coversBody: "entries",
      method: "POST",
      pathname: entriesPath,
      json: input.body,
      expectedStatus: input.status,
      ...(input.code ? { expectedCode: input.code } : {})
    });
  }
}

async function executeSourceFileIdBodyCases() {
  const pathname = `/admin/api/knowledge-bases/${encodeURIComponent(primaryKnowledgeBaseId)}/source-files/task-deletions`;
  const missingSourceFileId = "source-file-00000000-0000-4000-8000-000000000000";
  for (const input of [
    ["omitted", {}, 400],
    ["minimum", { sourceFileIds: [missingSourceFileId] }, 200],
    ["wrong-type", { sourceFileIds: {} }, 400],
    ["invalid-identifier", { sourceFileIds: ["invalid"] }, 400],
    ["duplicate", { sourceFileIds: [missingSourceFileId, missingSourceFileId] }, 200]
  ]) {
    const [caseName, body, status] = input;
    await execute({
      id: `body:sourceFileIds:${caseName}`,
      routeId: "POST:/admin/api/knowledge-bases/:knowledgeBaseId/source-files/task-deletions",
      coversBody: "sourceFileIds",
      method: "POST",
      pathname,
      json: body,
      expectedStatus: status
    });
  }
}

async function executeMutationPreconditionOccurrenceCases() {
  const primary = encodeURIComponent(primaryKnowledgeBaseId);
  const missingSource = "source-file-missing";
  const missingDirectory = "source-directory-missing";
  const knowledgeBasePath = `/admin/api/knowledge-bases/${primary}`;

  for (const input of [{ id: "omitted", withoutCookie: true }, {
    id: "invalid",
    cookieOverride: "focowiki_admin_session=invalid"
  }]) {
    await execute({
      id: `occurrence:logout:header:cookie:${input.id}`,
      routeId: "POST:/admin/api/logout",
      covers: ["header:cookie"],
      method: "POST",
      pathname: "/admin/api/logout",
      withoutCookie: input.withoutCookie,
      cookieOverride: input.cookieOverride,
      json: {},
      expectedStatus: 401,
      expectedCode: "UNAUTHORIZED"
    });
  }

  for (const input of [{ id: "omitted", header: undefined, status: 422 },
    { id: "below-minimum", header: "0", status: 422 },
    { id: "wrong-type", header: "invalid", status: 422 }]) {
    await execute({
      id: `occurrence:knowledge-base-update:header:if-match:${input.id}`,
      routeId: "PATCH:/admin/api/knowledge-bases/:knowledgeBaseId",
      covers: ["header:if-match"],
      method: "PATCH",
      pathname: knowledgeBasePath,
      headers: input.header === undefined ? {} : { "if-match": input.header },
      json: { description: "Boundary" },
      expectedStatus: input.status,
      expectedCode: "VALIDATION_ERROR"
    });
  }
  await execute({
    id: "occurrence:knowledge-base-update:header:if-match:minimum",
    routeId: "PATCH:/admin/api/knowledge-bases/:knowledgeBaseId",
    covers: ["header:if-match"],
    method: "PATCH",
    pathname: "/admin/api/knowledge-bases/knowledge-base-missing",
    headers: { "if-match": "1" },
    json: { description: "Boundary" },
    expectedStatus: 404,
    expectedCode: "NOT_FOUND"
  });
  const revisionFixture = await createSettledRevisionFixture();
  const staleRevision = revisionFixture.resourceRevision - 1;
  for (const caseName of ["stale-revision", "conflict"]) {
    await execute({
      id: `occurrence:knowledge-base-update:header:if-match:${caseName}`,
      routeId: "PATCH:/admin/api/knowledge-bases/:knowledgeBaseId",
      covers: ["header:if-match"],
      method: "PATCH",
      pathname: `/admin/api/knowledge-bases/${encodeURIComponent(revisionFixture.id)}`,
      headers: { "if-match": String(staleRevision) },
      json: { description: "Stale boundary" },
      expectedStatus: 409,
      expectedCode: "RESOURCE_REVISION_CONFLICT"
    });
  }

  const sourceMutationRoutes = [{
    key: "source-directory-move",
    routeId: "PATCH:/admin/api/knowledge-bases/:knowledgeBaseId/source-directories/:directoryId",
    method: "PATCH",
    pathname: `${knowledgeBasePath}/source-directories/${missingDirectory}`,
    json: { relativePath: "missing" }
  }, {
    key: "source-file-move",
    routeId: "PATCH:/admin/api/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId",
    method: "PATCH",
    pathname: `${knowledgeBasePath}/source-files/${missingSource}`,
    json: { relativePath: "missing.md" }
  }, {
    key: "source-file-replace",
    routeId: "PUT:/admin/api/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId/content",
    method: "PUT",
    pathname: `${knowledgeBasePath}/source-files/${missingSource}/content`,
    contentType: "text/markdown",
    rawBody: "# Missing"
  }, {
    key: "source-file-delete",
    routeId: "DELETE:/admin/api/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId",
    method: "DELETE",
    pathname: `${knowledgeBasePath}/source-files/${missingSource}`
  }];
  for (const route of sourceMutationRoutes) {
    for (const input of [{ id: "omitted", value: undefined, status: 422 },
      { id: "minimum", value: "1", status: 404 },
      { id: "below-minimum", value: "0", status: 422 },
      { id: "wrong-type", value: "invalid", status: 422 }]) {
      await execute({
        id: `occurrence:${route.key}:header:if-match:${input.id}`,
        routeId: route.routeId,
        covers: ["header:if-match"],
        method: route.method,
        pathname: route.pathname,
        headers: {
          "idempotency-key": `${runId}-${route.key}-${input.id}`,
          ...(input.value === undefined ? {} : { "if-match": input.value })
        },
        json: route.json,
        contentType: route.contentType,
        rawBody: route.rawBody,
        expectedStatus: input.status,
        ...(input.status === 422 ? { expectedCode: "VALIDATION_ERROR" } : {})
      });
    }
  }

  const idempotencyRoutes = [{
    key: "index-maintenance",
    routeId: "POST:/admin/api/knowledge-bases/:knowledgeBaseId/index-maintenance",
    method: "POST",
    pathname: "/admin/api/knowledge-bases/knowledge-base-missing/index-maintenance",
    bodyWhenOmitted: { idempotencyKey: `${runId}-body-fallback` }
  }, {
    key: "upload-session",
    routeId: "POST:/admin/api/knowledge-bases/:knowledgeBaseId/upload-sessions",
    method: "POST",
    pathname: `${knowledgeBasePath}/upload-sessions`,
    json: { declaredFileCount: 0, declaredByteCount: 0 }
  }, ...sourceMutationRoutes.map((route) => ({ ...route }))];
  for (const route of idempotencyRoutes) {
    for (const input of [{ id: "omitted", value: undefined }, { id: "duplicate", value: "duplicate-a, duplicate-b" }]) {
      const headers = {
        ...(route.key.startsWith("source-") ? { "if-match": "1" } : {}),
        ...(input.value === undefined ? {} : { "idempotency-key": input.value })
      };
      await execute({
        id: `occurrence:${route.key}:header:idempotency-key:${input.id}`,
        routeId: route.routeId,
        covers: ["header:idempotency-key"],
        method: route.method,
        pathname: route.pathname,
        headers,
        json: input.id === "omitted" && route.bodyWhenOmitted
          ? route.bodyWhenOmitted
          : route.json,
        contentType: route.contentType,
        rawBody: route.rawBody,
        expectedStatuses: [201, 400, 404, 409, 422]
      });
    }
  }

  await execute({
    id: "occurrence:source-file-replace:header:x-source-relative-path:omitted",
    routeId: "PUT:/admin/api/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId/content",
    covers: ["header:x-source-relative-path"],
    method: "PUT",
    pathname: `${knowledgeBasePath}/source-files/${missingSource}/content`,
    headers: { "if-match": "1", "idempotency-key": `${runId}-relative-path-omitted` },
    contentType: "text/markdown",
    rawBody: "# Missing",
    expectedStatus: 404,
    expectedCode: "NOT_FOUND"
  });

  await executeExpectedResourceRevisionCases(knowledgeBasePath, missingDirectory);
  await executeRelativePathCases(knowledgeBasePath, missingDirectory, missingSource);
  await executeMaintenanceIdempotencyBodyCases();
}

async function executeExpectedResourceRevisionCases(knowledgeBasePath, missingDirectory) {
  const pathname = `${knowledgeBasePath}/source-directories/${missingDirectory}`;
  for (const input of [{ id: "omitted", body: {}, status: 422 },
    { id: "below-minimum", body: { expectedResourceRevision: 0 }, status: 422 },
    { id: "wrong-type", body: { expectedResourceRevision: "1" }, status: 404 },
    { id: "minimum", body: { expectedResourceRevision: 1 }, status: 404 }]) {
    await execute({
      id: `body:expectedResourceRevision:${input.id}`,
      routeId: "DELETE:/admin/api/knowledge-bases/:knowledgeBaseId/source-directories/:directoryId",
      coversBody: "expectedResourceRevision",
      method: "DELETE",
      pathname,
      headers: { "idempotency-key": `${runId}-expected-revision-${input.id}` },
      json: input.body,
      expectedStatus: input.status,
      ...(input.status === 422 ? { expectedCode: "VALIDATION_ERROR" } : {})
    });
  }
}

async function executeRelativePathCases(knowledgeBasePath, missingDirectory, missingSource) {
  const routes = [{
    key: "directory",
    routeId: "PATCH:/admin/api/knowledge-bases/:knowledgeBaseId/source-directories/:directoryId",
    pathname: `${knowledgeBasePath}/source-directories/${missingDirectory}`,
    minimum: "x",
    maximum: boundedPath(2_048, ""),
    aboveMaximum: boundedPath(2_049, "")
  }, {
    key: "file",
    routeId: "PATCH:/admin/api/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId",
    pathname: `${knowledgeBasePath}/source-files/${missingSource}`,
    minimum: "x.md",
    maximum: boundedPath(2_048, ".md"),
    aboveMaximum: boundedPath(2_049, ".md")
  }];
  for (const route of routes) {
    for (const input of [{ id: "omitted", value: undefined, status: 422 },
      { id: "null", value: null, status: 422 },
      { id: "minimum", value: route.minimum, status: 404 },
      { id: "maximum", value: route.maximum, status: 404 },
      { id: "below-minimum", value: "", status: 422 },
      { id: "above-maximum", value: route.aboveMaximum, status: 422 },
      { id: "wrong-type", value: 1, status: 422 },
      { id: "invalid-identifier", value: "../escape", status: 422 }]) {
      await execute({
        id: `body:relativePath:${route.key}:${input.id}`,
        routeId: route.routeId,
        coversBody: "relativePath",
        method: "PATCH",
        pathname: route.pathname,
        headers: {
          "if-match": "1",
          "idempotency-key": `${runId}-relative-${route.key}-${input.id}`
        },
        json: input.value === undefined ? {} : { relativePath: input.value },
        expectedStatus: input.status,
        ...(input.status === 422 ? { expectedCode: "VALIDATION_ERROR" } : {})
      });
    }
  }
}

async function executeMaintenanceIdempotencyBodyCases() {
  const pathname = "/admin/api/knowledge-bases/knowledge-base-missing/index-maintenance";
  for (const input of [{ id: "omitted", body: {}, status: 400 },
    { id: "null", body: { idempotencyKey: null }, status: 400 },
    { id: "wrong-type", body: { idempotencyKey: 1 }, status: 400 }]) {
    await execute({
      id: `body:idempotencyKey:${input.id}`,
      routeId: "POST:/admin/api/knowledge-bases/:knowledgeBaseId/index-maintenance",
      coversBody: "idempotencyKey",
      method: "POST",
      pathname,
      json: input.body,
      expectedStatus: input.status,
      expectedCode: "INVALID_INDEX_MAINTENANCE_REQUEST"
    });
  }
  await execute({
    id: "body:idempotencyKey:duplicate",
    routeId: "POST:/admin/api/knowledge-bases/:knowledgeBaseId/index-maintenance",
    coversBody: "idempotencyKey",
    method: "POST",
    pathname,
    contentType: "application/json",
    rawBody: "{\"idempotencyKey\":\"duplicate-a\",\"idempotencyKey\":\"duplicate-b\"}",
    expectedStatus: 404,
    expectedCode: "NOT_FOUND"
  });
}

function boundedPath(length, suffix) {
  const segments = [];
  let remaining = length - suffix.length;
  while (remaining > 240) {
    const size = Math.min(240, remaining - 2);
    segments.push("x".repeat(size));
    remaining -= size + 1;
  }
  segments.push(`${"x".repeat(Math.max(1, remaining))}${suffix}`);
  const value = segments.join("/");
  assert(value.length === length, `Unable to build a ${length}-character boundary path.`);
  return value;
}

async function executeResourceConflictOccurrenceCases() {
  const sourceBase = `/admin/api/knowledge-bases/${encodeURIComponent(existingSourceFixture.knowledgeBaseId)}`
    + `/source-files/${encodeURIComponent(existingSourceFixture.sourceFileId)}`;
  const directoryBase = `/admin/api/knowledge-bases/${encodeURIComponent(existingDirectoryFixture.knowledgeBaseId)}`
    + `/source-directories/${encodeURIComponent(existingDirectoryFixture.directoryId)}`;
  const sourceStaleRevision = existingSourceFixture.resourceRevision - 1;
  const directoryStaleRevision = existingDirectoryFixture.resourceRevision + 1;
  const sourceAlternatePath = alternateSiblingPath(existingSourceFixture.relativePath, "stale");
  const directoryAlternatePath = alternateSiblingPath(existingDirectoryFixture.relativePath, "stale");
  const sourceBytes = await readSourceContentBytes(sourceBase);

  for (const caseName of ["stale-revision", "conflict"]) {
    await execute({
      id: `occurrence:source-file-move:header:if-match:${caseName}`,
      routeId: "PATCH:/admin/api/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId",
      covers: ["header:if-match"],
      method: "PATCH",
      pathname: sourceBase,
      headers: {
        "if-match": String(sourceStaleRevision),
        "idempotency-key": `${runId}-source-move-revision-${caseName}`
      },
      json: { relativePath: sourceAlternatePath },
      expectedStatus: 409,
      expectedCode: "RESOURCE_REVISION_CONFLICT"
    });
    await execute({
      id: `occurrence:source-file-replace:header:if-match:${caseName}`,
      routeId: "PUT:/admin/api/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId/content",
      covers: ["header:if-match"],
      method: "PUT",
      pathname: `${sourceBase}/content`,
      headers: {
        "if-match": String(sourceStaleRevision),
        "idempotency-key": `${runId}-source-replace-revision-${caseName}`
      },
      contentType: "text/markdown",
      rawBody: sourceBytes,
      expectedStatus: 409,
      expectedCode: "RESOURCE_REVISION_CONFLICT"
    });
    await execute({
      id: `occurrence:source-file-delete:header:if-match:${caseName}`,
      routeId: "DELETE:/admin/api/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId",
      covers: ["header:if-match"],
      method: "DELETE",
      pathname: sourceBase,
      headers: {
        "if-match": String(sourceStaleRevision),
        "idempotency-key": `${runId}-source-delete-revision-${caseName}`
      },
      expectedStatus: 409,
      expectedCode: "RESOURCE_REVISION_CONFLICT"
    });
    await execute({
      id: `occurrence:source-directory-move:header:if-match:${caseName}`,
      routeId: "PATCH:/admin/api/knowledge-bases/:knowledgeBaseId/source-directories/:directoryId",
      covers: ["header:if-match"],
      method: "PATCH",
      pathname: directoryBase,
      headers: {
        "if-match": String(directoryStaleRevision),
        "idempotency-key": `${runId}-directory-move-revision-${caseName}`
      },
      json: { relativePath: directoryAlternatePath },
      expectedStatus: 409,
      expectedCode: "RESOURCE_REVISION_CONFLICT"
    });
    await execute({
      id: `body:expectedResourceRevision:${caseName}`,
      routeId: "DELETE:/admin/api/knowledge-bases/:knowledgeBaseId/source-directories/:directoryId",
      coversBody: "expectedResourceRevision",
      method: "DELETE",
      pathname: directoryBase,
      headers: { "idempotency-key": `${runId}-directory-delete-revision-${caseName}` },
      json: { expectedResourceRevision: directoryStaleRevision },
      expectedStatus: 409,
      expectedCode: "RESOURCE_REVISION_CONFLICT"
    });
  }

  await execute({
    id: "body:relativePath:file:conflict",
    routeId: "PATCH:/admin/api/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId",
    coversBody: "relativePath",
    method: "PATCH",
    pathname: sourceBase,
    headers: {
      "if-match": String(existingSourceFixture.resourceRevision),
      "idempotency-key": `${runId}-source-path-conflict`
    },
    json: { relativePath: existingSourceFixture.relativePath },
    expectedStatus: 409,
    expectedCode: "RESOURCE_PATH_CONFLICT"
  });
  await execute({
    id: "body:relativePath:directory:conflict",
    routeId: "PATCH:/admin/api/knowledge-bases/:knowledgeBaseId/source-directories/:directoryId",
    coversBody: "relativePath",
    method: "PATCH",
    pathname: directoryBase,
    headers: {
      "if-match": String(existingDirectoryFixture.resourceRevision),
      "idempotency-key": `${runId}-directory-path-conflict`
    },
    json: { relativePath: existingDirectoryFixture.relativePath },
    expectedStatus: 409,
    expectedCode: "RESOURCE_PATH_CONFLICT"
  });
}

async function executeIdempotencyOccurrenceCases() {
  await executeUploadSessionIdempotencyCases();
  await executeMaintenanceIdempotencyCases();
  await executeDirectoryDeleteOptionalIdempotencyCases();
  await executeResourceMutationIdempotencyCases();
}

async function executeUploadSessionIdempotencyCases() {
  const fixture = await createTemporaryKnowledgeBase("upload idempotency");
  const routeId = "POST:/admin/api/knowledge-bases/:knowledgeBaseId/upload-sessions";
  const pathname = `/admin/api/knowledge-bases/${encodeURIComponent(fixture.id)}/upload-sessions`;
  const idempotencyKey = `${runId}-upload-create-replay`;
  const body = { declaredFileCount: 0, declaredByteCount: 0 };
  const first = await request("POST", pathname, {
    headers: { "idempotency-key": idempotencyKey },
    json: body
  });
  assert(first.status === 201, `Upload idempotency setup returned HTTP ${first.status}.`);
  const firstSessionId = first.body?.session?.id ?? "";
  assert(firstSessionId, "Upload idempotency setup returned no session ID.");
  uploadSessionOwners.set(firstSessionId, fixture.id);

  const replay = await execute({
    id: "occurrence:upload-session-create:header:idempotency-key:replay",
    routeId,
    covers: ["header:idempotency-key"],
    method: "POST",
    pathname,
    headers: { "idempotency-key": idempotencyKey },
    json: body,
    expectedStatus: 201
  });
  assert(replay.body?.session?.id === firstSessionId,
    "Upload-session idempotent replay returned a different session.");

  await execute({
    id: "occurrence:upload-session-create:header:idempotency-key:conflict",
    routeId,
    covers: ["header:idempotency-key"],
    method: "POST",
    pathname,
    headers: { "idempotency-key": idempotencyKey },
    json: { declaredFileCount: 1, declaredByteCount: 0 },
    expectedStatus: 409,
    expectedCode: "UPLOAD_IDEMPOTENCY_CONFLICT"
  });

  const cancelled = await request("DELETE", `${pathname}/${encodeURIComponent(firstSessionId)}`);
  assert(cancelled.status === 200, `Upload idempotency fixture cancellation returned HTTP ${cancelled.status}.`);
  uploadSessionOwners.delete(firstSessionId);
}

async function executeMaintenanceIdempotencyCases() {
  for (const input of [{
    kind: "body",
    fixtureLabel: "maintenance body idempotency",
    firstOptions: (key) => ({ json: { idempotencyKey: key } }),
    replayOptions: (key) => ({ json: { idempotencyKey: key } }),
    row: {
      id: "body:idempotencyKey:replay",
      coversBody: "idempotencyKey"
    }
  }, {
    kind: "header",
    fixtureLabel: "maintenance header idempotency",
    firstOptions: (key) => ({ headers: { "idempotency-key": key }, json: {} }),
    replayOptions: (key) => ({ headers: { "idempotency-key": key }, json: {} }),
    row: {
      id: "occurrence:index-maintenance:header:idempotency-key:replay",
      covers: ["header:idempotency-key"]
    }
  }]) {
    const fixture = await createTemporaryKnowledgeBase(input.fixtureLabel);
    const pathname = `/admin/api/knowledge-bases/${encodeURIComponent(fixture.id)}/index-maintenance`;
    const idempotencyKey = `${runId}-maintenance-${input.kind}-replay`;
    const first = await request("POST", pathname, input.firstOptions(idempotencyKey));
    assert(first.status === 202,
      `Maintenance ${input.kind} idempotency setup returned HTTP ${first.status} ${safeCode(first.body)}.`);
    const firstRequestId = first.body?.maintenance?.requestId ?? "";
    assert(firstRequestId, `Maintenance ${input.kind} idempotency setup returned no request ID.`);
    const replay = await execute({
      ...input.row,
      routeId: "POST:/admin/api/knowledge-bases/:knowledgeBaseId/index-maintenance",
      method: "POST",
      pathname,
      ...input.replayOptions(idempotencyKey),
      expectedStatus: 202
    });
    assert(replay.body?.maintenance?.requestId === firstRequestId,
      `Maintenance ${input.kind} idempotent replay returned a different request.`);
    const cancelled = await request("POST", `${pathname}/cancel`, { json: {} });
    assert([200, 409].includes(cancelled.status),
      `Maintenance ${input.kind} fixture cancellation returned HTTP ${cancelled.status}.`);
  }
}

async function executeDirectoryDeleteOptionalIdempotencyCases() {
  const routeId = "DELETE:/admin/api/knowledge-bases/:knowledgeBaseId/source-directories/:directoryId";
  const pathname = `/admin/api/knowledge-bases/${encodeURIComponent(primaryKnowledgeBaseId)}`
    + "/source-directories/source-directory-idempotency-missing";
  const body = { expectedResourceRevision: 1 };
  await execute({
    id: "occurrence:source-directory-delete:header:idempotency-key:omitted",
    routeId,
    covers: ["header:idempotency-key"],
    method: "DELETE",
    pathname,
    json: body,
    expectedStatus: 404,
    expectedCode: "NOT_FOUND"
  });
  await execute({
    id: "occurrence:source-directory-delete:header:idempotency-key:duplicate",
    routeId,
    covers: ["header:idempotency-key"],
    method: "DELETE",
    pathname,
    headerPairs: [
      ["idempotency-key", `${runId}-directory-delete-duplicate-a`],
      ["idempotency-key", `${runId}-directory-delete-duplicate-b`]
    ],
    json: body,
    expectedStatus: 404,
    expectedCode: "NOT_FOUND"
  });
}

async function executeResourceMutationIdempotencyCases() {
  const fixture = await createTemporaryKnowledgeBase("resource idempotency");
  const knowledgeBasePath = `/admin/api/knowledge-bases/${encodeURIComponent(fixture.id)}`;
  const uploaded = await uploadMarkdownFilesWithSession({
    request: uploadBoundaryRequest,
    routeBase: `${knowledgeBasePath}/upload-sessions`,
    files: [{
      relativePath: "boundary/source.md",
      bytes: new TextEncoder().encode(
        "---\ntitle: Boundary idempotency fixture\ntype: reference\n---\n\n"
        + "# Boundary idempotency fixture\n\nA small general-purpose validation document.\n"
      )
    }],
    idempotencyKey: `${runId}-resource-upload`,
    finalizationPollIntervalMs: 100,
    finalizationTimeoutMs: 180_000
  });
  const uploadedSessionId = uploaded.session?.id ?? "";
  if (uploadedSessionId) uploadSessionOwners.delete(uploadedSessionId);
  const sourceFileId = uploaded.files?.[0]?.sourceFileId ?? "";
  assert(sourceFileId, "Resource idempotency fixture upload returned no source-file ID.");
  let source = await waitForVisibleSourceFile(fixture.id, sourceFileId);

  const sourceRoute = `${knowledgeBasePath}/source-files/${encodeURIComponent(sourceFileId)}`;
  const movedPath = "boundary/source-moved.md";
  await assertResourceMutationIdempotency({
    key: "source-file-move",
    routeId: "PATCH:/admin/api/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId",
    method: "PATCH",
    pathname: sourceRoute,
    headers: { "if-match": String(source.resourceRevision) },
    json: { relativePath: movedPath },
    conflictJson: { relativePath: "boundary/source-conflict.md" }
  });
  source = await waitForVisibleSourceFile(fixture.id, sourceFileId, movedPath);

  const replacement = new TextEncoder().encode(
    "---\ntitle: Boundary idempotency fixture revised\ntype: reference\n---\n\n"
    + "# Boundary idempotency fixture revised\n\nReplacement content for exact replay validation.\n"
  );
  const replacementConflict = new Uint8Array([
    ...replacement,
    ...new TextEncoder().encode("\nConflict payload.\n")
  ]);
  await assertResourceMutationIdempotency({
    key: "source-file-replace",
    routeId: "PUT:/admin/api/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId/content",
    method: "PUT",
    pathname: `${sourceRoute}/content`,
    headers: {
      "if-match": String(source.resourceRevision),
      "content-type": "text/markdown; charset=utf-8"
    },
    rawBody: replacement,
    conflictRawBody: replacementConflict
  });
  source = await waitForVisibleSourceFile(fixture.id, sourceFileId, movedPath);

  let directory = await findDirectoryByRelativePath(fixture.id, "boundary");
  assert(directory, "Resource idempotency fixture directory is missing.");
  await assertResourceMutationIdempotency({
    key: "source-directory-move",
    routeId: "PATCH:/admin/api/knowledge-bases/:knowledgeBaseId/source-directories/:directoryId",
    method: "PATCH",
    pathname: `${knowledgeBasePath}/source-directories/${encodeURIComponent(directory.directoryId)}`,
    headers: { "if-match": String(directory.resourceRevision) },
    json: { relativePath: "boundary-moved" },
    conflictJson: { relativePath: "boundary-conflict" }
  });
  source = await waitForVisibleSourceFile(fixture.id, sourceFileId, "boundary-moved/source-moved.md");

  await assertResourceMutationIdempotency({
    key: "source-file-delete",
    routeId: "DELETE:/admin/api/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId",
    method: "DELETE",
    pathname: sourceRoute,
    headers: { "if-match": String(source.resourceRevision) },
    conflictHeaders: { "if-match": String(source.resourceRevision + 1) }
  });
  await waitForSourceFileMissing(fixture.id, sourceFileId);

  directory = await findDirectoryByRelativePath(fixture.id, "boundary-moved");
  assert(directory, "Moved resource idempotency fixture directory is missing.");
  await assertResourceMutationIdempotency({
    key: "source-directory-delete",
    routeId: "DELETE:/admin/api/knowledge-bases/:knowledgeBaseId/source-directories/:directoryId",
    method: "DELETE",
    pathname: `${knowledgeBasePath}/source-directories/${encodeURIComponent(directory.directoryId)}`,
    json: { expectedResourceRevision: directory.resourceRevision },
    conflictJson: { expectedResourceRevision: directory.resourceRevision + 1 },
    operationId: (body) => body?.operationId
  });
  await waitForDirectoryMissing(fixture.id, directory.directoryId);
}

async function assertResourceMutationIdempotency(input) {
  const idempotencyKey = `${runId}-${input.key}-replay`;
  const options = {
    headers: { ...(input.headers ?? {}), "idempotency-key": idempotencyKey },
    ...(input.json === undefined ? {} : { json: input.json }),
    ...(input.rawBody === undefined ? {} : { rawBody: input.rawBody })
  };
  const first = await request(input.method, input.pathname, options);
  assert(first.status === 202,
    `${input.key} idempotency setup returned HTTP ${first.status} ${safeCode(first.body)}.`);
  const readOperationId = input.operationId ?? ((body) => body?.operation?.operationId);
  const firstOperationId = readOperationId(first.body) ?? "";
  assert(firstOperationId, `${input.key} idempotency setup returned no operation ID.`);
  const replay = await execute({
    id: `occurrence:${input.key}:header:idempotency-key:replay`,
    routeId: input.routeId,
    covers: ["header:idempotency-key"],
    method: input.method,
    pathname: input.pathname,
    ...options,
    expectedStatus: 202
  });
  assert(readOperationId(replay.body) === firstOperationId,
    `${input.key} idempotent replay returned a different operation.`);
  await execute({
    id: `occurrence:${input.key}:header:idempotency-key:conflict`,
    routeId: input.routeId,
    covers: ["header:idempotency-key"],
    method: input.method,
    pathname: input.pathname,
    headers: {
      ...(input.headers ?? {}),
      ...(input.conflictHeaders ?? {}),
      "idempotency-key": idempotencyKey
    },
    ...(input.conflictJson === undefined
      ? (input.json === undefined ? {} : { json: input.json })
      : { json: input.conflictJson }),
    ...(input.conflictRawBody === undefined
      ? (input.rawBody === undefined ? {} : { rawBody: input.rawBody })
      : { rawBody: input.conflictRawBody }),
    expectedStatus: 409,
    expectedCode: "IDEMPOTENCY_CONFLICT"
  });
  await waitForResourceOperation(input.pathname, firstOperationId);
}

async function createTemporaryKnowledgeBase(label) {
  const created = await request("POST", "/admin/api/knowledge-bases", {
    json: { name: `${runId} ${label}`, description: null }
  });
  assert(created.status === 201, `${label} knowledge-base setup returned HTTP ${created.status}.`);
  const id = created.body?.knowledgeBase?.id ?? "";
  assert(id, `${label} knowledge-base setup returned no ID.`);
  knowledgeBaseIds.add(id);
  return { id };
}

async function uploadBoundaryRequest(pathname, options = {}) {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(options.query ?? {})) {
    query.set(name, String(value));
  }
  const requestPath = query.size > 0 ? `${pathname}?${query}` : pathname;
  const response = await request(options.method ?? "GET", requestPath, {
    headers: options.headers,
    ...(options.body === undefined ? {} : { json: options.body }),
    ...(options.rawBody === undefined ? {} : { rawBody: options.rawBody })
  });
  const expectedStatus = options.status ?? 200;
  assert(response.status === expectedStatus,
    `Upload fixture ${options.method ?? "GET"} ${pathname} returned HTTP ${response.status} ${safeCode(response.body)}.`);
  if (
    (options.method ?? "GET") === "POST"
    && /\/upload-sessions$/u.test(pathname)
    && typeof response.body?.session?.id === "string"
  ) {
    const knowledgeBaseId = decodeURIComponent(pathname.split("/")[5] ?? "");
    uploadSessionOwners.set(response.body.session.id, knowledgeBaseId);
  }
  return response.body;
}

async function waitForResourceOperation(resourcePath, operationId, timeoutMs = 180_000) {
  const knowledgeBasePath = resourcePath.match(
    /^(\/admin\/api\/knowledge-bases\/[^/]+)/u
  )?.[1];
  assert(knowledgeBasePath, `Unable to locate knowledge-base route for operation ${operationId}.`);
  const pathname = `${knowledgeBasePath}/operations/${encodeURIComponent(operationId)}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await request("GET", pathname);
    assert(response.status === 200,
      `Resource operation ${operationId} poll returned HTTP ${response.status}.`);
    const state = response.body?.operation?.state;
    if (state === "completed") return response.body.operation;
    if (["failed", "cancelled", "superseded"].includes(state)) {
      throw new Error(
        `Resource operation ${operationId} ended in ${state}: ${response.body?.operation?.errorCode ?? "UNKNOWN"}.`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Resource operation ${operationId} did not complete within ${timeoutMs}ms.`);
}

async function waitForVisibleSourceFile(knowledgeBaseId, sourceFileId, expectedPath = null) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const response = await request(
      "GET",
      `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-files?limit=100`
    );
    assert(response.status === 200, `Source-file fixture list returned HTTP ${response.status}.`);
    const source = response.body?.items?.find((item) => item.id === sourceFileId);
    if (source?.state === "failed") {
      throw new Error(`Source-file fixture failed: ${source.failure?.code ?? "UNKNOWN"}.`);
    }
    if (source?.state === "visible" && (!expectedPath || source.relativePath === expectedPath)) {
      return source;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Source-file fixture ${sourceFileId} did not become visible.`);
}

async function waitForSourceFileMissing(knowledgeBaseId, sourceFileId) {
  const pathname = `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`
    + `/source-files/${encodeURIComponent(sourceFileId)}?limit=1`;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const response = await request("GET", pathname);
    if (response.status === 404) return;
    assert(response.status === 200, `Source-file deletion poll returned HTTP ${response.status}.`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Source-file fixture ${sourceFileId} was not deleted.`);
}

async function findDirectoryByRelativePath(knowledgeBaseId, relativePath) {
  const response = await request(
    "GET",
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-directories?limit=100`
  );
  assert(response.status === 200, `Directory fixture list returned HTTP ${response.status}.`);
  return response.body?.items?.find((item) => item.relativePath === relativePath) ?? null;
}

async function waitForDirectoryMissing(knowledgeBaseId, directoryId) {
  const pathname = `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`
    + `/source-directories/${encodeURIComponent(directoryId)}`;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const response = await request("GET", pathname);
    if (response.status === 404) return;
    assert(response.status === 200, `Directory deletion poll returned HTTP ${response.status}.`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Directory fixture ${directoryId} was not deleted.`);
}

async function readSourceContentBytes(sourceBase) {
  adminApiRequestCount += 1;
  const response = await fetch(`${baseUrl}${sourceBase}/content`, {
    headers: { cookie }
  });
  assert(response.status === 200, `Source content fixture returned HTTP ${response.status}.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert(bytes.byteLength > 0, "Source content fixture is empty.");
  return bytes;
}

function alternateSiblingPath(relativePath, label) {
  const segments = relativePath.split("/");
  const current = segments.pop() ?? relativePath;
  const extensionIndex = current.lastIndexOf(".");
  const stem = extensionIndex > 0 ? current.slice(0, extensionIndex) : current;
  const extension = extensionIndex > 0 ? current.slice(extensionIndex) : "";
  segments.push(`${stem}-${label}-${runId.slice(-8)}${extension}`);
  return segments.join("/");
}

async function executeMutationHeaderCases() {
  const base = `/admin/api/knowledge-bases/${encodeURIComponent(primaryKnowledgeBaseId)}/source-files/source-file-missing`;
  await execute({
    ...fieldCase("header:idempotency-key:omitted", ["header:idempotency-key"], "PATCH", base, 422, "VALIDATION_ERROR"),
    headers: { "if-match": "1" },
    json: { relativePath: "renamed.md" }
  });
  await execute({
    ...fieldCase("header:if-match:invalid", ["header:if-match"], "PATCH", base, 422, "VALIDATION_ERROR"),
    headers: { "if-match": "0", "idempotency-key": `${runId}-if-match` },
    json: { relativePath: "renamed.md" }
  });
  await execute({
    ...fieldCase("body:relativePath:null", [], "PATCH", base, 422, "VALIDATION_ERROR"),
    coversBody: "relativePath",
    headers: { "if-match": "1", "idempotency-key": `${runId}-relative-path` },
    json: { relativePath: null }
  });
  await execute({
    ...fieldCase(
      "header:x-source-relative-path:unsafe",
      ["header:x-source-relative-path"],
      "PUT",
      `/admin/api/knowledge-bases/${encodeURIComponent(existingSourceFixture.knowledgeBaseId)}`
        + `/source-files/${encodeURIComponent(existingSourceFixture.sourceFileId)}/content`,
      422,
      "VALIDATION_ERROR"
    ),
    headers: {
      "if-match": String(existingSourceFixture.resourceRevision),
      "idempotency-key": `${runId}-replace-path`,
      "x-source-relative-path": "../escape.md"
    },
    contentType: "text/markdown",
    rawBody: "# replacement"
  });
  await execute({
    id: "body:expectedResourceRevision:null",
    coversBody: "expectedResourceRevision",
    method: "DELETE",
    pathname: `/admin/api/knowledge-bases/${encodeURIComponent(primaryKnowledgeBaseId)}`
      + "/source-directories/source-directory-missing",
    json: { expectedResourceRevision: null },
    expectedStatus: 422,
    expectedCode: "VALIDATION_ERROR"
  });
  await execute({
    id: "body:sourceFileIds:null",
    coversBody: "sourceFileIds",
    method: "POST",
    pathname: `/admin/api/knowledge-bases/${encodeURIComponent(primaryKnowledgeBaseId)}`
      + "/source-files/task-deletions",
    json: { sourceFileIds: null },
    expectedStatus: 400,
    expectedCode: "INVALID_SOURCE_FILE_TASK_DELETION_REQUEST"
  });
}

async function findExistingSourceFixture() {
  const knowledgeBases = await request("GET", "/admin/api/knowledge-bases?limit=200");
  assert(knowledgeBases.status === 200, `Knowledge-base fixture lookup returned HTTP ${knowledgeBases.status}.`);
  for (const knowledgeBase of knowledgeBases.body?.items ?? []) {
    const knowledgeBaseId = typeof knowledgeBase?.id === "string" ? knowledgeBase.id : "";
    if (!knowledgeBaseId || knowledgeBaseIds.has(knowledgeBaseId)) continue;
    const files = await request(
      "GET",
      `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-files?limit=1`
    );
    const sourceFile = files.status === 200 ? files.body?.items?.[0] : null;
    if (
      typeof sourceFile?.id === "string"
      && typeof sourceFile.relativePath === "string"
      && Number.isInteger(sourceFile.resourceRevision)
      && sourceFile.resourceRevision > 1
    ) {
      return {
        knowledgeBaseId,
        sourceFileId: sourceFile.id,
        relativePath: sourceFile.relativePath,
        resourceRevision: sourceFile.resourceRevision
      };
    }
  }
  throw new Error("No existing source-file fixture is available for safe path validation.");
}

async function findExistingDirectoryFixture() {
  const knowledgeBases = await request("GET", "/admin/api/knowledge-bases?limit=200");
  assert(knowledgeBases.status === 200,
    `Knowledge-base directory fixture lookup returned HTTP ${knowledgeBases.status}.`);
  for (const knowledgeBase of knowledgeBases.body?.items ?? []) {
    const knowledgeBaseId = typeof knowledgeBase?.id === "string" ? knowledgeBase.id : "";
    if (!knowledgeBaseId || knowledgeBaseIds.has(knowledgeBaseId)) continue;
    const directories = await request(
      "GET",
      `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-directories?limit=200`
    );
    const directory = (directories.status === 200 ? directories.body?.items ?? [] : [])
      .find((item) =>
        typeof item?.directoryId === "string"
        && typeof item.relativePath === "string"
        && Number.isInteger(item.resourceRevision)
        && item.resourceRevision > 0);
    if (directory) {
      return {
        knowledgeBaseId,
        directoryId: directory.directoryId,
        relativePath: directory.relativePath,
        resourceRevision: directory.resourceRevision
      };
    }
  }
  throw new Error("No existing source-directory fixture is available for revision validation.");
}

function readReferencedBodyFieldCoverage() {
  const evidenceDirectory = path.dirname(reportPath);
  const positiveName = "admin-api-positive-final-late-readiness.json";
  const securityName = "admin-api-security-expanded-after-proxy-fix.json";
  const positive = readEvidenceReport(path.join(evidenceDirectory, positiveName));
  const security = readEvidenceReport(path.join(evidenceDirectory, securityName));
  const positiveRows = Array.isArray(positive.rows) ? positive.rows : [];
  const securityRows = Array.isArray(security.rows) ? security.rows : [];
  assert(
    positiveRows.some((row) => row.routeId === "POST:/admin/api/login" && row.status === 200),
    `${positiveName} does not contain the successful login body evidence.`
  );
  assert(
    securityRows.some((row) => row.case === "invalid-credentials" && row.status === 401),
    `${securityName} does not contain the rejected login body evidence.`
  );
  for (const routeId of [
    "PUT:/admin/api/settings/embeddings/:configurationId",
    "PUT:/admin/api/settings/rerankers/:configurationId"
  ]) {
    assert(
      positiveRows.some((row) => row.routeId === routeId && row.status === 200),
      `${positiveName} does not contain ${routeId} body evidence.`
    );
  }
  return [
    { name: "username", report: securityName, case: "invalid-credentials" },
    { name: "password", report: securityName, case: "invalid-credentials" },
    { name: "configuration", report: positiveName, case: "embedding-and-reranker-update" },
    { name: "expectedRevision", report: positiveName, case: "embedding-and-reranker-update" }
  ];
}

function readEvidenceReport(filePath) {
  assert(fs.existsSync(filePath), `Referenced Admin evidence is missing: ${path.basename(filePath)}.`);
  const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert(value?.ok === true, `Referenced Admin evidence is not green: ${path.basename(filePath)}.`);
  return value;
}

async function executeUploadCases() {
  const base = `/admin/api/knowledge-bases/${encodeURIComponent(primaryKnowledgeBaseId)}/upload-sessions`;
  for (const [id, body] of [
    ["body:declaredFileCount:null", { declaredFileCount: null, declaredByteCount: 0 }],
    ["body:declaredFileCount:negative", { declaredFileCount: -1, declaredByteCount: 0 }],
    ["body:declaredByteCount:wrong-type", { declaredFileCount: 0, declaredByteCount: "0" }]
  ]) {
    await execute({
      id,
      covers: ["header:idempotency-key"],
      coversBody: id.split(":")[1],
      method: "POST",
      pathname: base,
      headers: { "idempotency-key": `${runId}-${id}` },
      json: body,
      expectedStatus: 400,
      expectedCode: "INVALID_UPLOAD_SESSION"
    });
  }
  const created = await request("POST", base, {
    headers: { "idempotency-key": `${runId}-upload-session` },
    json: { declaredFileCount: 0, declaredByteCount: 0 }
  });
  assert(created.status === 201, `Upload-session setup returned HTTP ${created.status}.`);
  uploadSessionId = created.body?.session?.id ?? "";
  assert(uploadSessionId, "Upload-session setup returned no ID.");
  uploadSessionOwners.set(uploadSessionId, primaryKnowledgeBaseId);
  const session = `${base}/${encodeURIComponent(uploadSessionId)}`;
  await execute(fieldCase("query:transferState:invalid", ["query:transferState", "param:sessionId"], "GET", `${session}?transferState=invalid`, 400, "INVALID_UPLOAD_ENTRY_FILTER"));
  await execute({
    ...fieldCase("body:entries:wrong-type", [], "POST", `${session}/entries`, 400, "INVALID_UPLOAD_MANIFEST_PAGE"),
    coversBody: "entries",
    json: { entries: null }
  });
  await execute({
    ...fieldCase("param:entryId:missing", ["param:entryId"], "PUT", `${session}/entries/entry-missing/content`, 404),
    contentType: "text/markdown",
    rawBody: "# missing entry"
  });
}

async function executeSettingsConfigurationOccurrenceCases() {
  for (const provider of ["embedding", "reranker"]) {
    await executeProviderUpdateCases(provider);
    await executeProviderActionCases(provider);
    await executeProviderDeleteCases(provider);
  }
}

async function executeProviderUpdateCases(provider) {
  const fixture = await createProviderFixture(provider, "update");
  const routeId = providerRouteId(provider, "update");
  const pathname = `${providerCollectionPath(provider)}/${encodeURIComponent(fixture.id)}`;
  const validationCode = providerErrorCode(provider, "VALIDATION_ERROR");
  const conflictCode = providerErrorCode(provider, "REVISION_CONFLICT");
  for (const input of [{ id: "omitted", value: undefined }, { id: "null", value: null },
    { id: "below-minimum", value: 0 }, { id: "wrong-type", value: "1" }]) {
    await execute({
      id: `settings:${provider}:update:expectedRevision:${input.id}`,
      routeId,
      coversBody: "expectedRevision",
      method: "PUT",
      pathname,
      json: {
        ...(input.value === undefined ? {} : { expectedRevision: input.value }),
        configuration: fixture.draft
      },
      expectedStatus: 400,
      expectedCode: validationCode
    });
  }
  for (const input of [{ id: "omitted", value: undefined }, { id: "null", value: null },
    { id: "wrong-type", value: [] }]) {
    await execute({
      id: `settings:${provider}:update:configuration:${input.id}`,
      routeId,
      coversBody: "configuration",
      method: "PUT",
      pathname,
      json: {
        expectedRevision: fixture.revision,
        ...(input.value === undefined ? {} : { configuration: input.value })
      },
      expectedStatus: 400,
      expectedCode: validationCode
    });
  }
  const minimum = await execute({
    id: `settings:${provider}:update:expectedRevision:minimum`,
    routeId,
    coversBody: "expectedRevision",
    method: "PUT",
    pathname,
    json: { expectedRevision: 1, configuration: fixture.draft },
    expectedStatus: 200
  });
  fixture.revision = Number(minimum.body?.configuration?.revision ?? 0);
  assert(fixture.revision === 2, `${provider} update minimum did not advance revision to 2.`);
  await execute({
    id: `settings:${provider}:update:configuration:unknown-field`,
    routeId,
    coversBody: "configuration",
    method: "PUT",
    pathname,
    json: {
      expectedRevision: fixture.revision,
      configuration: { ...fixture.draft, unknownField: true }
    },
    expectedStatus: 400,
    expectedCode: validationCode
  });
  for (const caseName of ["stale-revision", "conflict"]) {
    await execute({
      id: `settings:${provider}:update:expectedRevision:${caseName}`,
      routeId,
      coversBody: "expectedRevision",
      method: "PUT",
      pathname,
      json: { expectedRevision: 1, configuration: fixture.draft },
      expectedStatus: 409,
      expectedCode: conflictCode
    });
  }
}

async function executeProviderActionCases(provider) {
  const fixture = await createProviderFixture(provider, "action");
  const routeId = providerRouteId(provider, "action");
  const pathname = `${providerCollectionPath(provider)}/${encodeURIComponent(fixture.id)}/resume`;
  const validationCode = providerErrorCode(provider, "VALIDATION_ERROR");
  const conflictCode = providerErrorCode(provider, "REVISION_CONFLICT");
  for (const input of [{ id: "omitted", value: undefined }, { id: "null", value: null },
    { id: "below-minimum", value: 0 }, { id: "wrong-type", value: "1" }]) {
    await execute({
      id: `settings:${provider}:action:expectedRevision:${input.id}`,
      routeId,
      coversBody: "expectedRevision",
      method: "POST",
      pathname,
      json: input.value === undefined ? {} : { expectedRevision: input.value },
      expectedStatus: 400,
      expectedCode: validationCode
    });
  }
  const minimum = await execute({
    id: `settings:${provider}:action:expectedRevision:minimum`,
    routeId,
    coversBody: "expectedRevision",
    method: "POST",
    pathname,
    json: { expectedRevision: 1 },
    expectedStatus: 200
  });
  fixture.revision = Number(minimum.body?.configuration?.revision ?? 0);
  assert(fixture.revision === 2, `${provider} action minimum did not advance revision to 2.`);
  for (const caseName of ["stale-revision", "conflict"]) {
    await execute({
      id: `settings:${provider}:action:expectedRevision:${caseName}`,
      routeId,
      coversBody: "expectedRevision",
      method: "POST",
      pathname,
      json: { expectedRevision: 1 },
      expectedStatus: 409,
      expectedCode: conflictCode
    });
  }
}

async function executeProviderDeleteCases(provider) {
  const conflictFixture = await createProviderFixture(provider, "delete conflict");
  const minimumFixture = await createProviderFixture(provider, "delete minimum");
  const routeId = providerRouteId(provider, "delete");
  const validationCode = providerErrorCode(provider, "VALIDATION_ERROR");
  const conflictCode = providerErrorCode(provider, "REVISION_CONFLICT");
  const conflictPath = `${providerCollectionPath(provider)}/${encodeURIComponent(conflictFixture.id)}`;
  for (const input of [{ id: "omitted", value: undefined }, { id: "null", value: null },
    { id: "below-minimum", value: 0 }, { id: "wrong-type", value: "1" }]) {
    await execute({
      id: `settings:${provider}:delete:expectedRevision:${input.id}`,
      routeId,
      coversBody: "expectedRevision",
      method: "DELETE",
      pathname: conflictPath,
      json: input.value === undefined ? {} : { expectedRevision: input.value },
      expectedStatus: 400,
      expectedCode: validationCode
    });
  }
  const advanced = await request("PUT", conflictPath, {
    json: { expectedRevision: 1, configuration: conflictFixture.draft }
  });
  assert(advanced.status === 200, `${provider} delete conflict fixture update returned HTTP ${advanced.status}.`);
  conflictFixture.revision = Number(advanced.body?.configuration?.revision ?? 0);
  assert(conflictFixture.revision === 2,
    `${provider} delete conflict fixture did not advance revision to 2.`);
  providerRevisionMap(provider).set(conflictFixture.id, conflictFixture.revision);
  for (const caseName of ["stale-revision", "conflict"]) {
    await execute({
      id: `settings:${provider}:delete:expectedRevision:${caseName}`,
      routeId,
      coversBody: "expectedRevision",
      method: "DELETE",
      pathname: conflictPath,
      json: { expectedRevision: 1 },
      expectedStatus: 409,
      expectedCode: conflictCode
    });
  }
  const minimumPath = `${providerCollectionPath(provider)}/${encodeURIComponent(minimumFixture.id)}`;
  await execute({
    id: `settings:${provider}:delete:expectedRevision:minimum`,
    routeId,
    coversBody: "expectedRevision",
    method: "DELETE",
    pathname: minimumPath,
    json: { expectedRevision: 1 },
    expectedStatus: 200
  });
  providerRevisionMap(provider).delete(minimumFixture.id);
}

async function createProviderFixture(provider, label) {
  const draft = providerDraft(provider, label);
  const response = await request("POST", providerCollectionPath(provider), { json: draft });
  assert(response.status === 201, `${provider} ${label} fixture returned HTTP ${response.status}.`);
  const configuration = response.body?.configuration;
  assert(typeof configuration?.publicId === "string", `${provider} ${label} fixture returned no ID.`);
  assert(configuration.revision === 1, `${provider} ${label} fixture did not start at revision 1.`);
  providerRevisionMap(provider).set(configuration.publicId, configuration.revision);
  return { id: configuration.publicId, revision: configuration.revision, draft };
}

function providerDraft(provider, label) {
  const common = {
    displayName: `${runId} ${provider} ${label}`,
    authenticationMode: "none",
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: null,
    modelName: "boundary-model",
    timeoutMs: 100,
    retryCount: 0,
    minimumIntervalMs: 0,
    concurrency: 1
  };
  return provider === "embedding"
    ? {
        ...common,
        requestedDimension: null,
        normalization: "l2",
        maximumInputTokens: 8_192,
        batchSize: 8,
        maximumResponseBytes: 1_024,
        minimumVectorRelevance: 0
      }
    : common;
}

function providerCollectionPath(provider) {
  return `/admin/api/settings/${provider === "embedding" ? "embeddings" : "rerankers"}`;
}

function providerRevisionMap(provider) {
  return provider === "embedding"
    ? embeddingConfigurationRevisions
    : rerankerConfigurationRevisions;
}

function providerRouteId(provider, operation) {
  const collection = provider === "embedding" ? "embeddings" : "rerankers";
  if (operation === "action") return `POST:/admin/api/settings/${collection}/:configurationId/:action`;
  const method = operation === "delete" ? "DELETE" : "PUT";
  return `${method}:/admin/api/settings/${collection}/:configurationId`;
}

function providerErrorCode(provider, suffix) {
  return `${provider === "embedding" ? "EMBEDDING" : "RERANKER"}_CONFIGURATION_${suffix}`;
}

async function executeSettingsIdentifierCases() {
  for (const provider of ["embedding", "reranker"]) {
    const collection = provider === "embedding" ? "embeddings" : "rerankers";
    const missing = `${provider}-configuration-missing`;
    const draft = providerDraft(provider, "missing identifier");
    for (const input of [{
      key: "update",
      method: "PUT",
      suffix: "",
      json: { expectedRevision: 1, configuration: draft }
    }, {
      key: "test",
      method: "POST",
      suffix: "/test",
      json: {}
    }, {
      key: "action",
      method: "POST",
      suffix: "/resume",
      json: { expectedRevision: 1 }
    }, ...(provider === "reranker" ? [{
      key: "delete",
      method: "DELETE",
      suffix: "",
      json: { expectedRevision: 1 }
    }] : [])]) {
      const routeId = input.key === "action"
        ? `POST:/admin/api/settings/${collection}/:configurationId/:action`
        : input.key === "test"
          ? `POST:/admin/api/settings/${collection}/:configurationId/test`
          : `${input.method}:/admin/api/settings/${collection}/:configurationId`;
      await execute({
        id: `identifier:${provider}-${input.key}:configuration`,
        routeId,
        covers: ["param:configurationId"],
        method: input.method,
        pathname: `/admin/api/settings/${collection}/${missing}${input.suffix}`,
        json: input.json,
        expectedStatus: 404,
        expectedCode: providerErrorCode(provider, "NOT_FOUND")
      });
    }
  }
  for (const input of [{
    key: "update",
    routeId: "PUT:/admin/api/settings/models/:modelId",
    method: "PUT",
    pathname: "/admin/api/settings/models/model-missing",
    json: {}
  }, {
    key: "activate",
    routeId: "POST:/admin/api/settings/models/:modelId/activate",
    method: "POST",
    pathname: "/admin/api/settings/models/model-missing/activate",
    json: {}
  }, {
    key: "status",
    routeId: "HELPER:model-status",
    method: "POST",
    pathname: "/admin/api/settings/models/model-missing/pause",
    json: {}
  }]) {
    await execute({
      id: `identifier:model-${input.key}:model`,
      routeId: input.routeId,
      covers: ["param:modelId"],
      method: input.method,
      pathname: input.pathname,
      json: input.json,
      expectedStatus: 404,
      expectedCode: "NOT_FOUND"
    });
  }
  for (const input of [
    { name: "param:keyId", method: "DELETE", pathname: "/admin/api/openapi-keys/openapi-key-missing", json: {}, statuses: [404] },
    { name: "param:configurationId", method: "DELETE", pathname: "/admin/api/settings/embeddings/configuration-missing", json: { expectedRevision: 1 }, statuses: [404] },
    { name: "param:modelId", method: "DELETE", pathname: "/admin/api/settings/models/model-missing", json: {}, statuses: [404] },
    { name: "param:action", method: "POST", pathname: "/admin/api/settings/embeddings/configuration-missing/invalid-action", json: { expectedRevision: 1 }, statuses: [404] }
  ]) {
    await execute({
      id: `${input.name}:missing`,
      covers: [input.name],
      method: input.method,
      pathname: input.pathname,
      json: input.json,
      expectedStatuses: input.statuses
    });
  }
}

async function executeIdentifierOccurrenceCases() {
  const missingKnowledgeBaseId = "knowledge-base-missing";
  const missingKnowledgeBase = encodeURIComponent(missingKnowledgeBaseId);
  const primary = encodeURIComponent(primaryKnowledgeBaseId);
  const missingSource = "source-file-missing";
  const missingDirectory = "source-directory-missing";
  const missingOperation = "operation-missing";
  const missingSession = "upload-session-missing";
  const missingEntry = "upload-entry-missing";
  const cases = [{
    key: "delete-knowledge-base",
    routeId: "DELETE:/admin/api/knowledge-bases/:knowledgeBaseId",
    method: "DELETE",
    pathname: `/admin/api/knowledge-bases/${missingKnowledgeBase}`
  }, {
    key: "tree",
    routeId: "GET:/admin/api/knowledge-bases/:knowledgeBaseId/files/tree",
    method: "GET",
    pathname: `/admin/api/knowledge-bases/${missingKnowledgeBase}/files/tree`
  }, {
    key: "tree-search",
    routeId: "GET:/admin/api/knowledge-bases/:knowledgeBaseId/files/tree/search",
    method: "GET",
    pathname: `/admin/api/knowledge-bases/${missingKnowledgeBase}/files/tree/search?query=missing`
  }, {
    key: "index-maintenance",
    routeId: "POST:/admin/api/knowledge-bases/:knowledgeBaseId/index-maintenance",
    method: "POST",
    pathname: `/admin/api/knowledge-bases/${missingKnowledgeBase}/index-maintenance`,
    json: { idempotencyKey: `${runId}-missing-maintenance` }
  }, {
    key: "index-maintenance-cancel",
    routeId: "POST:/admin/api/knowledge-bases/:knowledgeBaseId/index-maintenance/cancel",
    method: "POST",
    pathname: `/admin/api/knowledge-bases/${missingKnowledgeBase}/index-maintenance/cancel`,
    json: {}
  }, {
    key: "processing-summary",
    routeId: "GET:/admin/api/knowledge-bases/:knowledgeBaseId/processing-summary",
    method: "GET",
    pathname: `/admin/api/knowledge-bases/${missingKnowledgeBase}/processing-summary`
  }, {
    key: "public-urls",
    routeId: "GET:/admin/api/knowledge-bases/:knowledgeBaseId/public-urls",
    method: "GET",
    pathname: `/admin/api/knowledge-bases/${missingKnowledgeBase}/public-urls`
  }, {
    key: "generated-detail-read",
    routeId: "GET:/admin/api/knowledge-bases/:knowledgeBaseId/files/detail",
    method: "GET",
    pathname: `/admin/api/knowledge-bases/${missingKnowledgeBase}/files/detail?path=index.md`
  }, {
    key: "generated-detail-delete",
    routeId: "DELETE:/admin/api/knowledge-bases/:knowledgeBaseId/files/detail",
    method: "DELETE",
    pathname: `/admin/api/knowledge-bases/${missingKnowledgeBase}/files/detail?path=missing.md`
  }, {
    key: "source-files",
    routeId: "GET:/admin/api/knowledge-bases/:knowledgeBaseId/source-files",
    method: "GET",
    pathname: `/admin/api/knowledge-bases/${missingKnowledgeBase}/source-files`
  }, {
    key: "source-file-detail",
    routeId: "GET:/admin/api/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId",
    method: "GET",
    pathname: `/admin/api/knowledge-bases/${missingKnowledgeBase}/source-files/${missingSource}`
  }, {
    key: "source-file-retry",
    routeId: "POST:/admin/api/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId/retry",
    method: "POST",
    pathname: `/admin/api/knowledge-bases/${missingKnowledgeBase}/source-files/${missingSource}/retry`,
    json: {}
  }, {
    key: "source-file-task-deletions",
    routeId: "POST:/admin/api/knowledge-bases/:knowledgeBaseId/source-files/task-deletions",
    method: "POST",
    pathname: `/admin/api/knowledge-bases/${missingKnowledgeBase}/source-files/task-deletions`,
    json: { sourceFileIds: [missingSource] }
  }, {
    key: "knowledge-base-update",
    routeId: "PATCH:/admin/api/knowledge-bases/:knowledgeBaseId",
    method: "PATCH",
    pathname: `/admin/api/knowledge-bases/${missingKnowledgeBase}`,
    headers: { "if-match": "1" },
    json: { name: "Missing" }
  }, {
    key: "source-directories",
    routeId: "GET:/admin/api/knowledge-bases/:knowledgeBaseId/source-directories",
    method: "GET",
    pathname: `/admin/api/knowledge-bases/${missingKnowledgeBase}/source-directories`
  }, {
    key: "source-directory-detail",
    routeId: "GET:/admin/api/knowledge-bases/:knowledgeBaseId/source-directories/:directoryId",
    method: "GET",
    pathname: `/admin/api/knowledge-bases/${missingKnowledgeBase}/source-directories/${missingDirectory}`
  }, {
    key: "source-directory-move",
    routeId: "PATCH:/admin/api/knowledge-bases/:knowledgeBaseId/source-directories/:directoryId",
    method: "PATCH",
    pathname: `/admin/api/knowledge-bases/${missingKnowledgeBase}/source-directories/${missingDirectory}`,
    headers: { "if-match": "1", "idempotency-key": `${runId}-missing-directory-move` },
    json: { relativePath: "missing" }
  }, {
    key: "source-directory-delete",
    routeId: "DELETE:/admin/api/knowledge-bases/:knowledgeBaseId/source-directories/:directoryId",
    method: "DELETE",
    pathname: `/admin/api/knowledge-bases/${missingKnowledgeBase}/source-directories/${missingDirectory}`,
    headers: { "idempotency-key": `${runId}-missing-directory-delete` },
    json: { expectedResourceRevision: 1 }
  }, {
    key: "source-content-read",
    routeId: "GET:/admin/api/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId/content",
    method: "GET",
    pathname: `/admin/api/knowledge-bases/${missingKnowledgeBase}/source-files/${missingSource}/content`
  }, {
    key: "source-file-move",
    routeId: "PATCH:/admin/api/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId",
    method: "PATCH",
    pathname: `/admin/api/knowledge-bases/${missingKnowledgeBase}/source-files/${missingSource}`,
    headers: { "if-match": "1", "idempotency-key": `${runId}-missing-file-move` },
    json: { relativePath: "missing.md" }
  }, {
    key: "source-content-replace",
    routeId: "PUT:/admin/api/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId/content",
    method: "PUT",
    pathname: `/admin/api/knowledge-bases/${missingKnowledgeBase}/source-files/${missingSource}/content`,
    headers: { "if-match": "1", "idempotency-key": `${runId}-missing-file-replace` },
    contentType: "text/markdown",
    rawBody: "# Missing"
  }, {
    key: "source-file-delete",
    routeId: "DELETE:/admin/api/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId",
    method: "DELETE",
    pathname: `/admin/api/knowledge-bases/${missingKnowledgeBase}/source-files/${missingSource}`,
    headers: { "if-match": "1", "idempotency-key": `${runId}-missing-file-delete` }
  }, {
    key: "operations",
    routeId: "GET:/admin/api/knowledge-bases/:knowledgeBaseId/operations",
    method: "GET",
    pathname: `/admin/api/knowledge-bases/${missingKnowledgeBase}/operations`
  }, {
    key: "operation-detail",
    routeId: "GET:/admin/api/knowledge-bases/:knowledgeBaseId/operations/:operationId",
    method: "GET",
    pathname: `/admin/api/knowledge-bases/${missingKnowledgeBase}/operations/${missingOperation}`
  }, {
    key: "upload-session-create",
    routeId: "POST:/admin/api/knowledge-bases/:knowledgeBaseId/upload-sessions",
    method: "POST",
    pathname: `/admin/api/knowledge-bases/${missingKnowledgeBase}/upload-sessions`,
    headers: { "idempotency-key": `${runId}-missing-upload` },
    json: { declaredFileCount: 0, declaredByteCount: 0 }
  }, {
    key: "upload-entry-add",
    routeId: "POST:/admin/api/knowledge-bases/:knowledgeBaseId/upload-sessions/:sessionId/entries",
    method: "POST",
    pathname: `/admin/api/knowledge-bases/${missingKnowledgeBase}/upload-sessions/${missingSession}/entries`,
    json: { entries: [] }
  }, {
    key: "upload-seal",
    routeId: "POST:/admin/api/knowledge-bases/:knowledgeBaseId/upload-sessions/:sessionId/seal",
    method: "POST",
    pathname: `/admin/api/knowledge-bases/${missingKnowledgeBase}/upload-sessions/${missingSession}/seal`,
    json: {}
  }, {
    key: "upload-content",
    routeId: "PUT:/admin/api/knowledge-bases/:knowledgeBaseId/upload-sessions/:sessionId/entries/:entryId/content",
    method: "PUT",
    pathname: `/admin/api/knowledge-bases/${missingKnowledgeBase}/upload-sessions/${missingSession}/entries/${missingEntry}/content`,
    contentType: "text/markdown",
    rawBody: "# Missing"
  }, {
    key: "upload-detail",
    routeId: "GET:/admin/api/knowledge-bases/:knowledgeBaseId/upload-sessions/:sessionId",
    method: "GET",
    pathname: `/admin/api/knowledge-bases/${missingKnowledgeBase}/upload-sessions/${missingSession}`
  }, {
    key: "upload-reconcile",
    routeId: "POST:/admin/api/knowledge-bases/:knowledgeBaseId/upload-sessions/:sessionId/reconcile",
    method: "POST",
    pathname: `/admin/api/knowledge-bases/${missingKnowledgeBase}/upload-sessions/${missingSession}/reconcile`,
    json: {}
  }, {
    key: "upload-finalize",
    routeId: "POST:/admin/api/knowledge-bases/:knowledgeBaseId/upload-sessions/:sessionId/finalize",
    method: "POST",
    pathname: `/admin/api/knowledge-bases/${missingKnowledgeBase}/upload-sessions/${missingSession}/finalize`,
    json: {}
  }, {
    key: "upload-cancel",
    routeId: "DELETE:/admin/api/knowledge-bases/:knowledgeBaseId/upload-sessions/:sessionId",
    method: "DELETE",
    pathname: `/admin/api/knowledge-bases/${missingKnowledgeBase}/upload-sessions/${missingSession}`
  }];

  for (const input of cases) {
    await execute({
      id: `identifier:${input.key}:knowledge-base`,
      routeId: input.routeId,
      covers: [
        "param:knowledgeBaseId",
        ...(input.pathname.includes(`/${missingSession}`) ? ["param:sessionId"] : [])
      ],
      method: input.method,
      pathname: input.pathname,
      headers: input.headers,
      json: input.json,
      contentType: input.contentType,
      rawBody: input.rawBody,
      expectedStatuses: [200, 201, 202, 400, 404, 409, 422]
    });
  }

  for (const input of [{
    key: "source-file-retry",
    routeId: "POST:/admin/api/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId/retry",
    method: "POST",
    pathname: `/admin/api/knowledge-bases/${primary}/source-files/${missingSource}/retry`,
    json: {}
  }, {
    key: "source-content-read",
    routeId: "GET:/admin/api/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId/content",
    method: "GET",
    pathname: `/admin/api/knowledge-bases/${primary}/source-files/${missingSource}/content`
  }, {
    key: "source-file-move",
    routeId: "PATCH:/admin/api/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId",
    method: "PATCH",
    pathname: `/admin/api/knowledge-bases/${primary}/source-files/${missingSource}`,
    headers: { "if-match": "1", "idempotency-key": `${runId}-missing-target-move` },
    json: { relativePath: "missing.md" }
  }, {
    key: "source-content-replace",
    routeId: "PUT:/admin/api/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId/content",
    method: "PUT",
    pathname: `/admin/api/knowledge-bases/${primary}/source-files/${missingSource}/content`,
    headers: { "if-match": "1", "idempotency-key": `${runId}-missing-target-replace` },
    contentType: "text/markdown",
    rawBody: "# Missing"
  }, {
    key: "source-file-delete",
    routeId: "DELETE:/admin/api/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId",
    method: "DELETE",
    pathname: `/admin/api/knowledge-bases/${primary}/source-files/${missingSource}`,
    headers: { "if-match": "1", "idempotency-key": `${runId}-missing-target-delete` }
  }]) {
    await execute({
      id: `identifier:${input.key}:source-file`,
      routeId: input.routeId,
      covers: ["param:sourceFileId"],
      method: input.method,
      pathname: input.pathname,
      headers: input.headers,
      json: input.json,
      contentType: input.contentType,
      rawBody: input.rawBody,
      expectedStatuses: [400, 404, 409, 422]
    });
  }

  for (const input of [{
    key: "source-directory-move",
    routeId: "PATCH:/admin/api/knowledge-bases/:knowledgeBaseId/source-directories/:directoryId",
    method: "PATCH",
    pathname: `/admin/api/knowledge-bases/${primary}/source-directories/${missingDirectory}`,
    headers: { "if-match": "1", "idempotency-key": `${runId}-missing-target-directory-move` },
    json: { relativePath: "missing" }
  }, {
    key: "source-directory-delete",
    routeId: "DELETE:/admin/api/knowledge-bases/:knowledgeBaseId/source-directories/:directoryId",
    method: "DELETE",
    pathname: `/admin/api/knowledge-bases/${primary}/source-directories/${missingDirectory}`,
    headers: { "idempotency-key": `${runId}-missing-target-directory-delete` },
    json: { expectedResourceRevision: 1 }
  }]) {
    await execute({
      id: `identifier:${input.key}:directory`,
      routeId: input.routeId,
      covers: ["param:directoryId"],
      method: input.method,
      pathname: input.pathname,
      headers: input.headers,
      json: input.json,
      expectedStatuses: [400, 404, 409, 422]
    });
  }
}

async function execute(input) {
  const response = await request(input.method, input.pathname, input);
  if (
    input.method === "POST"
    && input.pathname === "/admin/api/knowledge-bases"
    && response.status === 201
    && typeof response.body?.knowledgeBase?.id === "string"
  ) {
    knowledgeBaseIds.add(response.body.knowledgeBase.id);
  }
  if (
    input.method === "POST"
    && /\/admin\/api\/knowledge-bases\/[^/]+\/upload-sessions$/u.test(input.pathname)
    && response.status === 201
    && typeof response.body?.session?.id === "string"
  ) {
    const knowledgeBaseId = decodeURIComponent(input.pathname.split("/")[5] ?? "");
    uploadSessionOwners.set(response.body.session.id, knowledgeBaseId);
  }
  if (
    input.method === "POST"
    && input.pathname === "/admin/api/openapi-keys"
    && response.status === 201
    && typeof response.body?.key?.id === "string"
  ) {
    openApiKeyIds.add(response.body.key.id);
  }
  const configurationMatch = input.pathname.match(
    /^\/admin\/api\/settings\/(embeddings|rerankers)\/([^/]+)(?:\/[^/]+)?$/u
  );
  if (
    response.status >= 200
    && response.status < 300
    && configurationMatch
    && typeof response.body?.configuration?.publicId === "string"
    && Number.isSafeInteger(response.body.configuration.revision)
  ) {
    const revisions = configurationMatch[1] === "embeddings"
      ? embeddingConfigurationRevisions
      : rerankerConfigurationRevisions;
    revisions.set(response.body.configuration.publicId, response.body.configuration.revision);
  }
  const expectedStatuses = input.expectedStatuses ?? [input.expectedStatus];
  assert(expectedStatuses.includes(response.status),
    `${input.id} returned HTTP ${response.status} ${safeCode(response.body)}.`);
  if (input.expectedCode) {
    assert(safeCode(response.body) === input.expectedCode,
      `${input.id} returned ${safeCode(response.body)} instead of ${input.expectedCode}.`);
  }
  if (input.expectedCodes) {
    assert(input.expectedCodes.includes(safeCode(response.body)),
      `${input.id} returned undocumented error code ${safeCode(response.body)}.`);
  }
  report.rows.push({
    sequence: report.rows.length + 1,
    id: input.id,
    routeId: input.routeId ?? null,
    method: input.method,
    path: input.pathname.split("?", 1)[0],
    covers: input.covers ?? [],
    bodyField: input.coversBody ?? null,
    status: response.status,
    errorCode: safeCode(response.body),
    responseFields: responseFieldPaths(response.body),
    responseHeaders: response.responseHeaders,
    latencyMs: response.latencyMs,
    pass: true
  });
  if (input.coversBody) report.bodyCoverage.push(`${input.coversBody}:${input.id}`);
  return response;
}

function fieldCase(id, covers, method, pathname, expectedStatus, expectedCode = undefined) {
  return { id, covers, method, pathname, expectedStatus, expectedCode };
}

function addQuery(pathname, name, value) {
  const separator = pathname.includes("?") ? "&" : "?";
  return `${pathname}${separator}${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
}

function addRawQuery(pathname, query) {
  const separator = pathname.includes("?") ? "&" : "?";
  return `${pathname}${separator}${query}`;
}

async function login() {
  const response = await request("POST", "/admin/api/login", {
    json: { username: requiredEnv("ADMIN_USERNAME"), password: requiredEnv("ADMIN_PASSWORD") },
    withoutCookie: true
  });
  assert(response.status === 200, `Admin login returned HTTP ${response.status}.`);
  cookie = response.setCookie.split(";", 1)[0] ?? "";
  assert(cookie, "Admin login returned no session cookie.");
}

async function prepareLoginBoundaryCapacity() {
  const current = await request("GET", "/admin/api/settings/runtime");
  assert(current.status === 200, `Runtime settings returned HTTP ${current.status}.`);
  const loginLease = createAdminBoundaryRateLimitLease(
    current.body?.settings?.rateLimits,
    { adminLoginMax: 100, adminApiMax: 10_000 }
  );
  const publicationLease = createPublicationIntervalLease(
    current.body?.settings?.publication,
    1
  );
  originalRateLimits = loginLease.restore;
  originalPublicationSettings = publicationLease.restore;
  const updated = await request("PUT", "/admin/api/settings/rate-limits", {
    json: loginLease.elevated
  });
  assert(updated.status === 200, `Admin login boundary capacity returned HTTP ${updated.status}.`);
  const publicationUpdated = await request("PUT", "/admin/api/settings/publication", {
    json: publicationLease.elevated
  });
  assert(publicationUpdated.status === 200,
    `Publication boundary capacity returned HTTP ${publicationUpdated.status}.`);
}

async function createSettledRevisionFixture() {
  const fixture = await createKnowledgeBasePatchFixture("stale revision");
  const updated = await request(
    "PATCH",
    `/admin/api/knowledge-bases/${encodeURIComponent(fixture.id)}`,
    {
      headers: { "if-match": String(fixture.resourceRevision) },
      json: { description: "Revision boundary fixture" }
    }
  );
  assert(updated.status === 200,
    `Stale-revision fixture update returned HTTP ${updated.status} ${safeCode(updated.body)}.`);
  const targetRevision = Number(updated.body?.knowledgeBase?.resourceRevision ?? 0);
  assert(targetRevision > fixture.resourceRevision,
    "Stale-revision fixture update did not advance its response revision.");
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const detail = await request(
      "GET",
      `/admin/api/knowledge-bases/${encodeURIComponent(fixture.id)}`
    );
    if (Number(detail.body?.knowledgeBase?.resourceRevision ?? 0) >= targetRevision) {
      return { id: fixture.id, resourceRevision: targetRevision };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Stale-revision fixture did not settle within 30 seconds.");
}

async function request(method, pathname, input = {}) {
  const headers = new Headers({
    ...(input.withoutCookie ? {} : { cookie: input.cookieOverride ?? cookie }),
    ...(method === "GET" ? {} : { origin }),
    ...(input.headers ?? {}),
    ...(input.contentType ? { "content-type": input.contentType } : {}),
    ...(input.json === undefined ? {} : { "content-type": "application/json" })
  });
  for (const [name, value] of input.headerPairs ?? []) headers.append(name, value);
  adminApiRequestCount += 1;
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: input.rawBody ?? (input.json === undefined ? undefined : JSON.stringify(input.json))
  });
  const body = await readBody(response);
  assertSafe(body, `${method}:${pathname}`);
  return {
    status: response.status,
    body,
    setCookie: response.headers.get("set-cookie") ?? "",
    responseHeaders: [...response.headers.keys()].sort(),
    latencyMs: Number((performance.now() - startedAt).toFixed(3))
  };
}

function responseFieldPaths(value, prefix = "$") {
  if (value === null || typeof value !== "object") return [prefix];
  if (Array.isArray(value)) {
    return value.length === 0
      ? [`${prefix}[]`]
      : responseFieldPaths(value[0], `${prefix}[]`);
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return [prefix];
  return entries.flatMap(([key, child]) =>
    responseFieldPaths(child, `${prefix}.${key}`));
}

async function readBody(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { textLength: text.length }; }
}

function safeCode(body) {
  return String(body?.error?.code ?? "");
}

function assertSafe(body, label) {
  const serialized = JSON.stringify(body ?? {});
  assert(!/(postgres(?:ql)?:\/\/|redis:\/\/|stack\s*trace|objectKey|s3_secret|sql\s+state|\/Users\/|C:\\)/iu.test(serialized),
    `${label} exposed internal data.`);
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

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";
import {
  enumerateOpenApiBoundaryCases,
  openApiExampleForSchema
} from "./lib/comprehensive-openapi-boundary-matrix.mjs";
import { buildDeveloperOpenApiInventory } from "./lib/comprehensive-openapi-inventory.mjs";

loadLocalEnv();

const adminBaseUrl = `http://127.0.0.1:${process.env.ADMIN_API_PORT || "43000"}`;
const publicBaseUrl = `http://127.0.0.1:${process.env.PUBLIC_OPENAPI_PORT || "43200"}`;
const adminOrigin = process.env.ADMIN_PUBLIC_ORIGIN || "http://127.0.0.1:43100";
const reportPath = path.resolve(
  process.env.FOCOWIKI_COMPREHENSIVE_OPENAPI_FIELD_REPORT
    || "ReferenceDocs/validation/comprehensive-large-scale-release/openapi-field-boundaries.json"
);
const document = JSON.parse(fs.readFileSync("docs/public/openapi/focowiki-openapi.json", "utf8"));
const inventory = buildDeveloperOpenApiInventory(document);
const parameterInventory = inventory.filter((item) => item.kind === "parameter");
const parameterFieldInventory = inventory.filter((item) => item.kind === "parameter-field");
const requestFieldInventory = inventory.filter((item) => item.kind === "request-field");
const operations = collectOperations(document);
const runId = `clr-openapi-fields-${randomUUID().slice(0, 8)}`;
const existingKnowledgeBaseId = process.env.FOCOWIKI_EXISTING_KNOWLEDGE_BASE_ID?.trim() ?? "";
const report = {
  kind: "focowiki-comprehensive-openapi-field-boundaries",
  version: 1,
  runId,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  ok: false,
  operationCount: operations.length,
  expected: {
    parameterCount: parameterInventory.length,
    parameterFieldCount: parameterFieldInventory.length,
    requestFieldCount: requestFieldInventory.length
  },
  rows: [],
  coverage: {
    parameters: [],
    parameterFields: [],
    requestFields: [],
    notApplicable: [],
    missing: []
  },
  cleanup: {
    knowledgeBasesDeleted: 0,
    webhooksDeleted: 0,
    keyMode: "temporary",
    keyDeleted: false,
    keyPreserved: false,
    loggedOut: false
  }
};

let adminCookie = "";
let keyId = "";
let rawKey = "";
const knowledgeBases = new Map();
const webhooks = new Set();
let requestSequence = 0;

try {
  assert(operations.length === 43, `Expected 43 operations, found ${operations.length}.`);
  assert(parameterInventory.length === 127, `Expected 127 parameters, found ${parameterInventory.length}.`);
  assert(parameterFieldInventory.length === 127, `Expected 127 parameter fields, found ${parameterFieldInventory.length}.`);
  assert(requestFieldInventory.length === 34, `Expected 34 request fields, found ${requestFieldInventory.length}.`);
  const existingKeyFile = process.env.FOCOWIKI_OPENAPI_KEY_FILE?.trim();
  if (existingKeyFile) {
    rawKey = fs.readFileSync(path.resolve(existingKeyFile), "utf8").trim();
    assert(rawKey, "The run-owned OpenAPI key file is empty.");
    report.cleanup.keyMode = "existing-run-owned";
  } else {
    await login();
    ({ id: keyId, rawKey } = await createKey());
  }

  for (const operation of operations) {
    for (const parameter of operation.parameters) {
      const parameterKey = `${operation.operationId}:${parameter.in}:${parameter.name}`;
      const cases = enumerateOpenApiBoundaryCases({
        document,
        schema: parameter.schema ?? {},
        example: parameterExample(parameter),
        location: parameter.in,
        name: parameter.name,
        required: parameter.required === true
      });
      const applicableCases = cases.filter((boundaryCase) => {
        const applicable = isApplicableHttpParameterCase(parameter, boundaryCase);
        if (!applicable) {
          report.coverage.notApplicable.push({
            id: `openapi:parameter:${parameterKey}:${boundaryCase.id}`,
            reason: "HTTP path, query, and header values have no JSON null or non-string wire type."
          });
        }
        return applicable;
      });
      assert(applicableCases.length > 0, `${parameterKey} produced no applicable boundary cases.`);
      for (const boundaryCase of applicableCases) {
        const response = await invoke(operation, {
          parameterUnderTest: parameter,
          parameterValue: boundaryCase.value
        });
        assertBoundaryResponse(operation, parameter.in, boundaryCase, response);
        report.rows.push(row(operation, `parameter:${parameter.in}:${boundaryCase.id}`, boundaryCase, response));
      }
      report.coverage.parameters.push({ id: `openapi:parameter:${parameterKey}`, caseCount: applicableCases.length });
      report.coverage.parameterFields.push({
        id: `openapi:parameter-field:${operation.operationId}:${parameter.in}.${parameter.name}`,
        caseCount: applicableCases.length
      });
    }

    if (!operation.mediaType) continue;
    const bodyCases = operation.mediaType === "text/markdown"
      ? markdownBoundaryCases(operation)
      : enumerateOpenApiBoundaryCases({
          document,
          schema: operation.bodySchema,
          example: operation.bodyExample,
          location: "requestBody",
          required: operation.requestBodyRequired
        });
    assert(bodyCases.length > 0, `${operation.operationId} produced no request-body boundary cases.`);
    for (const boundaryCase of bodyCases) {
      const response = await invoke(operation, { bodyCase: boundaryCase });
      assertBoundaryResponse(operation, "requestBody", boundaryCase, response);
      registerCreatedResource(operation, response);
      report.rows.push(row(operation, `request:${operation.mediaType}:${boundaryCase.id}`, boundaryCase, response));
    }
    for (const item of requestFieldInventory.filter((candidate) =>
      candidate.operationId === operation.operationId)) {
      const fieldLabel = requestFieldLabel(item.pointer, operation.mediaType);
      const matching = bodyCases.filter((boundaryCase) => boundaryCaseCoversField(boundaryCase.id, fieldLabel));
      assert(matching.length > 0, `${item.id} has no executed boundary case.`);
      report.coverage.requestFields.push({ id: item.id, caseCount: matching.length });
    }
  }

  reconcileCoverage();
  report.ok = true;
} finally {
  await cleanupCreatedResources();
  if (adminCookie && keyId) {
    const deleted = await adminRequest(
      "DELETE",
      `/admin/api/openapi-keys/${encodeURIComponent(keyId)}`
    ).catch(() => null);
    report.cleanup.keyDeleted = deleted?.status === 200 || deleted?.status === 404;
    if (report.cleanup.keyDeleted) keyId = "";
  }
  if (report.cleanup.keyMode === "existing-run-owned") {
    report.cleanup.keyPreserved = Boolean(rawKey);
  }
  if (adminCookie) {
    const logout = await adminRequest("POST", "/admin/api/logout", { json: {} }).catch(() => null);
    report.cleanup.loggedOut = logout?.status === 200;
    adminCookie = "";
  }
  report.finishedAt = new Date().toISOString();
  report.ok = report.ok
    && (
      report.cleanup.keyMode === "existing-run-owned"
        ? report.cleanup.keyPreserved
        : report.cleanup.keyDeleted && report.cleanup.loggedOut
    )
    && knowledgeBases.size === 0
    && webhooks.size === 0
    && report.coverage.missing.length === 0;
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    operationCount: report.operationCount,
    rowCount: report.rows.length,
    coverage: {
      parameters: report.coverage.parameters.length,
      parameterFields: report.coverage.parameterFields.length,
      requestFields: report.coverage.requestFields.length,
      notApplicable: report.coverage.notApplicable.length,
      missing: report.coverage.missing.length
    },
    cleanup: report.cleanup,
    reportPath
  })}\n`);
}

if (!report.ok) throw new Error("Developer OpenAPI field-boundary validation failed.");

async function invoke(operation, input = {}) {
  requestSequence += 1;
  const pathValues = Object.fromEntries(operation.parameters
    .filter((parameter) => parameter.in === "path")
    .map((parameter) => [
      parameter.name,
      defaultParameterValue(parameter, requestSequence, operation)
    ]));
  const query = new URLSearchParams();
  const headers = {
    authorization: `Bearer ${rawKey}`
  };
  for (const parameter of operation.parameters) {
    const isUnderTest = input.parameterUnderTest === parameter;
    if (!isUnderTest && parameter.required !== true && parameter.in !== "path") continue;
    const value = isUnderTest
      ? input.parameterValue
      : defaultParameterValue(parameter, requestSequence, operation);
    if (parameter.in === "path") {
      pathValues[parameter.name] = value;
    } else if (value !== undefined && parameter.in === "query") {
      query.set(parameter.name, serializeParameter(value));
    } else if (value !== undefined && parameter.in === "header") {
      headers[parameter.name] = serializeParameter(value);
    }
  }
  applyConditionalParameterBaseline(operation, input.parameterUnderTest, query);
  const pathname = concretePath(operation.path, pathValues);
  const target = `${publicBaseUrl}${pathname}${query.size ? `?${query}` : ""}`;
  let body;
  if (operation.mediaType) {
    headers["content-type"] = operation.mediaType;
    const value = input.bodyCase ? input.bodyCase.value : operation.bodyExample;
    if (value !== undefined) {
      body = operation.mediaType === "application/json"
        ? JSON.stringify(value)
        : String(value);
    }
  }
  const startedAt = performance.now();
  const response = await fetch(target, { method: operation.method, headers, body });
  const responseBody = await readBody(response);
  assertSafe(responseBody, `${operation.operationId}:${input.bodyCase?.id ?? input.parameterUnderTest?.name}`);
  return {
    status: response.status,
    body: responseBody,
    latencyMs: Number((performance.now() - startedAt).toFixed(3)),
    responseHeaders: ["content-type", "retry-after", "x-request-id"]
      .filter((name) => response.headers.has(name))
  };
}

function assertBoundaryResponse(operation, location, boundaryCase, response) {
  assert(response.status !== 429, `${operation.operationId} exhausted the rate-limit budget.`);
  assert(response.status < 500, `${operation.operationId} ${boundaryCase.id} returned HTTP ${response.status}.`);
  if (boundaryCase.expectedValidity === "invalid") {
    const acceptedPathStatuses = location === "path" ? new Set([400, 404, 422]) : new Set([422]);
    assert(
      acceptedPathStatuses.has(response.status),
      `${operation.operationId} ${boundaryCase.id} expected validation rejection, received HTTP ${response.status}.`
    );
  } else {
    assert(
      ![400, 401, 413, 415, 422].includes(response.status),
      `${operation.operationId} ${boundaryCase.id} expected schema acceptance, received HTTP ${response.status}.`
    );
  }
  if (response.status >= 400) {
    assert(
      typeof response.body?.requestId === "string"
        && response.body?.error?.httpStatus === response.status
        && typeof response.body?.error?.code === "string",
      `${operation.operationId} ${boundaryCase.id} returned a non-standard error envelope.`
    );
  }
}

function row(operation, caseId, boundaryCase, response) {
  return {
    sequence: report.rows.length + 1,
    operationId: operation.operationId,
    method: operation.method,
    path: operation.path,
    case: caseId,
    expectedValidity: boundaryCase.expectedValidity,
    status: response.status,
    errorCode: String(response.body?.error?.code ?? ""),
    latencyMs: response.latencyMs,
    responseHeaders: response.responseHeaders,
    pass: true
  };
}

function registerCreatedResource(operation, response) {
  if (response.status === 201 && operation.operationId === "createKnowledgeBase") {
    const resource = response.body?.knowledgeBase;
    if (resource?.id && Number.isInteger(resource.resourceRevision)) {
      knowledgeBases.set(resource.id, resource.resourceRevision);
    }
  }
  if (response.status === 201 && operation.operationId === "createWebhook") {
    const webhookId = response.body?.webhook?.webhookId;
    if (webhookId) webhooks.add(webhookId);
  }
}

async function cleanupCreatedResources() {
  for (const webhookId of [...webhooks]) {
    const operation = operations.find((item) => item.operationId === "deleteWebhook");
    const response = await invokeCleanup(operation, { webhookId });
    if (response.status === 200 || response.status === 404) {
      webhooks.delete(webhookId);
      report.cleanup.webhooksDeleted += 1;
    }
  }
  for (const [knowledgeBaseId, resourceRevision] of [...knowledgeBases]) {
    const operation = operations.find((item) => item.operationId === "deleteKnowledgeBase");
    const response = await invokeCleanup(operation, { knowledgeBaseId }, {
      "If-Match": String(resourceRevision),
      "Idempotency-Key": `${runId}-cleanup-${knowledgeBaseId}`
    });
    if (response.status === 202 || response.status === 404) {
      knowledgeBases.delete(knowledgeBaseId);
      report.cleanup.knowledgeBasesDeleted += 1;
    }
  }
}

async function invokeCleanup(operation, pathValues, extraHeaders = {}) {
  if (!operation || !rawKey) return { status: 0 };
  const response = await fetch(`${publicBaseUrl}${concretePath(operation.path, pathValues)}`, {
    method: operation.method,
    headers: { authorization: `Bearer ${rawKey}`, ...extraHeaders }
  });
  return { status: response.status };
}

function reconcileCoverage() {
  const actualParameters = new Set(report.coverage.parameters.map((item) => item.id));
  const actualParameterFields = new Set(report.coverage.parameterFields.map((item) => item.id));
  const actualRequestFields = new Set(report.coverage.requestFields.map((item) => item.id));
  for (const item of parameterInventory) if (!actualParameters.has(item.id)) report.coverage.missing.push(item.id);
  for (const item of parameterFieldInventory) if (!actualParameterFields.has(item.id)) report.coverage.missing.push(item.id);
  for (const item of requestFieldInventory) if (!actualRequestFields.has(item.id)) report.coverage.missing.push(item.id);
  assert(report.coverage.missing.length === 0, `OpenAPI field coverage is incomplete: ${report.coverage.missing.join(",")}`);
  assert(
    new Set(report.rows.map((item) => `${item.operationId}:${item.case}`)).size === report.rows.length,
    "OpenAPI boundary rows are not unique."
  );
}

function collectOperations(openApiDocument) {
  const methods = new Set(["delete", "get", "patch", "post", "put"]);
  return Object.entries(openApiDocument.paths ?? {}).flatMap(([routePath, pathItem]) =>
    Object.entries(pathItem ?? {}).flatMap(([method, operation]) => {
      if (!methods.has(method) || !operation?.operationId) return [];
      const parameters = [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])]
        .map((parameter) => resolveReference(parameter));
      const mediaEntries = Object.entries(operation.requestBody?.content ?? {});
      assert(mediaEntries.length <= 1, `${operation.operationId} has multiple request media types.`);
      const [mediaType, media] = mediaEntries[0] ?? [];
      return [{
        operationId: operation.operationId,
        method: method.toUpperCase(),
        path: routePath,
        parameters,
        requestBodyRequired: operation.requestBody?.required !== false,
        mediaType: mediaType ?? null,
        bodySchema: media?.schema ?? null,
        bodyExample: media ? bodyExample(media) : undefined
      }];
    })
  ).sort((left, right) => left.operationId.localeCompare(right.operationId));
}

function resolveReference(value) {
  if (!value?.$ref) return value;
  return value.$ref.replace(/^#\//u, "").split("/").reduce(
    (current, segment) => current?.[segment.replaceAll("~1", "/").replaceAll("~0", "~")],
    document
  );
}

function parameterExample(parameter) {
  if (parameter.example !== undefined) return structuredClone(parameter.example);
  if (parameter.schema?.example !== undefined) return structuredClone(parameter.schema.example);
  return defaultParameterValue(parameter, 1);
}

function isApplicableHttpParameterCase(parameter, boundaryCase) {
  if (boundaryCase.id.endsWith(":null")) return false;
  const types = Array.isArray(parameter.schema?.type)
    ? parameter.schema.type
    : [parameter.schema?.type];
  if (boundaryCase.id.endsWith(":wrong-type") && types.includes("string")) return false;
  return true;
}

function defaultParameterValue(parameter, sequence, operation = null) {
  if (parameter.name.toLowerCase() === "idempotency-key") return `${runId}-${sequence}`;
  if (parameter.name.toLowerCase() === "if-match") return 1;
  if (parameter.in === "query" && parameter.name === "path") return "index.md";
  if (
    parameter.in === "path"
    && parameter.name === "knowledgeBaseId"
    && operation?.method === "GET"
    && existingKnowledgeBaseId
  ) {
    return existingKnowledgeBaseId;
  }
  if (parameter.in === "path") return `${parameter.name}-boundary-missing`;
  if (parameter.example !== undefined) return structuredClone(parameter.example);
  if (parameter.schema?.example !== undefined) return structuredClone(parameter.schema.example);
  if (parameter.schema?.default !== undefined) return structuredClone(parameter.schema.default);
  return openApiExampleForSchema(document, parameter.schema ?? {});
}

function bodyExample(media) {
  if (media.example !== undefined) return structuredClone(media.example);
  const first = Object.values(media.examples ?? {})[0];
  if (first?.value !== undefined) return structuredClone(first.value);
  return openApiExampleForSchema(document, media.schema ?? {});
}

function markdownBoundaryCases(operation) {
  return [{ id: "$:empty", expectedValidity: "invalid", value: undefined }, {
    id: "$:minimum", expectedValidity: "valid", value: "# x"
  }, {
    id: "$:malformed-optional-metadata", expectedValidity: "valid", value:
      "---\nstatus: [unexpected]\nverified: invalid\n---\n# Boundary document"
  }].map((item) => ({ ...item, operationId: operation.operationId }));
}

function requestFieldLabel(pointer, mediaType) {
  return pointer
    .replace(`request.${mediaType}`, "$")
    .replace(/\.variant-\d+$/u, "")
    .replace(/^\$\./u, "");
}

function boundaryCaseCoversField(caseId, fieldLabel) {
  const caseField = caseId.split(":", 1)[0];
  if (fieldLabel === "$") return caseField === "$";
  if (fieldLabel.endsWith("[]")) {
    const parent = fieldLabel.slice(0, -2);
    return caseField === parent || caseField.startsWith(`${fieldLabel}.`);
  }
  return caseField === fieldLabel || caseField.startsWith(`${fieldLabel}.`);
}

function concretePath(routePath, values) {
  return routePath.replace(/\{([^}]+)\}/gu, (_match, name) => {
    const value = values[name];
    return value === undefined ? "" : encodeURIComponent(serializeParameter(value));
  });
}

function serializeParameter(value) {
  if (Array.isArray(value)) return value.join(",");
  if (value && typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function applyConditionalParameterBaseline(operation, parameterUnderTest, query) {
  if (operation.operationId === "expandGraph") {
    const startingPoints = ["fileId", "nodeId", "edgeId", "query"];
    if (!startingPoints.some((name) => query.has(name))) {
      if (parameterUnderTest?.name === "query") {
        query.set("fileId", "file-boundary-missing");
      } else {
        query.set("query", "boundary question");
      }
    }
  }
  if (operation.operationId !== "searchGeneratedFiles") return;
  if (query.has("rerankTopK")) {
    query.set("rerank", "true");
    query.set("limit", "1");
  }
  if (query.has("rerankScoreThreshold")) query.set("rerank", "true");
}

async function login() {
  const response = await adminRequest("POST", "/admin/api/login", {
    json: { username: requiredEnv("ADMIN_USERNAME"), password: requiredEnv("ADMIN_PASSWORD") }
  });
  assert(response.status === 200, `Admin login returned HTTP ${response.status}.`);
  adminCookie = response.setCookie.split(";", 1)[0] ?? "";
  assert(adminCookie, "Admin login returned no cookie.");
}

async function createKey() {
  const response = await adminRequest("POST", "/admin/api/openapi-keys", {
    json: { name: `${runId}-key` }
  });
  assert(response.status === 201, `OpenAPI key creation returned HTTP ${response.status}.`);
  const id = response.body?.key?.id;
  const value = response.body?.oneTimeKey?.rawKey;
  assert(id && value, "OpenAPI key response is incomplete.");
  return { id, rawKey: value };
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
  return {
    status: response.status,
    body: await readBody(response),
    setCookie: response.headers.get("set-cookie") ?? ""
  };
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

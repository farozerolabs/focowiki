#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";

import { uploadMarkdownFilesWithSession } from "./lib/upload-session-client.mjs";

loadLocalEnv();

const runId = `clr-semantic-delete-${randomUUID().slice(0, 8)}`;
const adminBaseUrl = requiredEnv("FOCOWIKI_COMPREHENSIVE_ADMIN_BASE_URL");
const adminOrigin = requiredEnv("FOCOWIKI_COMPREHENSIVE_ADMIN_ORIGIN");
const databaseUrl = requiredEnv("FOCOWIKI_COMPREHENSIVE_DATABASE_URL");
const providerBaseUrl = requiredEnv("FOCOWIKI_COMPREHENSIVE_PROVIDER_BASE_URL");
const providerApiKey = process.env.FOCOWIKI_COMPREHENSIVE_PROVIDER_API_KEY?.trim()
  || requiredEnv("MEILI_MASTER_KEY");
const knowledgeBaseId = requiredEnv("FOCOWIKI_COMPREHENSIVE_KNOWLEDGE_BASE_ID");
const indexPrefix = requiredEnv("SEARCH_INDEX_PREFIX");
const reportPath = path.resolve(requiredEnv(
  "FOCOWIKI_COMPREHENSIVE_SEMANTIC_DELETION_REPORT"
));
const apiRequire = createRequire(path.join(process.cwd(), "apps/api/package.json"));
const postgres = apiRequire("postgres");
const sql = postgres(databaseUrl, {
  max: 2,
  connect_timeout: 10,
  idle_timeout: 5,
  prepare: false
});

let cookie = "";
let sourceFileId = "";
let sourceResourceRevision = null;
let deletionOperationId = "";
let injectedStagePublicId = "";
const startedAt = new Date().toISOString();
const observations = {
  uploadedVectorDocumentCount: 0,
  providerUploadedDocumentCount: 0,
  drainingContinuationObserved: false,
  drainingAttemptCount: null,
  priorRunSourceCleanupCount: 0,
  deletedDatabaseVectorDocumentCount: null,
  deletedProviderDocumentCount: null,
  sourceReadStatusAfterDeletion: null
};

try {
  await login();
  observations.priorRunSourceCleanupCount = await cleanupPriorRunSources();
  const relativePath = `validation/${runId}.md`;
  const bytes = Buffer.from([
    "---",
    `title: ${runId}`,
    "type: reference",
    "---",
    "",
    `# ${runId}`,
    "",
    "A general-purpose validation source describes bounded concurrency, durable ownership,",
    "search reconciliation, semantic vector projection, and safe deletion convergence.",
    "The content is intentionally domain-neutral and exists only for this release validation."
  ].join("\n"));
  const uploaded = await uploadMarkdownFilesWithSession({
    request: requestData,
    routeBase: `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/upload-sessions`,
    idempotencyKey: `${runId}-upload`,
    files: [{ relativePath, bytes }],
    finalizationPollIntervalMs: 250,
    finalizationTimeoutMs: 300_000
  });
  sourceFileId = uploaded.files[0]?.sourceFileId ?? "";
  assert(sourceFileId, "Semantic deletion race upload returned no source file identity");
  const source = await waitForProjectedSource();
  sourceResourceRevision = source.resourceRevision;
  assert(Number.isSafeInteger(sourceResourceRevision),
    "Semantic deletion race source returned no resource revision");

  const vectorState = await readActiveVectorState();
  observations.uploadedVectorDocumentCount = vectorState.documentIds.length;
  assert(vectorState.documentIds.length > 0,
    "Semantic deletion race source produced no active vector documents");
  const providerBefore = await readProviderSourceDocuments(vectorState.indexUid);
  observations.providerUploadedDocumentCount = providerBefore.length;
  assertSameIds(providerBefore, vectorState.documentIds,
    "Provider did not contain the exact uploaded source vector identities");

  const injected = await sql`
    WITH target AS (
      SELECT public_id
      FROM focowiki.semantic_stage_work_items
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND source_file_public_id = ${sourceFileId}
        AND stage_kind = 'vector'
        AND state = 'completed'
      ORDER BY updated_at DESC, public_id COLLATE "C"
      LIMIT 1
      FOR UPDATE
    )
    UPDATE focowiki.semantic_stage_work_items stage
    SET state = 'running', lease_owner = ${`${runId}-fault-injection`},
        lease_expires_at = now() + interval '5 minutes',
        execution_started_at = now(), cancellation_requested_at = NULL,
        safe_error_code = NULL, completed_at = NULL,
        revision = stage.revision + 1, updated_at = now()
    FROM target
    WHERE stage.public_id = target.public_id
    RETURNING stage.public_id
  `;
  injectedStagePublicId = injected[0]?.public_id ?? "";
  assert(injectedStagePublicId,
    "Semantic deletion race could not inject a deterministic running vector stage");

  const deletion = await requestData(
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`
      + `/source-files/${encodeURIComponent(sourceFileId)}`,
    {
      method: "DELETE",
      status: 202,
      headers: {
        "if-match": String(sourceResourceRevision),
        "idempotency-key": `${runId}-delete`
      }
    }
  );
  deletionOperationId = deletion.operation?.operationId ?? "";
  assert(deletionOperationId,
    "Semantic deletion race returned no deletion operation identity");

  const draining = await waitForDrainingContinuation();
  observations.drainingContinuationObserved = true;
  observations.drainingAttemptCount = draining.attempt_count;
  assert(Number(draining.attempt_count) === 0,
    "Semantic draining continuation consumed a deletion failure attempt");

  await releaseInjectedStage();
  await waitForOperationCompleted(deletionOperationId);
  await waitForSourceMissing();

  const remainingVectors = await sql`
    SELECT provider_document_id
    FROM focowiki.semantic_vector_documents
    WHERE knowledge_base_id = ${knowledgeBaseId}
      AND source_file_public_id = ${sourceFileId}
      AND deleted_at IS NULL
  `;
  observations.deletedDatabaseVectorDocumentCount = remainingVectors.length;
  const providerAfter = await readProviderSourceDocuments(vectorState.indexUid);
  observations.deletedProviderDocumentCount = providerAfter.length;
  assert(remainingVectors.length === 0,
    "Deleted source retained active PostgreSQL vector documents");
  assert(providerAfter.length === 0,
    "Deleted source retained active provider vector documents");

  const sourceRead = await rawRequest(
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`
      + `/source-files/${encodeURIComponent(sourceFileId)}?limit=10`
  );
  observations.sourceReadStatusAfterDeletion = sourceRead.status;
  assert(sourceRead.status === 404,
    "Deleted source remained readable through the Admin API");

  writePrivateReport(reportPath, {
    format: "focowiki-comprehensive-semantic-deletion-race-v1",
    generatedAt: new Date().toISOString(),
    startedAt,
    ok: true,
    runIdSha256: sha256(runId),
    knowledgeBaseIdSha256: sha256(knowledgeBaseId),
    sourceFileIdSha256: sha256(sourceFileId),
    deletionOperationIdSha256: sha256(deletionOperationId),
    injectedStagePublicIdSha256: sha256(injectedStagePublicId),
    observations
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    reportPath,
    observations
  })}\n`);
} catch (error) {
  writePrivateReport(reportPath, {
    format: "focowiki-comprehensive-semantic-deletion-race-v1",
    generatedAt: new Date().toISOString(),
    startedAt,
    ok: false,
    runIdSha256: sha256(runId),
    knowledgeBaseIdSha256: sha256(knowledgeBaseId),
    sourceFileIdSha256: sourceFileId ? sha256(sourceFileId) : null,
    deletionOperationIdSha256: deletionOperationId ? sha256(deletionOperationId) : null,
    injectedStagePublicIdSha256: injectedStagePublicId
      ? sha256(injectedStagePublicId) : null,
    observations,
    failure: safeError(error)
  });
  throw error;
} finally {
  await releaseInjectedStage().catch(() => undefined);
  await cleanupRunSource().catch(() => undefined);
  if (cookie) {
    await rawRequest("/admin/api/logout", { method: "POST", body: {} })
      .catch(() => undefined);
  }
  await sql.end({ timeout: 5 });
}

async function login() {
  const response = await rawRequest("/admin/api/login", {
    method: "POST",
    body: {
      username: requiredEnv("ADMIN_USERNAME"),
      password: requiredEnv("ADMIN_PASSWORD")
    }
  });
  assert(response.status === 200, "Semantic deletion race login failed");
  cookie = response.setCookie.split(";", 1)[0] ?? "";
  assert(cookie, "Semantic deletion race login returned no session cookie");
}

async function waitForProjectedSource() {
  return waitUntil(async () => {
    const page = await requestData(
      `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-files`,
      { query: { limit: 200 } }
    );
    const source = page.items?.find((item) => item.id === sourceFileId);
    if (source?.state === "failed") {
      throw new Error(`Semantic deletion race source failed: ${source.failure?.code ?? "UNKNOWN"}`);
    }
    if (!source || !["processing", "visible"].includes(source.state)) return null;
    const rows = await sql`
      SELECT EXISTS (
        SELECT 1 FROM focowiki.semantic_vector_documents
        WHERE knowledge_base_id = ${knowledgeBaseId}
          AND source_file_public_id = ${sourceFileId}
          AND state = 'active' AND deleted_at IS NULL
      ) AS present
    `;
    return rows[0]?.present === true ? source : null;
  }, 600_000, "Semantic deletion race source produced no active projection", 500);
}

async function readActiveVectorState() {
  const rows = await sql`
    SELECT generation.public_id AS semantic_generation_public_id,
           contract.mapping_fingerprint_sha256,
           vector.provider_document_id
    FROM focowiki.semantic_generations generation
    JOIN focowiki.semantic_projection_contracts contract
      ON contract.knowledge_base_id = generation.knowledge_base_id
     AND contract.semantic_generation_public_id = generation.public_id
    JOIN focowiki.semantic_vector_documents vector
      ON vector.knowledge_base_id = generation.knowledge_base_id
     AND vector.semantic_generation_public_id = generation.public_id
    WHERE generation.knowledge_base_id = ${knowledgeBaseId}
      AND generation.generation_role = 'active'
      AND generation.state = 'active'
      AND generation.deleted_at IS NULL
      AND vector.source_file_public_id = ${sourceFileId}
      AND vector.state = 'active'
      AND vector.deleted_at IS NULL
    ORDER BY vector.provider_document_id COLLATE "C"
  `;
  const first = rows[0];
  assert(first, "Semantic deletion race active vector state is missing");
  return {
    indexUid: semanticVectorIndexUid({
      knowledgeBaseId,
      semanticGenerationPublicId: first.semantic_generation_public_id,
      mappingFingerprintSha256: first.mapping_fingerprint_sha256
    }),
    documentIds: rows.map((row) => row.provider_document_id)
  };
}

async function waitForDrainingContinuation() {
  return waitUntil(async () => {
    const rows = await sql`
      SELECT work.state, work.attempt_count, work.next_attempt_at,
             stage.cancellation_requested_at, stage.state AS stage_state
      FROM focowiki.operation_work_items work
      JOIN focowiki.semantic_stage_work_items stage
        ON stage.public_id = ${injectedStagePublicId}
      WHERE work.operation_public_id = ${deletionOperationId}
    `;
    const row = rows[0];
    if (row?.state !== "queued" || row.stage_state !== "running"
      || !row.cancellation_requested_at || !row.next_attempt_at) return null;
    return row;
  }, 30_000, "Semantic deletion race did not observe the draining continuation", 50);
}

async function releaseInjectedStage() {
  if (!injectedStagePublicId) return;
  await sql`
    UPDATE focowiki.semantic_stage_work_items
    SET state = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
        execution_started_at = NULL,
        cancellation_requested_at = COALESCE(cancellation_requested_at, now()),
        safe_error_code = 'semantic_stage_cancelled',
        completed_at = COALESCE(completed_at, now()),
        revision = revision + 1, updated_at = now()
    WHERE public_id = ${injectedStagePublicId}
      AND state = 'running'
  `;
}

async function waitForOperationCompleted(operationId) {
  return waitUntil(async () => {
    const result = await requestData(
      `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`
        + `/operations/${encodeURIComponent(operationId)}`
    );
    const state = result.operation?.state;
    if (["failed", "cancelled", "superseded", "timed_out"].includes(state)) {
      throw new Error(`Semantic deletion operation ended in ${state}`);
    }
    return state === "completed" ? result.operation : null;
  }, 300_000, "Semantic deletion operation did not complete", 500);
}

async function waitForSourceMissing() {
  return waitUntil(async () => {
    const response = await rawRequest(
      `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`
        + `/source-files/${encodeURIComponent(sourceFileId)}?limit=10`
    );
    if (response.status !== 200 && response.status !== 404) {
      throw new Error(`Semantic deletion source poll returned HTTP ${response.status}`);
    }
    return response.status === 404 ? true : null;
  }, 300_000, "Semantic deletion source remained visible", 250);
}

async function cleanupPriorRunSources() {
  const rows = await sql`
    SELECT public_id, revision
    FROM focowiki.source_files
    WHERE knowledge_base_id = ${knowledgeBaseId}
      AND normalized_path LIKE 'validation/clr-semantic-delete-%' ESCAPE '\\'
      AND deleted_at IS NULL
    ORDER BY public_id COLLATE "C"
  `;
  let cleaned = 0;
  for (const source of rows) {
    const response = await rawRequest(
      `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`
        + `/source-files/${encodeURIComponent(source.public_id)}`,
      {
        method: "DELETE",
        headers: {
          "if-match": String(source.revision),
          "idempotency-key": `${runId}-prior-cleanup-${cleaned + 1}`
        }
      }
    );
    assert(response.status === 202,
      `Prior semantic deletion fixture cleanup returned HTTP ${response.status}`);
    const operationId = response.body?.operation?.operationId;
    assert(operationId, "Prior semantic deletion fixture cleanup returned no operation");
    const priorSourceFileId = sourceFileId;
    sourceFileId = source.public_id;
    try {
      await waitForOperationCompleted(operationId);
      await waitForSourceMissing();
    } finally {
      sourceFileId = priorSourceFileId;
    }
    cleaned += 1;
  }
  return cleaned;
}

async function cleanupRunSource() {
  if (!cookie || !sourceFileId) return;
  const page = await rawRequest(
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`
      + "/source-files?limit=200"
  );
  if (page.status !== 200) return;
  const source = page.body?.items?.find((item) => item.id === sourceFileId);
  if (!source) return;
  const deletion = await rawRequest(
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`
      + `/source-files/${encodeURIComponent(sourceFileId)}`,
    {
      method: "DELETE",
      headers: {
        "if-match": String(source.resourceRevision),
        "idempotency-key": `${runId}-cleanup-delete`
      }
    }
  );
  const operationId = deletion.body?.operation?.operationId
    ?? deletionOperationId;
  if (deletion.status === 202 && operationId) {
    await waitForOperationCompleted(operationId);
    await waitForSourceMissing();
  }
}

async function readProviderSourceDocuments(indexUid) {
  const documents = [];
  let offset = 0;
  while (true) {
    const url = new URL(
      `/indexes/${encodeURIComponent(indexUid)}/documents`,
      `${providerBaseUrl}/`
    );
    url.searchParams.set("limit", "500");
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("fields", "id,sourceFilePublicId");
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${providerApiKey}` }
    });
    assert(response.ok, `Semantic deletion provider returned HTTP ${response.status}`);
    const page = await response.json();
    const results = page.results ?? [];
    for (const document of results) {
      if (document.sourceFilePublicId === sourceFileId) documents.push(document.id);
    }
    if (results.length < 500) break;
    offset += results.length;
  }
  return documents.sort((left, right) => left.localeCompare(right, "en"));
}

async function requestData(pathname, options = {}) {
  const response = await rawRequest(pathname, options);
  const expectedStatus = options.status ?? 200;
  assert(response.status === expectedStatus,
    `Semantic deletion request returned HTTP ${response.status} for ${pathname}`);
  return response.body;
}

async function rawRequest(pathname, options = {}) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const response = await rawRequestOnce(pathname, options);
    if (response.status !== 429) return response;
    const delayMs = parseRetryAfterMilliseconds(response.retryAfter);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return rawRequestOnce(pathname, options);
}

async function rawRequestOnce(pathname, options = {}) {
  const url = new URL(pathname, `${adminBaseUrl}/`);
  for (const [name, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(name, String(value));
  }
  const method = options.method ?? "GET";
  const headers = {
    ...(cookie ? { cookie } : {}),
    ...(method !== "GET" ? { origin: adminOrigin } : {}),
    ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
    ...(options.headers ?? {})
  };
  const response = await fetch(url, {
    method,
    headers,
    body: options.rawBody ?? (options.body === undefined
      ? undefined : JSON.stringify(options.body))
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { textSha256: sha256(text), textLength: text.length };
    }
  }
  return {
    status: response.status,
    body,
    setCookie: response.headers.get("set-cookie") ?? "",
    retryAfter: response.headers.get("retry-after")
  };
}

async function waitUntil(probe, timeoutMs, message, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(message);
}

function semanticVectorIndexUid(input) {
  const digest = sha256([
    input.knowledgeBaseId,
    input.semanticGenerationPublicId,
    input.mappingFingerprintSha256
  ].join("\u001f")).slice(0, 48);
  return `${indexPrefix}-semantic-${digest}`;
}

function assertSameIds(actual, expected, message) {
  const normalizedExpected = [...expected].sort((left, right) =>
    left.localeCompare(right, "en"));
  assert(JSON.stringify(actual) === JSON.stringify(normalizedExpected), message);
}

function writePrivateReport(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function loadLocalEnv() {
  const envPath = path.resolve(process.env.ENV_FILE || ".env");
  if (fs.existsSync(envPath)) loadEnvFile(envPath);
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function safeError(error) {
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error
      ? error.message.replaceAll(databaseUrl, "[database-url]")
      : "Unknown validation error"
  };
}

function parseRetryAfterMilliseconds(value) {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(60_000, Math.max(250, Math.ceil(seconds * 1_000)));
  }
  const timestamp = value ? Date.parse(value) : Number.NaN;
  if (Number.isFinite(timestamp)) {
    return Math.min(60_000, Math.max(250, timestamp - Date.now()));
  }
  return 1_000;
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

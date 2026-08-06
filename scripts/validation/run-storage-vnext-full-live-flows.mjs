#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { loadEnvFile } from "node:process";
import {
  createLifecycleHttpClient
} from "./lib/interleaved-lifecycle-api.mjs";
import {
  STORAGE_VNEXT_FULL_LIVE_FLOW_KINDS,
  createStorageVnextFullLiveFlowUploadKey
} from "./lib/storage-vnext-full-live-flows.mjs";
import {
  createStorageVnextScaleRuntimeEnvironment
} from "./lib/storage-vnext-scale-scope.mjs";
import {
  uploadMarkdownFilesWithSession
} from "./lib/upload-session-client.mjs";

const REPRESENTATIVE_SOURCE_PATH =
  "01_宪法/中华人民共和国宪法修正案（1988年）__1988-04-12__有效__0a74bc2d55f6.md";
const REQUIRED_GENERATED_PATHS = Object.freeze([
  "index.md",
  "pages/index.md",
  "schema.md",
  "log.md",
  "_index/index.md",
  "_graph/index.md",
  "_index/catalog.json"
]);
const INTERNAL_FIELD_PATTERN =
  /objectKey|storageKey|providerIndexUid|providerTaskUid|ownerMarker|proofChecksum|redisKey|tableName/iu;
const TERMINAL_OPERATION_STATES = new Set([
  "completed", "failed", "cancelled", "superseded", "timed_out", "deleted"
]);

loadLocalEnv();
const proofPath = path.resolve(requiredEnv("FOCOWIKI_STORAGE_VNEXT_PROOF_FILE"));
const manifest = readJson(proofPath);
const proof = manifest?.proof;
const runtimeEnv = createStorageVnextScaleRuntimeEnvironment({ proof, env: process.env });
Object.assign(process.env, runtimeEnv);
const rebuild = readJson(path.join(proof.filesystemScope, "full-rebuild.json"));
const corpus = readJson(path.join(proof.filesystemScope, "full-corpus.json"));
const reads = readJson(path.join(proof.filesystemScope, "full-reads.json"));
const verification = readJson(path.join(proof.filesystemScope, "full-verification.json"));
const reportPath = path.join(proof.filesystemScope, "full-live-flows.json");
const sourceRoot = path.resolve(requiredEnv("FOCOWIKI_VALIDATION_MARKDOWN_DIR"));
assertInputs();

const require = createRequire(new URL("../../apps/api/package.json", import.meta.url));
const postgres = require("postgres");
const sql = postgres(runtimeEnv.DATABASE_URL, { max: 2, prepare: false });
const origin = requiredEnv("ADMIN_PUBLIC_ORIGIN");
const admin = createLifecycleHttpClient({
  baseUrl: `http://127.0.0.1:${runtimeEnv.ADMIN_API_PORT || "43000"}`
});
const developer = createLifecycleHttpClient({
  baseUrl: `http://127.0.0.1:${runtimeEnv.PUBLIC_OPENAPI_PORT || "43200"}`
});
const unauthorizedAdmin = createLifecycleHttpClient({
  baseUrl: `http://127.0.0.1:${runtimeEnv.ADMIN_API_PORT || "43000"}`
});
const unauthorizedDeveloper = createLifecycleHttpClient({
  baseUrl: `http://127.0.0.1:${runtimeEnv.PUBLIC_OPENAPI_PORT || "43200"}`
});
const report = {
  kind: "focowiki-storage-vnext-full-live-flows",
  version: 1,
  runId: proof.runId,
  knowledgeBaseId: rebuild.knowledgeBaseId,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  initialSourceCount: null,
  finalSourceCount: null,
  finalChecksumMismatchCount: null,
  finalPathMismatchCount: null,
  terminalWorkItems: null,
  liveCandidates: null,
  activeSnapshots: null,
  flows: [],
  failure: null
};

let credentialId = null;
let loggedIn = false;
try {
  report.initialSourceCount = await readSourceCount();
  if (report.initialSourceCount !== 29_736) {
    throw new Error("Full live-flow starting source count changed");
  }
  await verifyUnauthorizedSecurity();
  pass("security");
  await loginAdmin();
  loggedIn = true;
  const credential = await createCredential();
  credentialId = credential.id;
  developer.authorization = `Bearer ${credential.rawKey}`;

  const initial = await readRepresentative();
  await verifyAdmin(initial);
  pass("admin");
  await verifyOpenApi(initial);
  pass("openapi");
  await verifyGeneratedStructure();
  pass("generated");
  await verifySearchAndGraph(initial);
  pass("search");
  pass("graph");
  pass("positive");

  const failed = await acceptMutation(initial, {
    method: "PATCH",
    json: { relativePath: `missing-parent-${proof.runId}/failure.md` },
    suffix: "expected-failure"
  });
  const failure = await waitForOperation(failed.operationId, ["failed"]);
  if (!failure.errorCode || INTERNAL_FIELD_PATTERN.test(JSON.stringify(failure))) {
    throw new Error("Full failure flow did not return one safe terminal error");
  }
  const afterFailure = await readRepresentative();
  if (
    afterFailure.sourceFileId !== initial.sourceFileId
    || afterFailure.relativePath !== initial.relativePath
    || afterFailure.resourceRevision !== initial.resourceRevision
  ) throw new Error("Full failure flow changed the source fact");
  pass("failure");

  const movedPath = `${path.posix.dirname(initial.relativePath)}/svnext-validation-inverse.md`;
  const move = await acceptMutation(initial, {
    method: "PATCH",
    json: { relativePath: movedPath },
    suffix: "move"
  });
  await Promise.all([
    waitForOperation(move.operationId, ["completed"]),
    exerciseConcurrentReads()
  ]);
  const moved = await readSource(initial.sourceFileId);
  if (moved.relativePath !== movedPath) throw new Error("Full move flow did not become visible");
  const inverse = await acceptMutation(moved, {
    method: "PATCH",
    json: { relativePath: initial.relativePath },
    suffix: "inverse"
  });
  await Promise.all([
    waitForOperation(inverse.operationId, ["completed"]),
    exerciseConcurrentReads()
  ]);
  const restored = await readRepresentative();
  if (
    restored.sourceFileId !== initial.sourceFileId
    || restored.relativePath !== initial.relativePath
  ) throw new Error("Full inverse flow did not restore the source identity and path");
  pass("inverse");
  pass("interleaved");

  const deletion = await acceptMutation(restored, {
    method: "DELETE",
    suffix: "delete"
  });
  await waitForOperation(deletion.operationId, ["completed", "deleted"]);
  await waitForSourceMissing(restored.sourceFileId);
  const bytes = readRepresentativeBytes();
  const uploaded = await uploadMarkdownFilesWithSession({
    request: requestDeveloper,
    routeBase: `/openapi/v2/knowledge-bases/${encodeURIComponent(
      rebuild.knowledgeBaseId
    )}/upload-sessions`,
    idempotencyKey: createStorageVnextFullLiveFlowUploadKey({
      runId: proof.runId,
      sourceFileId: restored.sourceFileId
    }),
    files: [{ relativePath: REPRESENTATIVE_SOURCE_PATH, bytes }],
    finalizationPollIntervalMs: 500,
    finalizationTimeoutMs: 30 * 60 * 1_000
  });
  const recreatedId = uploaded.files[0]?.sourceFileId;
  if (!recreatedId || recreatedId === restored.sourceFileId) {
    throw new Error("Full deletion flow did not create a new source identity");
  }
  await waitForSourceVisible(recreatedId);
  await waitForFullConvergence();
  pass("deletion");

  const final = await readFinalEvidence();
  Object.assign(report, final);
  if (
    report.flows.length !== STORAGE_VNEXT_FULL_LIVE_FLOW_KINDS.length
    || report.finalSourceCount !== 29_736
    || report.finalChecksumMismatchCount !== 0
    || report.finalPathMismatchCount !== 0
    || report.terminalWorkItems !== 0
    || report.liveCandidates !== 0
    || report.activeSnapshots !== 1
  ) throw new Error("Full live-flow matrix did not restore exact terminal state");
  report.finishedAt = new Date().toISOString();
  writeReport();
  process.stdout.write(`${JSON.stringify({
    status: "complete",
    runId: proof.runId,
    flowCount: report.flows.length,
    finalSourceCount: report.finalSourceCount,
    reportPath
  }, null, 2)}\n`);
} catch (error) {
  report.failure = {
    name: error instanceof Error ? error.name : "Error",
    message: String(error instanceof Error ? error.message : error).slice(0, 2_000)
  };
  report.finishedAt = new Date().toISOString();
  writeReport();
  throw error;
} finally {
  if (credentialId && loggedIn) {
    await admin.request(`/admin/api/openapi-keys/${encodeURIComponent(credentialId)}`, {
      method: "DELETE",
      headers: { origin }
    }).catch(() => undefined);
  }
  await Promise.allSettled([
    loggedIn
      ? admin.request("/admin/api/logout", { method: "POST", headers: { origin } })
      : Promise.resolve(),
    sql.end({ timeout: 5 })
  ]);
}

async function verifyUnauthorizedSecurity() {
  for (const [client, pathname] of [
    [unauthorizedAdmin, "/admin/api/settings/runtime"],
    [unauthorizedDeveloper, `/openapi/v2/knowledge-bases/${encodeURIComponent(
      rebuild.knowledgeBaseId
    )}`]
  ]) {
    const response = await client.request(pathname);
    const body = await response.text();
    if (response.status !== 401 || INTERNAL_FIELD_PATTERN.test(body)) {
      throw new Error("Full security flow did not fail closed without internal disclosure");
    }
  }
}

async function loginAdmin() {
  await admin.json("/admin/api/login", {
    method: "POST",
    headers: { origin },
    json: {
      username: requiredEnv("ADMIN_USERNAME"),
      password: requiredEnv("ADMIN_PASSWORD")
    }
  });
}

async function createCredential() {
  const response = await admin.json("/admin/api/openapi-keys", {
    method: "POST",
    headers: { origin },
    json: { name: `storage-vnext-full-flows-${proof.runId}` },
    expectedStatus: 201
  });
  if (!response.key?.id || !response.oneTimeKey?.rawKey) {
    throw new Error("Full live-flow credential was not returned");
  }
  return { id: response.key.id, rawKey: response.oneTimeKey.rawKey };
}

async function verifyAdmin(source) {
  const [knowledgeBase, sourceFile] = await Promise.all([
    admin.json(`/admin/api/knowledge-bases/${encodeURIComponent(rebuild.knowledgeBaseId)}`),
    admin.json(`/admin/api/knowledge-bases/${encodeURIComponent(
      rebuild.knowledgeBaseId
    )}/source-files/${encodeURIComponent(source.sourceFileId)}`)
  ]);
  const serialized = JSON.stringify({ knowledgeBase, sourceFile });
  if (
    !serialized.includes(rebuild.knowledgeBaseId)
    || !serialized.includes(source.sourceFileId)
    || INTERNAL_FIELD_PATTERN.test(serialized)
  ) throw new Error("Full Admin flow is incomplete or disclosed internal storage fields");
}

async function verifyOpenApi(source) {
  const [knowledgeBase, sourceFile, content] = await Promise.all([
    developer.json(`/openapi/v2/knowledge-bases/${encodeURIComponent(rebuild.knowledgeBaseId)}`),
    developer.json(sourcePath(source.sourceFileId)),
    developer.text(`${sourcePath(source.sourceFileId)}/content`)
  ]);
  const serialized = JSON.stringify({ knowledgeBase, sourceFile });
  if (
    !serialized.includes(rebuild.knowledgeBaseId)
    || !serialized.includes(source.sourceFileId)
    || content.length === 0
    || INTERNAL_FIELD_PATTERN.test(serialized)
  ) throw new Error("Full OpenAPI flow is incomplete or disclosed internal storage fields");
}

async function verifyGeneratedStructure() {
  const bodies = new Map();
  for (const logicalPath of REQUIRED_GENERATED_PATHS) {
    const body = await developer.text(generatedContentPath(logicalPath));
    if (!body || INTERNAL_FIELD_PATTERN.test(body)) {
      throw new Error(`Full generated flow failed for ${logicalPath}`);
    }
    bodies.set(logicalPath, body);
  }
  const root = bodies.get("index.md");
  const navigation = [
    "pages/index.md", "_graph/index.md", "schema.md", "log.md", "_index/index.md"
  ];
  let previous = -1;
  for (const target of navigation) {
    const current = root.indexOf(target);
    if (current <= previous) throw new Error("Full generated root navigation order changed");
    previous = current;
  }
}

async function verifySearchAndGraph(source) {
  const base = `/openapi/v2/knowledge-bases/${encodeURIComponent(rebuild.knowledgeBaseId)}`;
  const [search, graph] = await Promise.all([
    developer.json(`${base}/files/search?query=${encodeURIComponent(source.title)}&mode=hybrid&limit=10`),
    developer.json(`${base}/graph/overview`)
  ]);
  if (
    search.searchStatus !== "ok"
    || !search.items?.some((item) => item.sourceFileId === source.sourceFileId)
    || !graph
    || INTERNAL_FIELD_PATTERN.test(JSON.stringify({ search, graph }))
  ) throw new Error("Full search or graph flow failed");
}

async function exerciseConcurrentReads() {
  const base = `/openapi/v2/knowledge-bases/${encodeURIComponent(rebuild.knowledgeBaseId)}`;
  const results = await Promise.all([
    developer.json(`${base}/files/search?query=%E5%AE%AA%E6%B3%95&mode=file&limit=10`),
    developer.json(`${base}/graph/overview`),
    developer.text(generatedContentPath("index.md")),
    developer.text(generatedContentPath("pages/index.md"))
  ]);
  if (results.some((value) => !value || INTERNAL_FIELD_PATTERN.test(JSON.stringify(value)))) {
    throw new Error("Full interleaved reads failed or disclosed internal storage fields");
  }
}

async function acceptMutation(source, input) {
  const response = await developer.json(sourcePath(source.sourceFileId), {
    method: input.method,
    headers: {
      "idempotency-key": `${proof.runId}-${input.suffix}-${randomUUID()}`,
      "if-match": `"${source.resourceRevision}"`
    },
    ...(input.json ? { json: input.json } : {}),
    expectedStatus: 202
  });
  if (!response.operation?.operationId) {
    throw new Error("Full live-flow mutation returned no operation identity");
  }
  return response.operation;
}

async function waitForOperation(operationId, expectedStates, timeoutMs = 30 * 60 * 1_000) {
  const deadline = Date.now() + timeoutMs;
  const pathname = `/openapi/v2/knowledge-bases/${encodeURIComponent(
    rebuild.knowledgeBaseId
  )}/operations/${encodeURIComponent(operationId)}`;
  while (Date.now() < deadline) {
    const response = await developer.json(pathname);
    const operation = response.operation;
    if (expectedStates.includes(operation.state)) return operation;
    if (TERMINAL_OPERATION_STATES.has(operation.state)) {
      throw new Error(`Full live-flow operation ended in ${operation.state}`);
    }
    await sleep(1_000);
  }
  throw new Error("Full live-flow operation timed out");
}

async function readRepresentative() {
  const rows = await sql`
    SELECT public_id AS "sourceFileId", logical_path AS "relativePath",
           title, revision::integer AS "resourceRevision"
    FROM focowiki.source_files
    WHERE knowledge_base_id = ${rebuild.knowledgeBaseId}
      AND logical_path = ${REPRESENTATIVE_SOURCE_PATH}
      AND deleted_at IS NULL
  `;
  if (rows.length !== 1) throw new Error("Full representative source is unavailable");
  return rows[0];
}

async function readSource(sourceFileId) {
  const response = await developer.json(sourcePath(sourceFileId));
  return response.sourceFile;
}

async function waitForSourceMissing(sourceFileId) {
  const deadline = Date.now() + 30 * 60 * 1_000;
  while (Date.now() < deadline) {
    const response = await developer.request(sourcePath(sourceFileId));
    await response.text();
    if (response.status === 404) return;
    if (response.status !== 200) {
      throw new Error(`Full deletion visibility returned HTTP ${response.status}`);
    }
    await sleep(1_000);
  }
  throw new Error("Full deleted source remained visible");
}

async function waitForSourceVisible(sourceFileId) {
  const deadline = Date.now() + 30 * 60 * 1_000;
  while (Date.now() < deadline) {
    const source = await readSource(sourceFileId);
    if (source.state === "visible") return source;
    if (source.state === "failed") throw new Error("Full recreated source processing failed");
    await sleep(1_000);
  }
  throw new Error("Full recreated source did not become visible");
}

async function waitForFullConvergence() {
  const deadline = Date.now() + 60 * 60 * 1_000;
  while (Date.now() < deadline) {
    const [state] = await sql`
      SELECT
        (SELECT count(*) FROM focowiki.source_files
          WHERE knowledge_base_id = ${rebuild.knowledgeBaseId}
            AND deleted_at IS NULL AND status = 'ready')::integer AS ready,
        (SELECT count(*) FROM focowiki.operation_work_items
          WHERE knowledge_base_id = ${rebuild.knowledgeBaseId})::integer AS live_work,
        (SELECT count(*) FROM focowiki.release_candidates
          WHERE knowledge_base_id = ${rebuild.knowledgeBaseId})::integer AS candidates,
        (SELECT count(*) FROM focowiki.active_snapshots
          WHERE knowledge_base_id = ${rebuild.knowledgeBaseId})::integer AS active,
        (SELECT count(*) FROM focowiki.active_snapshots snapshot
          CROSS JOIN LATERAL focowiki.resolve_release_catalog(
            snapshot.release_root_public_id
          ) entry
          WHERE snapshot.knowledge_base_id = ${rebuild.knowledgeBaseId}
            AND entry.entry_kind = 'source')::integer AS active_sources
    `;
    if (
      state.ready === 29_736
      && state.live_work === 0
      && state.candidates === 0
      && state.active === 1
      && state.active_sources === 29_736
    ) return;
    await sleep(2_000);
  }
  throw new Error("Full live-flow terminal convergence timed out");
}

async function readFinalEvidence() {
  const expected = new Map(corpus.files.map((file) => [file.relativePath, file]));
  const rows = await sql`
    SELECT source.logical_path, revision.checksum_sha256,
           revision.byte_count::text AS byte_count
    FROM focowiki.source_files source
    JOIN focowiki.source_file_current_revisions current_revision
      ON current_revision.knowledge_base_id = source.knowledge_base_id
     AND current_revision.source_file_public_id = source.public_id
    JOIN focowiki.source_revisions revision
      ON revision.public_id = current_revision.source_revision_public_id
     AND revision.knowledge_base_id = current_revision.knowledge_base_id
    WHERE source.knowledge_base_id = ${rebuild.knowledgeBaseId}
      AND source.deleted_at IS NULL
  `;
  let checksumMismatchCount = 0;
  let pathMismatchCount = 0;
  for (const row of rows) {
    const descriptor = expected.get(row.logical_path);
    if (!descriptor) pathMismatchCount += 1;
    if (
      !descriptor
      || descriptor.checksumSha256 !== row.checksum_sha256
      || descriptor.sizeBytes !== Number(row.byte_count)
    ) checksumMismatchCount += 1;
    else expected.delete(row.logical_path);
  }
  const [terminal] = await sql`
    SELECT
      (SELECT count(*) FROM focowiki.operation_work_items
        WHERE knowledge_base_id = ${rebuild.knowledgeBaseId})::integer AS work_items,
      (SELECT count(*) FROM focowiki.release_candidates
        WHERE knowledge_base_id = ${rebuild.knowledgeBaseId})::integer AS candidates,
      (SELECT count(*) FROM focowiki.active_snapshots
        WHERE knowledge_base_id = ${rebuild.knowledgeBaseId})::integer AS snapshots
  `;
  return {
    finalSourceCount: rows.length,
    finalChecksumMismatchCount: checksumMismatchCount + expected.size,
    finalPathMismatchCount: pathMismatchCount + expected.size,
    terminalWorkItems: terminal.work_items,
    liveCandidates: terminal.candidates,
    activeSnapshots: terminal.snapshots
  };
}

async function readSourceCount() {
  const [row] = await sql`
    SELECT count(*)::integer AS count FROM focowiki.source_files
    WHERE knowledge_base_id = ${rebuild.knowledgeBaseId} AND deleted_at IS NULL
  `;
  return row.count;
}

function readRepresentativeBytes() {
  const filePath = path.resolve(sourceRoot, REPRESENTATIVE_SOURCE_PATH);
  if (!filePath.startsWith(`${sourceRoot}${path.sep}`)) {
    throw new Error("Full representative source escaped the corpus root");
  }
  return fs.readFileSync(filePath);
}

function requestDeveloper(pathname, options) {
  return developer.json(pathname, {
    method: options.method,
    headers: options.headers,
    query: options.query,
    ...(options.body !== undefined ? { json: options.body } : {}),
    ...(options.rawBody !== undefined ? { rawBody: options.rawBody } : {}),
    expectedStatus: options.status
  });
}

function sourcePath(sourceFileId) {
  return `/openapi/v2/knowledge-bases/${encodeURIComponent(
    rebuild.knowledgeBaseId
  )}/source-files/${encodeURIComponent(sourceFileId)}`;
}

function generatedContentPath(logicalPath) {
  return `/openapi/v2/knowledge-bases/${encodeURIComponent(
    rebuild.knowledgeBaseId
  )}/files/content?path=${encodeURIComponent(logicalPath)}`;
}

function pass(kind) {
  if (!STORAGE_VNEXT_FULL_LIVE_FLOW_KINDS.includes(kind)) {
    throw new Error(`Unknown full live-flow kind: ${kind}`);
  }
  if (report.flows.some((flow) => flow.kind === kind)) {
    throw new Error(`Duplicate full live-flow kind: ${kind}`);
  }
  report.flows.push({ kind, passed: true, completedAt: new Date().toISOString() });
  writeReport();
}

function assertInputs() {
  if (
    path.dirname(proofPath) !== proof?.filesystemScope
    || rebuild?.kind !== "focowiki-storage-vnext-full-rebuild"
    || rebuild.runId !== proof.runId
    || rebuild.finishedAt === null
    || rebuild.failure !== null
    || corpus?.fileCount !== 29_736
    || corpus.totalSizeBytes !== 526_803_253
    || reads?.kind !== "focowiki-storage-vnext-full-reads"
    || reads.runId !== proof.runId
    || reads.finishedAt === null
    || reads.failure !== null
    || verification?.kind !== "focowiki-storage-vnext-full-verification"
    || verification.runId !== proof.runId
    || verification.summary?.generatedStructureParity !== true
    || verification.summary?.preexistingControlsUnchanged !== true
  ) throw new Error("Full live-flow input evidence is invalid");
}

function writeReport() {
  const temporary = `${reportPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, reportPath);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function loadLocalEnv() {
  const envPath = process.env.ENV_FILE || ".env";
  if (fs.existsSync(envPath)) loadEnvFile(envPath);
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

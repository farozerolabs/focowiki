#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { createRequire } from "node:module";
import { loadEnvFile } from "node:process";
import { promisify } from "node:util";
import {
  createLifecycleHttpClient
} from "./lib/interleaved-lifecycle-api.mjs";
import {
  createRateLimitedFetch
} from "./lib/storage-vnext-rate-limited-fetch.mjs";
import {
  validateStorageVnextScaleCorpusManifest
} from "./lib/storage-vnext-scale-corpus.mjs";
import {
  assertStorageVnextScaleConvergenceCanProgress,
  createStorageVnextScalePublicationSettings,
  createStorageVnextScaleWorkerSettings,
  createStorageVnextScaleSearchSettings,
  createStorageVnextScaleRuntimeEnvironment,
  createStorageVnextValidationProfile,
  recoverStorageVnextScaleCompletionTimes,
  recoverStorageVnextScaleRun,
  summarizeStorageVnextSearchTaskEvidence
} from "./lib/storage-vnext-scale-scope.mjs";
import {
  uploadStorageVnextScaleCorpus
} from "./lib/storage-vnext-scale-upload.mjs";
import {
  captureStorageVnextStackResourceSample,
  createStorageVnextStackResourceSampler,
  mergeStorageVnextStackResourceSampleSummaries
} from "./lib/storage-vnext-stack-resource-sampler.mjs";
import {
  STORAGE_VNEXT_10000_BUDGETS
} from "./storage-vnext-scale-budget.mjs";

loadLocalEnv();
const rebuildMode = process.env.FOCOWIKI_STORAGE_VNEXT_REBUILD_MODE?.trim() || "scale";
const profile = createStorageVnextValidationProfile(rebuildMode);
const fullRebuild = rebuildMode === "full";
const expectedFileCount = profile.expectedFileCount;
const reportKind = profile.rebuildKind;
const reportFileName = profile.rebuildFileName;
const targetNameSuffix = profile.targetNameSuffix;
const execFile = promisify(execFileCallback);
const proofPath = path.resolve(requiredEnvironment("FOCOWIKI_STORAGE_VNEXT_PROOF_FILE"));
const corpusPath = path.resolve(
  requiredEnvironment(profile.corpusPathEnvironment)
);
const proofManifest = readJson(proofPath);
const proof = proofManifest?.proof;
const corpus = validateStorageVnextScaleCorpusManifest(readJson(corpusPath), {
  expectedFileCount
});
if (profile.expectedSourceBytes !== null
  && corpus.totalSizeBytes !== profile.expectedSourceBytes) {
  throw new Error("Full corpus byte identity changed");
}
const runtimeEnvironment = createStorageVnextScaleRuntimeEnvironment({
  proof,
  env: process.env
});
Object.assign(process.env, runtimeEnvironment);
const sourceRoot = path.resolve(requiredEnvironment("FOCOWIKI_VALIDATION_MARKDOWN_DIR"));
const reportPath = path.join(proof.filesystemScope, reportFileName);
const recovered = recoverStorageVnextScaleRun({
  report: fs.existsSync(reportPath) ? readJson(reportPath) : null,
  runId: proof.runId,
  corpus,
  reportKind
});
const apiRequire = createRequire(path.resolve("apps/api/package.json"));
const postgres = apiRequire("postgres");
const sql = postgres(runtimeEnvironment.DATABASE_URL, {
  max: 3,
  idle_timeout: 5,
  connect_timeout: 10
});
const retryingFetch = createRateLimitedFetch({ maximumRetries: 240 });
const admin = createLifecycleHttpClient({
  baseUrl: `http://127.0.0.1:${runtimeEnvironment.ADMIN_API_PORT || "43000"}`,
  fetchImpl: retryingFetch
});
const developer = createLifecycleHttpClient({
  baseUrl: `http://127.0.0.1:${runtimeEnvironment.PUBLIC_OPENAPI_PORT || "43200"}`,
  fetchImpl: retryingFetch
});
const origin = requiredEnvironment("ADMIN_PUBLIC_ORIGIN");
const startedAtMs = recovered ? Date.parse(recovered.startedAt) : Date.now();
const report = {
  kind: reportKind,
  version: 1,
  runId: proof.runId,
  corpus: {
    fileCount: corpus.fileCount,
    totalSizeBytes: corpus.totalSizeBytes,
    manifestChecksumSha256: corpus.manifestChecksumSha256
  },
  startedAt: new Date(startedAtMs).toISOString(),
  finishedAt: null,
  knowledgeBaseId: recovered?.knowledgeBaseId ?? null,
  upload: recovered?.upload ?? null,
  milestones: recovered?.milestones ?? [],
  convergence: recovered?.convergence ?? null,
  searchIndexing: recovered?.searchIndexing ?? null,
  throughput: recovered?.throughput ?? null,
  resourceSampling: recovered?.resourceSampling ?? null,
  failure: null
};
const resourceSampler = fullRebuild
  ? createStorageVnextStackResourceSampler({
      capture: () => captureStorageVnextStackResourceSample({
        execFile,
        composeProject: requiredEnvironment("FOCOWIKI_STORAGE_VNEXT_COMPOSE_PROJECT"),
        composeFile: "docker-compose.local.yml",
        cwd: process.cwd(),
        env: process.env
      }),
      intervalMs: 5_000
    })
  : null;

let loggedProgressBucket = -1;
let adminLoggedIn = false;
let resourceSamplerStarted = false;
let resourceSamplerStopped = false;
try {
  if (await recheckRecoveredConvergence()) {
    writeCompletion();
  } else {
    if (resourceSampler) {
      await resourceSampler.start();
      resourceSamplerStarted = true;
    }
    await loginAdmin();
    adminLoggedIn = true;
    await configureScaleRuntime();
    const credential = await createCredential();
    developer.authorization = `Bearer ${credential.rawKey}`;
    const knowledgeBaseId = await resolveKnowledgeBase();
    report.knowledgeBaseId = knowledgeBaseId;
    writeReport();

    report.upload = await uploadStorageVnextScaleCorpus({
      client: developer,
      knowledgeBaseId,
      manifest: corpus,
      expectedFileCount,
      idempotencyKey: `${proof.runId}-${rebuildMode}-upload`,
      startedAtMs,
      readBytes: async (descriptor) => readCorpusBytes(descriptor),
      finalizationTimeoutMs: 2 * 60 * 60 * 1_000,
      onProgress: recordUploadProgress
    });
    writeReport();
    const uploadCompletedAtMs = Date.now();
    const convergence = await waitForConvergence(knowledgeBaseId, uploadCompletedAtMs);
    report.convergence = convergence.snapshot;
    report.searchIndexing = await captureSearchIndexing(knowledgeBaseId);
    report.throughput = calculateThroughput({
      fileCount: corpus.fileCount,
      startedAtMs,
      uploadCompletedAtMs,
      searchIndexingDurationMs: report.searchIndexing.durationMs,
      ...convergence.completedAt
    });
    assertThroughput(report.throughput);
    if (resourceSampler) {
      await stopResourceSampler();
    }
    report.finishedAt = new Date().toISOString();
    writeReport();
    writeCompletion();
  }
} catch (error) {
  report.failure = {
    name: error instanceof Error ? error.name : "Error",
    message: safeError(error)
  };
  report.finishedAt = new Date().toISOString();
  writeReport();
  throw error;
} finally {
  if (resourceSamplerStarted && !resourceSamplerStopped) {
    await stopResourceSampler().catch(() => undefined);
  }
  await Promise.allSettled([
    adminLoggedIn
      ? admin.request("/admin/api/logout", { method: "POST", headers: { origin } })
      : Promise.resolve(),
    sql.end({ timeout: 5 })
  ]);
}

async function stopResourceSampler() {
  if (!resourceSampler) return;
  const segment = await resourceSampler.stop();
  report.resourceSampling = mergeStorageVnextStackResourceSampleSummaries([
    ...(report.resourceSampling ? [report.resourceSampling] : []),
    segment
  ]);
  resourceSamplerStopped = true;
  writeReport();
}

async function recheckRecoveredConvergence() {
  if (
    !recovered?.upload
    || !recovered.convergence
    || !report.knowledgeBaseId
  ) return false;
  const snapshot = await captureConvergence(report.knowledgeBaseId);
  assertStorageVnextScaleConvergenceCanProgress(snapshot);
  if (!isConverged(snapshot)) return false;
  report.convergence = snapshot;
  report.searchIndexing = await captureSearchIndexing(report.knowledgeBaseId);
  report.throughput = recovered.throughput
    ? {
        ...recovered.throughput,
        searchIndexedFileEquivalentsPerSecond: rate(
          corpus.fileCount,
          report.searchIndexing.durationMs
        )
      }
    : calculateThroughput({
        fileCount: corpus.fileCount,
        startedAtMs,
        searchIndexingDurationMs: report.searchIndexing.durationMs,
        ...recoverStorageVnextScaleCompletionTimes({
          startedAt: report.startedAt,
          uploadDurationMs: recovered.upload.durationMs,
          fileCount: corpus.fileCount,
          milestones: report.milestones
        })
      });
  assertThroughput(report.throughput);
  report.failure = null;
  report.finishedAt = new Date().toISOString();
  writeReport();
  return true;
}

function writeCompletion() {
  process.stdout.write(`${JSON.stringify({
    status: "complete",
    runId: proof.runId,
    fileCount: corpus.fileCount,
    totalSizeBytes: corpus.totalSizeBytes,
    throughput: report.throughput,
    activeSearchDocuments: report.convergence.activeSearchDocuments,
    reportPath
  }, null, 2)}\n`);
}

async function loginAdmin() {
  await admin.json("/admin/api/login", {
    method: "POST",
    headers: { origin },
    json: {
      username: requiredEnvironment("ADMIN_USERNAME"),
      password: requiredEnvironment("ADMIN_PASSWORD")
    }
  });
}

async function configureScaleRuntime() {
  const current = await admin.json("/admin/api/settings/runtime");
  await admin.json("/admin/api/settings/worker", {
    method: "PUT",
    headers: { origin },
    json: createStorageVnextScaleWorkerSettings(current.settings.worker)
  });
  await admin.json("/admin/api/settings/publication", {
    method: "PUT",
    headers: { origin },
    json: createStorageVnextScalePublicationSettings(current.settings.publication)
  });
  await admin.json("/admin/api/settings/search", {
    method: "PUT",
    headers: { origin },
    json: createStorageVnextScaleSearchSettings(current.settings.search)
  });
}

async function createCredential() {
  const response = await admin.json("/admin/api/openapi-keys", {
    method: "POST",
    headers: { origin },
    json: { name: `storage-vnext-${rebuildMode}-${proof.runId}` },
    expectedStatus: 201
  });
  if (!response.oneTimeKey?.rawKey) throw new Error("Scale credential was not returned");
  return { id: response.key.id, rawKey: response.oneTimeKey.rawKey };
}

async function createKnowledgeBase() {
  const response = await developer.json("/openapi/v2/knowledge-bases", {
    method: "POST",
    headers: { "idempotency-key": `${proof.runId}-${rebuildMode}-kb` },
    json: {
      name: `Storage vNext ${proof.runId} ${targetNameSuffix}`,
      description: fullRebuild
        ? "Run-owned 29,736-file full-corpus validation target"
        : "Run-owned 10,000-file scale validation target"
    },
    expectedStatus: 201
  });
  const knowledgeBaseId = response.knowledgeBase?.knowledgeBaseId
    ?? response.knowledgeBaseId;
  if (!knowledgeBaseId) throw new Error("Scale knowledge base identity was not returned");
  return knowledgeBaseId;
}

async function resolveKnowledgeBase() {
  if (!report.knowledgeBaseId) return createKnowledgeBase();
  const response = await developer.json(
    `/openapi/v2/knowledge-bases/${encodeURIComponent(report.knowledgeBaseId)}`
  );
  const knowledgeBase = response.knowledgeBase;
  if (
    knowledgeBase?.knowledgeBaseId !== report.knowledgeBaseId
    || knowledgeBase.name !== `Storage vNext ${proof.runId} ${targetNameSuffix}`
  ) throw new Error("Recovered rebuild knowledge base is outside the owned run");
  return report.knowledgeBaseId;
}

function readCorpusBytes(descriptor) {
  const filePath = path.resolve(sourceRoot, descriptor.relativePath);
  if (!filePath.startsWith(`${sourceRoot}${path.sep}`)) {
    throw new Error("Scale corpus path escaped the source root");
  }
  return fs.readFileSync(filePath);
}

function recordUploadProgress(progress) {
  if (progress.phase === "upload-content") {
    const bucket = Math.floor(progress.uploadedFiles / 500);
    if (bucket === loggedProgressBucket) return;
    loggedProgressBucket = bucket;
  }
  process.stdout.write(`${JSON.stringify(progress)}\n`);
}

async function waitForConvergence(knowledgeBaseId, uploadCompletedAtMs) {
  const deadline = Date.now() + 40 * 60 * 60 * 1_000;
  const completedAt = {
    sourceCompletedAtMs: null,
    graphCompletedAtMs: null,
    publicationCompletedAtMs: null,
    activationCompletedAtMs: null,
    totalCompletedAtMs: null
  };
  let previousMilestone = "";
  let snapshot = null;
  while (Date.now() < deadline) {
    snapshot = await captureConvergence(knowledgeBaseId);
    assertStorageVnextScaleConvergenceCanProgress(snapshot);
    const now = Date.now();
    if (!completedAt.graphCompletedAtMs && snapshot.graphNodes === corpus.fileCount) {
      completedAt.graphCompletedAtMs = now;
    }
    if (
      !completedAt.sourceCompletedAtMs
      && snapshot.readySources === corpus.fileCount
      && snapshot.liveSourceWork === 0
    ) completedAt.sourceCompletedAtMs = now;
    if (
      !completedAt.activationCompletedAtMs
      && snapshot.activeSnapshots === 1
      && snapshot.activeSourceCatalogEntries === corpus.fileCount
    ) completedAt.activationCompletedAtMs = now;
    if (
      !completedAt.publicationCompletedAtMs
      && completedAt.activationCompletedAtMs
      && snapshot.livePublicationWork === 0
      && snapshot.liveSearchWork === 0
    ) completedAt.publicationCompletedAtMs = now;

    const milestone = JSON.stringify({
      progress: Math.floor(snapshot.readySources / 500),
      graph: Math.floor(snapshot.graphNodes / 500),
      active: snapshot.activeSnapshots,
      indexes: snapshot.activeUnifiedIndexes,
      candidates: snapshot.releaseCandidates + snapshot.candidateUnifiedIndexes
    });
    if (milestone !== previousMilestone) {
      previousMilestone = milestone;
      const safeSnapshot = { at: new Date(now).toISOString(), ...snapshot };
      report.milestones.push(safeSnapshot);
      if (report.milestones.length > 64) report.milestones.shift();
      process.stdout.write(`${JSON.stringify({
        phase: fullRebuild ? "full-progress" : "scale-progress",
        ...snapshot
      })}\n`);
      writeReport();
    }

    if (isConverged(snapshot)) {
      completedAt.totalCompletedAtMs = now;
      for (const key of Object.keys(completedAt)) completedAt[key] ??= now;
      return { snapshot, completedAt, uploadCompletedAtMs };
    }
    await sleep(2_000);
  }
  throw new Error("Scale rebuild did not converge within 40 hours");
}

async function captureConvergence(knowledgeBaseId) {
  const rows = await sql`
    SELECT
      (SELECT count(*)::integer FROM focowiki.source_files
       WHERE knowledge_base_id = ${knowledgeBaseId} AND deleted_at IS NULL) AS "sourceFiles",
      (SELECT count(*)::integer FROM focowiki.source_files
       WHERE knowledge_base_id = ${knowledgeBaseId} AND status = 'ready'
         AND deleted_at IS NULL) AS "readySources",
      (SELECT count(*)::integer FROM focowiki.source_files
       WHERE knowledge_base_id = ${knowledgeBaseId} AND status = 'failed'
         AND deleted_at IS NULL) AS "failedSources",
      (SELECT count(*)::integer FROM focowiki.graph_nodes
       WHERE knowledge_base_id = ${knowledgeBaseId}) AS "graphNodes",
      (SELECT count(*)::integer FROM focowiki.operation_work_items
       WHERE knowledge_base_id = ${knowledgeBaseId} AND work_kind = 'source') AS "liveSourceWork",
      (SELECT count(*)::integer FROM focowiki.operation_work_items
       WHERE knowledge_base_id = ${knowledgeBaseId} AND work_kind = 'publication') AS "livePublicationWork",
      (SELECT count(*)::integer FROM focowiki.operation_work_items
       WHERE knowledge_base_id = ${knowledgeBaseId} AND work_kind = 'search') AS "liveSearchWork",
      (SELECT count(*)::integer FROM focowiki.operations
       WHERE knowledge_base_id = ${knowledgeBaseId}
         AND operation_kind = 'publication' AND state = 'failed') AS "failedPublicationOperations",
      (SELECT count(*)::integer FROM focowiki.release_candidates
       WHERE knowledge_base_id = ${knowledgeBaseId}) AS "releaseCandidates",
      (SELECT count(*)::integer FROM focowiki.active_snapshots
       WHERE knowledge_base_id = ${knowledgeBaseId}) AS "activeSnapshots",
      (SELECT count(*)::integer
       FROM focowiki.active_snapshots snapshot
       CROSS JOIN LATERAL focowiki.resolve_release_catalog(
         snapshot.release_root_public_id
       ) entry
       WHERE snapshot.knowledge_base_id = ${knowledgeBaseId}
         AND entry.entry_kind = 'source') AS "activeSourceCatalogEntries",
      (SELECT count(*)::integer FROM focowiki.search_projections
       WHERE knowledge_base_id = ${knowledgeBaseId}
         AND projection_role = 'active' AND state = 'ready') AS "activeUnifiedIndexes",
      (SELECT count(*)::integer FROM focowiki.search_projections
       WHERE knowledge_base_id = ${knowledgeBaseId}
         AND projection_role = 'candidate') AS "candidateUnifiedIndexes",
      (SELECT coalesce(sum(document_count), 0)::integer
       FROM focowiki.search_projections
       WHERE knowledge_base_id = ${knowledgeBaseId}
         AND projection_role = 'active' AND state = 'ready') AS "activeSearchDocuments"
  `;
  return rows[0];
}

async function captureSearchIndexing(knowledgeBaseId) {
  const projections = await sql`
    SELECT
      provider_index_uid AS "providerIndexUid",
      document_count::integer AS "documentCount",
      next_batch_ordinal::integer AS "batchCount",
      created_at::text AS "createdAt",
      updated_at::text AS "updatedAt"
    FROM focowiki.search_projections
    WHERE knowledge_base_id = ${knowledgeBaseId}
      AND projection_role = 'active'
      AND state = 'ready'
  `;
  if (projections.length !== 1) {
    throw new Error("Scale rebuild does not have exactly one active search projection");
  }
  const projection = projections[0];
  const tasksUrl = new URL("/tasks", requiredEnvironment("MEILI_HOST"));
  tasksUrl.searchParams.set("indexUids", projection.providerIndexUid);
  tasksUrl.searchParams.set("types", "documentAdditionOrUpdate");
  tasksUrl.searchParams.set("limit", "1000");
  const response = await retryingFetch(tasksUrl, {
    headers: {
      authorization: `Bearer ${requiredEnvironment("MEILI_API_KEY")}`
    }
  });
  if (!response.ok) {
    throw new Error(`Search provider task evidence request failed with ${response.status}`);
  }
  const taskPage = await response.json();
  let providerStats = null;
  if (Array.isArray(taskPage?.results) && taskPage.results.length === 0) {
    const statsUrl = new URL(
      `/indexes/${encodeURIComponent(projection.providerIndexUid)}/stats`,
      requiredEnvironment("MEILI_HOST")
    );
    const statsResponse = await retryingFetch(statsUrl, {
      headers: {
        authorization: `Bearer ${requiredEnvironment("MEILI_API_KEY")}`
      }
    });
    if (!statsResponse.ok) {
      throw new Error(
        `Search provider stats evidence request failed with ${statsResponse.status}`
      );
    }
    providerStats = await statsResponse.json();
  }
  return summarizeStorageVnextSearchTaskEvidence({
    providerIndexUid: projection.providerIndexUid,
    expectedDocumentCount: projection.documentCount,
    taskPage,
    durableProjection: projection,
    providerStats
  });
}

function isConverged(snapshot) {
  return snapshot.sourceFiles === corpus.fileCount
    && snapshot.readySources === corpus.fileCount
    && snapshot.failedSources === 0
    && snapshot.graphNodes === corpus.fileCount
    && snapshot.liveSourceWork === 0
    && snapshot.livePublicationWork === 0
    && snapshot.liveSearchWork === 0
    && snapshot.failedPublicationOperations === 0
    && snapshot.releaseCandidates === 0
    && snapshot.activeSnapshots === 1
    && snapshot.activeSourceCatalogEntries === corpus.fileCount
    && snapshot.activeUnifiedIndexes === 1
    && snapshot.candidateUnifiedIndexes === 0
    && snapshot.activeSearchDocuments >= corpus.fileCount;
}

function calculateThroughput(input) {
  return {
    uploadAcceptedFilesPerSecond: report.upload.filesPerSecond,
    sourceCompletedFilesPerSecond: rate(
      input.fileCount,
      input.sourceCompletedAtMs - input.uploadCompletedAtMs
    ),
    publicationCompletedFilesPerSecond: rate(
      input.fileCount,
      input.publicationCompletedAtMs - input.uploadCompletedAtMs
    ),
    searchIndexedFileEquivalentsPerSecond: rate(
      input.fileCount,
      input.searchIndexingDurationMs
    ),
    graphCompletedFilesPerSecond: rate(
      input.fileCount,
      input.graphCompletedAtMs - input.uploadCompletedAtMs
    ),
    totalCompletedFilesPerSecond: rate(
      input.fileCount,
      input.totalCompletedAtMs - input.startedAtMs
    )
  };
}

function assertThroughput(throughput) {
  const minimums = STORAGE_VNEXT_10000_BUDGETS.throughput;
  const checks = [
    ["upload", throughput.uploadAcceptedFilesPerSecond,
      minimums.minimumUploadAcceptedFilesPerSecond],
    ["source", throughput.sourceCompletedFilesPerSecond,
      minimums.minimumSourceCompletedFilesPerSecond],
    ["publication", throughput.publicationCompletedFilesPerSecond,
      minimums.minimumPublicationCompletedFilesPerSecond],
    ["search", throughput.searchIndexedFileEquivalentsPerSecond,
      minimums.minimumSearchIndexedFileEquivalentsPerSecond],
    ["graph", throughput.graphCompletedFilesPerSecond,
      minimums.minimumGraphCompletedFilesPerSecond],
    ["total", throughput.totalCompletedFilesPerSecond,
      minimums.minimumTotalCompletedFilesPerSecond]
  ];
  const failures = checks.filter(([_name, actual, minimum]) => (
    !Number.isFinite(actual) || actual < minimum
  ));
  if (failures.length > 0) {
    throw new Error(`Scale throughput failed: ${failures.map(([name]) => name).join(", ")}`);
  }
}

function rate(count, milliseconds) {
  return Math.round(count / Math.max(milliseconds / 1_000, 0.001) * 1_000) / 1_000;
}

function writeReport() {
  const temporary = `${reportPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, reportPath);
}

function safeError(error) {
  return String(error instanceof Error ? error.message : error)
    .replaceAll(sourceRoot, "[external-corpus]")
    .slice(0, 2_000);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function loadLocalEnv() {
  const envPath = process.env.ENV_FILE || ".env";
  if (fs.existsSync(envPath)) loadEnvFile(envPath);
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

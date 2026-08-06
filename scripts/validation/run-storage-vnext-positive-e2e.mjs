import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";
import {
  createLifecycleHttpClient,
  createUploadSessionPhaseClient
} from "./lib/interleaved-lifecycle-api.mjs";
import {
  resolveCompletedUploadSessionId
} from "./lib/storage-vnext-positive-e2e-resume.mjs";

loadLocalEnv();
const proofPath = requiredEnv("FOCOWIKI_STORAGE_VNEXT_PROOF_FILE");
const corpusPath = requiredEnv("FOCOWIKI_STORAGE_VNEXT_CORPUS_MANIFEST_PATH");
const targetPath = requiredEnv("FOCOWIKI_STORAGE_VNEXT_TARGET_FILE");
const externalRoot = path.resolve(requiredEnv("FOCOWIKI_VALIDATION_MARKDOWN_DIR"));
const controlRoot = path.resolve("scripts/validation/fixtures/non-legal-control");
const proofManifest = readJson(proofPath);
const corpus = readJson(corpusPath);
const target = readJson(targetPath);
const runId = proofManifest?.proof?.runId;
const filesystemScope = proofManifest?.proof?.filesystemScope;
assertInputs();

const reportPath = path.join(filesystemScope, "positive-e2e.json");
const previousReport = fs.existsSync(reportPath) ? readJson(reportPath) : null;
const previousUploadSessionId = resolveCompletedUploadSessionId({
  report: previousReport,
  runId,
  knowledgeBaseId: target.knowledgeBase.id,
  sampleCount: corpus.samples.length
});
const report = {
  kind: "focowiki-storage-vnext-positive-e2e",
  version: 1,
  runId,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  knowledgeBaseId: target.knowledgeBase.id,
  sampleCount: corpus.samples.length,
  phases: [],
  checks: [],
  sourceFileIds: [],
  generatedPaths: [],
  search: null,
  graph: null,
  unifiedIndexUid: null,
  completedUploadSessionId: previousUploadSessionId,
  originalPublicationSettings: previousReport?.originalPublicationSettings ?? null,
  effectivePublicationSettings: previousReport?.effectivePublicationSettings ?? null,
  resumedFrom: previousReport ? {
    startedAt: previousReport.startedAt,
    finishedAt: previousReport.finishedAt,
    phases: previousReport.phases,
    checks: previousReport.checks,
    failure: previousReport.failure ?? null
  } : null
};
const admin = createLifecycleHttpClient({
  baseUrl: `http://127.0.0.1:${process.env.ADMIN_API_PORT || "43000"}`
});
const developer = createLifecycleHttpClient({
  baseUrl: `http://127.0.0.1:${process.env.PUBLIC_OPENAPI_PORT || "43200"}`,
  authorization: `Bearer ${target.openApiCredential.rawKey}`
});
const origin = requiredEnv("ADMIN_PUBLIC_ORIGIN");

try {
  const files = loadAndVerifyFiles();
  phase("corpus-verified", { fileCount: files.length });
  await loginAdmin();
  await configureFastBatchPublication();

  const upload = createUploadSessionPhaseClient({
    client: developer,
    knowledgeBaseId: target.knowledgeBase.id,
    idempotencyPrefix: `${runId}-positive`
  });
  const completedSessionId = report.completedUploadSessionId;
  if (completedSessionId) {
    const imported = await listAllDeveloper(
      `/openapi/v2/knowledge-bases/${encodeURIComponent(target.knowledgeBase.id)}/source-files?limit=200`
    );
    if (imported.length !== files.length) {
      throw new Error("Completed upload source count no longer matches the corpus manifest.");
    }
    verifySourcePathSet(files, imported);
    phase("upload-resumed", { sessionId: completedSessionId });
  } else {
    const created = await upload.create(files);
    const sessionId = created.session.id;
    phase("upload-session-created", { sessionId });
    await upload.appendManifest(sessionId);
    phase("upload-manifest-appended", { fileCount: files.length });
    await upload.seal(sessionId);
    const reconciled = await waitForReservations(upload, sessionId);
    phase("upload-manifest-sealed", {
      entryCount: reconciled.entries?.length ?? files.length
    });
    await upload.uploadMissingContent(sessionId, reconciled.entries);
    phase("upload-content-written", {
      byteCount: files.reduce((total, file) => total + file.bytes.byteLength, 0)
    });
    await upload.finalize(sessionId);
    await waitForUploadSession(upload, sessionId);
    report.completedUploadSessionId = sessionId;
    phase("upload-completed", { sessionId });
  }

  await retryFailedSourceFiles(target.knowledgeBase.id);

  const sourceFiles = await waitForVisibleSourceFiles(
    target.knowledgeBase.id,
    files.length,
    timeoutMilliseconds()
  );
  report.sourceFileIds = sourceFiles.map((source) => source.sourceFileId);
  report.generatedPaths = sourceFiles.map((source) => source.generatedPath).filter(Boolean);
  phase("source-and-publication-completed", {
    sourceFileCount: sourceFiles.length,
    generatedPathCount: report.generatedPaths.length
  });

  verifySourcePathSet(files, sourceFiles);
  await verifyRepresentativeSourceContent(files, sourceFiles);
  const knowledgeBase = await developer.json(
    `/openapi/v2/knowledge-bases/${encodeURIComponent(target.knowledgeBase.id)}`
  );
  assertNoInternalStorageFields(knowledgeBase);
  check("knowledge-base-metadata", Boolean(knowledgeBase.knowledgeBase));

  const rootIndex = await developer.text(
    openApiPath("/files/content?path=index.md")
  );
  check("root-index-readable", rootIndex.trim().length > 0, {
    bytes: Buffer.byteLength(rootIndex)
  });
  const representative = representativeSource(sourceFiles);
  const generated = await developer.text(openApiPath(
    `/files/content?path=${encodeURIComponent(representative.generatedPath)}`
  ));
  check("source-backed-generated-file", generated.trim().length > 0, {
    path: representative.generatedPath,
    bytes: Buffer.byteLength(generated)
  });

  const tree = await listPublishedTree();
  check("published-tree", tree.items.length > files.length, {
    itemCount: tree.items.length,
    directoryCount: tree.directoryCount
  });
  const fileById = await developer.json(openApiPath(
    `/files/${encodeURIComponent(representative.sourceFileId)}`
  ));
  assertNoInternalStorageFields(fileById);
  check("generated-file-by-id", Boolean(fileById.file));
  const related = await developer.json(openApiPath(
    `/files/${encodeURIComponent(representative.sourceFileId)}/related?limit=50`
  ));
  assertNoInternalStorageFields(related);
  check("related-file-read", Array.isArray(related.items), {
    itemCount: related.items?.length ?? 0
  });

  const searchQuery = searchTerm(files);
  const search = await developer.json(openApiPath(
    `/files/search?query=${encodeURIComponent(searchQuery)}&mode=hybrid&limit=50`
  ));
  assertNoInternalStorageFields(search);
  check("unified-search", Array.isArray(search.items) && search.items.length > 0, {
    query: searchQuery,
    resultCount: search.items?.length ?? 0
  });
  report.search = {
    query: searchQuery,
    resultCount: search.items.length,
    nextCursor: Boolean(search.nextCursor)
  };

  const graphOverview = await developer.json(openApiPath("/graph/overview"));
  const graphExpansion = await developer.json(openApiPath(
    `/graph/expand?fileId=${encodeURIComponent(representative.sourceFileId)}&depth=1&fanout=10&limit=50`
  ));
  assertNoInternalStorageFields(graphOverview);
  assertNoInternalStorageFields(graphExpansion);
  check(
    "graph-overview",
    graphOverview.availability === "available"
      && Number.isSafeInteger(graphOverview.summary?.nodeCount)
      && graphOverview.summary.nodeCount > 0,
    {
      nodeCount: graphOverview.summary?.nodeCount ?? 0,
      edgeCount: graphOverview.summary?.edgeCount ?? 0
    }
  );
  check("graph-expansion", Array.isArray(graphExpansion.relationships), {
    relationshipCount: graphExpansion.relationships?.length ?? 0
  });
  report.graph = {
    relationshipCount: graphExpansion.relationships.length,
    pathCount: graphExpansion.graphPaths?.length ?? 0
  };

  await verifyAdminSurfaces(representative);
  report.unifiedIndexUid = await verifyOneUnifiedIndex();
  phase("positive-surfaces-verified", {
    checkCount: report.checks.length,
    unifiedIndexUid: report.unifiedIndexUid
  });
  report.finishedAt = new Date().toISOString();
  writeReport();
  process.stdout.write(`${JSON.stringify({
    runId,
    reportPath,
    knowledgeBaseId: report.knowledgeBaseId,
    sampleCount: report.sampleCount,
    sourceFileCount: report.sourceFileIds.length,
    generatedPathCount: report.generatedPaths.length,
    treeItemCount: tree.items.length,
    searchResultCount: report.search.resultCount,
    graphRelationshipCount: report.graph.relationshipCount,
    unifiedIndexUid: report.unifiedIndexUid,
    checkCount: report.checks.length
  }, null, 2)}\n`);
} catch (error) {
  report.finishedAt = new Date().toISOString();
  report.failure = {
    name: error?.name ?? "Error",
    message: String(error?.message ?? error).replaceAll(externalRoot, "[external-corpus]")
  };
  writeReport();
  throw error;
} finally {
  await admin.request("/admin/api/logout", {
    method: "POST",
    headers: { origin }
  }).catch(() => undefined);
}

function loadAndVerifyFiles() {
  return corpus.samples.map((sample) => {
    const root = sample.group === "external" ? externalRoot : controlRoot;
    const filePath = path.resolve(root, sample.relativePath);
    if (!filePath.startsWith(`${root}${path.sep}`)) {
      throw new Error("Corpus manifest sample escaped its source root.");
    }
    const bytes = fs.readFileSync(filePath);
    if (
      bytes.byteLength !== sample.sizeBytes
      || crypto.createHash("sha256").update(bytes).digest("hex")
        !== sample.checksumSha256
    ) throw new Error(`Corpus sample changed: ${sample.relativePath}`);
    return {
      relativePath: sample.group === "external"
        ? sample.relativePath
        : `generic-control/${sample.relativePath}`,
      bytes,
      checksumSha256: sample.checksumSha256,
      group: sample.group
    };
  });
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
  check("admin-login", true);
}

async function configureFastBatchPublication() {
  const current = await admin.json("/admin/api/settings/runtime");
  report.originalPublicationSettings ??= current.settings.publication;
  const next = {
    ...current.settings.publication,
    mode: "batch",
    intervalSeconds: 10
  };
  const updated = await admin.json("/admin/api/settings/publication", {
    method: "PUT",
    headers: { origin },
    json: next
  });
  report.effectivePublicationSettings = updated.settings.publication;
  check(
    "publication-settings-field-update",
    updated.settings.publication.mode === "batch"
      && updated.settings.publication.intervalSeconds === 10
  );
}

async function retryFailedSourceFiles(knowledgeBaseId) {
  const files = await listAllDeveloper(
    `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-files?limit=200`
  );
  const failed = files.filter((file) => file.state === "failed");
  for (const file of failed) {
    await admin.json(
      `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-files/${
        encodeURIComponent(file.sourceFileId)
      }/retry`,
      { method: "POST", headers: { origin } }
    );
  }
  phase("failed-source-files-retried", { retryCount: failed.length });
}

async function waitForReservations(upload, sessionId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = await upload.reconcile(sessionId);
    if ((current.session?.counts?.waitingReservation ?? 0) === 0) return current;
    await sleep(100);
  }
  throw new Error("Upload path reservations did not converge.");
}

async function waitForUploadSession(upload, sessionId) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const current = await upload.get(sessionId, { limit: 1 });
    const state = current.session?.state;
    if (state === "completed") return;
    if (["cancelled", "expired", "failed"].includes(state)) {
      throw new Error(`Upload session reached ${state}.`);
    }
    await sleep(250);
  }
  throw new Error("Upload session did not complete.");
}

async function waitForVisibleSourceFiles(knowledgeBaseId, expectedCount, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastProgress = "";
  while (Date.now() < deadline) {
    const files = await listAllDeveloper(
      `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-files?limit=200`
    );
    const counts = Object.fromEntries(
      [...new Set(files.map((file) => file.state))].sort().map((state) => [
        state,
        files.filter((file) => file.state === state).length
      ])
    );
    const progress = JSON.stringify({ total: files.length, ...counts });
    if (progress !== lastProgress) {
      process.stdout.write(`${JSON.stringify({ phase: "source-progress", ...JSON.parse(progress) })}\n`);
      lastProgress = progress;
    }
    const failure = files.find((file) => file.state === "failed");
    if (failure) {
      throw new Error(`Source file failed: ${failure.relativePath} (${failure.failure?.code ?? "UNKNOWN"})`);
    }
    if (
      files.length === expectedCount
      && files.every((file) => file.state === "visible" && file.generatedPath)
    ) return files;
    await sleep(1_000);
  }
  throw new Error("Source processing and publication did not converge.");
}

async function listAllDeveloper(pathname) {
  const items = [];
  let cursor = null;
  do {
    const separator = pathname.includes("?") ? "&" : "?";
    const page = await developer.json(
      `${pathname}${cursor ? `${separator}cursor=${encodeURIComponent(cursor)}` : ""}`
    );
    items.push(...(page.items ?? []));
    cursor = page.nextCursor ?? null;
  } while (cursor);
  return items;
}

function verifySourcePathSet(files, sourceFiles) {
  const expected = files.map((file) => file.relativePath).sort();
  const actual = sourceFiles.map((file) => file.relativePath).sort();
  check("source-path-set", JSON.stringify(actual) === JSON.stringify(expected), {
    pathCount: actual.length
  });
}

async function verifyRepresentativeSourceContent(files, sourceFiles) {
  const positions = [0, Math.floor(files.length / 2), files.length - 1];
  for (const position of positions) {
    const expected = files[position];
    const source = sourceFiles.find((item) => item.relativePath === expected.relativePath);
    if (!source) throw new Error(`Representative source is missing: ${expected.relativePath}`);
    const response = await developer.request(openApiPath(
      `/source-files/${encodeURIComponent(source.sourceFileId)}/content`
    ));
    const body = Buffer.from(await response.arrayBuffer());
    if (!response.ok) throw new Error(`Source content returned HTTP ${response.status}.`);
    check(
      `source-content-${position}`,
      crypto.createHash("sha256").update(body).digest("hex") === expected.checksumSha256,
      { bytes: body.byteLength }
    );
  }
}

async function listPublishedTree() {
  const queue = ["pages"];
  const visited = new Set();
  const items = [];
  let directoryCount = 0;
  while (queue.length > 0) {
    const parentPath = queue.shift();
    if (!parentPath || visited.has(parentPath)) continue;
    visited.add(parentPath);
    let cursor = null;
    do {
      const page = await developer.json(openApiPath(
        `/tree?parentPath=${encodeURIComponent(parentPath)}&limit=500${
          cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
        }`
      ));
      for (const item of page.items ?? []) {
        items.push(item);
        if (item.entryType === "directory") {
          directoryCount += 1;
          queue.push(item.path ?? item.logicalPath);
        }
      }
      cursor = page.nextCursor ?? null;
    } while (cursor);
  }
  return { items, directoryCount };
}

async function verifyAdminSurfaces(representative) {
  const knowledgeBases = await admin.json("/admin/api/knowledge-bases?limit=200");
  check(
    "admin-knowledge-base-list",
    knowledgeBases.items?.some((item) => item.id === target.knowledgeBase.id)
  );
  const processing = await admin.json(
    `/admin/api/knowledge-bases/${encodeURIComponent(target.knowledgeBase.id)}/processing-summary`
  );
  check("admin-processing-summary", Boolean(processing));
  const tree = await admin.json(
    `/admin/api/knowledge-bases/${encodeURIComponent(target.knowledgeBase.id)}/files/tree?parentPath=pages&limit=500`
  );
  check("admin-file-tree", Array.isArray(tree.items) && tree.items.length > 0);
  const detail = await admin.json(
    `/admin/api/knowledge-bases/${encodeURIComponent(target.knowledgeBase.id)}/files/detail?path=${
      encodeURIComponent(representative.generatedPath)
    }`
  );
  check("admin-generated-file-detail", Boolean(detail.file) && detail.content.length > 0);
  assertNoInternalStorageFields({
    knowledgeBases,
    processing,
    tree,
    file: detail.file
  });
}

async function verifyOneUnifiedIndex() {
  const response = await fetch(`${requiredEnv("MEILI_HOST")}/indexes?limit=1000`, {
    headers: { authorization: `Bearer ${requiredEnv("MEILI_API_KEY")}` },
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`Meilisearch index inventory returned HTTP ${response.status}.`);
  const page = await response.json();
  const owned = page.results
    .map((index) => index.uid)
    .filter((uid) => uid.startsWith(proofManifest.proof.searchScope));
  check("one-unified-index-per-knowledge-base", owned.length === 1, {
    indexCount: owned.length
  });
  return owned[0];
}

function representativeSource(sourceFiles) {
  const source = sourceFiles.find((item) => item.relativePath.startsWith("generic-control/"))
    ?? sourceFiles[0];
  if (!source?.generatedPath) throw new Error("No source-backed generated file is available.");
  return source;
}

function searchTerm(files) {
  const control = files.find((file) => file.relativePath.endsWith("authentication.md"));
  return control ? "authentication" : path.basename(files[0].relativePath).split("__")[0];
}

function openApiPath(suffix) {
  return `/openapi/v2/knowledge-bases/${encodeURIComponent(target.knowledgeBase.id)}${suffix}`;
}

function assertNoInternalStorageFields(value) {
  const serialized = JSON.stringify(value);
  if (
    /objectKey|providerIndexUid|providerTaskUid|ownerMarker|proofChecksum|redisKey|tableName/iu
      .test(serialized)
  ) throw new Error("Public response exposed an internal storage identity.");
}

function phase(name, details = {}) {
  report.phases.push({ name, at: new Date().toISOString(), details });
  process.stdout.write(`${JSON.stringify({ phase: name, ...details })}\n`);
  writeReport();
}

function check(name, passed, details = {}) {
  report.checks.push({ name, passed, details });
  if (!passed) throw new Error(`Positive E2E check failed: ${name}.`);
}

function writeReport() {
  const temporary = `${reportPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, reportPath);
}

function assertInputs() {
  if (
    !/^svnext-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$/u.test(runId ?? "")
    || path.dirname(proofPath) !== filesystemScope
    || path.dirname(targetPath) !== filesystemScope
    || target.runId !== runId
    || corpus.kind !== "storage-vnext-cleaned-markdown-corpus-manifest"
    || corpus.externalSampleCount !== 200
    || corpus.genericControlSampleCount !== 14
    || corpus.samples.length !== 214
  ) throw new Error("Positive E2E inputs do not match one exact run-owned scope.");
}

function timeoutMilliseconds() {
  const value = Number(process.env.FOCOWIKI_STORAGE_VNEXT_POSITIVE_TIMEOUT_MS ?? 1_200_000);
  if (!Number.isSafeInteger(value) || value < 60_000) {
    throw new Error("Positive E2E timeout is invalid.");
  }
  return value;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function loadLocalEnv() {
  const envPath = process.env.ENV_FILE || ".env";
  if (fs.existsSync(envPath)) loadEnvFile(envPath);
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

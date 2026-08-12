#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { analyzeOkfMetadata } from "../../packages/okf/src/index.ts";
import { createLifecycleHttpClient } from "./lib/interleaved-lifecycle-api.mjs";
import { inspectOkfV02CorpusBaseline } from
  "./lib/okf-v02-corpus-inspection.mjs";
import { uploadMarkdownFilesWithSession } from
  "./lib/upload-session-client.mjs";

const reportDirectory = requireReportDirectory();
const reportPath = path.join(reportDirectory, "corpus-e2e.json");
const privateWorkspacePath = path.join(reportDirectory, "corpus-workspace-private.json");
const manifestPath = path.join(reportDirectory, "corpus-manifest.json");
const adminBaseUrl = `http://127.0.0.1:${process.env.ADMIN_API_PORT || "43000"}`;
const developerBaseUrl = `http://127.0.0.1:${process.env.PUBLIC_OPENAPI_PORT || "43200"}`;
const origin = process.env.ADMIN_PUBLIC_ORIGIN || "http://127.0.0.1:43100";
const runId = `comprehensive-corpus-${crypto.randomUUID()}`;
const admin = createLifecycleHttpClient({ baseUrl: adminBaseUrl });
const manifest = readJson(manifestPath);
const privateWorkspace = readJson(privateWorkspacePath);
const samples = loadSamples({ manifest, privateWorkspace });
const aliasByPath = new Map(samples.map((sample) => [sample.relativePath, sample.alias]));
const previousReport = fs.existsSync(reportPath) ? readJson(reportPath) : null;
const report = {
  kind: "focowiki-comprehensive-corpus-e2e",
  version: 1,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  ok: false,
  provider: "opensearch",
  counts: { official: 53, legacy: 147, total: 200 },
  knowledgeBases: previousReport?.kind === "focowiki-comprehensive-corpus-e2e"
    ? previousReport.knowledgeBases ?? {}
    : {},
  files: Object.fromEntries(samples.map((sample) => [sample.alias, {
    family: sample.family,
    expectedChecksumSha256: sample.checksumSha256,
    expectedSizeBytes: sample.bytes.byteLength,
    transfer: null,
    sourceFileId: null,
    firstSeenElapsedMs: null,
    visibleElapsedMs: null,
    finalState: null,
    finalStage: null,
    modelInvocationStatus: null,
    modelNameRecorded: false,
    generatedOutputStatus: null,
    generatedFileAvailable: false,
    retryCount: null,
    sourceChecksumVerified: false,
    generatedContentVerified: false,
    ...(previousReport?.files?.[sample.alias]?.expectedChecksumSha256 === sample.checksumSha256
      ? previousReport.files[sample.alias]
      : {})
  }])),
  baselines: previousReport?.baselines ?? {},
  checks: previousReport?.checks ?? [],
  cleanup: { keyDeleted: false, publicationRestored: false },
  failure: null
};

let developer = null;
let keyId = null;
let originalPublication = null;

try {
  assertCorpusInputs();
  await login();
  const runtime = await admin.json("/admin/api/settings/runtime");
  originalPublication = runtime.settings.publication;
  await admin.json("/admin/api/settings/publication", {
    method: "PUT",
    headers: { origin },
    json: { ...originalPublication, mode: "batch", intervalSeconds: 10 }
  });

  const key = await admin.json("/admin/api/openapi-keys", {
    method: "POST",
    headers: { origin },
    json: { name: "Comprehensive corpus validation" },
    expectedStatus: 201
  });
  keyId = key.key?.id;
  const rawKey = key.oneTimeKey?.rawKey;
  assert(keyId && rawKey, "OpenAPI key creation returned an incomplete result.");
  developer = createLifecycleHttpClient({
    baseUrl: developerBaseUrl,
    authorization: `Bearer ${rawKey}`
  });

  for (const family of ["official", "legacy"]) {
    await runFamily(family);
    persistReport();
  }
  verifyOriginalChecksums();
  pass("original-corpus-checksums-unchanged", { count: samples.length });
  report.ok = report.checks.every((check) => check.ok)
    && Object.values(report.files).every((file) =>
      file.finalState === "visible"
        && file.sourceChecksumVerified
        && file.generatedContentVerified
    );
} catch (error) {
  report.failure = {
    name: error instanceof Error ? error.name : "Error",
    message: sanitizeMessage(error instanceof Error ? error.message : String(error))
  };
} finally {
  if (keyId) {
    report.cleanup.keyDeleted = await cleanupRequest(
      `/admin/api/openapi-keys/${encodeURIComponent(keyId)}`,
      { method: "DELETE", headers: { origin } }
    );
  }
  if (originalPublication) {
    report.cleanup.publicationRestored = await cleanupRequest(
      "/admin/api/settings/publication",
      { method: "PUT", headers: { origin }, json: originalPublication }
    );
  }
  await admin.request("/admin/api/logout", { method: "POST", headers: { origin } })
    .catch(() => undefined);
  report.finishedAt = new Date().toISOString();
  report.ok = report.ok && Object.values(report.cleanup).every(Boolean);
  persistReport();
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    completedFiles: Object.values(report.files).filter((file) =>
      file.finalState === "visible" && file.generatedContentVerified).length,
    checks: report.checks.length,
    cleanup: report.cleanup,
    reportPath
  })}\n`);
  if (!report.ok) process.exitCode = 1;
}

async function runFamily(family) {
  const familySamples = samples.filter((sample) => sample.family === family);
  const reusable = await readReusableFamily(family, familySamples);
  let knowledgeBaseId = reusable?.knowledgeBaseId ?? null;
  const uploadStartedAt = Date.now();
  if (!reusable) {
    const createdAt = Date.now();
    const created = await developer.json("/openapi/v2/knowledge-bases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: family === "official"
          ? "General-purpose OKF 0.2 validation"
          : "OKF 0.1 compatibility validation",
        description: "Run-owned comprehensive release validation"
      }),
      expectedStatus: 201
    });
    const knowledgeBase = created.knowledgeBase ?? created;
    knowledgeBaseId = knowledgeBase.knowledgeBaseId;
    assert(knowledgeBaseId, `${family} knowledge base identity is missing.`);
    report.knowledgeBases[family] = {
      id: knowledgeBaseId,
      resourceRevision: knowledgeBase.resourceRevision,
      createdElapsedMs: Date.now() - createdAt,
      initialSourceCount: null,
      initialTreeCount: null,
      initialSearchCount: null,
      uploadSessionId: null,
      uploadElapsedMs: null,
      visibleElapsedMs: null,
      finalSourceCount: null
    };

    const initialSources = await developer.json(
      `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`
        + "/source-files?limit=200"
    );
    const initialTree = await admin.json(
      `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`
        + "/files/tree?parentPath=&limit=200"
    );
    const initialSearch = await developer.json(
      `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`
        + "/files/search?"
        + new URLSearchParams({ query: "empty validation", mode: "hybrid", limit: "10", rerank: "false" })
    );
    report.knowledgeBases[family].initialSourceCount = initialSources.items?.length ?? 0;
    report.knowledgeBases[family].initialTreeCount = initialTree.items?.length ?? 0;
    report.knowledgeBases[family].initialSearchCount = initialSearch.items?.length ?? 0;
    assert(
      report.knowledgeBases[family].initialSourceCount === 0
        && report.knowledgeBases[family].initialTreeCount === 0
        && report.knowledgeBases[family].initialSearchCount === 0,
      `${family} knowledge base did not start empty.`
    );
    pass(`${family}-empty-state`, { source: 0, tree: 0, search: 0 });

    const uploaded = await uploadMarkdownFilesWithSession({
    request: (pathname, options) => developer.json(pathname, {
      method: options.method,
      query: options.query,
      headers: {
        ...(options.headers ?? {}),
        ...(options.body ? { "content-type": "application/json" } : {})
      },
      body: options.rawBody ?? (options.body ? JSON.stringify(options.body) : undefined),
      expectedStatus: options.status
    }),
    routeBase: `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/upload-sessions`,
    files: familySamples,
    idempotencyKey: `${runId}-${family}`,
    finalizationPollIntervalMs: 250,
    finalizationTimeoutMs: 30 * 60_000,
    onFileTransfer(event) {
      const alias = aliasByPath.get(event.relativePath);
      assert(alias, "Upload transfer returned an unknown corpus path.");
      report.files[alias].transfer = {
        status: event.status,
        attempts: event.attempts,
        startedElapsedMs: event.startedAt - uploadStartedAt,
        finishedElapsedMs: event.finishedAt - uploadStartedAt,
        elapsedMs: event.elapsedMs
      };
    }
    });
    const uploadFinishedAt = Date.now();
    report.knowledgeBases[family].uploadSessionId = uploaded.session.id;
    report.knowledgeBases[family].uploadElapsedMs = uploadFinishedAt - uploadStartedAt;
    assert(uploaded.files.length === familySamples.length, `${family} upload source IDs are incomplete.`);
    assert(uploaded.entries.length === familySamples.length, `${family} upload entries are incomplete.`);

    const sampleByPath = new Map(familySamples.map((sample) => [sample.relativePath, sample]));
    for (const entry of uploaded.entries) {
      const sample = sampleByPath.get(entry.relativePath);
      assert(sample, "Upload entry returned an unknown corpus path.");
      assert(entry.declaredSize === sample.bytes.byteLength, `Upload size changed for ${sample.alias}.`);
      assert(entry.receivedSize === sample.bytes.byteLength, `Received size changed for ${sample.alias}.`);
      assert(["uploaded", "skipped"].includes(entry.transferState),
        `Upload transfer is incomplete for ${sample.alias}.`);
      assert(["upload_required", "skipped_existing"].includes(entry.disposition),
        `Upload disposition is invalid for ${sample.alias}.`);
    }
    for (const file of uploaded.files) {
      const alias = aliasByPath.get(file.relativePath);
      assert(alias, "Upload source returned an unknown corpus path.");
      report.files[alias].sourceFileId = file.sourceFileId;
    }
    pass(`${family}-upload-session`, {
      fileCount: uploaded.files.length,
      elapsedMs: uploadFinishedAt - uploadStartedAt,
      contentUploadConcurrency: uploaded.transport.contentUploadConcurrency
    });
  } else {
    pass(`${family}-compatible-resume`, { fileCount: reusable.rows.length });
  }

  const finalRows = await waitForVisible({
    family,
    knowledgeBaseId,
    expectedCount: familySamples.length,
    startedAt: uploadStartedAt
  });
  report.knowledgeBases[family].visibleElapsedMs = Date.now() - uploadStartedAt;
  report.knowledgeBases[family].finalSourceCount = finalRows.length;
  pass(`${family}-all-visible`, {
    fileCount: finalRows.length,
    elapsedMs: report.knowledgeBases[family].visibleElapsedMs
  });

  const sourceByPath = new Map((await listAllDeveloperSources(knowledgeBaseId))
    .map((file) => [file.relativePath, file]));
  const sourceContentById = new Map();
  const generatedContentByPath = new Map();
  const baseline = await inspectOkfV02CorpusBaseline({
    samples: familySamples,
    sourceFiles: [...sourceByPath.values()],
    readSourceContent: async (file) => {
      const content = await developer.text(
        `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`
          + `/source-files/${encodeURIComponent(file.sourceFileId)}/content`
      );
      sourceContentById.set(file.sourceFileId, content);
      return content;
    },
    readGeneratedContent: async (generatedPath) => {
      const response = await developer.json(
        `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`
          + `/files/content?path=${encodeURIComponent(generatedPath)}`
      );
      const content = response.content;
      assert(typeof content === "string", "Generated content response is incomplete.");
      generatedContentByPath.set(generatedPath, content);
      return content;
    },
    readRootContent: async () => {
      const response = await developer.json(
        `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`
          + "/files/content?path=index.md"
      );
      assert(typeof response.content === "string", "Root content response is incomplete.");
      return response.content;
    },
    normalizeSourceMetadata: (metadata, body) => analyzeOkfMetadata(metadata, {
      ownership: "source",
      markdownBody: body
    }).metadata
  });
  report.baselines[family] = baseline;

  for (const sample of familySamples) {
    const source = sourceByPath.get(sample.relativePath);
    const body = sourceContentById.get(source.sourceFileId);
    const alias = sample.alias;
    report.files[alias].sourceChecksumVerified = sha256(body) === sample.checksumSha256;
    report.files[alias].generatedContentVerified = Boolean(
      source.generatedPath && generatedContentByPath.has(source.generatedPath)
    );
    assert(report.files[alias].sourceChecksumVerified, `Source checksum changed for ${alias}.`);
    assert(report.files[alias].generatedContentVerified, `Generated content is missing for ${alias}.`);
  }
  pass(`${family}-content-and-metadata`, {
    compared: baseline.totalCompared,
    officialCompared: baseline.officialCompared,
    legacyCompared: baseline.legacyCompared
  });
}

async function waitForVisible(input) {
  const deadline = Date.now() + 45 * 60_000;
  const expectedAliases = samples.filter((sample) => sample.family === input.family)
    .map((sample) => sample.alias);
  while (Date.now() < deadline) {
    const rows = await listAllAdminSources(input.knowledgeBaseId);
    for (const row of rows) {
      const alias = aliasByPath.get(row.relativePath);
      if (!alias) continue;
      const item = report.files[alias];
      item.firstSeenElapsedMs ??= Date.now() - input.startedAt;
      item.finalState = row.state;
      item.finalStage = row.currentStage;
      item.modelInvocationStatus = row.modelInvocationStatus;
      item.modelNameRecorded = row.modelInvocationStatus === "completed"
        ? typeof row.modelInvocationModelName === "string" && row.modelInvocationModelName.length > 0
        : row.modelInvocationStatus === "skipped";
      item.generatedOutputStatus = row.generatedOutputStatus;
      item.generatedFileAvailable = row.generatedFileAvailable === true;
      item.retryCount = row.retryCount;
      if (row.state === "visible") item.visibleElapsedMs ??= Date.now() - input.startedAt;
    }
    const failed = expectedAliases.filter((alias) => report.files[alias].finalState === "failed");
    if (failed.length > 0) {
      throw new Error(`${input.family} source processing failed for aliases: ${failed.join(",")}`);
    }
    if (
      rows.length === input.expectedCount
      && expectedAliases.every((alias) => {
        const file = report.files[alias];
        return file.finalState === "visible"
          && ["completed", "skipped"].includes(file.modelInvocationStatus)
          && file.modelNameRecorded
          && file.generatedOutputStatus === "visible"
          && file.generatedFileAvailable;
      })
    ) return rows;
    if (Date.now() % 10_000 < 1_000) persistReport();
    await sleep(1_000);
  }
  const pending = expectedAliases.filter((alias) => report.files[alias].finalState !== "visible");
  throw new Error(`${input.family} source processing timed out for aliases: ${pending.join(",")}`);
}

async function listAllAdminSources(knowledgeBaseId) {
  const items = [];
  let cursor = null;
  do {
    const query = new URLSearchParams({ limit: "200" });
    if (cursor) query.set("cursor", cursor);
    const page = await admin.json(
      `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-files?${query}`
    );
    items.push(...(page.items ?? []));
    cursor = page.nextCursor ?? null;
  } while (cursor);
  return items;
}

async function listAllDeveloperSources(knowledgeBaseId) {
  const items = [];
  let cursor = null;
  do {
    const query = new URLSearchParams({ limit: "200" });
    if (cursor) query.set("cursor", cursor);
    const page = await developer.json(
      `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-files?${query}`
    );
    items.push(...(page.items ?? []));
    cursor = page.nextCursor ?? null;
  } while (cursor);
  return items;
}

async function readReusableFamily(family, familySamples) {
  const existing = report.knowledgeBases[family];
  if (!existing?.id) return null;
  try {
    const rows = await listAllDeveloperSources(existing.id);
    const expectedIds = new Set(familySamples.map((sample) =>
      report.files[sample.alias].sourceFileId).filter(Boolean));
    if (
      rows.length !== familySamples.length
      || expectedIds.size !== familySamples.length
      || rows.some((row) => !expectedIds.has(row.sourceFileId))
    ) {
      throw new Error(`${family} prior run is incompatible with safe resume.`);
    }
    return { knowledgeBaseId: existing.id, rows };
  } catch (error) {
    if (String(error instanceof Error ? error.message : error).includes("HTTP 404")) return null;
    throw error;
  }
}

function loadSamples(input) {
  assert(input.manifest?.counts?.official === 53, "Official manifest count is invalid.");
  assert(input.manifest?.counts?.legacy === 147, "Legacy manifest count is invalid.");
  const manifestByPathHash = new Map(input.manifest.rows.map((row) => [row.pathHash, row]));
  return input.privateWorkspace.files.map((file) => {
    const separator = file.path.indexOf("/");
    const family = file.path.slice(0, separator);
    const familyPath = file.path.slice(separator + 1);
    const manifestRow = manifestByPathHash.get(sha256(familyPath.normalize("NFC")));
    assert(manifestRow?.family === family, "Private corpus row does not match its sanitized manifest.");
    const bytes = fs.readFileSync(file.stagedPath);
    assert(sha256(bytes) === manifestRow.checksumSha256, `Staged checksum changed for ${manifestRow.alias}.`);
    return {
      alias: manifestRow.alias,
      family,
      relativePath: file.path,
      stagedPath: file.stagedPath,
      checksumSha256: manifestRow.checksumSha256,
      bytes
    };
  }).sort((left, right) => left.alias.localeCompare(right.alias));
}

function assertCorpusInputs() {
  assert(samples.length === 200, "Comprehensive corpus must contain exactly 200 files.");
  assert(samples.filter((sample) => sample.family === "official").length === 53,
    "Official corpus must contain exactly 53 files.");
  assert(samples.filter((sample) => sample.family === "legacy").length === 147,
    "Legacy corpus must contain exactly 147 files.");
  assert(new Set(samples.map((sample) => sample.alias)).size === 200,
    "Corpus aliases must be unique.");
}

function verifyOriginalChecksums() {
  for (const sample of samples) {
    assert(sha256(fs.readFileSync(sample.stagedPath)) === sample.checksumSha256,
      `Original checksum changed for ${sample.alias}.`);
  }
}

async function login() {
  const username = requiredEnv("ADMIN_USERNAME");
  const password = requiredEnv("ADMIN_PASSWORD");
  await admin.json("/admin/api/login", {
    method: "POST",
    headers: { origin },
    json: { username, password }
  });
}

async function cleanupRequest(pathname, options) {
  try {
    await admin.json(pathname, options);
    return true;
  } catch {
    return false;
  }
}

function pass(id, details = {}) {
  const existing = report.checks.find((check) => check.id === id);
  if (existing) Object.assign(existing, { ok: true, details });
  else report.checks.push({ id, ok: true, details });
}

function persistReport() {
  fs.mkdirSync(reportDirectory, { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sanitizeMessage(message) {
  let safe = String(message);
  for (const [relativePath, alias] of aliasByPath) safe = safe.replaceAll(relativePath, alias);
  for (const sample of samples) safe = safe.replaceAll(sample.stagedPath, `<${sample.alias}>`);
  return safe;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function requireReportDirectory() {
  const value = process.env.FOCOWIKI_COMPREHENSIVE_REPORT_DIR;
  if (
    !value
    || !/^ReferenceDocs\/validation\/comprehensive-large-scale-release\/validation-\d{14}-[a-f0-9]{8}$/u.test(value)
  ) throw new Error("FOCOWIKI_COMPREHENSIVE_REPORT_DIR must be an exact ignored run-owned directory.");
  return path.resolve(value);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

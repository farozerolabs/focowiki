import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";
import {
  createLifecycleHttpClient,
  createUploadSessionPhaseClient
} from "./lib/interleaved-lifecycle-api.mjs";

loadLocalEnv();

const adminBaseUrl = `http://127.0.0.1:${process.env.ADMIN_API_PORT || "43000"}`;
const developerBaseUrl = `http://127.0.0.1:${process.env.PUBLIC_OPENAPI_PORT || "43200"}`;
const origin = process.env.ADMIN_PUBLIC_ORIGIN || "http://127.0.0.1:43100";
const reportPath = path.resolve(
  process.env.FOCOWIKI_COMPREHENSIVE_MODEL_PROBE_REPORT
    || "ReferenceDocs/validation/comprehensive-large-scale-release/live-model-probe.json"
);
const runId = `comprehensive-model-probe-${crypto.randomUUID()}`;
const body = createSelectedProbeBody();

const admin = createLifecycleHttpClient({ baseUrl: adminBaseUrl });
let developer = null;
let knowledgeBaseId = null;
let keyId = null;
let originalPublication = null;
const report = {
  kind: "focowiki-comprehensive-live-model-probe",
  version: 1,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  ok: false,
  checks: [],
  cleanup: { knowledgeBaseDeleted: true, keyDeleted: true, settingsRestored: true }
};

try {
  await login();
  const runtime = await admin.json("/admin/api/settings/runtime");
  const embeddings = await admin.json("/admin/api/settings/embeddings");
  const rerankers = await admin.json("/admin/api/settings/rerankers");
  assertPublicModelState(runtime, embeddings, rerankers);
  check("model-public-redaction", true);
  check("generation-active", runtime.models.filter((item) => item.isActive).length === 1);
  check("embedding-active-valid", embeddings.configurations.some((item) =>
    item.lifecycleStatus === "active"
      && item.validationStatus === "valid"
      && Number.isInteger(item.resolvedDimension)
      && item.resolvedDimension > 0
  ));
  check("reranker-active-valid", rerankers.configurations.some((item) =>
    item.lifecycleStatus === "active" && item.validationStatus === "valid"
  ));

  originalPublication = runtime.settings.publication;
  report.cleanup.settingsRestored = false;
  const updatedPublication = await admin.json("/admin/api/settings/publication", {
    method: "PUT",
    headers: { origin },
    json: { ...originalPublication, mode: "batch", intervalSeconds: 10 }
  });
  check(
    "publication-fast-probe",
    updatedPublication.settings.publication.mode === "batch"
      && updatedPublication.settings.publication.intervalSeconds === 10
  );

  const createdKnowledgeBase = await admin.json("/admin/api/knowledge-bases", {
    method: "POST",
    headers: { origin },
    json: {
      name: "Bounded model validation",
      description: "Synthetic general-purpose validation resource"
    },
    expectedStatus: 201
  });
  knowledgeBaseId = createdKnowledgeBase.knowledgeBase?.id;
  report.cleanup.knowledgeBaseDeleted = false;
  assert(knowledgeBaseId, "Knowledge-base creation returned no ID.");

  const createdKey = await admin.json("/admin/api/openapi-keys", {
    method: "POST",
    headers: { origin },
    json: { name: "Bounded model validation" },
    expectedStatus: 201
  });
  keyId = createdKey.key?.id;
  report.cleanup.keyDeleted = false;
  const rawKey = createdKey.oneTimeKey?.rawKey;
  assert(keyId && rawKey, "OpenAPI key creation returned an incomplete result.");
  developer = createLifecycleHttpClient({
    baseUrl: developerBaseUrl,
    authorization: `Bearer ${rawKey}`
  });

  const upload = createUploadSessionPhaseClient({
    client: developer,
    knowledgeBaseId,
    idempotencyPrefix: runId
  });
  const createdUpload = await upload.create([{ relativePath: "probe/model-validation.md", bytes: body }]);
  const sessionId = createdUpload.session?.id;
  assert(sessionId, "Upload session creation returned no ID.");
  await upload.appendManifest(sessionId);
  await upload.seal(sessionId);
  const reconciled = await upload.reconcile(sessionId);
  await upload.uploadMissingContent(sessionId, reconciled.entries?.items);
  await upload.finalize(sessionId);
  await waitForUpload(upload, sessionId);
  check("upload-completed", true);

  const sourceFile = await waitForVisibleSource();
  const adminSourceFile = await waitForAdminSource(sourceFile.sourceFileId);
  check("generation-real-invocation", adminSourceFile.modelInvocationStatus === "completed");
  check(
    "generation-model-recorded",
    typeof adminSourceFile.modelInvocationModelName === "string"
      && adminSourceFile.modelInvocationModelName.length > 0
  );
  check("generated-file-visible", adminSourceFile.generatedFileAvailable === true);

  const sourceBody = await developer.text(
    `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`
      + `/source-files/${encodeURIComponent(sourceFile.sourceFileId)}/content`
  );
  check("source-body-preserved", Buffer.from(sourceBody).equals(body));

  const search = await developer.json(
    `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`
      + "/files/search?"
      + new URLSearchParams({
        query: "Which signal is recorded before the morning review?",
        mode: "hybrid",
        limit: "10",
        rerank: "true",
        rerankTopK: "10"
      })
  );
  check("embedding-query-ready", search.semanticStatus?.state === "ready");
  check("hybrid-source-result", search.items?.some((item) =>
    item.sourceFileId === sourceFile.sourceFileId && item.contentAvailable === true
  ));
  check(
    "reranker-real-invocation",
    search.rerankerStatus?.state === "applied"
      || search.rerankerStatus?.state === "skipped"
        && search.rerankerStatus.safeCode === "RERANKER_NO_CANDIDATES"
  );
  check("search-does-not-answer", !("answer" in search) && !("generatedAnswer" in search));

  report.ok = report.checks.every((item) => item.ok);
} finally {
  if (keyId) {
    report.cleanup.keyDeleted = await cleanupRequest(
      `/admin/api/openapi-keys/${encodeURIComponent(keyId)}`,
      { method: "DELETE", headers: { origin } }
    );
  }
  if (knowledgeBaseId) {
    report.cleanup.knowledgeBaseDeleted = await cleanupRequest(
      `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`,
      { method: "DELETE", headers: { origin } }
    );
  }
  if (originalPublication) {
    report.cleanup.settingsRestored = await cleanupRequest(
      "/admin/api/settings/publication",
      { method: "PUT", headers: { origin }, json: originalPublication }
    );
  }
  await admin.request("/admin/api/logout", { method: "POST", headers: { origin } })
    .catch(() => undefined);
  report.finishedAt = new Date().toISOString();
  report.ok = report.ok && Object.values(report.cleanup).every(Boolean);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    checkCount: report.checks.length,
    cleanup: report.cleanup,
    reportPath
  })}\n`);
}

async function login() {
  await admin.json("/admin/api/login", {
    method: "POST",
    headers: { origin },
    json: {
      username: requiredEnv("ADMIN_USERNAME"),
      password: requiredEnv("ADMIN_PASSWORD")
    }
  });
}

async function waitForUpload(upload, sessionId) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const current = await upload.get(sessionId, { limit: 10 });
    if (current.session?.state === "completed") return;
    if (["cancelled", "expired", "failed"].includes(current.session?.state)) {
      throw new Error(`Upload session reached ${current.session.state}.`);
    }
    await sleep(250);
  }
  throw new Error("Upload session did not complete.");
}

async function waitForVisibleSource() {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const page = await developer.json(
      `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-files?limit=10`
    );
    const sourceFile = page.items?.[0];
    if (sourceFile?.state === "failed") {
      throw new Error(`Synthetic source processing failed: ${sourceFile.failure?.code || "unknown"}.`);
    }
    if (sourceFile?.state === "visible") return sourceFile;
    await sleep(1_000);
  }
  throw new Error("Synthetic source did not become visible.");
}

async function waitForAdminSource(sourceFileId) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const page = await admin.json(
      `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-files?limit=10`
    );
    const sourceFile = page.items?.find((item) => item.id === sourceFileId);
    if (sourceFile?.state === "visible") return sourceFile;
    await sleep(250);
  }
  throw new Error("Admin source-file state did not converge with the Developer OpenAPI result.");
}

function assertPublicModelState(runtime, embeddings, rerankers) {
  const serialized = JSON.stringify({ runtime, embeddings, rerankers });
  assert(!serialized.includes('"apiKey":'), "Admin model response exposed an API-key field.");
  assert(!serialized.includes('"encryptedApiKey":'), "Admin model response exposed an encrypted API-key field.");
  assert(runtime.models.every((item) => item.apiKeyFingerprint && !item.apiKey),
    "Generation model response was not safely serialized.");
  assert(embeddings.configurations.every((item) => item.apiKeyConfigured === true),
    "Embedding configuration did not report credential presence safely.");
  assert(rerankers.configurations.every((item) => item.apiKeyConfigured === true),
    "Reranker configuration did not report credential presence safely.");
}

async function cleanupRequest(pathname, options) {
  try {
    await admin.json(pathname, options);
    return true;
  } catch {
    return false;
  }
}

function check(id, ok) {
  report.checks.push({ id, ok: Boolean(ok) });
  assert(ok, `Live model probe failed: ${id}.`);
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function createSelectedProbeBody() {
  for (let nonce = 0; nonce < 100_000; nonce += 1) {
    const markdown = [
      "---",
      "title: Bounded model validation note",
      "description: Synthetic general-purpose content for validating the configured model pipeline.",
      "---",
      "",
      "# Bounded model validation note",
      "",
      "A calibrated observatory records amber signals before the morning review.",
      "The review links the observatory signal to the reusable validation checklist.",
      `Stable validation marker: ${nonce}.`,
      ""
    ].join("\n");
    const bucket = Number.parseInt(
      crypto.createHash("sha256").update(markdown).digest("hex").slice(0, 8),
      16
    ) % 10_000;
    if (bucket < 500) return Buffer.from(markdown);
  }
  throw new Error("Unable to build a deterministic selected semantic-skeleton probe.");
}

function loadLocalEnv() {
  const envPath = path.resolve(".env");
  if (fs.existsSync(envPath)) loadEnvFile(envPath);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

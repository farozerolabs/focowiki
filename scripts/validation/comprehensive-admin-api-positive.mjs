import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { buildAdminApiInventory } from "./lib/comprehensive-code-inventory.mjs";
import {
  createAdminValidationRuntimePolicy
} from "./lib/comprehensive-admin-validation-runtime-policy.mjs";
import {
  requestWithRateLimitRetry
} from "./lib/comprehensive-rate-limit-retry.mjs";
import {
  waitForResourceRevision
} from "./lib/comprehensive-resource-revision-wait.mjs";

loadLocalEnv();

const repositoryRoot = process.cwd();
const baseUrl = `http://127.0.0.1:${process.env.ADMIN_API_PORT || "43000"}`;
const origin = process.env.ADMIN_PUBLIC_ORIGIN || "http://127.0.0.1:43100";
const reportPath = path.resolve(
  process.env.FOCOWIKI_COMPREHENSIVE_ADMIN_POSITIVE_REPORT
    || "ReferenceDocs/validation/comprehensive-large-scale-release/admin-api-positive.json"
);
const runId = `clr-admin-${randomUUID().slice(0, 8)}`;
const routeInventory = buildAdminApiInventory(repositoryRoot)
  .filter((item) => item.kind === "route")
  .sort((left, right) => routeId(left.method, left.path).localeCompare(routeId(right.method, right.path)));
const report = {
  kind: "focowiki-comprehensive-admin-api-positive",
  version: 1,
  runId,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  ok: false,
  routeCount: routeInventory.length,
  rows: [],
  pendingPositive: [],
  cleanup: {
    keyDeleted: false,
    knowledgeBaseDeleted: false,
    generationModelDeleted: false,
    embeddingConfigurationDeleted: false,
    rerankerConfigurationDeleted: false,
    generationModelRestored: false,
    embeddingConfigurationRestored: false,
    rerankerConfigurationRestored: false,
    publicationSettingsRestored: false,
    workerSettingsRestored: false,
    loggedOut: false
  }
};

let cookie = "";
let knowledgeBaseId = "";
let openApiKeyId = "";
let generationModelId = "";
let embeddingConfigurationId = "";
let rerankerConfigurationId = "";
let originalActiveGenerationModelId = "";
let originalEmbeddingConfigurationId = "";
let originalRerankerConfigurationId = "";
let originalPublicationSettings = null;
let originalWorkerSettings = null;
let uploadInvocation = 0;

try {
  await login();
  await call("GET", "/admin/api/session", "/admin/api/session");

  const runtime = await call(
    "GET", "/admin/api/settings/runtime", "/admin/api/settings/runtime"
  );
  const runtimePolicy = createAdminValidationRuntimePolicy(runtime.body.settings);
  originalPublicationSettings = runtimePolicy.original.publication;
  originalWorkerSettings = runtimePolicy.original.worker;
  originalActiveGenerationModelId = runtime.body.models?.find((model) => model.isActive)?.id ?? "";
  for (const [section, suffix] of Object.entries({
    rateLimits: "rate-limits",
    worker: "worker",
    publication: "publication",
    graph: "graph",
    maintenance: "maintenance",
    search: "search",
    semantic: "semantic"
  })) {
    await call(
      "PUT",
      `/admin/api/settings/${suffix}`,
      `/admin/api/settings/${suffix}`,
      { json: runtime.body.settings[section] }
    );
  }
  await call(
    "PUT", "/admin/api/settings/publication", "/admin/api/settings/publication",
    { json: runtimePolicy.validation.publication, caseName: "validation-policy" }
  );
  await call(
    "PUT", "/admin/api/settings/worker", "/admin/api/settings/worker",
    { json: runtimePolicy.validation.worker, caseName: "validation-policy" }
  );
  await exerciseGenerationModel();
  await exerciseEmbeddingConfigurations();
  await exerciseRerankerConfigurations();

  const createdKey = await call(
    "POST", "/admin/api/openapi-keys", "/admin/api/openapi-keys",
    { json: { name: `${runId}-key` }, expectedStatus: 201 }
  );
  openApiKeyId = createdKey.body.key?.id ?? "";
  assert(openApiKeyId, "OpenAPI key creation returned no ID.");
  await call("GET", "/admin/api/openapi-keys", "/admin/api/openapi-keys?limit=20");

  const createdKnowledgeBase = await call(
    "POST", "/admin/api/knowledge-bases", "/admin/api/knowledge-bases",
    {
      json: { name: `${runId} positive lifecycle`, description: "Run-owned Admin API validation" },
      expectedStatus: 201
    }
  );
  knowledgeBaseId = createdKnowledgeBase.body.knowledgeBase?.id ?? "";
  let knowledgeBaseRevision = createdKnowledgeBase.body.knowledgeBase?.resourceRevision;
  assert(knowledgeBaseId && Number.isInteger(knowledgeBaseRevision), "Knowledge base identity is incomplete.");
  await call("GET", "/admin/api/knowledge-bases", `/admin/api/knowledge-bases?query=${runId}&limit=20`);
  await call(
    "GET", "/admin/api/knowledge-bases/:knowledgeBaseId",
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`
  );
  const updatedKnowledgeBase = await call(
    "PATCH", "/admin/api/knowledge-bases/:knowledgeBaseId",
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`,
    {
      headers: { "if-match": String(knowledgeBaseRevision) },
      json: { description: "Updated run-owned Admin API validation" }
    }
  );
  knowledgeBaseRevision = updatedKnowledgeBase.body.knowledgeBase?.resourceRevision;
  await waitForResourceRevision({
    expectedRevision: knowledgeBaseRevision,
    read: async () => {
      const current = await call(
        "GET", "/admin/api/knowledge-bases/:knowledgeBaseId",
        `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`,
        { caseName: "metadata-publication-poll" }
      );
      return current.body.knowledgeBase;
    }
  });

  const uploaded = await uploadFiles([
    {
      relativePath: "alpha/first.md",
      bytes: Buffer.from("---\ntitle: Admin positive first\ntype: reference\n---\n\n# Admin positive first\n\nThe first run-owned document links to [second](../beta/second.md).\n")
    },
    {
      relativePath: "beta/second.md",
      bytes: Buffer.from("---\ntitle: Admin positive second\ntype: guide\n---\n\n# Admin positive second\n\nThe second run-owned document describes a general workflow.\n")
    },
    {
      relativePath: "gamma/third.md",
      bytes: Buffer.from("---\ntitle: Admin positive third\ntype: note\n---\n\n# Admin positive third\n\nThe third run-owned document is the recursive directory deletion fixture.\n")
    }
  ]);
  const visibleFiles = await waitForVisibleFiles(uploaded.sourceFileIds);
  assert(visibleFiles.length === 3, "Uploaded source files did not become visible.");
  await exerciseSourceRetry();

  await call(
    "GET", "/admin/api/knowledge-bases/:knowledgeBaseId/processing-summary",
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/processing-summary`
  );
  await call(
    "GET", "/admin/api/knowledge-bases/:knowledgeBaseId/public-urls",
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/public-urls`
  );
  await call(
    "GET", "/admin/api/knowledge-bases/:knowledgeBaseId/files/tree",
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/files/tree?limit=100`
  );
  await call(
    "GET", "/admin/api/knowledge-bases/:knowledgeBaseId/files/tree/search",
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/files/tree/search?query=first&limit=20`
  );

  let first = visibleFiles.find((file) => file.relativePath.includes("first.md"));
  let second = visibleFiles.find((file) => file.relativePath.includes("second.md"));
  const third = visibleFiles.find((file) => file.relativePath.includes("third.md"));
  assert(first && second && third, "Uploaded source-file identities are incomplete.");
  await call(
    "GET", "/admin/api/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId",
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-files/${encodeURIComponent(first.id)}?limit=100`
  );
  await call(
    "GET", "/admin/api/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId/content",
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-files/${encodeURIComponent(first.id)}/content`
  );
  await call(
    "GET", "/admin/api/knowledge-bases/:knowledgeBaseId/files/detail",
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/files/detail?path=${encodeURIComponent(first.generatedFilePath)}`
  );

  const directories = await call(
    "GET", "/admin/api/knowledge-bases/:knowledgeBaseId/source-directories",
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-directories?limit=100`
  );
  let alpha = directories.body.items?.find((directory) => directory.relativePath === "alpha");
  assert(alpha?.directoryId, "Run-owned alpha directory is missing.");
  await call(
    "GET", "/admin/api/knowledge-bases/:knowledgeBaseId/source-directories/:directoryId",
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-directories/${encodeURIComponent(alpha.directoryId)}`
  );
  const directoryMove = await call(
    "PATCH", "/admin/api/knowledge-bases/:knowledgeBaseId/source-directories/:directoryId",
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-directories/${encodeURIComponent(alpha.directoryId)}`,
    {
      headers: {
        "if-match": String(alpha.resourceRevision),
        "idempotency-key": `${runId}-directory-move`
      },
      json: { relativePath: "renamed-alpha" },
      expectedStatus: 202
    }
  );
  await waitForOperation(directoryMove.body.operation?.operationId);
  first = await findSourceFile(first.id);

  const fileMove = await call(
    "PATCH", "/admin/api/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId",
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-files/${encodeURIComponent(first.id)}`,
    {
      headers: {
        "if-match": String(first.resourceRevision),
        "idempotency-key": `${runId}-file-move`
      },
      json: { relativePath: "renamed-alpha/first-renamed.md" },
      expectedStatus: 202
    }
  );
  await waitForOperation(fileMove.body.operation?.operationId);
  first = await waitForVisibleSource(first.id);

  const replacementBody = "---\ntitle: Admin positive first revised\ntype: reference\n---\n\n# Admin positive first revised\n\nA complete replacement body.\n";
  const replacement = await call(
    "PUT", "/admin/api/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId/content",
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-files/${encodeURIComponent(first.id)}/content`,
    {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "if-match": String(first.resourceRevision),
        "idempotency-key": `${runId}-replace`
      },
      rawBody: replacementBody,
      expectedStatus: 202
    }
  );
  await waitForOperation(replacement.body.operation?.operationId);
  first = await waitForVisibleSource(first.id);
  await call(
    "GET", "/admin/api/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId/content",
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-files/${encodeURIComponent(first.id)}/content`
  );

  await call(
    "POST", "/admin/api/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId/retry",
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-files/${encodeURIComponent(first.id)}/retry`,
    { expectedStatus: 409, positive: false, caseName: "visible-source-retry-not-applicable" }
  );
  await call(
    "POST", "/admin/api/knowledge-bases/:knowledgeBaseId/source-files/task-deletions",
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-files/task-deletions`,
    { json: { sourceFileIds: [first.id] } }
  );

  const completedOperations = await call(
    "GET", "/admin/api/knowledge-bases/:knowledgeBaseId/operations",
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/operations?state=completed&limit=100`
  );
  const operationId = completedOperations.body.items?.[0]?.operationId;
  assert(operationId, "Completed resource operation is missing.");
  await call(
    "GET", "/admin/api/knowledge-bases/:knowledgeBaseId/operations/:operationId",
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/operations/${encodeURIComponent(operationId)}`
  );

  const maintenance = await call(
    "POST", "/admin/api/knowledge-bases/:knowledgeBaseId/index-maintenance",
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/index-maintenance`,
    {
      headers: { "idempotency-key": `${runId}-maintenance` },
      json: {},
      expectedStatus: 202
    }
  );
  assert(maintenance.body.maintenance?.requestId, "Maintenance request returned no ID.");
  await call(
    "POST", "/admin/api/knowledge-bases/:knowledgeBaseId/index-maintenance/cancel",
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/index-maintenance/cancel`,
    { json: {} }
  );

  const gammaDirectory = await findDirectoryByPath("gamma");
  assert(gammaDirectory, "Gamma deletion fixture directory is missing.");
  const directoryDeletion = await call(
    "DELETE", "/admin/api/knowledge-bases/:knowledgeBaseId/source-directories/:directoryId",
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-directories/${encodeURIComponent(gammaDirectory.directoryId)}`,
    {
      headers: { "idempotency-key": `${runId}-directory-delete` },
      json: { expectedResourceRevision: gammaDirectory.resourceRevision },
      expectedStatus: 202
    }
  );
  await waitForOperation(directoryDeletion.body.operationId);
  await waitForSourceMissing(third.id);

  const fileDeletion = await call(
    "DELETE", "/admin/api/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId",
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-files/${encodeURIComponent(first.id)}`,
    {
      headers: {
        "if-match": String(first.resourceRevision),
        "idempotency-key": `${runId}-file-delete`
      },
      expectedStatus: 202
    }
  );
  await waitForOperation(fileDeletion.body.operation?.operationId);
  await waitForSourceMissing(first.id);

  await call(
    "DELETE", "/admin/api/knowledge-bases/:knowledgeBaseId/files/detail",
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/files/detail?path=${encodeURIComponent(second.generatedFilePath)}`
  );
  await waitForSourceMissing(second.id);

  await restoreValidationRuntimePolicy();
  await deleteOpenApiKey();
  await deleteKnowledgeBase();
  const logout = await call(
    "POST", "/admin/api/logout", "/admin/api/logout",
    { json: {} }
  );
  report.cleanup.loggedOut = logout.status === 200;
  cookie = "";

  const positiveRoutes = new Set(
    report.rows.filter((row) => row.positive).map((row) => row.routeId)
  );
  report.pendingPositive = routeInventory
    .map((route) => routeId(route.method, route.path))
    .filter((id) => !positiveRoutes.has(id));
  assert(
    report.pendingPositive.length === 0,
    `Unexpected Admin API positive-route gap: ${report.pendingPositive.join(",")}`
  );
  report.ok = true;
} finally {
  await restoreValidationRuntimePolicy().catch(() => undefined);
  await restoreGenerationModel().catch(() => undefined);
  await restoreEmbeddingConfiguration().catch(() => undefined);
  await restoreRerankerConfiguration().catch(() => undefined);
  await cleanupTemporaryModel().catch(() => undefined);
  await cleanupTemporaryEmbeddingConfiguration().catch(() => undefined);
  await cleanupTemporaryRerankerConfiguration().catch(() => undefined);
  await deleteOpenApiKey().catch(() => undefined);
  await deleteKnowledgeBase().catch(() => undefined);
  if (cookie) {
    const logout = await rawRequest("POST", "/admin/api/logout", {
      headers: { origin }, json: {}
    }).catch(() => null);
    report.cleanup.loggedOut = logout?.status === 200;
    cookie = "";
  }
  report.finishedAt = new Date().toISOString();
  report.ok = report.ok
    && report.cleanup.loggedOut
    && report.cleanup.keyDeleted
    && report.cleanup.knowledgeBaseDeleted
    && report.cleanup.generationModelDeleted
    && report.cleanup.embeddingConfigurationDeleted
    && report.cleanup.rerankerConfigurationDeleted
    && report.cleanup.generationModelRestored
    && report.cleanup.embeddingConfigurationRestored
    && report.cleanup.rerankerConfigurationRestored
    && report.cleanup.publicationSettingsRestored
    && report.cleanup.workerSettingsRestored;
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    routeCount: report.routeCount,
    positiveRouteCount: new Set(report.rows.filter((row) => row.positive).map((row) => row.routeId)).size,
    pendingPositive: report.pendingPositive,
    rowCount: report.rows.length,
    cleanup: report.cleanup,
    reportPath
  })}\n`);
}

async function restoreValidationRuntimePolicy() {
  if (!cookie || !originalPublicationSettings || !originalWorkerSettings) return;
  if (!report.cleanup.publicationSettingsRestored) {
    await call(
      "PUT", "/admin/api/settings/publication", "/admin/api/settings/publication",
      { json: originalPublicationSettings, caseName: "validation-policy-restore" }
    );
    report.cleanup.publicationSettingsRestored = true;
  }
  if (!report.cleanup.workerSettingsRestored) {
    await call(
      "PUT", "/admin/api/settings/worker", "/admin/api/settings/worker",
      { json: originalWorkerSettings, caseName: "validation-policy-restore" }
    );
    report.cleanup.workerSettingsRestored = true;
  }
  const runtime = await call(
    "GET", "/admin/api/settings/runtime", "/admin/api/settings/runtime",
    { caseName: "validation-policy-restore-verify" }
  );
  assert(
    JSON.stringify(runtime.body.settings?.publication) === JSON.stringify(originalPublicationSettings),
    "Admin validation publication settings were not restored exactly."
  );
  assert(
    JSON.stringify(runtime.body.settings?.worker) === JSON.stringify(originalWorkerSettings),
    "Admin validation worker settings were not restored exactly."
  );
}

async function exerciseGenerationModel() {
  const created = await call(
    "POST", "/admin/api/settings/models", "/admin/api/settings/models",
    {
      json: {
        displayName: `${runId} generation`,
        apiMode: "chat_completions",
        baseUrl: "http://127.0.0.1:9/v1",
        apiKey: `${runId}-generation-secret`,
        modelName: "run-owned-generation",
        contextWindowTokens: 8192,
        requestMaxTimeoutMs: 60000,
        requestIdleTimeoutMs: 30000,
        suggestionConcurrency: 1,
        transientRetryDelayMs: 1000,
        requestMinIntervalMs: 0,
        isActive: false
      },
      expectedStatus: 201
    }
  );
  generationModelId = created.body.model?.id ?? "";
  assert(generationModelId, "Generation model creation returned no ID.");
  await call(
    "PUT", "/admin/api/settings/models/:modelId",
    `/admin/api/settings/models/${encodeURIComponent(generationModelId)}`,
    {
      json: {
        displayName: `${runId} generation updated`,
        apiMode: "chat_completions",
        baseUrl: "http://127.0.0.1:9/v1",
        modelName: "run-owned-generation-updated",
        contextWindowTokens: 8192,
        requestMaxTimeoutMs: 60000,
        requestIdleTimeoutMs: 30000,
        suggestionConcurrency: 1,
        transientRetryDelayMs: 1000,
        requestMinIntervalMs: 0
      }
    }
  );
  await call(
    "POST", "/admin/api/settings/models/:modelId/pause",
    `/admin/api/settings/models/${encodeURIComponent(generationModelId)}/pause`
  );
  await call(
    "POST", "/admin/api/settings/models/:modelId/resume",
    `/admin/api/settings/models/${encodeURIComponent(generationModelId)}/resume`
  );
  await call(
    "POST", "/admin/api/settings/models/:modelId/activate",
    `/admin/api/settings/models/${encodeURIComponent(generationModelId)}/activate`
  );
  await restoreGenerationModel();
}

async function exerciseSourceRetry() {
  assert(generationModelId, "A temporary generation model is required for retry validation.");
  assert(originalActiveGenerationModelId, "An active generation model is required for retry validation.");
  await call(
    "POST", "/admin/api/settings/models/:modelId/pause",
    `/admin/api/settings/models/${encodeURIComponent(originalActiveGenerationModelId)}/pause`,
    { caseName: "controlled-failure-model-pause" }
  );
  const uploaded = await uploadFiles([{
    relativePath: "retry/recovered.md",
    bytes: Buffer.from(
      "---\ntitle: Admin retry recovery\ntype: note\n---\n\n# Admin retry recovery\n\nThis run-owned source validates terminal retry recovery.\n"
    )
  }]);
  const sourceFileId = uploaded.sourceFileIds[0];
  assert(sourceFileId, "Retry source upload returned no source ID.");
  await waitForFailedSource(sourceFileId);
  await restoreGenerationModel();
  await cleanupTemporaryModel({ recordPositive: true });
  await call(
    "POST",
    "/admin/api/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId/retry",
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-files/${encodeURIComponent(sourceFileId)}/retry`,
    { json: {}, expectedStatus: 202 }
  );
  await waitForVisibleSource(sourceFileId);
}

async function exerciseEmbeddingConfigurations() {
  const listed = await call(
    "GET", "/admin/api/settings/embeddings", "/admin/api/settings/embeddings"
  );
  const active = listed.body.configurations?.find((configuration) =>
    configuration.lifecycleStatus === "active");
  assert(active?.publicId, "An active embedding configuration is required.");
  originalEmbeddingConfigurationId = active.publicId;
  let current = (await call(
    "POST", "/admin/api/settings/embeddings/:configurationId/test",
    `/admin/api/settings/embeddings/${encodeURIComponent(active.publicId)}/test`,
    { timeoutMs: 120000 }
  )).body.configuration;
  await callAction("embeddings", active.publicId, "pause", current.revision, {
    expectedStatus: 400,
    positive: false,
    caseName: "pause-in-use-rejected"
  });
  current = (await callAction("embeddings", active.publicId, "activate", current.revision)).body.configuration;
  report.cleanup.embeddingConfigurationRestored = current.lifecycleStatus === "active";

  const draft = {
    displayName: `${runId} embedding`,
    authenticationMode: "none",
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: null,
    modelName: "run-owned-embedding",
    requestedDimension: null,
    normalization: "l2",
    maximumInputTokens: 8192,
    batchSize: 8,
    timeoutMs: 30000,
    retryCount: 0,
    minimumIntervalMs: 0,
    concurrency: 1,
    maximumResponseBytes: 8388608,
    minimumVectorRelevance: 0.7
  };
  const created = await call(
    "POST", "/admin/api/settings/embeddings", "/admin/api/settings/embeddings",
    { json: draft, expectedStatus: 201 }
  );
  embeddingConfigurationId = created.body.configuration?.publicId ?? "";
  let revision = created.body.configuration?.revision;
  assert(embeddingConfigurationId && Number.isInteger(revision), "Embedding configuration identity is incomplete.");
  const updated = await call(
    "PUT", "/admin/api/settings/embeddings/:configurationId",
    `/admin/api/settings/embeddings/${encodeURIComponent(embeddingConfigurationId)}`,
    { json: { expectedRevision: revision, configuration: { ...draft, displayName: `${runId} embedding updated` } } }
  );
  revision = updated.body.configuration?.revision;
  await call(
    "DELETE", "/admin/api/settings/embeddings/:configurationId",
    `/admin/api/settings/embeddings/${encodeURIComponent(embeddingConfigurationId)}`,
    { json: { expectedRevision: revision } }
  );
  embeddingConfigurationId = "";
  report.cleanup.embeddingConfigurationDeleted = true;
}

async function exerciseRerankerConfigurations() {
  const listed = await call(
    "GET", "/admin/api/settings/rerankers", "/admin/api/settings/rerankers"
  );
  const active = listed.body.configurations?.find((configuration) =>
    configuration.lifecycleStatus === "active");
  assert(active?.publicId, "An active reranker configuration is required.");
  originalRerankerConfigurationId = active.publicId;
  let current = (await call(
    "POST", "/admin/api/settings/rerankers/:configurationId/test",
    `/admin/api/settings/rerankers/${encodeURIComponent(active.publicId)}/test`,
    { timeoutMs: 120000 }
  )).body.configuration;
  const paused = await callAction("rerankers", active.publicId, "pause", current.revision, {
    expectedStatuses: [200, 400],
    caseName: "pause"
  });
  if (paused.status === 200) {
    current = paused.body.configuration;
    current = (await callAction(
      "rerankers", active.publicId, "resume", current.revision
    )).body.configuration;
  }
  current = (await callAction("rerankers", active.publicId, "activate", current.revision)).body.configuration;
  report.cleanup.rerankerConfigurationRestored = current.lifecycleStatus === "active";

  const draft = {
    displayName: `${runId} reranker`,
    authenticationMode: "none",
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: null,
    modelName: "run-owned-reranker",
    timeoutMs: 30000,
    retryCount: 0,
    minimumIntervalMs: 0,
    concurrency: 1
  };
  const created = await call(
    "POST", "/admin/api/settings/rerankers", "/admin/api/settings/rerankers",
    { json: draft, expectedStatus: 201 }
  );
  rerankerConfigurationId = created.body.configuration?.publicId ?? "";
  let revision = created.body.configuration?.revision;
  assert(rerankerConfigurationId && Number.isInteger(revision), "Reranker configuration identity is incomplete.");
  const updated = await call(
    "PUT", "/admin/api/settings/rerankers/:configurationId",
    `/admin/api/settings/rerankers/${encodeURIComponent(rerankerConfigurationId)}`,
    { json: { expectedRevision: revision, configuration: { ...draft, displayName: `${runId} reranker updated` } } }
  );
  revision = updated.body.configuration?.revision;
  await call(
    "DELETE", "/admin/api/settings/rerankers/:configurationId",
    `/admin/api/settings/rerankers/${encodeURIComponent(rerankerConfigurationId)}`,
    { json: { expectedRevision: revision } }
  );
  rerankerConfigurationId = "";
  report.cleanup.rerankerConfigurationDeleted = true;
}

async function callAction(kind, id, action, expectedRevision, options = {}) {
  return call(
    "POST", `/admin/api/settings/${kind}/:configurationId/:action`,
    `/admin/api/settings/${kind}/${encodeURIComponent(id)}/${action}`,
    { json: { expectedRevision }, caseName: options.caseName ?? action, ...options }
  );
}

async function uploadFiles(files) {
  uploadInvocation += 1;
  const routeBase = `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/upload-sessions`;
  const declaredByteCount = files.reduce((total, file) => total + file.bytes.byteLength, 0);
  const created = await call(
    "POST", "/admin/api/knowledge-bases/:knowledgeBaseId/upload-sessions", routeBase,
    {
      headers: { "idempotency-key": `${runId}-upload-${uploadInvocation}` },
      json: { declaredFileCount: files.length, declaredByteCount },
      expectedStatus: 201
    }
  );
  const sessionId = created.body.session?.id;
  assert(sessionId, "Upload session creation returned no ID.");
  await call(
    "POST", "/admin/api/knowledge-bases/:knowledgeBaseId/upload-sessions/:sessionId/entries",
    `${routeBase}/${encodeURIComponent(sessionId)}/entries`,
    {
      json: {
        entries: files.map((file) => ({
          relativePath: file.relativePath,
          declaredSize: file.bytes.byteLength,
          checksumSha256: createHash("sha256").update(file.bytes).digest("hex")
        }))
      }
    }
  );
  const sealed = await call(
    "POST", "/admin/api/knowledge-bases/:knowledgeBaseId/upload-sessions/:sessionId/seal",
    `${routeBase}/${encodeURIComponent(sessionId)}/seal`
  );
  const sourceFileIds = new Set(
    (sealed.body.sample ?? []).map((entry) => entry.sourceFileId).filter(Boolean)
  );
  const missing = await call(
    "GET", "/admin/api/knowledge-bases/:knowledgeBaseId/upload-sessions/:sessionId",
    `${routeBase}/${encodeURIComponent(sessionId)}?transferState=missing&limit=100`
  );
  for (const entry of missing.body.entries?.items ?? []) {
    const file = files.find((candidate) => candidate.relativePath === entry.relativePath);
    assert(file, `Upload entry has no file: ${entry.relativePath}`);
    const transferred = await call(
      "PUT",
      "/admin/api/knowledge-bases/:knowledgeBaseId/upload-sessions/:sessionId/entries/:entryId/content",
      `${routeBase}/${encodeURIComponent(sessionId)}/entries/${encodeURIComponent(entry.id)}/content`,
      {
        headers: { "content-type": "text/markdown; charset=utf-8" },
        rawBody: file.bytes
      }
    );
    if (transferred.body.entry?.sourceFileId) {
      sourceFileIds.add(transferred.body.entry.sourceFileId);
    }
  }
  await call(
    "POST", "/admin/api/knowledge-bases/:knowledgeBaseId/upload-sessions/:sessionId/reconcile",
    `${routeBase}/${encodeURIComponent(sessionId)}/reconcile`
  );
  await call(
    "POST", "/admin/api/knowledge-bases/:knowledgeBaseId/upload-sessions/:sessionId/finalize",
    `${routeBase}/${encodeURIComponent(sessionId)}/finalize`
  );
  let completed = null;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    completed = await call(
      "GET", "/admin/api/knowledge-bases/:knowledgeBaseId/upload-sessions/:sessionId",
      `${routeBase}/${encodeURIComponent(sessionId)}?limit=100`,
      { caseName: "completion-poll" }
    );
    if (completed.body.session?.state === "completed") break;
    if (["failed", "cancelled", "expired"].includes(completed.body.session?.state)) {
      throw new Error(`Upload session ended in ${completed.body.session.state}.`);
    }
    await sleep(250);
  }
  assert(completed?.body.session?.state === "completed", "Upload session did not complete.");
  for (const entry of completed.body.entries?.items ?? []) {
    if (entry.sourceFileId) sourceFileIds.add(entry.sourceFileId);
  }
  if (sourceFileIds.size !== files.length) {
    const sourcePage = await call(
      "GET", "/admin/api/knowledge-bases/:knowledgeBaseId/source-files",
      `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-files?limit=100`,
      { caseName: "upload-source-identity-resolution" }
    );
    const expectedPaths = new Set(files.map((file) => file.relativePath));
    for (const source of sourcePage.body.items ?? []) {
      if (expectedPaths.has(source.relativePath) && source.id) sourceFileIds.add(source.id);
    }
  }
  assert(sourceFileIds.size === files.length, "Upload session returned incomplete source IDs.");

  const cancellable = await call(
    "POST", "/admin/api/knowledge-bases/:knowledgeBaseId/upload-sessions", routeBase,
    {
      headers: { "idempotency-key": `${runId}-cancel` },
      json: { declaredFileCount: 0, declaredByteCount: 0 },
      expectedStatus: 201,
      caseName: "cancellable-create"
    }
  );
  await call(
    "DELETE", "/admin/api/knowledge-bases/:knowledgeBaseId/upload-sessions/:sessionId",
    `${routeBase}/${encodeURIComponent(cancellable.body.session.id)}`
  );
  return { sourceFileIds: [...sourceFileIds] };
}

async function waitForVisibleFiles(expectedIds) {
  const expected = new Set(expectedIds);
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    const response = await call(
      "GET", "/admin/api/knowledge-bases/:knowledgeBaseId/source-files",
      `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-files?limit=100`,
      { caseName: "visibility-poll" }
    );
    const files = (response.body.items ?? []).filter((file) => expected.has(file.id));
    const failed = files.find((file) => file.state === "failed");
    if (failed) throw new Error(`Source processing failed: ${failed.failure?.code ?? "UNKNOWN"}.`);
    if (files.length === expected.size && files.every((file) => file.state === "visible")) return files;
    await sleep(500);
  }
  throw new Error("Timed out waiting for visible source files.");
}

async function waitForVisibleSource(sourceFileId) {
  const files = await waitForVisibleFiles([sourceFileId]);
  return files[0];
}

async function waitForFailedSource(sourceFileId) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const response = await call(
      "GET", "/admin/api/knowledge-bases/:knowledgeBaseId/source-files",
      `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-files?limit=100`,
      { caseName: "controlled-failure-poll" }
    );
    const source = response.body.items?.find((file) => file.id === sourceFileId);
    if (source?.state === "failed") return source;
    if (source?.state === "visible") {
      throw new Error("Controlled failure source became visible before retry validation.");
    }
    await sleep(500);
  }
  throw new Error("Timed out waiting for the controlled source failure.");
}

async function findSourceFile(sourceFileId) {
  const response = await call(
    "GET", "/admin/api/knowledge-bases/:knowledgeBaseId/source-files",
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-files?limit=100`,
    { caseName: "post-mutation-refresh" }
  );
  const source = response.body.items?.find((file) => file.id === sourceFileId);
  assert(source, `Source file is missing: ${sourceFileId}.`);
  return source;
}

async function findDirectoryByPath(relativePath) {
  const response = await call(
    "GET", "/admin/api/knowledge-bases/:knowledgeBaseId/source-directories",
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-directories?limit=100`,
    { caseName: "post-mutation-refresh" }
  );
  return response.body.items?.find((directory) => directory.relativePath === relativePath) ?? null;
}

async function waitForOperation(operationId) {
  assert(operationId, "Resource operation ID is missing.");
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    const response = await call(
      "GET", "/admin/api/knowledge-bases/:knowledgeBaseId/operations/:operationId",
      `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/operations/${encodeURIComponent(operationId)}`,
      { caseName: "operation-poll" }
    );
    const state = response.body.operation?.state;
    if (state === "completed") return response.body.operation;
    if (["failed", "cancelled", "superseded"].includes(state)) {
      throw new Error(`Resource operation ended in ${state}: ${response.body.operation?.errorCode ?? "UNKNOWN"}.`);
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for resource operation ${operationId}.`);
}

async function waitForSourceMissing(sourceFileId) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const response = await rawRequest(
      "GET",
      `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-files/${encodeURIComponent(sourceFileId)}?limit=10`
    );
    if (response.status === 404) return;
    if (response.status !== 200) throw new Error(`Source missing poll returned HTTP ${response.status}.`);
    await sleep(250);
  }
  throw new Error(`Timed out waiting for source deletion ${sourceFileId}.`);
}

async function restoreGenerationModel() {
  if (!originalActiveGenerationModelId) {
    report.cleanup.generationModelRestored = true;
    return;
  }
  if (!cookie) return;
  const current = await rawRequest("GET", "/admin/api/settings/runtime");
  let original = current.body?.models?.find((model) =>
    model.id === originalActiveGenerationModelId);
  if (original?.status === "paused") {
    await rawRequest(
      "POST",
      `/admin/api/settings/models/${encodeURIComponent(originalActiveGenerationModelId)}/resume`,
      { headers: { origin }, json: {} }
    );
    const resumed = await rawRequest("GET", "/admin/api/settings/runtime");
    original = resumed.body?.models?.find((model) =>
      model.id === originalActiveGenerationModelId);
  }
  if (original?.isActive !== true) {
    await rawRequest(
      "POST",
      `/admin/api/settings/models/${encodeURIComponent(originalActiveGenerationModelId)}/activate`,
      { headers: { origin }, json: {} }
    );
  }
  const verified = await rawRequest("GET", "/admin/api/settings/runtime");
  report.cleanup.generationModelRestored = verified.status === 200
    && verified.body?.models?.some((model) =>
      model.id === originalActiveGenerationModelId && model.isActive === true) === true;
}

async function restoreEmbeddingConfiguration() {
  if (!originalEmbeddingConfigurationId) {
    report.cleanup.embeddingConfigurationRestored = true;
    return;
  }
  if (!cookie) return;
  const listed = await rawRequest("GET", "/admin/api/settings/embeddings");
  const configuration = listed.body?.configurations?.find((item) =>
    item.publicId === originalEmbeddingConfigurationId);
  if (!configuration) return;
  let current = configuration;
  if (current.lifecycleStatus === "paused") {
    const resumed = await rawRequest(
      "POST",
      `/admin/api/settings/embeddings/${encodeURIComponent(current.publicId)}/resume`,
      { headers: { origin }, json: { expectedRevision: current.revision } }
    );
    current = resumed.body?.configuration ?? current;
  }
  const activated = await rawRequest(
    "POST",
    `/admin/api/settings/embeddings/${encodeURIComponent(current.publicId)}/activate`,
    { headers: { origin }, json: { expectedRevision: current.revision } }
  );
  report.cleanup.embeddingConfigurationRestored = activated.status === 200;
}

async function restoreRerankerConfiguration() {
  if (!originalRerankerConfigurationId) {
    report.cleanup.rerankerConfigurationRestored = true;
    return;
  }
  if (!cookie) return;
  const listed = await rawRequest("GET", "/admin/api/settings/rerankers");
  const configuration = listed.body?.configurations?.find((item) =>
    item.publicId === originalRerankerConfigurationId);
  if (!configuration) return;
  let current = configuration;
  if (current.lifecycleStatus === "paused") {
    const resumed = await rawRequest(
      "POST",
      `/admin/api/settings/rerankers/${encodeURIComponent(current.publicId)}/resume`,
      { headers: { origin }, json: { expectedRevision: current.revision } }
    );
    current = resumed.body?.configuration ?? current;
  }
  const activated = await rawRequest(
    "POST",
    `/admin/api/settings/rerankers/${encodeURIComponent(current.publicId)}/activate`,
    { headers: { origin }, json: { expectedRevision: current.revision } }
  );
  report.cleanup.rerankerConfigurationRestored = activated.status === 200;
}

async function cleanupTemporaryModel({ recordPositive = false } = {}) {
  if (!cookie || !generationModelId) {
    report.cleanup.generationModelDeleted ||= !generationModelId;
    return;
  }
  await rawRequest(
    "POST", `/admin/api/settings/models/${encodeURIComponent(generationModelId)}/pause`,
    { headers: { origin }, json: {} }
  );
  const response = recordPositive
    ? await call(
        "DELETE", "/admin/api/settings/models/:modelId",
        `/admin/api/settings/models/${encodeURIComponent(generationModelId)}`,
        { json: {} }
      )
    : await rawRequest(
        "DELETE", `/admin/api/settings/models/${encodeURIComponent(generationModelId)}`,
        { headers: { origin }, json: {} }
      );
  report.cleanup.generationModelDeleted = response.status === 200 || response.status === 404;
  if (report.cleanup.generationModelDeleted) generationModelId = "";
}

async function cleanupTemporaryEmbeddingConfiguration() {
  if (!cookie || !embeddingConfigurationId) {
    report.cleanup.embeddingConfigurationDeleted ||= !embeddingConfigurationId;
    return;
  }
  const listed = await rawRequest("GET", "/admin/api/settings/embeddings");
  const configuration = listed.body?.configurations?.find((item) => item.publicId === embeddingConfigurationId);
  if (!configuration) {
    report.cleanup.embeddingConfigurationDeleted = true;
    embeddingConfigurationId = "";
    return;
  }
  const response = await rawRequest(
    "DELETE", `/admin/api/settings/embeddings/${encodeURIComponent(embeddingConfigurationId)}`,
    { headers: { origin }, json: { expectedRevision: configuration.revision } }
  );
  report.cleanup.embeddingConfigurationDeleted = response.status === 200 || response.status === 404;
  if (report.cleanup.embeddingConfigurationDeleted) embeddingConfigurationId = "";
}

async function cleanupTemporaryRerankerConfiguration() {
  if (!cookie || !rerankerConfigurationId) {
    report.cleanup.rerankerConfigurationDeleted ||= !rerankerConfigurationId;
    return;
  }
  const listed = await rawRequest("GET", "/admin/api/settings/rerankers");
  const configuration = listed.body?.configurations?.find((item) => item.publicId === rerankerConfigurationId);
  if (!configuration) {
    report.cleanup.rerankerConfigurationDeleted = true;
    rerankerConfigurationId = "";
    return;
  }
  const response = await rawRequest(
    "DELETE", `/admin/api/settings/rerankers/${encodeURIComponent(rerankerConfigurationId)}`,
    { headers: { origin }, json: { expectedRevision: configuration.revision } }
  );
  report.cleanup.rerankerConfigurationDeleted = response.status === 200 || response.status === 404;
  if (report.cleanup.rerankerConfigurationDeleted) rerankerConfigurationId = "";
}

async function deleteOpenApiKey() {
  if (!cookie || !openApiKeyId) {
    report.cleanup.keyDeleted ||= !openApiKeyId;
    return;
  }
  const response = await call(
    "DELETE", "/admin/api/openapi-keys/:keyId",
    `/admin/api/openapi-keys/${encodeURIComponent(openApiKeyId)}`
  );
  report.cleanup.keyDeleted = response.status === 200;
  if (report.cleanup.keyDeleted) openApiKeyId = "";
}

async function deleteKnowledgeBase() {
  if (!cookie || !knowledgeBaseId) {
    report.cleanup.knowledgeBaseDeleted ||= !knowledgeBaseId;
    return;
  }
  const response = await call(
    "DELETE", "/admin/api/knowledge-bases/:knowledgeBaseId",
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`,
    { expectedStatuses: [200, 404], caseName: "cleanup" }
  );
  report.cleanup.knowledgeBaseDeleted = response.status === 200 || response.status === 404;
  if (report.cleanup.knowledgeBaseDeleted) knowledgeBaseId = "";
}

async function login() {
  const response = await call(
    "POST", "/admin/api/login", "/admin/api/login",
    {
      json: {
        username: requiredEnv("ADMIN_USERNAME"),
        password: requiredEnv("ADMIN_PASSWORD")
      }
    }
  );
  cookie = response.setCookie.split(";", 1)[0] ?? "";
  assert(cookie, "Admin login returned no session cookie.");
}

async function call(method, template, pathname, options = {}) {
  const response = await requestWithRateLimitRetry({
    request: () => rawRequest(method, pathname, options),
    maximumRetries: 4
  });
  const expectedStatuses = options.expectedStatuses
    ?? [options.expectedStatus ?? (method === "POST" && template.endsWith("upload-sessions") ? 201 : 200)];
  assert(
    expectedStatuses.includes(response.status),
    `${routeId(method, template)} ${options.caseName ?? "positive"} returned HTTP ${response.status} ${response.body?.error?.code ?? ""}.`
  );
  const positive = options.positive ?? response.status < 400;
  report.rows.push({
    sequence: report.rows.length + 1,
    routeId: routeId(method, template),
    method,
    path: template,
    case: options.caseName ?? "positive",
    status: response.status,
    positive,
    latencyMs: response.latencyMs,
    responseHeaders: response.responseHeaders,
    responseFields: responseFieldPaths(response.body),
    identityEvidence: identityEvidence(response.body),
    pass: true
  });
  return response;
}

async function rawRequest(method, pathname, options = {}) {
  const headers = {
    ...(cookie ? { cookie } : {}),
    ...(method !== "GET" ? { origin } : {}),
    ...(options.json !== undefined ? { "content-type": "application/json" } : {}),
    ...(options.headers ?? {})
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30000);
  const startedAt = performance.now();
  try {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers,
      body: options.rawBody ?? (options.json === undefined ? undefined : JSON.stringify(options.json)),
      signal: controller.signal
    });
    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { textLength: text.length, textSha256: createHash("sha256").update(text).digest("hex") };
      }
    }
    assertSafeBody(body, `${method}:${pathname}`);
    return {
      status: response.status,
      body,
      retryAfter: response.headers.get("retry-after"),
      setCookie: response.headers.get("set-cookie") ?? "",
      responseHeaders: ["content-type", "etag", "x-content-revision", "retry-after"]
        .flatMap((name) => response.headers.has(name) ? [name] : []),
      latencyMs: Number((performance.now() - startedAt).toFixed(3))
    };
  } finally {
    clearTimeout(timeout);
  }
}

function responseFieldPaths(value, prefix = "$") {
  if (value === null || value === undefined) return [prefix];
  if (Array.isArray(value)) {
    return value.length === 0 ? [`${prefix}[]`] : responseFieldPaths(value[0], `${prefix}[]`);
  }
  if (typeof value !== "object") return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    responseFieldPaths(child, `${prefix}.${key}`));
}

function identityEvidence(value, prefix = "$") {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.slice(0, 1).flatMap((item) => identityEvidence(item, `${prefix}[]`));
  return Object.entries(value).flatMap(([key, child]) => {
    const next = `${prefix}.${key}`;
    if (/(?:^|_)(?:id|revision|cursor)$/iu.test(key) || /(?:Id|Revision|Cursor)$/u.test(key)) {
      return [{ field: next, valueHash: createHash("sha256").update(String(child)).digest("hex") }];
    }
    return identityEvidence(child, next);
  });
}

function assertSafeBody(body, label) {
  const serialized = JSON.stringify(body ?? {});
  assert(!/(postgres(?:ql)?:\/\/|redis:\/\/|stack\s*trace|objectKey|s3_secret|sql\s+state)/iu.test(serialized), `${label} exposed internal data.`);
  assert(!serialized.includes(`${runId}-generation-secret`), `${label} exposed a temporary model secret.`);
}

function routeId(method, routePath) {
  return `${method}:${routePath}`;
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

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

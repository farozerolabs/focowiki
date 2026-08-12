import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadEnvFile } from "node:process";
import { performance } from "node:perf_hooks";
import {
  createOpenApiOperationCoverage
} from "./lib/openapi-real-operation-coverage.mjs";
import {
  createOpenApiRuntimeResponseValidator
} from "./lib/openapi-runtime-response-validator.mjs";
import { selectClosedMarkdownSample } from "./lib/storage-vnext-linked-corpus-samples.mjs";
import { uploadMarkdownFilesWithSession } from "./lib/upload-session-client.mjs";
import { inspectOkfV02CorpusBaseline } from
  "./lib/okf-v02-corpus-inspection.mjs";
import { createOkfV02MutationScope } from
  "./lib/okf-v02-lifecycle-selection.mjs";

const OPERATION_POLL_INTERVAL_MS = 5_000;
const MAXIMUM_RATE_LIMIT_RETRIES = 4;
const RESERVED_SOURCE_FILENAME = /^(?:index|log)(?:-\d+)?\.md$/iu;
const exactOkfCorpus = process.env.FOCOWIKI_RESOURCE_LIFECYCLE_EXACT_OKF_CORPUS === "1";
const allowUnresolvedSampleLinks =
  process.env.FOCOWIKI_RESOURCE_LIFECYCLE_ALLOW_UNRESOLVED_LINKS === "1";
const validationSampleCount = exactOkfCorpus ? 200 : positiveIntegerEnvironment(
  "FOCOWIKI_RESOURCE_LIFECYCLE_SAMPLE_COUNT",
  8,
  200
);
const concurrentMutationCount = exactOkfCorpus ? 8 : Math.min(
  validationSampleCount,
  positiveIntegerEnvironment(
    "FOCOWIKI_RESOURCE_LIFECYCLE_CONCURRENT_MUTATION_COUNT",
    Math.min(8, validationSampleCount),
    8
  )
);
const mutationScope = createOkfV02MutationScope(
  exactOkfCorpus
    ? process.env.FOCOWIKI_RESOURCE_LIFECYCLE_MUTATION_PREFIX || "legacy/"
    : ""
);

const reportPath = path.resolve(
  process.env.FOCOWIKI_RESOURCE_LIFECYCLE_REPORT
    || "ReferenceDocs/rebuild-folder-aware-okf-bundles/resource-lifecycle-report.json"
);
const sampleRoot = path.resolve(
  process.env.FOCOWIKI_VALIDATION_MARKDOWN_DIR
    || "/tmp/focowiki-folder-v2-real-e2e-20260710"
);
const openApiDocument = JSON.parse(
  fs.readFileSync("docs/public/openapi/focowiki-openapi.json", "utf8")
);
const operationCoverage = createOpenApiOperationCoverage(openApiDocument);
const openApiPerformancePhase = optionalPerformancePhase(
  process.env.FOCOWIKI_RESOURCE_LIFECYCLE_PERFORMANCE_PHASE
);
const responseValidator = createOpenApiRuntimeResponseValidator(openApiDocument);
const report = {
  kind: "folder-aware-resource-lifecycle",
  startedAt: new Date().toISOString(),
  finishedAt: null,
  ok: false,
  knowledgeBaseId: null,
  checks: [],
  failures: [],
  operationCoverage: null
};

loadLocalEnv();

const admin = createClient(`http://127.0.0.1:${process.env.ADMIN_API_PORT || "43000"}`);
const publicOpenApiBaseUrl = `http://127.0.0.1:${process.env.PUBLIC_OPENAPI_PORT || "43200"}`;
const developer = createClient(publicOpenApiBaseUrl, {
    authorization: "authenticated",
    coverage: operationCoverage,
  responseValidator,
  performancePhase: openApiPerformancePhase
});
const unauthenticatedDeveloper = createClient(publicOpenApiBaseUrl, {
  authorization: "unauthenticated",
  coverage: operationCoverage,
  responseValidator
});
let keyId = null;
let knowledgeBaseId = null;
let knowledgeBaseRevision = null;
let originalPublicationSettings = null;
let originalWorkerSettings = null;
const keepKnowledgeBase = process.env.FOCOWIKI_VALIDATION_KEEP_KNOWLEDGE_BASE === "1";

try {
  await loginAdmin();
  await checkEveryOperationRejectsMissingAuthentication();
  originalWorkerSettings = await useValidationWorkerPolicy();
  originalPublicationSettings = await useValidationPublicationPolicy();
  const credential = await createOpenApiKey();
  keyId = credential.id;
  developer.authorization = `Bearer ${credential.rawKey}`;
  await checkReadOnlyRootOperations();
  await checkTemporaryKnowledgeBaseDeletion();

  const created = await developer.json("/openapi/v2/knowledge-bases", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: `Folder lifecycle ${new Date().toISOString()}`,
      description: "Real Markdown lifecycle validation"
    }),
    expectedStatus: 201
  });
  const knowledgeBase = created.knowledgeBase ?? created;
  knowledgeBaseId = knowledgeBase.knowledgeBaseId;
  knowledgeBaseRevision = knowledgeBase.resourceRevision;
  assert(knowledgeBaseId && Number.isInteger(knowledgeBaseRevision), "Knowledge-base identity is incomplete.");
  report.knowledgeBaseId = knowledgeBaseId;
  pass("knowledge-base-create", { knowledgeBaseId });

  const updated = await developer.json(`/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "if-match": `"${knowledgeBaseRevision}"`
    },
    body: JSON.stringify({ description: "Updated real Markdown lifecycle validation" })
  });
  knowledgeBaseRevision = updated.knowledgeBase.resourceRevision;
  assert(knowledgeBaseRevision === 2, "Knowledge-base update did not advance its resource revision.");
  await waitForKnowledgeBaseRevision(knowledgeBaseRevision);
  pass("knowledge-base-update", { resourceRevision: knowledgeBaseRevision });

  const samples = selectSamples(validationSampleCount);
  assert(
    samples.length === validationSampleCount,
    `Expected ${validationSampleCount} Markdown validation samples, found ${samples.length}.`
  );
  const initial = await upload(samples);
  assert(initial.files.length === samples.length, "Initial upload did not return every source file.");
  await waitForFiles(initial.files.map((file) => file.sourceFileId));
  const initialFiles = await listSourceFiles();
  const initialByPath = new Map(initialFiles.map((file) => [file.relativePath, file]));
  if (exactOkfCorpus) {
    const { analyzeOkfMetadata } = await import("../../packages/okf/src/index.ts");
    report.okfV02Baseline = await inspectOkfV02CorpusBaseline({
      samples,
      sourceFiles: initialFiles,
      readSourceContent: (file) => developer.text(
        `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`
          + `/source-files/${encodeURIComponent(file.sourceFileId)}/content`
      ),
      readGeneratedContent: (generatedPath) => developer.text(
        `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`
          + `/files/content?path=${encodeURIComponent(generatedPath)}`
      ),
      readRootContent: () => developer.text(
        `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`
          + "/files/content?path=index.md"
      ),
      normalizeSourceMetadata: (metadata, body) => analyzeOkfMetadata(metadata, {
        ownership: "source",
        markdownBody: body
      }).metadata
    });
    assert(
      report.okfV02Baseline.officialCompared === 53
        && report.okfV02Baseline.legacyCompared === 147,
      "The OKF 0.2 baseline comparison did not close the exact 200-file corpus."
    );
  }
  pass("nested-upload", { fileCount: initialFiles.length });

  const addition = exactOkfCorpus
    ? null
    : {
        relativePath: "collection-extra/appendix/new-evidence.md",
        bytes: Buffer.from("---\ntitle: Added evidence\ntype: reference\n---\n\n# Added evidence\n\nA real overlap validation document.\n")
      };
  const overlapFiles = addition ? [...samples, addition] : samples;
  const sourceBodyByPath = new Map(
    overlapFiles.map((file) => [file.relativePath, file.bytes])
  );
  const overlap = await upload(overlapFiles);
  const dispositionCounts = Object.groupBy(overlap.entries, (entry) => entry.disposition);
  assert((dispositionCounts.skipped_existing?.length ?? 0) === samples.length, "Overlap upload did not skip every existing path.");
  const expectedAdditionalUploads = addition ? 1 : 0;
  assert(
    (dispositionCounts.upload_required?.length ?? 0) === expectedAdditionalUploads,
    "Overlap upload transferred an unexpected number of paths."
  );
  const deletionFixture = addition ?? samples.filter(mutationScope).at(-1);
  const additionFile = overlap.files.find((file) =>
    file.relativePath === deletionFixture.relativePath
  );
  assert(additionFile?.sourceFileId, "Overlap upload did not expose the deletion fixture ID.");
  if (addition) await waitForFiles([additionFile.sourceFileId]);
  let afterOverlap = await listSourceFiles();
  for (const sample of samples) {
    const before = initialByPath.get(sample.relativePath);
    const after = afterOverlap.find((file) => file.relativePath === sample.relativePath);
    assert(before?.sourceFileId === after?.sourceFileId, `Overlap upload changed source identity for ${sample.relativePath}.`);
    assert(before?.resourceRevision === after?.resourceRevision, `Overlap upload changed revision for ${sample.relativePath}.`);
  }
  pass("overlap-upload", {
    skippedExisting: samples.length,
    uploaded: expectedAdditionalUploads
  });

  await checkConcurrentMutationBurst(afterOverlap, sourceBodyByPath);
  afterOverlap = await listSourceFiles();

  const replaceTarget = afterOverlap.find(mutationScope);
  assert(replaceTarget, "Replacement target was not returned by the source-file list.");
  const replaceTargetBytes = sourceBodyByPath.get(replaceTarget.relativePath);
  assert(replaceTargetBytes, "Replacement target did not resolve to its source Markdown body.");
  const replacement = Buffer.concat([
    replaceTargetBytes,
    Buffer.from("\n\n## Lifecycle validation revision\n\nThis complete Markdown revision was applied through OpenAPI.\n")
  ]);
  const replaceOperation = await acceptOperation(
    `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-files/${encodeURIComponent(replaceTarget.sourceFileId)}/content`,
    {
      method: "PUT",
      revision: replaceTarget.resourceRevision,
      idempotencyKey: `replace-${randomUUID()}`,
      headers: { "content-type": "text/markdown; charset=utf-8" },
      body: replacement
    }
  );
  await waitForOperation(replaceOperation.operationId);
  const replaced = await getSourceFile(replaceTarget.sourceFileId);
  assert(replaced.resourceRevision === replaceTarget.resourceRevision + 1, "Replacement did not advance the resource revision.");
  assert(replaced.contentRevision === replaceTarget.contentRevision + 1, "Replacement did not advance the content revision.");
  assert(replaced.generatedPath, "Replacement completed without a generated Markdown path.");
  const generatedContentAction = replaced.actions.find((action) => action.kind === "open_generated_file");
  assert(generatedContentAction?.href, "Replacement completed without a generated content action.");
  const replacementContent = await developer.text(generatedContentAction.href);
  assert(replacementContent.includes("Lifecycle validation revision"), "Replacement content is absent from the generated page.");
  pass("source-file-replace", { sourceFileId: replaced.sourceFileId });

  const moveTarget = afterOverlap.find((file) =>
    mutationScope(file) && file.sourceFileId !== replaceTarget.sourceFileId);
  const moveTargetBytes = sourceBodyByPath.get(moveTarget.relativePath);
  assert(moveTargetBytes, "File move target did not resolve to its original Markdown body.");
  const previousGeneratedPath = moveTarget.generatedPath ?? `pages/${moveTarget.relativePath}`;
  const directoriesBeforeMove = await listAllDirectories();
  const fileTargetDirectory = directoriesBeforeMove.find(
    (directory) => mutationScope(directory)
      && directory.depth >= 2
      && directory.directoryId !== moveTarget.directoryId
  );
  assert(fileTargetDirectory, "No existing target directory was available for file move validation.");
  const rejectedMove = await acceptOperation(
    `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-files/${encodeURIComponent(moveTarget.sourceFileId)}`,
    {
      method: "PATCH",
      revision: moveTarget.resourceRevision,
      idempotencyKey: `reject-file-move-${randomUUID()}`,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ relativePath: `missing-parent/${path.basename(moveTarget.relativePath)}` })
    }
  );
  await waitForOperationFailure(rejectedMove.operationId, "RESOURCE_PATH_CONFLICT");
  await getSourceFile(moveTarget.sourceFileId);
  pass("resource-operation-failure-isolation", { operationId: rejectedMove.operationId });
  const movedRelativePath = `${fileTargetDirectory.relativePath}/relocated-${path.basename(moveTarget.relativePath)}`;
  const moveOperation = await acceptOperation(
    `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-files/${encodeURIComponent(moveTarget.sourceFileId)}`,
    {
      method: "PATCH",
      revision: moveTarget.resourceRevision,
      idempotencyKey: `move-file-${randomUUID()}`,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ relativePath: movedRelativePath })
    }
  );
  await waitForOperation(moveOperation.operationId);
  await waitForFiles([moveTarget.sourceFileId]);
  const moved = await getSourceFile(moveTarget.sourceFileId);
  assert(moved.relativePath === movedRelativePath, "File move did not preserve the source ID at the new path.");
  await expectStatus(
    `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/files/content?path=${encodeURIComponent(previousGeneratedPath)}`,
    404
  );
  await developer.json(`/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/files/content?path=${encodeURIComponent(moved.generatedPath)}`);
  pass("source-file-move", { sourceFileId: moved.sourceFileId, relativePath: moved.relativePath });

  const directoryTarget = directoriesBeforeMove.find(
    (directory) =>
      directory.depth >= 2
      && mutationScope(directory)
      && directory.directoryId !== fileTargetDirectory.directoryId
      && directory.descendantFileCount >= 2
  );
  assert(directoryTarget, "No nested source directory was available for move validation.");
  const directoryParentPath = path.posix.dirname(directoryTarget.relativePath);
  const movedDirectoryPath = `${directoryParentPath}/renamed-${path.posix.basename(directoryTarget.relativePath)}`;
  const directoryMove = await acceptOperation(
    `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-directories/${encodeURIComponent(directoryTarget.directoryId)}`,
    {
      method: "PATCH",
      revision: directoryTarget.resourceRevision,
      idempotencyKey: `move-directory-${randomUUID()}`,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ relativePath: movedDirectoryPath })
    }
  );
  await waitForOperation(directoryMove.operationId);
  const movedDirectoryFiles = (await listSourceFiles()).filter((file) =>
    file.relativePath.startsWith(`${movedDirectoryPath}/`)
  );
  assert(movedDirectoryFiles.length > 0, "Directory move did not expose its descendant files.");
  await waitForFiles(movedDirectoryFiles.map((file) => file.sourceFileId));
  const movedDirectory = await developer.json(
    `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-directories/${encodeURIComponent(directoryTarget.directoryId)}`
  );
  assert(movedDirectory.directory.relativePath === movedDirectoryPath, "Directory move did not preserve the directory ID at the new path.");
  pass("source-directory-move", { directoryId: directoryTarget.directoryId, relativePath: movedDirectoryPath });

  await checkConnectedReadOperations(await getSourceFile(replaced.sourceFileId));
  await checkUploadSessionCancellation();
  if (!exactOkfCorpus) await checkWebhooks();

  const deleteTarget = (await listSourceFiles()).find((file) => file.sourceFileId === additionFile.sourceFileId);
  const fileDelete = await acceptOperation(
    `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-files/${encodeURIComponent(deleteTarget.sourceFileId)}`,
    {
      method: "DELETE",
      revision: deleteTarget.resourceRevision,
      idempotencyKey: `delete-file-${randomUUID()}`
    }
  );
  await waitUntilMissing(`/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-files/${encodeURIComponent(deleteTarget.sourceFileId)}`);

  const directoryForDelete = (await listAllDirectories()).find(
    (directory) => directory.directoryId === fileTargetDirectory.directoryId
  );
  assert(directoryForDelete, "Moved file directory was not available for deletion.");
  const directoryDelete = await acceptOperation(
    `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-directories/${encodeURIComponent(directoryForDelete.directoryId)}`,
    {
      method: "DELETE",
      revision: directoryForDelete.resourceRevision,
      idempotencyKey: `delete-directory-${randomUUID()}`
    }
  );
  await waitUntilMissing(`/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-directories/${encodeURIComponent(directoryForDelete.directoryId)}`);
  await Promise.all([
    waitForOperation(fileDelete.operationId),
    waitForOperation(directoryDelete.operationId)
  ]);
  pass("overlapping-file-and-directory-delete", {
    sourceFileId: deleteTarget.sourceFileId,
    fileOperationId: fileDelete.operationId,
    directoryOperationId: directoryDelete.operationId
  });
  const recreateWebhookId = exactOkfCorpus
    ? await createWebhookSubscription()
    : null;
  const recreated = await uploadAfterDeletion([{
    relativePath: movedRelativePath,
    bytes: moveTargetBytes
  }]);
  const recreatedFile = recreated.files.find((file) => file.relativePath === movedRelativePath);
  assert(recreatedFile?.sourceFileId && recreatedFile.sourceFileId !== moved.sourceFileId, "Recreated path did not receive a new source identity.");
  await waitForFiles([recreatedFile.sourceFileId]);
  if (recreateWebhookId) await verifyWebhookOperations(recreateWebhookId);
  await sleep(1500);
  await getSourceFile(recreatedFile.sourceFileId);
  pass("directory-delete-and-recreate", {
    operationId: directoryDelete.operationId,
    oldSourceFileId: moved.sourceFileId,
    newSourceFileId: recreatedFile.sourceFileId
  });

  const operations = await developer.json(`/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/operations?limit=100`);
  assert(operations.items.length >= 5, "Resource operation list omitted accepted mutations.");
  pass("operation-list", { operationCount: operations.items.length });

  report.ok = true;
} catch (error) {
  report.failures.push(error instanceof Error ? error.message : String(error));
  throw error;
} finally {
  if (knowledgeBaseId && knowledgeBaseRevision && !keepKnowledgeBase) {
    try {
      const response = await developer.request(
        `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`,
        {
          method: "DELETE",
          headers: {
            "idempotency-key": `delete-lifecycle-${knowledgeBaseId}`,
            "if-match": `"${knowledgeBaseRevision}"`
          }
        }
      );
      if (response.status !== 404 && response.status !== 202) {
        throw new Error(`Knowledge-base cleanup returned HTTP ${response.status}.`);
      }
      if (response.status !== 404) {
        await waitUntilMissing(
          `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`
        );
      }
      pass("knowledge-base-hidden", {
        knowledgeBaseId,
        note: "Physical PostgreSQL, Redis, and storage cleanup is verified by the white-box residual inspection."
      });
    } catch (error) {
      report.ok = false;
      report.failures.push(
        `Knowledge-base cleanup failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  } else if (knowledgeBaseId && keepKnowledgeBase) {
    pass("knowledge-base-retained", { knowledgeBaseId });
  }
  if (keyId) {
    await admin.request(`/admin/api/openapi-keys/${encodeURIComponent(keyId)}`, {
      method: "DELETE",
      headers: { origin: adminOrigin() }
    }).catch(() => undefined);
  }
  if (originalPublicationSettings) {
    await updatePublicationSettings(originalPublicationSettings).catch(() => undefined);
  }
  if (originalWorkerSettings) {
    await updateWorkerSettings(originalWorkerSettings).catch(() => undefined);
  }
  await admin.request("/admin/api/logout", {
    method: "POST",
    headers: { origin: adminOrigin() }
  }).catch(() => undefined);
  report.operationCoverage = operationCoverage.summary({
    acceptedAuthenticatedStatuses: {
      retryKnowledgeBaseSourceFile: [409]
    }
  });
  if (!report.operationCoverage.complete) {
    report.ok = false;
    report.failures.push(
      `OpenAPI operation coverage is incomplete. Missing authentication: ${report.operationCoverage.missingAuthentication.join(", ") || "none"}. Missing business paths: ${report.operationCoverage.missingBusinessPath.join(", ") || "none"}.`
    );
  }
  report.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

if (!report.ok) {
  throw new Error(report.failures.at(-1) ?? "OpenAPI resource lifecycle validation failed.");
}

function loadLocalEnv() {
  const envFile = process.env.ENV_FILE || ".env";
  if (fs.existsSync(envFile)) loadEnvFile(envFile);
}

function createClient(baseUrl, tracking = null) {
  return {
    baseUrl,
    cookie: "",
    authorization: "",
    async request(pathname, options = {}) {
      for (let attempt = 0; ; attempt += 1) {
        const startedAt = performance.now();
        const response = await fetch(`${this.baseUrl}${pathname}`, {
          ...options,
          headers: {
            ...(this.cookie ? { cookie: this.cookie } : {}),
            ...(this.authorization ? { authorization: this.authorization } : {}),
            ...(options.headers ?? {})
          }
        });
        const cookie = response.headers.get("set-cookie");
        if (cookie) this.cookie = cookie.split(";")[0] ?? "";
        await tracking?.responseValidator.validateFetchResponse({
          method: options.method ?? "GET",
          pathname,
          response
        });
        const durationMs = performance.now() - startedAt;
        tracking?.coverage.record({
          method: options.method ?? "GET",
          pathname,
          status: response.status,
          authorization: tracking.authorization,
          ...(tracking.performancePhase && tracking.authorization === "authenticated"
            ? {
                measurementPhase: tracking.performancePhase,
                durationMs
              }
            : {})
        });
        if (
          response.status !== 429
          || attempt >= MAXIMUM_RATE_LIMIT_RETRIES
        ) return response;
        const retryAfterSeconds = Number(response.headers.get("retry-after"));
        const retryAfterMilliseconds = Number.isFinite(retryAfterSeconds)
          && retryAfterSeconds > 0
          ? retryAfterSeconds * 1_000
          : OPERATION_POLL_INTERVAL_MS;
        await response.text();
        await sleep(retryAfterMilliseconds);
      }
    },
    async json(pathname, options = {}) {
      const response = await this.request(pathnameWithQuery(pathname, options.query), options);
      const text = await response.text();
      const data = text ? JSON.parse(text) : null;
      const expectedStatus = options.expectedStatus;
      if (expectedStatus ? response.status !== expectedStatus : !response.ok) {
        throw new Error(`HTTP ${response.status} for ${pathname}: ${JSON.stringify(data)}`);
      }
      return data;
    },
    async text(pathname, options = {}) {
      const response = await this.request(pathname, options);
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${pathname}: ${text}`);
      try {
        const parsed = JSON.parse(text);
        return parsed.content ?? text;
      } catch {
        return text;
      }
    }
  };
}

function optionalPerformancePhase(value) {
  const phase = String(value ?? "").trim();
  if (!phase) return null;
  if (!["cold", "warm", "concurrent"].includes(phase)) {
    throw new Error("FOCOWIKI_RESOURCE_LIFECYCLE_PERFORMANCE_PHASE is invalid");
  }
  return phase;
}

async function loginAdmin() {
  await admin.json("/admin/api/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin: adminOrigin() },
    body: JSON.stringify({
      username: requiredEnv("ADMIN_USERNAME"),
      password: requiredEnv("ADMIN_PASSWORD")
    })
  });
  pass("admin-login");
}

async function checkEveryOperationRejectsMissingAuthentication() {
  const methods = new Set(["delete", "get", "patch", "post", "put"]);
  let checked = 0;
  for (const [pathname, pathItem] of Object.entries(openApiDocument.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem ?? {})) {
      if (!methods.has(method) || !operation?.operationId) continue;
      const concretePath = pathname.replace(/\{[^}]+\}/gu, "unauthenticated-test-id");
      const response = await unauthenticatedDeveloper.request(concretePath, {
        method: method.toUpperCase(),
        headers: { "content-type": "application/json" }
      });
      const body = await response.json().catch(() => null);
      assert(response.status === 401, `${operation.operationId} returned HTTP ${response.status} without a bearer key.`);
      assert(
        body?.error?.code === "UNAUTHORIZED"
          && body.error.httpStatus === 401
          && typeof body.requestId === "string",
        `${operation.operationId} returned an invalid unauthorized error envelope.`
      );
      assert(
        !/postgres|redis|s3|meili|stack|constraint|sql/iu.test(JSON.stringify(body)),
        `${operation.operationId} exposed internal storage details in its unauthorized response.`
      );
      checked += 1;
    }
  }
  assert(checked === operationCoverage.operationCount, "OpenAPI authentication sweep did not visit every operation.");
  pass("openapi-authentication-sweep", { operationCount: checked });
}

async function createOpenApiKey() {
  const data = await admin.json("/admin/api/openapi-keys", {
    method: "POST",
    headers: { "content-type": "application/json", origin: adminOrigin() },
    body: JSON.stringify({ name: `resource-lifecycle-${Date.now()}` }),
    expectedStatus: 201
  });
  assert(data.key?.id && data.oneTimeKey?.rawKey, "OpenAPI key creation returned an incomplete credential.");
  return { id: data.key.id, rawKey: data.oneTimeKey.rawKey };
}

async function useValidationPublicationPolicy() {
  const current = await admin.json("/admin/api/settings/runtime");
  const publication = current.settings?.publication;
  assert(publication, "Runtime publication settings are unavailable.");
  const validationPolicy = {
    ...publication,
    mode: "batch",
    intervalSeconds: 5
  };
  await updatePublicationSettings(validationPolicy);
  pass("publication-mode", {
    previousMode: publication.mode,
    validationMode: validationPolicy.mode,
    validationIntervalSeconds: validationPolicy.intervalSeconds
  });
  return publication;
}

async function useValidationWorkerPolicy() {
  const current = await admin.json("/admin/api/settings/runtime");
  const worker = current.settings?.worker;
  assert(worker, "Runtime worker settings are unavailable.");
  const validationPolicy = {
    ...worker,
    jobRetryDelayMs: 100,
    hardDeleteRetryDelayMs: 100
  };
  await updateWorkerSettings(validationPolicy);
  pass("worker-policy", {
    previousJobRetryDelayMs: worker.jobRetryDelayMs,
    validationJobRetryDelayMs: validationPolicy.jobRetryDelayMs,
    previousHardDeleteRetryDelayMs: worker.hardDeleteRetryDelayMs,
    validationHardDeleteRetryDelayMs: validationPolicy.hardDeleteRetryDelayMs
  });
  return worker;
}

async function updatePublicationSettings(publication) {
  await admin.json("/admin/api/settings/publication", {
    method: "PUT",
    headers: { "content-type": "application/json", origin: adminOrigin() },
    body: JSON.stringify(publication)
  });
}

async function updateWorkerSettings(worker) {
  await admin.json("/admin/api/settings/worker", {
    method: "PUT",
    headers: { "content-type": "application/json", origin: adminOrigin() },
    body: JSON.stringify(worker)
  });
}

async function checkReadOnlyRootOperations() {
  const [health, version, contract, knowledgeBases] = await Promise.all([
    developer.json("/openapi/v2/health"),
    developer.json("/openapi/v2/version"),
    developer.json("/openapi/v2/openapi.json"),
    developer.json("/openapi/v2/knowledge-bases?limit=1")
  ]);
  assert(health.status === "ok" && version.apiVersion === "v2", "OpenAPI root identity is invalid.");
  assert(contract.openapi && Array.isArray(knowledgeBases.items), "OpenAPI root reads are incomplete.");
  pass("openapi-root-reads");
}

async function checkTemporaryKnowledgeBaseDeletion() {
  const created = await developer.json("/openapi/v2/knowledge-bases", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: `Deletion fixture ${new Date().toISOString()}`,
      description: "Isolated knowledge-base deletion validation"
    }),
    expectedStatus: 201
  });
  const temporary = created.knowledgeBase ?? created;
  assert(
    temporary.knowledgeBaseId && Number.isInteger(temporary.resourceRevision),
    "Temporary deletion fixture identity is incomplete."
  );
  const pathname = `/openapi/v2/knowledge-bases/${encodeURIComponent(temporary.knowledgeBaseId)}`;
  const deleted = await developer.json(pathname, {
    method: "DELETE",
    headers: {
      "idempotency-key": `delete-fixture-${temporary.knowledgeBaseId}`,
      "if-match": `"${temporary.resourceRevision}"`
    },
    expectedStatus: 202
  });
  assert(deleted.deletion?.accepted === true, "Temporary knowledge-base deletion was not accepted.");
  await waitUntilMissing(pathname);
  pass("knowledge-base-delete", { knowledgeBaseId: temporary.knowledgeBaseId });
}

function selectSamples(limit) {
  const files = [];
  walk(sampleRoot, files);
  const markdownFiles = files
    .filter((filePath) => filePath.toLowerCase().endsWith(".md"))
    .filter((filePath) => !RESERVED_SOURCE_FILENAME.test(path.basename(filePath)))
    .sort((left, right) => left.localeCompare(right));
  const selectedPaths = exactOkfCorpus
    ? markdownFiles
    : selectClosedMarkdownSample({
      filePaths: markdownFiles,
      limit,
      allowUnresolvedLinks: allowUnresolvedSampleLinks,
      readText: (filePath) => fs.readFileSync(filePath, "utf8")
      });
  return selectedPaths.map((filePath) => ({
    relativePath: exactOkfCorpus
      ? path.relative(sampleRoot, filePath).split(path.sep).join("/")
      : `real-corpus/${path.relative(sampleRoot, filePath).split(path.sep).join("/")}`,
    bytes: fs.readFileSync(filePath)
  }));
}

function walk(directory, files) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(target, files);
    else if (entry.isFile()) files.push(target);
  }
}

async function upload(files) {
  return uploadMarkdownFilesWithSession({
    request: async (pathname, options) => developer.json(pathname, {
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
    files
  });
}

async function uploadAfterDeletion(files, timeoutMs = 300_000) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await upload(files);
    } catch (error) {
      lastError = error;
      if (!String(error instanceof Error ? error.message : error).includes("active deletion")) {
        throw error;
      }
      await sleep(500);
    }
  }
  throw lastError ?? new Error("Timed out waiting to recreate a deleted source path.");
}

async function listSourceFiles() {
  return listAll(`/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-files`);
}

async function listDirectories(parentDirectoryId) {
  const query = new URLSearchParams({ limit: "100" });
  query.set("parentDirectoryId", parentDirectoryId ?? "root");
  return listAll(`/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-directories?${query}`);
}

async function listAllDirectories() {
  const result = [];
  const queue = [null];
  while (queue.length > 0) {
    const parentDirectoryId = queue.shift();
    const children = await listDirectories(parentDirectoryId);
    result.push(...children);
    queue.push(...children.map((directory) => directory.directoryId));
  }
  return result;
}

async function listAll(pathname) {
  const items = [];
  let cursor = null;
  do {
    const separator = pathname.includes("?") ? "&" : "?";
    const data = await developer.json(`${pathname}${cursor ? `${separator}cursor=${encodeURIComponent(cursor)}` : ""}`);
    items.push(...(data.items ?? []));
    cursor = data.nextCursor ?? null;
  } while (cursor);
  return items;
}

async function waitForFiles(sourceFileIds, timeoutMs = 300_000) {
  const expected = new Set(sourceFileIds);
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const files = (await listSourceFiles()).filter((file) => expected.has(file.sourceFileId));
    if (files.length === expected.size && files.every((file) => file.state === "visible")) return files;
    const failed = files.find((file) => file.state === "failed");
    if (failed) throw new Error(`Source processing failed for ${failed.relativePath}: ${failed.failure?.code ?? "UNKNOWN"}`);
    await sleep(500);
  }
  throw new Error("Timed out waiting for source-file processing.");
}

async function waitForKnowledgeBaseRevision(expectedRevision, timeoutMs = 300_000) {
  const pathname = `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const data = await developer.json(pathname);
    const knowledgeBase = data.knowledgeBase ?? data;
    if (knowledgeBase.resourceRevision === expectedRevision) return knowledgeBase;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for knowledge-base revision ${expectedRevision}.`);
}

async function getSourceFile(sourceFileId) {
  const data = await developer.json(
    `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-files/${encodeURIComponent(sourceFileId)}`
  );
  return data.sourceFile;
}

async function acceptOperation(pathname, options) {
  const data = await developer.json(pathname, {
    method: options.method,
    headers: {
      ...(options.headers ?? {}),
      "idempotency-key": options.idempotencyKey,
      "if-match": `"${options.revision}"`
    },
    body: options.body,
    expectedStatus: 202
  });
  assert(data.operation?.operationId, `Mutation did not return an operation identity for ${pathname}.`);
  return data.operation;
}

async function waitForOperation(operationId, timeoutMs = 300_000) {
  const pathname = `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/operations/${encodeURIComponent(operationId)}`;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const data = await developer.json(pathname);
    if (data.operation.state === "completed") return data.operation;
    if (["failed", "cancelled", "superseded"].includes(data.operation.state)) {
      throw new Error(`Resource operation ${operationId} ended in ${data.operation.state}: ${data.operation.errorCode}`);
    }
    await sleep(OPERATION_POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for resource operation ${operationId}.`);
}

async function waitForOperationFailure(operationId, expectedErrorCode, timeoutMs = 300_000) {
  const pathname = `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/operations/${encodeURIComponent(operationId)}`;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const data = await developer.json(pathname);
    if (data.operation.state === "failed") {
      assert(
        data.operation.errorCode === expectedErrorCode,
        `Resource operation ${operationId} failed with ${data.operation.errorCode}.`
      );
      return data.operation;
    }
    if (["completed", "cancelled", "superseded"].includes(data.operation.state)) {
      throw new Error(`Resource operation ${operationId} ended in unexpected state ${data.operation.state}.`);
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for failed resource operation ${operationId}.`);
}

async function checkConnectedReadOperations(sourceFile) {
  const base = `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`;
  const events = await developer.json(`${base}/source-files/${encodeURIComponent(sourceFile.sourceFileId)}/events?limit=100`);
  assert(events.items.length > 0, "Source-file events are empty.");
  const treeItems = await listAll(
    `${base}/tree?parentPath=${encodeURIComponent(path.posix.dirname(sourceFile.generatedPath))}&limit=100`
  );
  const entry = treeItems.find((item) => item.sourceFileId === sourceFile.sourceFileId);
  assert(
    entry?.fileId,
    `Generated tree did not preserve source-file identity continuity for ${sourceFile.sourceFileId} at ${sourceFile.generatedPath}; tree returned ${treeItems.length} entries.`
  );
  const file = await developer.json(`${base}/files/${encodeURIComponent(entry.fileId)}`);
  const byId = await developer.text(`${base}/files/${encodeURIComponent(entry.fileId)}/content`);
  const byPath = await developer.text(`${base}/files/content?path=${encodeURIComponent(entry.path)}`);
  assert(file.file.fileId === entry.fileId && byId === byPath, "Generated-file reads lost ID/path continuity.");
  const search = await developer.json(`${base}/files/search?query=${encodeURIComponent(sourceFile.name)}&limit=10`);
  assert(Array.isArray(search.items), "Search did not return a bounded item list.");
  await developer.json(`${base}/graph/expand?fileId=${encodeURIComponent(entry.fileId)}&depth=2&fanout=5&limit=20`);
  await developer.json(`${base}/graph/overview`);
  await developer.json(`${base}/files/${encodeURIComponent(entry.fileId)}/related?limit=20`);
  await developer.text(`${base}/source-files/${encodeURIComponent(sourceFile.sourceFileId)}/content`);
  const retry = await developer.request(
    `${base}/source-files/${encodeURIComponent(sourceFile.sourceFileId)}/retry`,
    { method: "POST" }
  );
  const retryBody = await retry.text();
  assert(retry.status === 409, `Ready source retry returned HTTP ${retry.status}.`);
  assert(
    !/postgres|redis|s3|meili|stack|constraint|sql/iu.test(retryBody),
    "Ready source retry exposed internal storage details."
  );
  pass("connected-read-operations", { generatedFileId: entry.fileId });
}

async function checkConcurrentMutationBurst(sourceFiles, sourceBodyByPath) {
  const targets = sourceFiles
    .filter((file) => mutationScope(file) && sourceBodyByPath.has(file.relativePath))
    .slice(0, concurrentMutationCount);
  assert(
    targets.length === concurrentMutationCount,
    `Concurrent mutation validation requires ${concurrentMutationCount} source files.`
  );

  const accepted = await Promise.all(targets.map(async (file, index) => {
    const original = sourceBodyByPath.get(file.relativePath);
    assert(original, `Concurrent replacement body is missing for ${file.relativePath}.`);
    const replacement = Buffer.concat([
      original,
      Buffer.from(`\n\n## Concurrent validation ${index + 1}\n\nThis revision validates durable publication coalescing.\n`)
    ]);
    const route = `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-files/${encodeURIComponent(file.sourceFileId)}/content`;
    const operation = await acceptOperation(route, {
      method: "PUT",
      revision: file.resourceRevision,
      idempotencyKey: `burst-replace-${index}-${randomUUID()}`,
      headers: { "content-type": "text/markdown; charset=utf-8" },
      body: replacement
    });
    return { file, operation, route, replacement };
  }));

  await Promise.all(accepted.map(({ operation }) => waitForOperation(operation.operationId)));

  await Promise.all(accepted.map(async ({ file, route, replacement }, index) => {
    const response = await developer.request(route, {
      method: "PUT",
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "idempotency-key": `burst-conflict-${index}-${randomUUID()}`,
        "if-match": `"${file.resourceRevision}"`
      },
      body: replacement
    });
    assert(
      response.status === 409,
      `Stale replacement returned HTTP ${response.status} for ${file.relativePath}.`
    );
  }));

  pass("concurrent-resource-mutation-burst", {
    accepted: accepted.length,
    rejectedConflicts: accepted.length,
    attemptedMutations: accepted.length * 2
  });
}

async function checkUploadSessionCancellation() {
  const base = `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/upload-sessions`;
  const created = await developer.json(base, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": `cancel-session-${randomUUID()}` },
    body: JSON.stringify({ declaredFileCount: 1, declaredByteCount: 1 }),
    expectedStatus: 201
  });
  const sessionId = created.session.id;
  const reconciled = await developer.json(
    `${base}/${encodeURIComponent(sessionId)}/reconcile`,
    { method: "POST" }
  );
  assert(reconciled.session?.id === sessionId, "Upload reconciliation changed the session identity.");
  await developer.json(`${base}/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  pass("upload-session-cancel", { sessionId });
}

async function createWebhookSubscription() {
  const created = await developer.json("/openapi/v2/webhooks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Folder lifecycle webhook",
      url: "https://127.0.0.1:44443/folder-lifecycle",
      events: ["source_file.completed", "generation.activated"]
    }),
    expectedStatus: 201
  });
  return created.webhook.webhookId;
}

async function checkWebhooks() {
  const webhookId = await createWebhookSubscription();
  try {
    const sample = selectSamples(validationSampleCount)[0];
    assert(sample, "Webhook validation Markdown sample is unavailable.");
    const uploaded = await upload([{
      relativePath: `webhook-validation/${Date.now()}-${path.posix.basename(sample.relativePath)}`,
      bytes: sample.bytes
    }]);
    const target = uploaded.files[0];
    assert(target?.sourceFileId, "Webhook validation upload omitted its source-file ID.");
    await waitForFiles([target.sourceFileId]);
    await verifyWebhookOperations(webhookId);
  } catch (error) {
    await deleteWebhookSubscription(webhookId);
    throw error;
  }
}

async function verifyWebhookOperations(webhookId) {
  try {
    const listed = await developer.json("/openapi/v2/webhooks?limit=100");
    assert(listed.items.some((item) => item.webhookId === webhookId), "Webhook list omitted the created subscription.");
    const delivery = await waitForWebhookDelivery(webhookId, "source_file.completed");
    assert(
      ["pending", "success", "failed"].includes(delivery.status),
      `Webhook delivery exposed an unsupported status: ${delivery.status}`
    );
    assert(
      JSON.stringify(Object.keys(delivery).sort()) === JSON.stringify([
        "attemptCount", "createdAt", "deliveryId", "errorCode", "eventId",
        "eventType", "httpStatus", "status", "updatedAt", "webhookId"
      ]),
      "Webhook delivery exposed internal fields or omitted released fields."
    );
    const redelivered = await developer.json(
      `/openapi/v2/webhook-deliveries/${encodeURIComponent(delivery.deliveryId)}/redeliver`,
      { method: "POST", expectedStatus: 202 }
    );
    assert(
      redelivered.delivery?.deliveryId
        && redelivered.delivery.deliveryId !== delivery.deliveryId,
      "Webhook redelivery did not return a new public delivery ID."
    );
    assert(
      redelivered.delivery.eventId === delivery.eventId
        && redelivered.delivery.status === "pending",
      "Webhook redelivery did not preserve the released event identity and pending status."
    );
    pass("webhook-operations", {
      webhookId,
      deliveryId: delivery.deliveryId,
      redeliveryId: redelivered.delivery.deliveryId,
      eventId: delivery.eventId
    });
  } finally {
    await deleteWebhookSubscription(webhookId);
  }
}

async function deleteWebhookSubscription(webhookId) {
  const response = await developer.request(
    `/openapi/v2/webhooks/${encodeURIComponent(webhookId)}`,
    { method: "DELETE" }
  );
  if (response.status !== 200 && response.status !== 404) {
    throw new Error(`Webhook cleanup returned HTTP ${response.status}.`);
  }
  await response.text();
}

async function waitForWebhookDelivery(webhookId, eventType, timeoutMs = 120_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const deliveries = await developer.json("/openapi/v2/webhook-deliveries?limit=100");
    const delivery = deliveries.items.find((item) =>
      item.webhookId === webhookId && item.eventType === eventType
    );
    if (delivery) return delivery;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${eventType} webhook delivery.`);
}

async function waitUntilMissing(pathname, timeoutMs = 300_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const response = await developer.request(pathname);
    if (response.status === 404) return;
    if (!response.ok) throw new Error(`Unexpected HTTP ${response.status} while waiting for deletion of ${pathname}.`);
    await sleep(500);
  }
  throw new Error(`Timed out waiting for deletion of ${pathname}.`);
}

async function expectStatus(pathname, expectedStatus) {
  const response = await developer.request(pathname);
  if (response.status !== expectedStatus) {
    throw new Error(`Expected HTTP ${expectedStatus} for ${pathname}, got ${response.status}.`);
  }
}

function pathnameWithQuery(pathname, query) {
  if (!query || Object.keys(query).length === 0) return pathname;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  return `${pathname}?${params}`;
}

function adminOrigin() {
  return process.env.ADMIN_PUBLIC_ORIGIN || "http://127.0.0.1:43100";
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function positiveIntegerEnvironment(name, fallback, maximum) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function pass(name, details = {}) {
  report.checks.push({ name, ok: true, details });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

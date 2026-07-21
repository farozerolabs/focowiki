import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadEnvFile } from "node:process";
import { uploadMarkdownFilesWithSession } from "./lib/upload-session-client.mjs";

const reportPath = path.resolve(
  process.env.FOCOWIKI_RESOURCE_LIFECYCLE_REPORT
    || "ReferenceDocs/rebuild-folder-aware-okf-bundles/resource-lifecycle-report.json"
);
const sampleRoot = path.resolve(
  process.env.FOCOWIKI_VALIDATION_MARKDOWN_DIR
    || "/tmp/focowiki-folder-v2-real-e2e-20260710"
);
const report = {
  kind: "folder-aware-resource-lifecycle",
  startedAt: new Date().toISOString(),
  finishedAt: null,
  ok: false,
  knowledgeBaseId: null,
  checks: [],
  failures: []
};

loadLocalEnv();

const admin = createClient(`http://127.0.0.1:${process.env.ADMIN_API_PORT || "43000"}`);
const developer = createClient(`http://127.0.0.1:${process.env.PUBLIC_OPENAPI_PORT || "43200"}`);
let keyId = null;
let knowledgeBaseId = null;
let knowledgeBaseRevision = null;
let originalPublicationSettings = null;
let originalWorkerSettings = null;
const keepKnowledgeBase = process.env.FOCOWIKI_VALIDATION_KEEP_KNOWLEDGE_BASE === "1";

try {
  await loginAdmin();
  originalWorkerSettings = await useValidationWorkerPolicy();
  originalPublicationSettings = await useValidationPublicationPolicy();
  const credential = await createOpenApiKey();
  keyId = credential.id;
  developer.authorization = `Bearer ${credential.rawKey}`;
  await checkReadOnlyRootOperations();

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
  pass("knowledge-base-update", { resourceRevision: knowledgeBaseRevision });

  const samples = selectSamples(8);
  assert(
    samples.length === 8,
    `Expected eight Markdown validation samples under ${sampleRoot}, found ${samples.length}.`
  );
  const initial = await upload(samples);
  assert(initial.files.length === samples.length, "Initial upload did not return every source file.");
  await waitForFiles(initial.files.map((file) => file.sourceFileId));
  const initialFiles = await listSourceFiles();
  const initialByPath = new Map(initialFiles.map((file) => [file.relativePath, file]));
  pass("nested-upload", { fileCount: initialFiles.length });

  const addition = {
    relativePath: "collection-extra/appendix/new-evidence.md",
    bytes: Buffer.from("---\ntitle: Added evidence\ntype: reference\n---\n\n# Added evidence\n\nA real overlap validation document.\n")
  };
  const sourceBodyByPath = new Map(
    [...samples, addition].map((file) => [file.relativePath, file.bytes])
  );
  const overlap = await upload([...samples, addition]);
  const dispositionCounts = Object.groupBy(overlap.entries, (entry) => entry.disposition);
  assert((dispositionCounts.skipped_existing?.length ?? 0) === samples.length, "Overlap upload did not skip every existing path.");
  assert((dispositionCounts.upload_required?.length ?? 0) === 1, "Overlap upload did not transfer only the new path.");
  const additionFile = overlap.files.find((file) => file.relativePath === addition.relativePath);
  assert(additionFile?.sourceFileId, "Overlap upload did not expose the new source-file ID.");
  await waitForFiles([additionFile.sourceFileId]);
  let afterOverlap = await listSourceFiles();
  for (const sample of samples) {
    const before = initialByPath.get(sample.relativePath);
    const after = afterOverlap.find((file) => file.relativePath === sample.relativePath);
    assert(before?.sourceFileId === after?.sourceFileId, `Overlap upload changed source identity for ${sample.relativePath}.`);
    assert(before?.resourceRevision === after?.resourceRevision, `Overlap upload changed revision for ${sample.relativePath}.`);
  }
  pass("overlap-upload", { skippedExisting: samples.length, uploaded: 1 });

  await checkConcurrentMutationBurst(afterOverlap, sourceBodyByPath);
  afterOverlap = await listSourceFiles();

  const replaceTarget = afterOverlap.find((file) => file.relativePath === samples[0].relativePath);
  assert(replaceTarget, "Replacement target was not returned by the source-file list.");
  const replacement = Buffer.concat([
    samples[0].bytes,
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

  const moveTarget = afterOverlap.find((file) => file.sourceFileId !== replaceTarget.sourceFileId);
  const moveTargetBytes = sourceBodyByPath.get(moveTarget.relativePath);
  assert(moveTargetBytes, "File move target did not resolve to its original Markdown body.");
  const previousGeneratedPath = moveTarget.generatedPath ?? `pages/${moveTarget.relativePath}`;
  const directoriesBeforeMove = await listAllDirectories();
  const fileTargetDirectory = directoriesBeforeMove.find(
    (directory) => directory.depth >= 2 && directory.directoryId !== moveTarget.directoryId
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
  await checkWebhooks();

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
  const recreated = await uploadAfterDeletion([{
    relativePath: movedRelativePath,
    bytes: moveTargetBytes
  }]);
  const recreatedFile = recreated.files.find((file) => file.relativePath === movedRelativePath);
  assert(recreatedFile?.sourceFileId && recreatedFile.sourceFileId !== moved.sourceFileId, "Recreated path did not receive a new source identity.");
  await waitForFiles([recreatedFile.sourceFileId]);
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
  report.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

function loadLocalEnv() {
  const envFile = process.env.ENV_FILE || ".env";
  if (fs.existsSync(envFile)) loadEnvFile(envFile);
}

function createClient(baseUrl) {
  return {
    baseUrl,
    cookie: "",
    authorization: "",
    async request(pathname, options = {}) {
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
      return response;
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
    batchSize: 8,
    intervalSeconds: 5
  };
  await updatePublicationSettings(validationPolicy);
  pass("publication-mode", {
    previousMode: publication.mode,
    validationMode: validationPolicy.mode,
    validationBatchSize: validationPolicy.batchSize,
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
    hardDeleteRetryDelayMs: 100
  };
  await updateWorkerSettings(validationPolicy);
  pass("worker-policy", {
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

function selectSamples(limit) {
  const files = [];
  walk(sampleRoot, files);
  return files
    .filter((filePath) => filePath.toLowerCase().endsWith(".md"))
    .sort((left, right) => left.localeCompare(right))
    .slice(0, limit)
    .map((filePath, index) => ({
      relativePath: `real-corpus/group-${String(Math.floor(index / 4) + 1).padStart(2, "0")}/${path.basename(filePath)}`,
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
    await sleep(500);
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
  pass("connected-read-operations", { generatedFileId: entry.fileId });
}

async function checkConcurrentMutationBurst(sourceFiles, sourceBodyByPath) {
  const targets = sourceFiles
    .filter((file) => sourceBodyByPath.has(file.relativePath))
    .slice(0, 8);
  assert(targets.length === 8, "Concurrent mutation validation requires eight source files.");

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
  await developer.json(`${base}/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  pass("upload-session-cancel", { sessionId });
}

async function checkWebhooks() {
  const created = await developer.json("/openapi/v2/webhooks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Folder lifecycle webhook",
      url: "https://hooks.example.com/folder-lifecycle",
      events: ["source_file.completed", "generation.activated"]
    }),
    expectedStatus: 201
  });
  const webhookId = created.webhook.webhookId;
  const listed = await developer.json("/openapi/v2/webhooks?limit=100");
  assert(listed.items.some((item) => item.webhookId === webhookId), "Webhook list omitted the created subscription.");
  await developer.json("/openapi/v2/webhook-deliveries?limit=10");
  await developer.json(`/openapi/v2/webhooks/${encodeURIComponent(webhookId)}`, { method: "DELETE" });
  pass("webhook-operations", { webhookId });
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function pass(name, details = {}) {
  report.checks.push({ name, ok: true, details });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

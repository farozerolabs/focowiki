import fs from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";
import {
  createLifecycleHttpClient,
  createUploadSessionPhaseClient
} from "./lib/interleaved-lifecycle-api.mjs";
import {
  assertRepeatedConflictCoverage
} from "./lib/interleaved-repeat-cases.mjs";
import {
  createInterleavedLifecycleController
} from "./lib/interleaved-lifecycle-controller.mjs";

loadLocalEnv();

const runId = requiredEnv("FOCOWIKI_INTERLEAVED_RUN_ID");
const sourceRoot = path.resolve(requiredEnv("FOCOWIKI_VALIDATION_MARKDOWN_DIR"));
const adminOrigin = process.env.ADMIN_PUBLIC_ORIGIN || "http://127.0.0.1:43100";
const admin = createLifecycleHttpClient({
  baseUrl: `http://127.0.0.1:${process.env.ADMIN_API_PORT || "43000"}`
});
const developer = createLifecycleHttpClient({
  baseUrl: `http://127.0.0.1:${process.env.PUBLIC_OPENAPI_PORT || "43200"}`
});
const controller = createInterleavedLifecycleController({
  runId,
  seed: process.env.FOCOWIKI_INTERLEAVED_SEED || runId,
  reportRoot: path.resolve("ReferenceDocs", "validate-interleaved-lifecycle-e2e")
});
await controller.initialize();

const report = {
  kind: "repeated-conflict-lifecycle",
  runId,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  ok: false,
  knowledgeBaseId: null,
  checks: [],
  failures: []
};
const reportPath = path.join(
  controller.state.evidenceDir,
  "repeated-conflict-results.json"
);
let keyId = null;
let knowledgeBaseId = null;
let knowledgeBaseRevision = null;
let knowledgeBaseDeleted = false;

try {
  await login();
  const credential = await createOpenApiKey();
  keyId = credential.id;
  developer.authorization = `Bearer ${credential.rawKey}`;

  const created = await developer.json("/openapi/v2/knowledge-bases", {
    method: "POST",
    headers: { "idempotency-key": `${runId}-repeat-kb-create` },
    json: {
      name: `Repeated lifecycle ${runId}`,
      description: "Repeated and conflicting lifecycle validation"
    },
    expectedStatus: 201
  });
  const knowledgeBase = created.knowledgeBase ?? created;
  knowledgeBaseId = knowledgeBase.knowledgeBaseId;
  knowledgeBaseRevision = knowledgeBase.resourceRevision;
  report.knowledgeBaseId = knowledgeBaseId;
  controller.registerOwnership("knowledgeBases", knowledgeBaseId);

  const samples = readSamples(3);
  const initialFiles = [
    { relativePath: "repeat/source.md", bytes: samples[0] },
    { relativePath: "repeat/second.md", bytes: samples[1] },
    { relativePath: "repeat/nested/third.md", bytes: samples[2] }
  ];
  const upload = createUpload();

  const stableUploadKey = `${runId}-stable-upload`;
  const firstSession = await upload.create(initialFiles, {
    idempotencyKey: stableUploadKey
  });
  const replayedSession = await upload.create(initialFiles, {
    idempotencyKey: stableUploadKey
  });
  assert(
    firstSession.session.id === replayedSession.session.id,
    "Identical upload-session replay returned a different session."
  );
  registerSession(firstSession.session.id);
  pass("upload-session-idempotent-replay", {
    sameSession: true
  });

  const changedReplay = await developer.request(uploadBase(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": stableUploadKey
    },
    json: {
      declaredFileCount: initialFiles.length,
      declaredByteCount: totalBytes(initialFiles) + 1
    }
  });
  assert(
    changedReplay.status === 409,
    `Changed upload-session replay returned HTTP ${changedReplay.status}.`
  );
  pass("upload-session-idempotency-payload-conflict", {
    status: changedReplay.status
  });

  await completeCreatedUpload(upload, firstSession.session.id);
  const visibleInitial = await waitForVisibleFiles(initialFiles.length);
  const initialByPath = new Map(
    visibleInitial.map((file) => [file.relativePath, file])
  );

  const existing = await completeUpload(
    [initialFiles[0]],
    `${runId}-sequential-existing`
  );
  assert(
    existing.entries.some((entry) => entry.disposition === "skipped_existing"),
    "Sequential existing upload did not report skipped_existing."
  );
  pass("sequential-existing-upload", {
    disposition: "skipped_existing"
  });

  const changedExistingBody = Buffer.concat([
    initialFiles[0].bytes,
    Buffer.from("\n\nChanged upload body that must not replace an existing path.\n")
  ]);
  const changedExisting = await completeUpload(
    [{ relativePath: initialFiles[0].relativePath, bytes: changedExistingBody }],
    `${runId}-changed-existing`
  );
  assert(
    changedExisting.entries.some((entry) => entry.disposition === "skipped_existing"),
    "Changed content at an existing path did not preserve existing-file semantics."
  );
  const unchangedContent = await developer.text(
    `${sourceBase()}/${encodeURIComponent(
      initialByPath.get(initialFiles[0].relativePath).sourceFileId
    )}/content`
  );
  assert(
    !unchangedContent.includes("Changed upload body"),
    "Changed upload content unexpectedly replaced the existing source."
  );
  pass("changed-content-existing-path", {
    disposition: "skipped_existing",
    existingContentPreserved: true
  });

  const competingFile = [{
    relativePath: "repeat/concurrent.md",
    bytes: Buffer.from("# Concurrent upload\n\nOne source identity must win.\n")
  }];
  const concurrentUploads = await Promise.allSettled([
    completeUpload(competingFile, `${runId}-concurrent-upload-left`),
    completeUpload(competingFile, `${runId}-concurrent-upload-right`)
  ]);
  const concurrentVisible = (await listSourceFiles()).filter(
    (file) => file.relativePath === competingFile[0].relativePath
  );
  assert(
    concurrentVisible.length === 1,
    `Concurrent upload created ${concurrentVisible.length} active source identities.`
  );
  assert(
    concurrentUploads.some((outcome) => outcome.status === "fulfilled"),
    "Both concurrent uploads failed."
  );
  pass("concurrent-distinct-upload-same-path", {
    fulfilled: concurrentUploads.filter((item) => item.status === "fulfilled").length,
    rejected: concurrentUploads.filter((item) => item.status === "rejected").length,
    activeSourceCount: concurrentVisible.length
  });

  let replaceTarget = await getSourceFile(
    initialByPath.get(initialFiles[0].relativePath).sourceFileId
  );
  const replacementBody = Buffer.concat([
    initialFiles[0].bytes,
    Buffer.from("\n\n## Repeated replacement\n\nStable idempotent content.\n")
  ]);
  const replaceKey = `${runId}-replace-replay`;
  const replaceRoute = `${sourceBase()}/${encodeURIComponent(
    replaceTarget.sourceFileId
  )}/content`;
  const firstReplace = await submitMutation(replaceRoute, {
    method: "PUT",
    revision: replaceTarget.resourceRevision,
    idempotencyKey: replaceKey,
    contentType: "text/markdown; charset=utf-8",
    body: replacementBody
  });
  const replayedReplace = await submitMutation(replaceRoute, {
    method: "PUT",
    revision: replaceTarget.resourceRevision,
    idempotencyKey: replaceKey,
    contentType: "text/markdown; charset=utf-8",
    body: replacementBody
  });
  assert(
    firstReplace.operationId === replayedReplace.operationId,
    "Replacement replay returned a different operation."
  );
  await waitForOperation(firstReplace.operationId);
  pass("replace-idempotent-replay", {
    sameOperation: true
  });

  replaceTarget = await getSourceFile(replaceTarget.sourceFileId);
  const competingReplacements = await Promise.all([
    submitMutationResult(replaceRoute, {
      method: "PUT",
      revision: replaceTarget.resourceRevision,
      idempotencyKey: `${runId}-replace-left`,
      contentType: "text/markdown; charset=utf-8",
      body: Buffer.concat([replacementBody, Buffer.from("\n\nLeft replacement.\n")])
    }),
    submitMutationResult(replaceRoute, {
      method: "PUT",
      revision: replaceTarget.resourceRevision,
      idempotencyKey: `${runId}-replace-right`,
      contentType: "text/markdown; charset=utf-8",
      body: Buffer.concat([replacementBody, Buffer.from("\n\nRight replacement.\n")])
    })
  ]);
  const replacementOutcomes = await settleMutationResults(competingReplacements);
  assertSingleWinner(replacementOutcomes, "concurrent replacement");
  pass("concurrent-replace-current-revision", summarizeOutcomes(replacementOutcomes));

  const staleReplace = await submitMutationResult(replaceRoute, {
    method: "PUT",
    revision: replaceTarget.resourceRevision,
    idempotencyKey: `${runId}-replace-stale`,
    contentType: "text/markdown; charset=utf-8",
    body: replacementBody
  });
  assert(
    staleReplace.status === 409,
    `Stale replacement returned HTTP ${staleReplace.status}.`
  );
  pass("replace-stale-revision", { status: staleReplace.status });

  let moveTarget = await getSourceFile(
    initialByPath.get(initialFiles[1].relativePath).sourceFileId
  );
  const moveRoute = `${sourceBase()}/${encodeURIComponent(moveTarget.sourceFileId)}`;
  const moveKey = `${runId}-file-move-replay`;
  const moveBody = JSON.stringify({ relativePath: "repeat/nested/moved-second.md" });
  const firstMove = await submitMutation(moveRoute, {
    method: "PATCH",
    revision: moveTarget.resourceRevision,
    idempotencyKey: moveKey,
    contentType: "application/json",
    body: moveBody
  });
  const replayedMove = await submitMutation(moveRoute, {
    method: "PATCH",
    revision: moveTarget.resourceRevision,
    idempotencyKey: moveKey,
    contentType: "application/json",
    body: moveBody
  });
  assert(
    firstMove.operationId === replayedMove.operationId,
    "File-move replay returned a different operation."
  );
  await waitForOperation(firstMove.operationId);
  pass("file-move-idempotent-replay", { sameOperation: true });

  moveTarget = await getSourceFile(moveTarget.sourceFileId);
  const competingMoves = await Promise.all([
    submitMutationResult(moveRoute, {
      method: "PATCH",
      revision: moveTarget.resourceRevision,
      idempotencyKey: `${runId}-file-move-left`,
      contentType: "application/json",
      body: JSON.stringify({ relativePath: "repeat/move-left.md" })
    }),
    submitMutationResult(moveRoute, {
      method: "PATCH",
      revision: moveTarget.resourceRevision,
      idempotencyKey: `${runId}-file-move-right`,
      contentType: "application/json",
      body: JSON.stringify({ relativePath: "repeat/move-right.md" })
    })
  ]);
  const moveOutcomes = await settleMutationResults(competingMoves);
  assertSingleWinner(moveOutcomes, "competing file move");
  pass("file-move-competing-destination", summarizeOutcomes(moveOutcomes));

  const nestedDirectory = (await listDirectories()).find(
    (directory) => directory.relativePath === "repeat/nested"
  );
  assert(nestedDirectory, "Nested directory was not available for move replay.");
  const directoryRoute = `${directoryBase()}/${encodeURIComponent(
    nestedDirectory.directoryId
  )}`;
  const directoryMoveKey = `${runId}-directory-move-replay`;
  const directoryMoveBody = JSON.stringify({ relativePath: "repeat/renamed" });
  const firstDirectoryMove = await submitMutation(directoryRoute, {
    method: "PATCH",
    revision: nestedDirectory.resourceRevision,
    idempotencyKey: directoryMoveKey,
    contentType: "application/json",
    body: directoryMoveBody
  });
  const replayedDirectoryMove = await submitMutation(directoryRoute, {
    method: "PATCH",
    revision: nestedDirectory.resourceRevision,
    idempotencyKey: directoryMoveKey,
    contentType: "application/json",
    body: directoryMoveBody
  });
  assert(
    firstDirectoryMove.operationId === replayedDirectoryMove.operationId,
    "Directory-move replay returned a different operation."
  );
  await waitForOperation(firstDirectoryMove.operationId);
  pass("directory-move-idempotent-replay", { sameOperation: true });

  const currentKnowledgeBase = await getKnowledgeBase();
  const metadataUpdates = await Promise.all([
    developer.request(knowledgeBaseRoute(), {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "if-match": `"${currentKnowledgeBase.resourceRevision}"`
      },
      json: { description: "Concurrent metadata update left" }
    }),
    developer.request(knowledgeBaseRoute(), {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "if-match": `"${currentKnowledgeBase.resourceRevision}"`
      },
      json: { description: "Concurrent metadata update right" }
    })
  ]);
  const metadataStatuses = metadataUpdates.map((response) => response.status);
  assertStatusWinner(metadataStatuses, "knowledge-base metadata update");
  knowledgeBaseRevision = (await getKnowledgeBase()).resourceRevision;
  pass("knowledge-base-update-concurrent-revision", {
    statuses: metadataStatuses
  });

  const taskDeleteSourceFileId = concurrentVisible[0].sourceFileId;
  const taskDeleteRoute = `/admin/api/knowledge-bases/${encodeURIComponent(
    knowledgeBaseId
  )}/source-files/task-deletions`;
  const overlappingTaskDeletes = await Promise.all([
    admin.json(taskDeleteRoute, {
      method: "POST",
      headers: { origin: adminOrigin },
      json: { sourceFileIds: [taskDeleteSourceFileId] }
    }),
    admin.json(taskDeleteRoute, {
      method: "POST",
      headers: { origin: adminOrigin },
      json: { sourceFileIds: [taskDeleteSourceFileId] }
    })
  ]);
  const taskDeleteStatuses = overlappingTaskDeletes.flatMap((response) =>
    response.results?.map((result) => result.status) ?? []
  );
  assert(
    taskDeleteStatuses.length === 2
      && taskDeleteStatuses.some((status) => status === "hidden" || status === "deleted")
      && taskDeleteStatuses.every((status) =>
        status === "hidden" || status === "deleted" || status === "skipped"
      ),
    `Overlapping task deletion returned unsafe outcomes ${taskDeleteStatuses.join(",")}.`
  );
  pass("task-delete-idempotent-overlap", {
    statuses: taskDeleteStatuses
  });

  const terminalTaskDelete = await admin.json(taskDeleteRoute, {
    method: "POST",
    headers: { origin: adminOrigin },
    json: { sourceFileIds: [taskDeleteSourceFileId] }
  });
  assert(
    terminalTaskDelete.summary?.skipped === 1,
    "Terminal task deletion did not return a stable skipped outcome."
  );
  pass("task-delete-after-terminal", {
    status: terminalTaskDelete.results?.[0]?.status ?? null,
    reason: terminalTaskDelete.results?.[0]?.reason ?? null
  });

  const fileDeleteTarget = await getSourceFile(replaceTarget.sourceFileId);
  const fileDeleteRoute = `${sourceBase()}/${encodeURIComponent(
    fileDeleteTarget.sourceFileId
  )}`;
  const fileDeleteKey = `${runId}-file-delete-replay`;
  const firstFileDelete = await submitMutation(fileDeleteRoute, {
    method: "DELETE",
    revision: fileDeleteTarget.resourceRevision,
    idempotencyKey: fileDeleteKey
  });
  const replayedFileDelete = await submitMutation(fileDeleteRoute, {
    method: "DELETE",
    revision: fileDeleteTarget.resourceRevision,
    idempotencyKey: fileDeleteKey
  });
  assert(
    firstFileDelete.operationId === replayedFileDelete.operationId,
    "File-delete replay returned a different operation."
  );
  pass("file-delete-idempotent-replay", { sameOperation: true });
  await waitForOperation(firstFileDelete.operationId);
  await waitUntilMissing(fileDeleteRoute);
  const terminalFileDelete = await submitMutationResult(fileDeleteRoute, {
    method: "DELETE",
    revision: fileDeleteTarget.resourceRevision,
    idempotencyKey: fileDeleteKey
  });
  assert(
    [202, 404].includes(terminalFileDelete.status),
    `Terminal file-delete replay returned HTTP ${terminalFileDelete.status}.`
  );
  pass("file-delete-after-terminal", { status: terminalFileDelete.status });

  const renamedDirectory = (await listDirectories()).find(
    (directory) => directory.relativePath === "repeat/renamed"
  );
  assert(renamedDirectory, "Renamed directory was not available for deletion.");
  const directoryDeleteRoute = `${directoryBase()}/${encodeURIComponent(
    renamedDirectory.directoryId
  )}`;
  const directoryDeleteKey = `${runId}-directory-delete-replay`;
  const firstDirectoryDelete = await submitMutation(directoryDeleteRoute, {
    method: "DELETE",
    revision: renamedDirectory.resourceRevision,
    idempotencyKey: directoryDeleteKey
  });
  const replayedDirectoryDelete = await submitMutation(directoryDeleteRoute, {
    method: "DELETE",
    revision: renamedDirectory.resourceRevision,
    idempotencyKey: directoryDeleteKey
  });
  assert(
    firstDirectoryDelete.operationId === replayedDirectoryDelete.operationId,
    "Directory-delete replay returned a different operation."
  );
  pass("directory-delete-idempotent-replay", { sameOperation: true });
  await waitForOperation(firstDirectoryDelete.operationId);
  await waitUntilMissing(directoryDeleteRoute);
  const terminalDirectoryDelete = await submitMutationResult(directoryDeleteRoute, {
    method: "DELETE",
    revision: renamedDirectory.resourceRevision,
    idempotencyKey: directoryDeleteKey
  });
  assert(
    [202, 404].includes(terminalDirectoryDelete.status),
    `Terminal directory-delete replay returned HTTP ${terminalDirectoryDelete.status}.`
  );
  pass("directory-delete-after-terminal", {
    status: terminalDirectoryDelete.status
  });

  const beforeKnowledgeBaseDelete = await getKnowledgeBase();
  const knowledgeBaseDeleteKey = `${runId}-knowledge-base-delete-replay`;
  const deleteOptions = {
    method: "DELETE",
    headers: {
      "idempotency-key": knowledgeBaseDeleteKey,
      "if-match": `"${beforeKnowledgeBaseDelete.resourceRevision}"`
    }
  };
  const knowledgeBaseDeletes = await Promise.all([
    developer.request(knowledgeBaseRoute(), deleteOptions),
    developer.request(knowledgeBaseRoute(), deleteOptions)
  ]);
  const knowledgeBaseDeleteStatuses = knowledgeBaseDeletes.map(
    (response) => response.status
  );
  assert(
    knowledgeBaseDeleteStatuses.every((status) => [202, 404, 409].includes(status))
      && knowledgeBaseDeleteStatuses.includes(202),
    `Knowledge-base deletion returned unsafe statuses ${knowledgeBaseDeleteStatuses.join(",")}.`
  );
  await waitUntilMissing(knowledgeBaseRoute());
  knowledgeBaseDeleted = true;
  pass("knowledge-base-delete-idempotent-replay", {
    statuses: knowledgeBaseDeleteStatuses
  });

  assertRepeatedConflictCoverage(report.checks.map((check) => check.name));
  report.ok = true;
} catch (error) {
  report.failures.push(error instanceof Error ? error.message : String(error));
  throw error;
} finally {
  if (knowledgeBaseId && !knowledgeBaseDeleted) {
    await deleteKnowledgeBase().catch((error) => {
      report.failures.push(
        `Knowledge-base cleanup failed: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }
  if (keyId) {
    await admin.request(`/admin/api/openapi-keys/${encodeURIComponent(keyId)}`, {
      method: "DELETE",
      headers: { origin: adminOrigin }
    }).catch(() => undefined);
  }
  await admin.request("/admin/api/logout", {
    method: "POST",
    headers: { origin: adminOrigin }
  }).catch(() => undefined);
  report.finishedAt = new Date().toISOString();
  writeJson(reportPath, report);
  await controller.persist();
}

process.stdout.write(`${JSON.stringify({
  runId,
  passed: report.checks.length,
  failed: report.failures.length,
  ok: report.ok
}, null, 2)}\n`);

function createUpload() {
  return createUploadSessionPhaseClient({
    client: developer,
    knowledgeBaseId,
    idempotencyPrefix: `${runId}-repeat`
  });
}

async function completeUpload(files, idempotencyKey) {
  const upload = createUpload();
  const created = await upload.create(files, { idempotencyKey });
  registerSession(created.session.id);
  try {
    await completeCreatedUpload(upload, created.session.id);
    const page = await upload.get(created.session.id, { limit: 100 });
    return {
      session: page.session,
      entries: page.entries?.items ?? []
    };
  } catch (error) {
    await upload.cancel(created.session.id).catch(() => undefined);
    throw error;
  }
}

async function completeCreatedUpload(upload, sessionId) {
  await upload.appendManifest(sessionId);
  let sealed = await upload.seal(sessionId);
  for (let attempt = 0; sealed.session?.counts?.waitingReservation > 0 && attempt < 20; attempt += 1) {
    await sleep(100);
    sealed = await upload.reconcile(sessionId);
  }
  if (sealed.session?.counts?.waitingReservation > 0) {
    throw new Error(`Upload session ${sessionId} did not resolve path reservations.`);
  }
  await upload.uploadMissingContent(sessionId, sealed.entries);
  await upload.finalize(sessionId);
  await waitForUploadSession(upload, sessionId);
}

async function waitForUploadSession(upload, sessionId, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await upload.get(sessionId, { limit: 1 });
    const state = current.session?.state;
    if (state === "completed") return current.session;
    if (["cancelled", "expired", "failed"].includes(state)) {
      throw new Error(`Upload session ${sessionId} ended in ${state}.`);
    }
    await sleep(200);
  }
  throw new Error(`Upload session ${sessionId} did not complete.`);
}

async function submitMutation(pathname, options) {
  const result = await submitMutationResult(pathname, options);
  if (result.status !== 202 || !result.body?.operation?.operationId) {
    throw new Error(
      `Mutation ${pathname} returned HTTP ${result.status}: ${JSON.stringify(result.body)}`
    );
  }
  return result.body.operation;
}

async function submitMutationResult(pathname, options) {
  const response = await developer.request(pathname, {
    method: options.method,
    headers: {
      ...(options.contentType ? { "content-type": options.contentType } : {}),
      "idempotency-key": options.idempotencyKey,
      "if-match": `"${options.revision}"`
    },
    rawBody: options.body
  });
  return {
    status: response.status,
    body: await readResponseBody(response)
  };
}

async function settleMutationResults(results) {
  return Promise.all(results.map(async (result) => {
    if (result.status !== 202) {
      return {
        state: "rejected",
        status: result.status,
        errorCode: result.body?.error?.code ?? null
      };
    }
    const operationId = result.body?.operation?.operationId;
    assert(operationId, "Accepted mutation returned no operation ID.");
    try {
      const operation = await waitForOperation(operationId);
      return { state: operation.state, status: 202, operationId };
    } catch (error) {
      return {
        state: "failed",
        status: 202,
        operationId,
        errorCode: error?.code ?? "RESOURCE_OPERATION_FAILED"
      };
    }
  }));
}

async function waitForOperation(operationId, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  const pathname = `${knowledgeBaseRoute()}/operations/${encodeURIComponent(operationId)}`;
  while (Date.now() < deadline) {
    const data = await developer.json(pathname);
    const operation = data.operation;
    if (operation.state === "completed") return operation;
    if (["failed", "cancelled", "superseded"].includes(operation.state)) {
      const error = new Error(
        `Resource operation ${operationId} ended in ${operation.state}.`
      );
      error.code = operation.errorCode ?? "RESOURCE_OPERATION_FAILED";
      throw error;
    }
    await sleep(200);
  }
  throw new Error(`Resource operation ${operationId} did not complete.`);
}

async function waitForVisibleFiles(expectedMinimum, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const files = await listSourceFiles();
    if (
      files.length >= expectedMinimum
      && files.every((file) => file.state === "visible")
    ) {
      return files;
    }
    const failed = files.find((file) => file.state === "failed");
    if (failed) {
      throw new Error(
        `Source file ${failed.relativePath} failed with ${failed.failure?.code ?? "UNKNOWN"}.`
      );
    }
    await sleep(250);
  }
  throw new Error("Source files did not reach visible state.");
}

async function listSourceFiles() {
  return listAll(sourceBase());
}

async function listDirectories() {
  const directories = [];
  const parents = ["root"];
  while (parents.length > 0) {
    const parentDirectoryId = parents.shift();
    const children = await listAll(
      `${directoryBase()}?parentDirectoryId=${encodeURIComponent(parentDirectoryId)}`
    );
    directories.push(...children);
    parents.push(...children.map((directory) => directory.directoryId));
  }
  return directories;
}

async function listAll(pathname) {
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

async function getSourceFile(sourceFileId) {
  const result = await developer.json(
    `${sourceBase()}/${encodeURIComponent(sourceFileId)}`
  );
  return result.sourceFile;
}

async function getKnowledgeBase() {
  const result = await developer.json(knowledgeBaseRoute());
  return result.knowledgeBase ?? result;
}

async function waitUntilMissing(pathname, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await developer.request(pathname);
    if (response.status === 404) return;
    if (!response.ok) {
      throw new Error(`Deletion wait returned HTTP ${response.status} for ${pathname}.`);
    }
    await sleep(250);
  }
  throw new Error(`Resource remained visible after deletion: ${pathname}.`);
}

async function deleteKnowledgeBase() {
  const current = await getKnowledgeBase();
  const response = await developer.request(knowledgeBaseRoute(), {
    method: "DELETE",
    headers: {
      "idempotency-key": `${runId}-repeat-cleanup`,
      "if-match": `"${current.resourceRevision}"`
    }
  });
  if (![202, 404].includes(response.status)) {
    throw new Error(`Knowledge-base cleanup returned HTTP ${response.status}.`);
  }
  if (response.status === 202) await waitUntilMissing(knowledgeBaseRoute());
  knowledgeBaseDeleted = true;
}

async function login() {
  await admin.json("/admin/api/login", {
    method: "POST",
    headers: { origin: adminOrigin },
    json: {
      username: requiredEnv("ADMIN_USERNAME"),
      password: requiredEnv("ADMIN_PASSWORD")
    }
  });
}

async function createOpenApiKey() {
  const result = await admin.json("/admin/api/openapi-keys", {
    method: "POST",
    headers: { origin: adminOrigin },
    json: { name: `repeated-conflict-${runId}` },
    expectedStatus: 201
  });
  const id = result.key?.id;
  const rawKey = result.oneTimeKey?.rawKey;
  assert(id && rawKey, "Admin API did not return a complete OpenAPI credential.");
  return { id, rawKey };
}

function readSamples(count) {
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(controller.state.evidenceDir, "corpus-manifest.json"),
      "utf8"
    )
  );
  return manifest.samples.slice(0, count).map((sample) =>
    fs.readFileSync(path.join(sourceRoot, sample.relativePath))
  );
}

function assertSingleWinner(outcomes, label) {
  const completed = outcomes.filter((outcome) => outcome.state === "completed");
  assert(
    completed.length === 1,
    `${label} produced ${completed.length} completed operations.`
  );
}

function assertStatusWinner(statuses, label) {
  assert(
    statuses.filter((status) => status === 200).length === 1
      && statuses.every((status) => [200, 409].includes(status)),
    `${label} returned unexpected statuses ${statuses.join(",")}.`
  );
}

function summarizeOutcomes(outcomes) {
  return {
    completed: outcomes.filter((outcome) => outcome.state === "completed").length,
    rejected: outcomes.filter((outcome) => outcome.state === "rejected").length,
    failed: outcomes.filter((outcome) => outcome.state === "failed").length
  };
}

function registerSession(sessionId) {
  controller.registerOwnership("uploadSessions", sessionId);
}

function pass(name, details = {}) {
  report.checks.push({ name, ok: true, details });
}

function knowledgeBaseRoute() {
  return `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`;
}

function uploadBase() {
  return `${knowledgeBaseRoute()}/upload-sessions`;
}

function sourceBase() {
  return `${knowledgeBaseRoute()}/source-files`;
}

function directoryBase() {
  return `${knowledgeBaseRoute()}/source-directories`;
}

function totalBytes(files) {
  return files.reduce((total, file) => total + file.bytes.byteLength, 0);
}

async function readResponseBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 300) };
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function loadLocalEnv() {
  const envFile = process.env.ENV_FILE || ".env";
  if (fs.existsSync(envFile)) loadEnvFile(envFile);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

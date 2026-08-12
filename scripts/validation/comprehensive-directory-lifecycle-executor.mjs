#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";

import { createAdminValidationRuntimePolicy } from
  "./lib/comprehensive-admin-validation-runtime-policy.mjs";
import { buildCrudExecutionFiles, safeHttpFailureReason } from
  "./lib/comprehensive-crud-execution.mjs";
import {
  assertDirectoryLifecycleExecutionState,
  createDirectoryLifecycleExecutionState,
  directoryCaseId,
  directoryDeletionResumeDecision,
  directoryIdempotencyKey,
  emptyDirectoryFixtureResumeDecision,
  nextDirectoryMutationAttempt,
  reconcileDirectoryImpacts,
  synchronizeDirectoryState,
  temporaryDirectoryPath,
  updateDirectorySubtreeState
} from "./lib/comprehensive-directory-lifecycle-execution.mjs";
import {
  DIRECTORY_LIFECYCLE_ACTIONS,
  assertComprehensiveDirectoryLifecyclePlan,
  buildComprehensiveDirectoryLifecyclePlan
} from "./lib/comprehensive-directory-lifecycle-matrix.mjs";
import { requestWithRateLimitRetry } from
  "./lib/comprehensive-rate-limit-retry.mjs";
import { uploadMarkdownFilesWithSession } from
  "./lib/upload-session-client.mjs";

loadLocalEnvironment();

const reportDirectory = requireReportDirectory();
const evidenceSuffix = resolveEvidenceSuffix();
const runId = `${path.basename(reportDirectory).replace(
  /^validation-\d{14}-/u,
  "clr-"
)}${evidenceSuffix ? `-${evidenceSuffix}` : ""}`;
const crudPlan = readJson(path.join(reportDirectory, "comprehensive-crud-plan.json"));
const manifest = readJson(path.join(reportDirectory, "corpus-manifest.json"));
const privateWorkspace = readJson(path.join(reportDirectory, "corpus-workspace-private.json"));
const corpusReport = readJson(path.join(reportDirectory, "corpus-e2e.json"));
const crudStatePath = path.join(reportDirectory, "comprehensive-crud-execution-private.json");
const crudState = readJson(crudStatePath);
const files = buildCrudExecutionFiles({
  plan: crudPlan,
  manifest,
  privateWorkspace,
  corpusReport
}).map((file) => ({
  ...file,
  sourceFileId: crudState.files[file.alias]?.sourceFileId ?? file.sourceFileId
}));
const fileByAlias = new Map(files.map((file) => [file.alias, file]));
const knowledgeBaseIds = [...new Set(files.map((file) => file.knowledgeBaseId))];
const planPath = path.join(reportDirectory, evidenceName(
  "comprehensive-directory-lifecycle-plan.json"
));
const statePath = path.join(reportDirectory, evidenceName(
  "comprehensive-directory-lifecycle-state-private.json"
));
const ledgerPath = path.join(reportDirectory, evidenceName(
  "comprehensive-directory-lifecycle-results.ndjson"
));
const summaryPath = path.join(reportDirectory, evidenceName(
  "comprehensive-directory-lifecycle-summary.json"
));
const operationTimeoutMs = resolveOperationTimeoutMs();
const selectedActions = readSelectedActions();

const admin = createHttpClient({
  baseUrl: `http://127.0.0.1:${process.env.ADMIN_API_PORT || "43000"}`,
  origin: process.env.ADMIN_PUBLIC_ORIGIN || "http://127.0.0.1:43100"
});
let developer = null;
let keyId = null;
let originalPublication = null;
let originalWorker = null;
let plan = null;
let state = null;
let completed = new Set();
let failure = null;
const cleanup = {
  keyDeleted: false,
  publicationRestored: false,
  workerRestored: false,
  loggedOut: false
};

try {
  await login();
  const runtime = await admin.json("/admin/api/settings/runtime");
  const runtimePolicy = createAdminValidationRuntimePolicy(runtime.settings);
  originalPublication = runtimePolicy.original.publication;
  originalWorker = runtimePolicy.original.worker;
  await admin.json("/admin/api/settings/publication", {
    method: "PUT",
    json: runtimePolicy.validation.publication
  });
  await admin.json("/admin/api/settings/worker", {
    method: "PUT",
    json: runtimePolicy.validation.worker
  });
  const credential = await admin.json("/admin/api/openapi-keys", {
    method: "POST",
    json: { name: `Comprehensive directory lifecycle ${runId} ${Date.now()}` },
    expectedStatus: 201
  });
  keyId = requiredString(credential.key?.id, "Temporary OpenAPI key ID");
  developer = createHttpClient({
    baseUrl: `http://127.0.0.1:${process.env.PUBLIC_OPENAPI_PORT || "43200"}`,
    authorization: `Bearer ${requiredString(
      credential.oneTimeKey?.rawKey,
      "Temporary OpenAPI raw key"
    )}`
  });
  const runtimeDirectories = await listAllDirectories();
  plan = loadOrCreatePlan(runtimeDirectories);
  state = loadOrCreateState();
  completed = new Set(state.completedCaseIds);
  synchronizeDirectoryState({ state, runtimeDirectories });
  synchronizeCrudFileState(await listAllSourceFiles());
  persistState();
  persistCrudState();
  initializeLedger();

  for (let directoryIndex = 0; directoryIndex < plan.directories.length; directoryIndex += 1) {
    const directory = plan.directories[directoryIndex];
    for (const action of selectedActions) {
      const plannedCase = plan.cases.find((item) =>
        item.directoryAlias === directory.directoryAlias && item.action === action
      );
      if (!plannedCase) throw new Error("Directory lifecycle planned case is missing");
      const id = plannedCase.id;
      if (completed.has(id)) continue;
      if (!plannedCase.applicable) {
        appendLedger({
          kind: "case",
          id,
          directoryAlias: directory.directoryAlias,
          action,
          ok: true,
          status: "not_applicable",
          reason: plannedCase.skipReason,
          completedAt: new Date().toISOString()
        });
        completeCase(id);
        continue;
      }
      await executePlannedCase(directory, action);
    }
    process.stdout.write(`${JSON.stringify({
      progress: true,
      completedDirectories: directoryIndex + 1,
      totalDirectories: plan.directories.length,
      completedCases: completed.size,
      totalCases: plan.counts.cases
    })}\n`);
  }
} catch (error) {
  failure = sanitizeError(error);
  process.exitCode = 1;
} finally {
  if (keyId) {
    cleanup.keyDeleted = await cleanupCall(() => admin.json(
      `/admin/api/openapi-keys/${encodeURIComponent(keyId)}`,
      { method: "DELETE" }
    ));
  }
  if (originalPublication) {
    cleanup.publicationRestored = await cleanupCall(() => admin.json(
      "/admin/api/settings/publication",
      { method: "PUT", json: originalPublication }
    ));
  }
  if (originalWorker) {
    cleanup.workerRestored = await cleanupCall(() => admin.json(
      "/admin/api/settings/worker",
      { method: "PUT", json: originalWorker }
    ));
  }
  cleanup.loggedOut = await cleanupCall(() => admin.json(
    "/admin/api/logout",
    { method: "POST" }
  ));
  if (state) persistState();
  writeSummary();
  process.stdout.write(`${JSON.stringify({
    ok: failure === null && Object.values(cleanup).every(Boolean),
    completedCases: completed.size,
    totalCases: plan?.counts?.cases ?? null,
    cleanup,
    failure,
    summaryPath
  })}\n`);
}

async function executePlannedCase(directory, action) {
  const id = directoryCaseId(directory.directoryAlias, action);
  const mutation = [
    "rename",
    "restore-after-rename",
    "move",
    "restore-after-move",
    "delete",
    "recreate"
  ].includes(action);
  const pendingMatches = state.pendingCase?.id === id;
  const before = mutation && pendingMatches && state.pendingCase.before
    ? state.pendingCase.before
    : mutation
      ? await captureSourceSnapshot()
      : null;
  state.pendingCase = {
    id,
    directoryAlias: directory.directoryAlias,
    action,
    phase: "executing",
    before,
    mutationInput: pendingMatches ? state.pendingCase.mutationInput : null,
    operationId: pendingMatches ? state.pendingCase.operationId ?? null : null,
    retryCount: pendingMatches ? state.pendingCase.retryCount ?? 0 : 0
  };
  persistState();
  const result = await executeCase(directory, action);
  let impactCount = 0;
  if (mutation) {
    const runtimeSources = await listAllSourceFiles();
    const runtimeDirectories = await listAllDirectories();
    synchronizeDirectoryState({ state, runtimeDirectories });
    synchronizeCrudFileState(runtimeSources);
    const after = await captureSourceSnapshot(runtimeSources);
    const impacts = reconcileDirectoryImpacts({
      files,
      directory,
      action,
      before,
      after,
      alreadyConverged: result.detail?.disposition === "resumed_existing"
    });
    if (impacts.length !== files.length || impacts.some((item) => !item.ok)) {
      throw new Error(`Directory lifecycle impact reconciliation failed for ${id}`);
    }
    for (const impact of impacts) appendLedger({ kind: "impact", ...impact });
    impactCount = impacts.length;
    persistCrudState();
  }
  appendLedger({
    kind: "case",
    id,
    directoryAlias: directory.directoryAlias,
    action,
    ok: true,
    status: result.status,
    operationIdHash: result.operationId ? sha256(result.operationId) : null,
    impactCount,
    detail: result.detail ?? null,
    completedAt: new Date().toISOString()
  });
  completeCase(id);
}

async function executeCase(directory, action) {
  const current = state.directories[directory.directoryAlias];
  if (action === "list") {
    const runtime = await listAllDirectoriesForKnowledgeBase(directory.knowledgeBaseId);
    if (!runtime.some((item) => item.directoryId === current.directoryId)) {
      throw new Error(`Directory list omitted ${directory.directoryAlias}`);
    }
    return { status: "listed", detail: { listed: true } };
  }
  if (action === "detail-read" || action === "final-detail-read") {
    const observed = await getDirectory(directory.knowledgeBaseId, current.directoryId);
    assertDirectoryIdentity(current, observed);
    return {
      status: "read",
      detail: {
        relativePathHash: sha256(observed.relativePath),
        resourceRevision: observed.resourceRevision,
        descendantFileCount: observed.descendantFileCount
      }
    };
  }
  if (action === "rename") {
    return mutateDirectoryPath(directory, temporaryDirectoryPath(directory, "rename"), action);
  }
  if (action === "restore-after-rename" || action === "restore-after-move") {
    return mutateDirectoryPath(directory, directory.relativePath, action);
  }
  if (action === "move") {
    return mutateDirectoryPath(directory, temporaryDirectoryPath(directory, "move"), action);
  }
  if (action === "delete") return deleteDirectory(directory);
  if (action === "recreate") return recreateDirectory(directory);
  throw new Error(`Unknown directory lifecycle action: ${action}`);
}

async function mutateDirectoryPath(directory, targetPath, action) {
  const current = state.directories[directory.directoryAlias];
  const runtimeBefore = await listAllDirectoriesForKnowledgeBase(directory.knowledgeBaseId);
  const alreadyConverged = runtimeBefore.find((item) => item.directoryId === current.directoryId);
  if (alreadyConverged?.relativePath === targetPath) {
    synchronizeDirectoryState({ state, runtimeDirectories: runtimeBefore });
    return { status: "resumed_converged", detail: { targetPathHash: sha256(targetPath) } };
  }
  const mutationInput = state.pendingCase.mutationInput ?? {
    directoryId: current.directoryId,
    resourceRevision: current.resourceRevision,
    targetPath,
    idempotencyKey: directoryIdempotencyKey(runId, directory.directoryAlias, action)
  };
  state.pendingCase.mutationInput = mutationInput;
  persistState();
  const operation = await executeDirectoryMutationWithRetry(directory.knowledgeBaseId, {
    method: "PATCH",
    bodyFor(input) {
      return { relativePath: input.targetPath };
    }
  });
  const runtimeDirectories = await listAllDirectoriesForKnowledgeBase(directory.knowledgeBaseId);
  synchronizeDirectoryState({ state, runtimeDirectories });
  const observed = runtimeDirectories.find((item) => item.directoryId === mutationInput.directoryId);
  if (observed?.relativePath !== targetPath) {
    throw new Error(`Directory path mutation did not converge for ${directory.directoryAlias}`);
  }
  return {
    status: "mutated",
    operationId: operation.operationId,
    detail: { targetPathHash: sha256(targetPath) }
  };
}

async function deleteDirectory(directory) {
  const current = state.directories[directory.directoryAlias];
  const runtimeBefore = await listAllDirectoriesForKnowledgeBase(directory.knowledgeBaseId);
  const directoryPresent = runtimeBefore.some((item) =>
    item.directoryId === current.directoryId
  );
  if (directoryDeletionResumeDecision({
    directoryPresent,
    hasMutationInput: Boolean(state.pendingCase.mutationInput)
  }) === "unowned_missing_target") {
    throw new Error(`Directory deletion target is missing without an owned operation: ${
      directory.directoryAlias
    }`);
  }
  const mutationInput = state.pendingCase.mutationInput ?? {
    directoryId: current.directoryId,
    resourceRevision: current.resourceRevision,
    idempotencyKey: directoryIdempotencyKey(runId, directory.directoryAlias, "delete")
  };
  state.pendingCase.mutationInput = mutationInput;
  persistState();
  const operation = await executeDirectoryMutationWithRetry(directory.knowledgeBaseId, {
    method: "DELETE"
  });
  await waitForDirectoryMissing(directory.knowledgeBaseId, mutationInput.directoryId);
  markDeletedSubtree(directory);
  return { status: "deleted", operationId: operation.operationId };
}

function resolveEvidenceSuffix() {
  const value = process.env.FOCOWIKI_COMPREHENSIVE_DIRECTORY_EVIDENCE_SUFFIX?.trim()
    ?? "";
  if (value && !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(value)) {
    throw new Error("Comprehensive directory evidence suffix is invalid");
  }
  return value;
}

function evidenceName(filename) {
  if (!evidenceSuffix) return filename;
  const extension = path.extname(filename);
  return `${filename.slice(0, -extension.length)}-${evidenceSuffix}${extension}`;
}

async function recreateDirectory(directory) {
  const expectedFiles = directory.descendantAliases.map((alias) => {
    const file = fileByAlias.get(alias);
    if (!file) throw new Error(`Directory descendant file is missing for ${alias}`);
    return file;
  });
  if (expectedFiles.length === 0) {
    return recreateEmptyDirectory(directory);
  }
  const currentSources = await listAllSourceFilesForKnowledgeBase(directory.knowledgeBaseId);
  const byPath = new Map(currentSources.map((item) => [item.relativePath, item]));
  const alreadyVisible = expectedFiles.every((file) =>
    byPath.get(file.originalRelativePath)?.state === "visible"
  );
  let disposition = "resumed_existing";
  if (!alreadyVisible) {
    const upload = await uploadMarkdownFilesWithSession({
      request: uploadRequest,
      routeBase: `/openapi/v2/knowledge-bases/${encodeURIComponent(
        directory.knowledgeBaseId
      )}/upload-sessions`,
      idempotencyKey: `clr-directory-recreate-${Date.now()}-${directory.directoryAlias}`,
      finalizationPollIntervalMs: 200,
      finalizationTimeoutMs: operationTimeoutMs,
      files: expectedFiles.map((file) => ({
        relativePath: file.originalRelativePath,
        bytes: fs.readFileSync(file.stagedPath)
      }))
    });
    disposition = upload.session?.state ?? "uploaded";
  }
  await waitForSourcePathsVisible(
    directory.knowledgeBaseId,
    expectedFiles.map((file) => file.originalRelativePath)
  );
  const runtimeDirectories = await listAllDirectoriesForKnowledgeBase(directory.knowledgeBaseId);
  updateDirectorySubtreeState({ state, target: directory, runtimeDirectories });
  const observed = runtimeDirectories.find((item) => item.relativePath === directory.relativePath);
  if (!observed) throw new Error("Recreated directory root is missing");
  return {
    status: "recreated",
    detail: { fileCount: expectedFiles.length, disposition }
  };
}

async function recreateEmptyDirectory(directory) {
  const fixturePath = `${directory.relativePath}/__clr_empty_directory_recreation.md`;
  const fixtureBody = Buffer.from(
    "# Empty directory recreation\n\nThis temporary validation source recreates an empty directory.\n"
  );
  const currentSources = await listAllSourceFilesForKnowledgeBase(directory.knowledgeBaseId);
  let fixture = currentSources.find((source) => source.relativePath === fixturePath) ?? null;
  const resumeDecision = emptyDirectoryFixtureResumeDecision(fixture);
  let fixtureUploadState = "resumed_existing";
  if (resumeDecision === "upload") {
    const upload = await uploadMarkdownFilesWithSession({
      request: uploadRequest,
      routeBase: `/openapi/v2/knowledge-bases/${encodeURIComponent(
        directory.knowledgeBaseId
      )}/upload-sessions`,
      idempotencyKey: `clr-empty-directory-recreate-${Date.now()}-${directory.directoryAlias}`,
      finalizationPollIntervalMs: 200,
      finalizationTimeoutMs: operationTimeoutMs,
      files: [{ relativePath: fixturePath, bytes: fixtureBody }]
    });
    fixtureUploadState = upload.session?.state ?? "uploaded";
    [fixture] = await waitForSourcePathsVisible(directory.knowledgeBaseId, [fixturePath]);
  }
  if (!fixture) throw new Error("Empty directory fixture is unavailable");
  const deleteResponse = await developer.request(
    `/openapi/v2/knowledge-bases/${encodeURIComponent(directory.knowledgeBaseId)}`
      + `/source-files/${encodeURIComponent(fixture.sourceFileId)}`,
    {
      method: "DELETE",
      headers: {
        "idempotency-key": directoryIdempotencyKey(
          runId,
          directory.directoryAlias,
          "empty-fixture-delete"
        ),
        "if-match": `"${fixture.resourceRevision}"`
      }
    }
  );
  const deleteText = await deleteResponse.text();
  const deleteBody = deleteText ? JSON.parse(deleteText) : null;
  expectStatus(deleteResponse, 202, "empty directory fixture deletion", deleteBody);
  const operationId = requiredString(
    deleteBody?.operation?.operationId,
    "Empty directory fixture deletion operation ID"
  );
  await waitForOperation(directory.knowledgeBaseId, operationId);
  await waitForSourceMissing(directory.knowledgeBaseId, fixture.sourceFileId);
  const runtimeDirectories = await listAllDirectoriesForKnowledgeBase(directory.knowledgeBaseId);
  updateDirectorySubtreeState({ state, target: directory, runtimeDirectories });
  return {
    status: "recreated_empty",
    operationId,
    detail: { fixtureUploadState }
  };
}

async function acceptDirectoryMutation(knowledgeBaseId, input) {
  const route = `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`
    + `/source-directories/${encodeURIComponent(input.directoryId)}`;
  const response = await developer.request(route, {
    method: input.method,
    headers: {
      "idempotency-key": input.idempotencyKey,
      "if-match": `"${input.resourceRevision}"`,
      ...(input.body ? { "content-type": "application/json" } : {})
    },
    body: input.body ? JSON.stringify(input.body) : undefined
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  expectStatus(response, 202, route, body);
  const operation = body?.operation;
  if (!operation?.operationId) throw new Error("Directory mutation has no operation identity");
  return operation;
}

async function executeDirectoryMutationWithRetry(knowledgeBaseId, input) {
  while (true) {
    const mutationInput = state.pendingCase.mutationInput;
    const operation = state.pendingCase.operationId
      ? { operationId: state.pendingCase.operationId }
      : await acceptDirectoryMutation(knowledgeBaseId, {
          method: input.method,
          ...mutationInput,
          ...(input.bodyFor ? { body: input.bodyFor(mutationInput) } : {})
        });
    state.pendingCase.operationId = operation.operationId;
    persistState();
    try {
      await waitForOperation(knowledgeBaseId, operation.operationId);
      return operation;
    } catch (error) {
      if (!error?.directoryOperationTerminalState) throw error;
      const runtimeDirectories = await listAllDirectoriesForKnowledgeBase(knowledgeBaseId);
      const observed = runtimeDirectories.find((item) =>
        item.directoryId === mutationInput.directoryId
      );
      if (!observed && input.method !== "DELETE") throw error;
      const next = nextDirectoryMutationAttempt({
        mutationInput,
        retryCount: state.pendingCase.retryCount ?? 0,
        terminalState: error.directoryOperationTerminalState,
        currentResourceRevision:
          observed?.resourceRevision ?? mutationInput.resourceRevision
      });
      if (!next) throw error;
      state.pendingCase.mutationInput = next.mutationInput;
      state.pendingCase.retryCount = next.retryCount;
      state.pendingCase.operationId = null;
      persistState();
    }
  }
}

async function waitForOperation(knowledgeBaseId, operationId) {
  const deadline = Date.now() + operationTimeoutMs;
  const route = `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`
    + `/operations/${encodeURIComponent(operationId)}`;
  while (Date.now() < deadline) {
    const body = await developer.json(route);
    if (body.operation?.state === "completed") return body.operation;
    if (["failed", "cancelled", "superseded"].includes(body.operation?.state)) {
      throw Object.assign(
        new Error(`Directory operation ended in ${body.operation.state}: ${
          body.operation.errorCode ?? "UNKNOWN"
        }`),
        {
          directoryOperationTerminalState: body.operation.state,
          directoryOperationErrorCode: body.operation.errorCode ?? "UNKNOWN"
        }
      );
    }
    await sleep(200);
  }
  throw new Error("Directory operation timed out");
}

async function waitForDirectoryMissing(knowledgeBaseId, directoryId) {
  const deadline = Date.now() + operationTimeoutMs;
  const route = `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`
    + `/source-directories/${encodeURIComponent(directoryId)}`;
  while (Date.now() < deadline) {
    const response = await developer.request(route);
    if (response.status === 404) return;
    if (response.status !== 200) {
      const text = await response.text();
      expectStatus(response, 200, route, text ? JSON.parse(text) : null);
    }
    await sleep(200);
  }
  throw new Error("Directory deletion visibility timed out");
}

async function waitForSourceMissing(knowledgeBaseId, sourceFileId) {
  const deadline = Date.now() + operationTimeoutMs;
  const route = `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`
    + `/source-files/${encodeURIComponent(sourceFileId)}`;
  while (Date.now() < deadline) {
    const response = await developer.request(route);
    if (response.status === 404) return;
    if (response.status !== 200) {
      const text = await response.text();
      expectStatus(response, 200, route, text ? JSON.parse(text) : null);
    }
    await sleep(200);
  }
  throw new Error("Empty directory fixture deletion timed out");
}

async function waitForSourcePathsVisible(knowledgeBaseId, relativePaths) {
  const expected = new Set(relativePaths);
  const deadline = Date.now() + operationTimeoutMs;
  while (Date.now() < deadline) {
    const sources = await listAllSourceFilesForKnowledgeBase(knowledgeBaseId);
    const matching = sources.filter((item) => expected.has(item.relativePath));
    const failed = matching.find((item) => item.state === "failed");
    if (failed) {
      throw new Error(`Directory recreation source failed: ${failed.failure?.code ?? "UNKNOWN"}`);
    }
    if (matching.length === expected.size && matching.every((item) =>
      item.state === "visible" && item.generatedOutputStatus === "visible"
    )) return matching;
    await sleep(200);
  }
  throw new Error("Directory recreation source visibility timed out");
}

async function getDirectory(knowledgeBaseId, directoryId) {
  const body = await developer.json(
    `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`
      + `/source-directories/${encodeURIComponent(directoryId)}`
  );
  return body.directory;
}

async function listAllDirectories() {
  return (await Promise.all(knowledgeBaseIds.map(listAllDirectoriesForKnowledgeBase))).flat();
}

async function listAllDirectoriesForKnowledgeBase(knowledgeBaseId) {
  const result = [];
  const queue = [null];
  while (queue.length > 0) {
    const parentDirectoryId = queue.shift();
    const query = new URLSearchParams({
      limit: "100",
      parentDirectoryId: parentDirectoryId ?? "root"
    });
    const children = await listAll(
      `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`
        + `/source-directories?${query}`
    );
    result.push(...children.map((item) => ({ ...item, knowledgeBaseId })));
    queue.push(...children.map((item) => item.directoryId));
  }
  return result;
}

async function listAllSourceFiles() {
  return (await Promise.all(knowledgeBaseIds.map(listAllSourceFilesForKnowledgeBase))).flat();
}

async function listAllSourceFilesForKnowledgeBase(knowledgeBaseId) {
  return (await listAll(
    `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-files`
  )).map((item) => ({ ...item, knowledgeBaseId }));
}

async function listAll(route) {
  const result = [];
  let cursor = null;
  do {
    const separator = route.includes("?") ? "&" : "?";
    const body = await developer.json(
      `${route}${cursor ? `${separator}cursor=${encodeURIComponent(cursor)}` : ""}`
    );
    result.push(...(body.items ?? []));
    cursor = body.nextCursor ?? null;
  } while (cursor);
  return result;
}

async function captureSourceSnapshot(runtimeSources = null) {
  const sourceRows = runtimeSources ?? await listAllSourceFiles();
  const byId = new Map(sourceRows.map((item) => [item.sourceFileId, item]));
  const byPath = new Map(sourceRows.map((item) => [
    `${item.knowledgeBaseId}\0${item.relativePath}`,
    item
  ]));
  return Object.fromEntries(files.map((file) => {
    const current = crudState.files[file.alias];
    const source = byId.get(current.sourceFileId)
      ?? byPath.get(`${file.knowledgeBaseId}\0${file.originalRelativePath}`);
    return [file.alias, publicSourceState(source, current.sourceFileId)];
  }));
}

function synchronizeCrudFileState(runtimeSources) {
  const byId = new Map(runtimeSources.map((item) => [item.sourceFileId, item]));
  const byPath = new Map(runtimeSources.map((item) => [
    `${item.knowledgeBaseId}\0${item.relativePath}`,
    item
  ]));
  for (const file of files) {
    const current = crudState.files[file.alias];
    const source = byId.get(current.sourceFileId)
      ?? byPath.get(`${file.knowledgeBaseId}\0${file.originalRelativePath}`);
    if (!source) {
      current.currentRelativePath = null;
      current.resourceRevision = null;
      current.state = "deleted";
      continue;
    }
    current.sourceFileId = source.sourceFileId;
    current.currentRelativePath = source.relativePath;
    current.resourceRevision = source.resourceRevision;
    current.state = source.state;
  }
}

function markDeletedSubtree(directory) {
  const prefix = `${directory.relativePath}/`;
  for (const current of Object.values(state.directories)) {
    if (
      current.knowledgeBaseId === directory.knowledgeBaseId
      && (current.originalRelativePath === directory.relativePath
        || current.originalRelativePath.startsWith(prefix))
    ) {
      current.state = "deleted";
    }
  }
}

function assertDirectoryIdentity(expected, observed) {
  if (
    !observed
    || observed.directoryId !== expected.directoryId
    || observed.relativePath !== expected.currentRelativePath
    || observed.resourceRevision !== expected.resourceRevision
  ) {
    throw new Error("Directory detail identity is inconsistent");
  }
}

function publicSourceState(source, fallbackSourceFileId) {
  if (!source) {
    return {
      present: false,
      sourceFileIdHash: fallbackSourceFileId ? sha256(fallbackSourceFileId) : null,
      relativePathHash: null,
      resourceRevision: null,
      contentRevision: null,
      state: "deleted",
      currentStage: null,
      generatedPathHash: null,
      generatedOutputStatus: null
    };
  }
  return {
    present: true,
    sourceFileIdHash: sha256(source.sourceFileId),
    relativePathHash: sha256(source.relativePath),
    resourceRevision: source.resourceRevision,
    contentRevision: source.contentRevision,
    state: source.state,
    currentStage: source.currentStage,
    generatedPathHash: source.generatedPath ? sha256(source.generatedPath) : null,
    generatedOutputStatus: source.generatedOutputStatus
  };
}

async function uploadRequest(route, options) {
  return developer.json(route, {
    method: options.method,
    query: options.query,
    headers: {
      ...(options.headers ?? {}),
      ...(options.body ? { "content-type": "application/json" } : {})
    },
    rawBody: options.rawBody,
    body: options.body ? JSON.stringify(options.body) : undefined,
    expectedStatus: options.status
  });
}

function loadOrCreatePlan(runtimeDirectories) {
  if (fs.existsSync(planPath)) {
    const existing = readJson(planPath);
    return assertComprehensiveDirectoryLifecyclePlan(existing, {
      expectedFileCount: 200,
      expectedDirectoryCount: existing.counts?.directories
    });
  }
  const created = buildComprehensiveDirectoryLifecyclePlan({
    files: files.map((file) => ({
      alias: file.alias,
      knowledgeBaseId: file.knowledgeBaseId,
      relativePath: file.originalRelativePath
    })),
    directories: runtimeDirectories
  });
  fs.writeFileSync(planPath, `${JSON.stringify(created, null, 2)}\n`, { mode: 0o600 });
  return assertComprehensiveDirectoryLifecyclePlan(created, {
    expectedFileCount: 200,
    expectedDirectoryCount: runtimeDirectories.length
  });
}

function loadOrCreateState() {
  if (!fs.existsSync(statePath)) {
    const created = createDirectoryLifecycleExecutionState(plan.directories, runId);
    fs.writeFileSync(statePath, `${JSON.stringify(created, null, 2)}\n`, { mode: 0o600 });
    return created;
  }
  return assertDirectoryLifecycleExecutionState(
    readJson(statePath),
    plan.directories,
    runId
  );
}

function completeCase(id) {
  completed.add(id);
  state.completedCaseIds.push(id);
  state.pendingCase = null;
  persistState();
}

function persistState() {
  state.updatedAt = new Date().toISOString();
  writeJsonAtomic(statePath, state);
}

function persistCrudState() {
  crudState.updatedAt = new Date().toISOString();
  writeJsonAtomic(crudStatePath, crudState);
}

function initializeLedger() {
  if (fs.existsSync(ledgerPath)) return;
  appendLedger({
    kind: "header",
    schema: "focowiki-comprehensive-directory-lifecycle-results",
    version: 1,
    runId,
    plannedFiles: plan.counts.files,
    plannedDirectories: plan.counts.directories,
    plannedCases: plan.counts.cases,
    startedAt: new Date().toISOString()
  });
}

function appendLedger(row) {
  fs.appendFileSync(ledgerPath, `${JSON.stringify(row)}\n`, { mode: 0o600 });
}

function writeSummary() {
  const actionCounts = plan ? Object.fromEntries(DIRECTORY_LIFECYCLE_ACTIONS.map((action) => [
    action,
    plan.directories.filter((directory) => completed.has(directoryCaseId(
      directory.directoryAlias,
      action
    ))).length
  ])) : {};
  const summary = {
    kind: "focowiki-comprehensive-directory-lifecycle-summary",
    version: 1,
    runId,
    updatedAt: new Date().toISOString(),
    ok: failure === null && Object.values(cleanup).every(Boolean),
    complete: plan ? completed.size === plan.counts.cases : false,
    planned: plan?.counts ?? null,
    completedCases: completed.size,
    actionCounts,
    cleanup,
    failure
  };
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
}

function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function createHttpClient(input) {
  let cookie = "";
  return {
    async request(route, options = {}) {
      const response = await requestWithRateLimitRetry({
        maximumRetries: 12,
        request: async () => {
          const url = new URL(route, `${input.baseUrl}/`);
          for (const [key, value] of Object.entries(options.query ?? {})) {
            if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
          }
          const raw = await fetch(url, {
            method: options.method ?? "GET",
            headers: {
              ...(cookie ? { cookie } : {}),
              ...(input.authorization ? { authorization: input.authorization } : {}),
              ...(input.origin ? { origin: input.origin } : {}),
              ...(options.json === undefined ? {} : { "content-type": "application/json" }),
              ...(options.headers ?? {})
            },
            body: options.rawBody ?? options.body
              ?? (options.json === undefined ? undefined : JSON.stringify(options.json))
          });
          return { response: raw, status: raw.status, retryAfter: raw.headers.get("retry-after") };
        }
      });
      const setCookie = response.response.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";", 1)[0] ?? "";
      return response.response;
    },
    async json(route, options = {}) {
      const response = await this.request(route, options);
      const text = await response.text();
      const body = text ? JSON.parse(text) : null;
      expectStatus(response, options.expectedStatus ?? 200, route, body);
      return body;
    }
  };
}

function expectStatus(response, expectedStatus, label, body = null) {
  if (response.status !== expectedStatus) {
    throw new Error(`${label} returned HTTP ${response.status} (${safeHttpFailureReason(body)})`);
  }
}

async function login() {
  await admin.json("/admin/api/login", {
    method: "POST",
    json: {
      username: requiredEnv("ADMIN_USERNAME"),
      password: requiredEnv("ADMIN_PASSWORD")
    }
  });
}

function readSelectedActions() {
  const value = process.env.FOCOWIKI_COMPREHENSIVE_DIRECTORY_ACTIONS?.trim();
  if (!value) return [...DIRECTORY_LIFECYCLE_ACTIONS];
  const requested = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (requested.length === 0 || requested.some((item) =>
    !DIRECTORY_LIFECYCLE_ACTIONS.includes(item)
  )) {
    throw new Error("FOCOWIKI_COMPREHENSIVE_DIRECTORY_ACTIONS contains an unknown action");
  }
  return DIRECTORY_LIFECYCLE_ACTIONS.filter((item) => requested.includes(item));
}

function resolveOperationTimeoutMs() {
  const configured = process.env.FOCOWIKI_COMPREHENSIVE_OPERATION_TIMEOUT_MS;
  const value = configured ? Number(configured) : 20 * 60_000;
  if (!Number.isSafeInteger(value) || value < 15 * 60_000) {
    throw new Error("FOCOWIKI_COMPREHENSIVE_OPERATION_TIMEOUT_MS must be at least 900000");
  }
  return value;
}

function requireReportDirectory() {
  const value = process.env.FOCOWIKI_COMPREHENSIVE_REPORT_DIR?.trim();
  if (
    !value
    || !/^ReferenceDocs\/validation\/comprehensive-large-scale-release\/validation-\d{14}-[a-f0-9]{8}$/u.test(value)
  ) {
    throw new Error("FOCOWIKI_COMPREHENSIVE_REPORT_DIR must be an exact ignored run-owned directory");
  }
  return path.resolve(value);
}

function loadLocalEnvironment() {
  const envPath = path.resolve(process.env.ENV_FILE || ".env");
  if (fs.existsSync(envPath)) loadEnvFile(envPath);
}

function requiredEnv(name) {
  return requiredString(process.env[name], name);
}

function requiredString(value, name) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function sanitizeError(error) {
  let message = error instanceof Error ? error.message : String(error);
  for (const file of files) {
    message = message.replaceAll(file.stagedPath, `<${file.alias}>`);
    message = message.replaceAll(file.originalRelativePath, `<${file.alias}-path>`);
  }
  return { name: error instanceof Error ? error.name : "Error", message };
}

async function cleanupCall(operation) {
  try {
    await operation();
    return true;
  } catch {
    return false;
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

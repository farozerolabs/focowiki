#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";

import { createAdminValidationRuntimePolicy } from
  "./lib/comprehensive-admin-validation-runtime-policy.mjs";
import {
  actionRelativePath,
  assertCrudExecutionState,
  buildContentMutationBody,
  buildCrudExecutionFiles,
  caseId,
  classifyDeleteMutationResponse,
  controlledSourceFailureResumeDecision,
  createCrudExecutionState,
  expectedTargetDisposition,
  expectedMissingSourceAliases,
  idempotencyKey,
  mutationResumeDecision,
  publicCaseResult,
  reconcileMutationImpact,
  replayProbeRelativePath,
  resolveCrudOperationTimeoutMs,
  safeHttpFailureReason,
  selectControlledFailureModelId,
  shouldPrepareFreshReplay,
  snapshotSourceFiles
} from "./lib/comprehensive-crud-execution.mjs";
import { CRUD_FILE_ACTIONS, CRUD_MUTATION_ACTIONS } from
  "./lib/comprehensive-crud-matrix.mjs";
import { requestWithRateLimitRetry } from
  "./lib/comprehensive-rate-limit-retry.mjs";
import { uploadMarkdownFilesWithSession } from
  "./lib/upload-session-client.mjs";

loadLocalEnvironment();

const reportDirectory = requireReportDirectory();
const runId = path.basename(reportDirectory).replace(/^validation-\d{14}-/u, "clr-");
const plan = readJson(path.join(reportDirectory, "comprehensive-crud-plan.json"));
const manifest = readJson(path.join(reportDirectory, "corpus-manifest.json"));
const privateWorkspace = readJson(path.join(reportDirectory, "corpus-workspace-private.json"));
const corpusReport = readJson(path.join(reportDirectory, "corpus-e2e.json"));
const files = buildCrudExecutionFiles({ plan, manifest, privateWorkspace, corpusReport });
const fileByAlias = new Map(files.map((file) => [file.alias, file]));
const statePath = path.join(reportDirectory, "comprehensive-crud-execution-private.json");
const ledgerPath = path.join(reportDirectory, "comprehensive-crud-results.ndjson");
const summaryPath = path.join(reportDirectory, "comprehensive-crud-summary.json");
const selectedActions = readSelectedActions();
const operationTimeoutMs = resolveCrudOperationTimeoutMs(
  process.env.FOCOWIKI_COMPREHENSIVE_OPERATION_TIMEOUT_MS
);
const state = loadState();
const completed = new Set(state.completedCaseIds);
state.mutationInputs ??= {};

const admin = createHttpClient({
  baseUrl: `http://127.0.0.1:${process.env.ADMIN_API_PORT || "43000"}`,
  origin: process.env.ADMIN_PUBLIC_ORIGIN || "http://127.0.0.1:43100"
});
let developer = null;
let keyId = null;
let originalPublication = null;
let originalWorker = null;
const cleanup = {
  keyDeleted: false,
  modelRestored: true,
  publicationRestored: false,
  workerRestored: false,
  loggedOut: false
};
let failure = null;
let controlledFailureModelId = null;
let controlledFailureModelPaused = false;

initializeLedger();

try {
  await login();
  const runtime = await admin.json("/admin/api/settings/runtime");
  const runtimePolicy = createAdminValidationRuntimePolicy(runtime.settings);
  originalPublication = runtimePolicy.original.publication;
  originalWorker = runtimePolicy.original.worker;
  if (selectedActions.includes("controlled-source-failure")) {
    controlledFailureModelId = selectControlledFailureModelId(runtime.models);
  }
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
    json: { name: `Comprehensive CRUD ${runId} ${Date.now()}` },
    expectedStatus: 201
  });
  keyId = requiredString(credential.key?.id, "Temporary OpenAPI key ID");
  const rawKey = requiredString(credential.oneTimeKey?.rawKey, "Temporary OpenAPI raw key");
  developer = createHttpClient({
    baseUrl: `http://127.0.0.1:${process.env.PUBLIC_OPENAPI_PORT || "43200"}`,
    authorization: `Bearer ${rawKey}`
  });

  await synchronizeStateFromRuntime();
  for (const action of selectedActions) {
    if (action === "controlled-source-failure") {
      await pauseControlledFailureModel();
      try {
        await executeAction(action);
      } finally {
        cleanup.modelRestored = await cleanupCall(restoreControlledFailureModel);
      }
    } else {
      await executeAction(action);
    }
  }
} catch (error) {
  failure = sanitizeError(error);
  process.exitCode = 1;
} finally {
  if (controlledFailureModelPaused) {
    cleanup.modelRestored = await cleanupCall(restoreControlledFailureModel);
  }
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
    "/admin/api/logout", { method: "POST" }
  ));
  persistState();
  writeSummary();
  process.stdout.write(`${JSON.stringify({
    ok: failure === null && Object.values(cleanup).every(Boolean),
    completedCases: completed.size,
    selectedActions,
    cleanup,
    failure,
    summaryPath
  })}\n`);
}

async function executeAction(action) {
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const id = caseId(file.alias, action);
    if (completed.has(id)) continue;
    const mutation = CRUD_MUTATION_ACTIONS.includes(action);
    const replayProtocol = requiresFreshReplaySetup(action) ? "fresh-replay-v1" : null;
    if (replayProtocol && shouldPrepareFreshReplay(state.pendingCase, id, replayProtocol)) {
      state.pendingCase = {
        id,
        alias: file.alias,
        action,
        protocol: replayProtocol,
        phase: "preparing",
        before: null
      };
      persistState();
      if (action === "replace-content-idempotent-replay") {
        await prepareFreshContentReplay(file, action);
      } else {
        await prepareFreshPathReplay(file, action);
      }
    }
    const before = mutation
      ? state.pendingCase?.id === id
        && state.pendingCase.protocol === replayProtocol
        && state.pendingCase.before
        ? state.pendingCase.before
        : await captureSnapshot()
      : null;
    state.pendingCase = {
      id,
      alias: file.alias,
      action,
      protocol: replayProtocol,
      phase: "executing",
      before
    };
    persistState();
    const result = await executeCase(file, action);
    let impacts = [];
    if (mutation) {
      const after = await captureSnapshot();
      impacts = reconcileMutationImpact({
        before,
        after,
        mutationAlias: file.alias,
        action,
        expectedTargetDisposition: expectedTargetDisposition(action)
      });
      if (impacts.length !== files.length || impacts.some((row) => !row.ok)) {
        throw new Error(`CRUD impact reconciliation failed for ${id}`);
      }
      synchronizeFileState(after);
    }
    appendLedger(publicCaseResult({
      alias: file.alias,
      family: file.family,
      action,
      ok: true,
      status: result.status,
      httpStatus: result.httpStatus,
      operationId: result.operationId,
      sourceFileId: state.files[file.alias].sourceFileId,
      checksumVerified: result.checksumVerified,
      detail: result.detail
    }));
    for (const impact of impacts) appendLedger({ kind: "impact", ...impact });
    completed.add(id);
    state.completedCaseIds.push(id);
    state.pendingCase = null;
    persistState();
    if ((index + 1) % 10 === 0 || index + 1 === files.length) {
      process.stdout.write(`${JSON.stringify({
        progress: true,
        action,
        completedInAction: index + 1,
        totalInAction: files.length,
        completedCases: completed.size
      })}\n`);
    }
  }
}

async function executeCase(file, action) {
  if (action === "list") return readList(file);
  if (["detail-read", "final-detail-read"].includes(action)) return readDetail(file);
  if (["content-read", "final-content-read"].includes(action)) return readContent(file);
  if (["preview-read", "final-preview-read"].includes(action)) return readPreview(file);
  if (action === "duplicate-upload") return duplicateUpload(file);
  if (action === "cancel-upload") return cancelUpload(file);
  if ([
    "rename",
    "rename-idempotent-replay",
    "move",
    "move-idempotent-replay",
    "restore-path"
  ].includes(action)) return mutatePath(file, action);
  if ([
    "replace-content",
    "replace-content-idempotent-replay",
    "restore-content",
    "restore-after-retry"
  ].includes(action)) return mutateContent(file, action);
  if (action === "controlled-source-failure") {
    return induceTerminalSourceFailure(file);
  }
  if (action === "terminal-retry") return retryTerminalSource(file);
  if (["delete", "delete-idempotent-replay"].includes(action)) {
    return deleteSource(file, action);
  }
  if (action === "recreate") return recreateSource(file);
  throw new Error(`CRUD action ${action} is not implemented by this executor yet`);
}

async function readList(file) {
  const rows = await listSources(file.knowledgeBaseId);
  if (!rows.some((row) => row.sourceFileId === state.files[file.alias].sourceFileId)) {
    throw new Error(`List omitted ${file.alias}`);
  }
  return { status: "listed", httpStatus: 200, detail: { collectionCount: rows.length } };
}

async function readDetail(file) {
  const source = await getSource(file.alias);
  assertVisibleIdentity(file, source);
  return { status: "read", httpStatus: 200, detail: publicReadDetail(source) };
}

async function readContent(file) {
  const response = await developer.request(sourceRoute(file, "/content"));
  const body = Buffer.from(await response.arrayBuffer());
  expectStatus(response, 200, "source content read");
  const checksumVerified = sha256(body) === file.checksumSha256;
  if (!checksumVerified) throw new Error(`Source checksum changed for ${file.alias}`);
  return {
    status: "read",
    httpStatus: 200,
    checksumVerified,
    detail: {
      byteCount: body.byteLength,
      etagPresent: Boolean(response.headers.get("etag")),
      contentRevisionPresent: Boolean(response.headers.get("x-content-revision"))
    }
  };
}

async function readPreview(file) {
  const source = await getSource(file.alias);
  assertVisibleIdentity(file, source);
  if (!source.generatedPath) throw new Error(`Generated path is missing for ${file.alias}`);
  const body = await developer.json(
    `/openapi/v2/knowledge-bases/${encodeURIComponent(file.knowledgeBaseId)}`
      + `/files/content?path=${encodeURIComponent(source.generatedPath)}`
  );
  if (typeof body.content !== "string" || body.content.length === 0) {
    throw new Error(`Generated preview is empty for ${file.alias}`);
  }
  return {
    status: "read",
    httpStatus: 200,
    detail: { generatedByteCount: Buffer.byteLength(body.content), generatedContentReadable: true }
  };
}

async function duplicateUpload(file) {
  const bytes = fs.readFileSync(file.stagedPath);
  const uploaded = await uploadMarkdownFilesWithSession({
    request: uploadRequest,
    routeBase: uploadBase(file),
    files: [{ relativePath: file.originalRelativePath, bytes }],
    idempotencyKey: idempotencyKey(runId, file.alias, "duplicate-upload"),
    finalizationPollIntervalMs: 100,
    finalizationTimeoutMs: 5 * 60_000
  });
  const entry = uploaded.entries[0];
  if (
    uploaded.session?.state !== "completed"
    || entry?.disposition !== "skipped_existing"
    || entry?.sourceFileId !== state.files[file.alias].sourceFileId
  ) {
    throw new Error(`Duplicate upload changed source ownership for ${file.alias}`);
  }
  return {
    status: "deduplicated",
    httpStatus: 200,
    detail: { disposition: entry.disposition, terminalState: uploaded.session.state }
  };
}

async function cancelUpload(file) {
  const bytes = fs.readFileSync(file.stagedPath);
  const alternatePath = `__clr_cancelled/${file.family}/${file.alias}.md`;
  const created = await developer.json(uploadBase(file), {
    method: "POST",
    headers: { "idempotency-key": idempotencyKey(runId, file.alias, "cancel-upload") },
    json: { declaredFileCount: 1, declaredByteCount: bytes.byteLength },
    expectedStatus: 201
  });
  const sessionId = requiredString(created.session?.id, "Cancellation upload session ID");
  await developer.json(`${uploadBase(file)}/${encodeURIComponent(sessionId)}/entries`, {
    method: "POST",
    json: { entries: [{
      relativePath: alternatePath,
      declaredSize: bytes.byteLength,
      checksumSha256: sha256(bytes)
    }] }
  });
  const cancelled = await developer.json(
    `${uploadBase(file)}/${encodeURIComponent(sessionId)}`,
    { method: "DELETE" }
  );
  if (cancelled.session?.state !== "cancelled") {
    throw new Error(`Upload cancellation did not converge for ${file.alias}`);
  }
  return {
    status: "cancelled",
    httpStatus: 200,
    detail: { terminalState: cancelled.session.state }
  };
}

async function mutatePath(file, action) {
  const replay = action.endsWith("-idempotent-replay");
  const canonical = action.replace(/-idempotent-replay$/u, "");
  const mutationId = caseId(file.alias, canonical);
  let mutationInput = state.mutationInputs[mutationId];
  if (!replay) {
    const pendingMatches = state.pendingCase?.id === caseId(file.alias, action);
    const priorOperation = pendingMatches && mutationInput?.operationId
      ? await getOperation(file.knowledgeBaseId, mutationInput.operationId)
      : null;
    const decision = mutationResumeDecision({
      pendingMatches,
      mutationInput,
      operationState: priorOperation?.state
    });
    if (decision === "resume") {
      if (priorOperation.state !== "completed") {
        await waitForOperation(file.knowledgeBaseId, mutationInput.operationId, ["completed"]);
      }
      const visible = await waitForSource(file.alias, ["visible"]);
      if (visible.relativePath !== mutationInput.relativePath) {
        throw new Error(`Resumed path mutation did not publish for ${file.alias}`);
      }
      return {
        status: "completed",
        httpStatus: 202,
        operationId: mutationInput.operationId,
        detail: { idempotentReplay: false, resumed: true, attempt: mutationInput.attempt ?? 1 }
      };
    }
    const source = await getSource(file.alias);
    const attempt = decision === "retry" ? (mutationInput.attempt ?? 1) + 1 : 1;
    mutationInput = {
      action,
      attempt,
      idempotencyKey: idempotencyKey(
        runId,
        file.alias,
        attempt === 1 ? action : `${action}-attempt-${attempt}`
      ),
      resourceRevision: source.resourceRevision,
      relativePath: actionRelativePath(file, action, {
        moveDirectory: moveTargetDirectory(file)
      }),
      operationId: null
    };
    state.mutationInputs[mutationId] = mutationInput;
    persistState();
  } else if (!mutationInput?.operationId) {
    throw new Error(`Replay input is missing for ${file.alias} ${action}`);
  }
  const accepted = await developer.json(sourceRoute(file), {
    method: "PATCH",
    headers: {
      "idempotency-key": mutationInput.idempotencyKey,
      "if-match": `"${mutationInput.resourceRevision}"`
    },
    json: { relativePath: mutationInput.relativePath },
    expectedStatus: 202
  });
  const operationId = requiredString(accepted.operation?.operationId, "Path operation ID");
  if (replay && operationId !== mutationInput.operationId) {
    throw new Error(`Idempotency replay changed operation identity for ${file.alias}`);
  }
  if (!replay) {
    mutationInput.operationId = operationId;
    persistState();
    await waitForOperation(file.knowledgeBaseId, operationId, ["completed"]);
    const visible = await waitForSource(file.alias, ["visible"]);
    if (visible.relativePath !== mutationInput.relativePath) {
      throw new Error(`Path mutation did not publish for ${file.alias}`);
    }
  }
  return {
    status: replay ? "replayed" : "completed",
    httpStatus: 202,
    operationId,
    detail: { idempotentReplay: replay }
  };
}

async function prepareFreshPathReplay(file, action) {
  const canonical = action.replace(/-idempotent-replay$/u, "");
  const mutationId = caseId(file.alias, canonical);
  let mutationInput = state.mutationInputs[mutationId];
  if (mutationInput?.protocol !== "fresh-replay-v1") {
    const source = await getSource(file.alias);
    mutationInput = {
      protocol: "fresh-replay-v1",
      idempotencyKey: idempotencyKey(runId, file.alias, `${canonical}-replay-probe`),
      resourceRevision: source.resourceRevision,
      relativePath: replayProbeRelativePath(file, action, {
        moveDirectory: moveTargetDirectory(file)
      }),
      operationId: null
    };
    state.mutationInputs[mutationId] = mutationInput;
    persistState();
  }
  const accepted = await developer.json(sourceRoute(file), {
    method: "PATCH",
    headers: {
      "idempotency-key": mutationInput.idempotencyKey,
      "if-match": `"${mutationInput.resourceRevision}"`
    },
    json: { relativePath: mutationInput.relativePath },
    expectedStatus: 202
  });
  const operationId = requiredString(
    accepted.operation?.operationId,
    "Replay probe operation ID"
  );
  if (mutationInput.operationId && mutationInput.operationId !== operationId) {
    throw new Error(`Replay probe operation identity changed for ${file.alias}`);
  }
  mutationInput.operationId = operationId;
  persistState();
  await waitForOperation(file.knowledgeBaseId, mutationInput.operationId, ["completed"]);
  const visible = await waitForSource(file.alias, ["visible"]);
  if (visible.relativePath !== mutationInput.relativePath) {
    throw new Error(`Replay probe did not publish for ${file.alias}`);
  }
  state.pendingCase.phase = "prepared";
  persistState();
}

async function mutateContent(file, action) {
  const replay = action.endsWith("-idempotent-replay");
  const canonical = action.replace(/-idempotent-replay$/u, "");
  const mutationId = caseId(file.alias, canonical);
  const originalBytes = fs.readFileSync(file.stagedPath);
  const expectedBytes = buildContentMutationBody(originalBytes, file.alias, action);
  const expectedChecksum = sha256(expectedBytes);
  if (action === "restore-after-retry") {
    await waitForSource(file.alias, ["visible"]);
    await assertSourceContentChecksum(file, expectedChecksum);
    return {
      status: "preserved",
      httpStatus: 200,
      checksumVerified: true,
      detail: { contentMutationRequired: false }
    };
  }
  let mutationInput = state.mutationInputs[mutationId];
  if (!replay) {
    const pendingMatches = state.pendingCase?.id === caseId(file.alias, action);
    const priorOperation = pendingMatches && mutationInput?.operationId
      ? await getOperation(file.knowledgeBaseId, mutationInput.operationId)
      : null;
    const decision = mutationResumeDecision({
      pendingMatches,
      mutationInput,
      operationState: priorOperation?.state
    });
    if (decision === "resume") {
      if (priorOperation.state !== "completed") {
        await waitForOperation(file.knowledgeBaseId, mutationInput.operationId, ["completed"]);
      }
      await waitForSource(file.alias, ["visible"]);
      await assertSourceContentChecksum(file, mutationInput.contentChecksumSha256);
      return {
        status: "completed",
        httpStatus: 202,
        operationId: mutationInput.operationId,
        checksumVerified: true,
        detail: { idempotentReplay: false, resumed: true, attempt: mutationInput.attempt ?? 1 }
      };
    }
    const source = await getSource(file.alias);
    const attempt = decision === "retry" ? (mutationInput.attempt ?? 1) + 1 : 1;
    mutationInput = {
      action,
      attempt,
      idempotencyKey: idempotencyKey(
        runId,
        file.alias,
        attempt === 1 ? action : `${action}-attempt-${attempt}`
      ),
      resourceRevision: source.resourceRevision,
      contentChecksumSha256: expectedChecksum,
      operationId: null
    };
    state.mutationInputs[mutationId] = mutationInput;
    persistState();
  } else if (!mutationInput?.operationId) {
    throw new Error(`Replay input is missing for ${file.alias} ${action}`);
  }
  if (mutationInput.contentChecksumSha256 !== expectedChecksum) {
    throw new Error(`Content mutation input changed for ${file.alias} ${action}`);
  }
  const accepted = await developer.json(sourceRoute(file, "/content"), {
    method: "PUT",
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "idempotency-key": mutationInput.idempotencyKey,
      "if-match": `"${mutationInput.resourceRevision}"`
    },
    rawBody: expectedBytes,
    expectedStatus: 202
  });
  const operationId = requiredString(accepted.operation?.operationId, "Content operation ID");
  if (replay && operationId !== mutationInput.operationId) {
    throw new Error(`Content replay changed operation identity for ${file.alias}`);
  }
  if (!replay) {
    mutationInput.operationId = operationId;
    persistState();
    await waitForOperation(file.knowledgeBaseId, operationId, ["completed"]);
    await waitForSource(file.alias, ["visible"]);
  }
  await assertSourceContentChecksum(file, expectedChecksum);
  return {
    status: replay ? "replayed" : "completed",
    httpStatus: 202,
    operationId,
    checksumVerified: true,
    detail: { idempotentReplay: replay }
  };
}

async function induceTerminalSourceFailure(file) {
  const action = "controlled-source-failure";
  const mutationId = caseId(file.alias, action);
  const bytes = fs.readFileSync(file.stagedPath);
  const mutationInput = state.mutationInputs[mutationId] ?? {
    action,
    priorSourceFileId: state.files[file.alias].sourceFileId,
    deleteAttempt: 1,
    deleteOperationId: null,
    recreatedSourceFileId: null,
    attempt: 1
  };
  state.mutationInputs[mutationId] = mutationInput;
  persistState();

  let source = (await listSources(file.knowledgeBaseId)).find(
    (item) => item.relativePath === file.originalRelativePath
  ) ?? null;
  let decision = controlledSourceFailureResumeDecision({
    source,
    priorSourceFileId: mutationInput.priorSourceFileId
  });
  if (decision === "delete") {
    if (mutationInput.deleteOperationId) {
      const prior = await getOperation(
        file.knowledgeBaseId,
        mutationInput.deleteOperationId
      );
      if (["failed", "cancelled", "superseded"].includes(prior.state)) {
        mutationInput.deleteAttempt += 1;
        mutationInput.deleteOperationId = null;
        persistState();
      }
    }
    if (!mutationInput.deleteOperationId) {
      const accepted = await developer.json(sourceRoute(file), {
        method: "DELETE",
        headers: {
          "idempotency-key": idempotencyKey(
            runId,
            file.alias,
            mutationInput.deleteAttempt === 1
              ? `${action}-delete`
              : `${action}-delete-attempt-${mutationInput.deleteAttempt}`
          ),
          "if-match": `"${source.resourceRevision}"`
        },
        expectedStatus: 202
      });
      mutationInput.deleteOperationId = requiredString(
        accepted.operation?.operationId,
        "Controlled source failure deletion operation ID"
      );
      persistState();
    }
    await waitForOperation(
      file.knowledgeBaseId,
      mutationInput.deleteOperationId,
      ["completed", "deleted"]
    );
    await waitForSourceMissing(file);
    source = null;
    decision = "upload";
  }
  if (decision === "upload") {
    const uploaded = await uploadAfterDeletion(file, bytes, action);
    const recreated = uploaded.files.find(
      (item) => item.relativePath === file.originalRelativePath
    );
    const sourceFileId = requiredString(
      recreated?.sourceFileId,
      "Controlled failure source file ID"
    );
    if (sourceFileId === mutationInput.priorSourceFileId) {
      throw new Error(`Controlled failure reused deleted identity for ${file.alias}`);
    }
    mutationInput.recreatedSourceFileId = sourceFileId;
    state.files[file.alias].sourceFileId = sourceFileId;
    state.files[file.alias].currentRelativePath = file.originalRelativePath;
    persistState();
  } else if (source && source.sourceFileId !== state.files[file.alias].sourceFileId) {
    mutationInput.recreatedSourceFileId = source.sourceFileId;
    state.files[file.alias].sourceFileId = source.sourceFileId;
    state.files[file.alias].currentRelativePath = file.originalRelativePath;
    persistState();
  }
  const failed = decision === "complete"
    ? source
    : await waitForSource(file.alias, ["failed"]);
  if (!failed?.failure?.code) {
    throw new Error(`Controlled source failure omitted its safe code for ${file.alias}`);
  }
  await assertSourceContentChecksum(file, file.checksumSha256);
  return {
    status: "failed-as-controlled",
    httpStatus: 202,
    operationId: mutationInput.deleteOperationId,
    checksumVerified: true,
    detail: {
      identityReplaced: true,
      sourceFailureCode: failed.failure.code
    }
  };
}

async function retryTerminalSource(file) {
  const failed = await getSource(file.alias);
  if (failed?.state !== "failed") {
    throw new Error(`Terminal retry source is not failed for ${file.alias}`);
  }
  const retried = await developer.json(sourceRoute(file, "/retry"), {
    method: "POST",
    expectedStatus: 202
  });
  if (
    retried.sourceFile?.sourceFileId !== state.files[file.alias].sourceFileId
    || retried.retry?.scope !== "source_file"
  ) {
    throw new Error(`Terminal retry response is invalid for ${file.alias}`);
  }
  const visible = await waitForSource(file.alias, ["visible"]);
  return {
    status: "retried",
    httpStatus: 202,
    detail: {
      retryKind: retried.retry.kind,
      coalesced: retried.retry.coalesced,
      finalStage: visible.currentStage
    }
  };
}

async function deleteSource(file, action) {
  const replay = action === "delete-idempotent-replay";
  const mutationId = caseId(file.alias, "delete");
  let mutationInput = state.mutationInputs[mutationId];
  if (!replay) {
    const pendingMatches = state.pendingCase?.id === caseId(file.alias, action);
    const priorOperation = pendingMatches && mutationInput?.operationId
      ? await getOperation(file.knowledgeBaseId, mutationInput.operationId)
      : null;
    const decision = mutationResumeDecision({
      pendingMatches,
      mutationInput,
      operationState: priorOperation?.state
    });
    if (decision === "resume") {
      if (!["completed", "deleted"].includes(priorOperation.state)) {
        await waitForOperation(
          file.knowledgeBaseId,
          mutationInput.operationId,
          ["completed", "deleted"]
        );
      }
      await waitForSourceMissing(file);
      return {
        status: "deleted",
        httpStatus: 202,
        operationId: mutationInput.operationId,
        detail: { idempotentReplay: false, resumed: true }
      };
    }
    const source = await getSource(file.alias);
    mutationInput = {
      action,
      idempotencyKey: idempotencyKey(runId, file.alias, action),
      resourceRevision: source.resourceRevision,
      operationId: null
    };
    state.mutationInputs[mutationId] = mutationInput;
    persistState();
  } else if (!mutationInput?.operationId) {
    throw new Error(`Delete replay input is missing for ${file.alias}`);
  }

  const response = await developer.request(sourceRoute(file), {
    method: "DELETE",
    headers: {
      "idempotency-key": mutationInput.idempotencyKey,
      "if-match": `"${mutationInput.resourceRevision}"`
    }
  });
  const responseText = await response.text();
  const body = responseText ? JSON.parse(responseText) : null;
  const classification = classifyDeleteMutationResponse({
    replay,
    status: response.status,
    operationId: body?.operation?.operationId ?? null,
    originalOperationId: mutationInput.operationId
  });
  if (classification.terminalResourceMissing) {
    await waitForSourceMissing(file);
    return {
      status: classification.status,
      httpStatus: 404,
      operationId: classification.operationId,
      detail: { idempotentReplay: true, terminalResourceMissing: true }
    };
  }
  const operationId = classification.operationId;
  if (!replay) {
    mutationInput.operationId = operationId;
    persistState();
    await waitForOperation(file.knowledgeBaseId, operationId, ["completed", "deleted"]);
  }
  await waitForSourceMissing(file);
  return {
    status: classification.status,
    httpStatus: 202,
    operationId,
    detail: { idempotentReplay: replay, terminalResourceMissing: false }
  };
}

async function recreateSource(file) {
  const bytes = fs.readFileSync(file.stagedPath);
  const priorSourceFileId = state.files[file.alias].sourceFileId;
  const existing = (await listSources(file.knowledgeBaseId)).find(
    (source) => source.relativePath === file.originalRelativePath
  );
  let sourceFileId = existing?.sourceFileId ?? null;
  let disposition = existing ? "resumed_existing" : null;
  if (!sourceFileId) {
    const uploaded = await uploadAfterDeletion(file, bytes);
    const recreated = uploaded.files.find(
      (source) => source.relativePath === file.originalRelativePath
    );
    sourceFileId = requiredString(recreated?.sourceFileId, "Recreated source file ID");
    disposition = recreated.disposition ?? null;
  }
  if (sourceFileId === priorSourceFileId) {
    throw new Error(`Recreated source reused deleted identity for ${file.alias}`);
  }
  state.files[file.alias].sourceFileId = sourceFileId;
  state.files[file.alias].currentRelativePath = file.originalRelativePath;
  persistState();
  const visible = await waitForSource(file.alias, ["visible"]);
  assertVisibleIdentity(file, visible);
  await assertSourceContentChecksum(file, file.checksumSha256);
  return {
    status: existing ? "recreated-resumed" : "recreated",
    httpStatus: existing ? 200 : 201,
    checksumVerified: true,
    detail: {
      disposition,
      identityReplaced: true,
      resumed: Boolean(existing)
    }
  };
}

async function uploadAfterDeletion(file, bytes, action = "recreate") {
  const deadline = Date.now() + operationTimeoutMs;
  let lastError = null;
  const mutationId = caseId(file.alias, action);
  const mutationInput = state.mutationInputs[mutationId] ?? {
    action,
    attempt: 1
  };
  mutationInput.attempt ??= 1;
  state.mutationInputs[mutationId] = mutationInput;
  persistState();
  while (Date.now() < deadline) {
    try {
      return await uploadMarkdownFilesWithSession({
        request: uploadRequest,
        routeBase: uploadBase(file),
        files: [{ relativePath: file.originalRelativePath, bytes }],
        idempotencyKey: idempotencyKey(
          runId,
          file.alias,
          mutationInput.attempt === 1
            ? action
            : `${action}-attempt-${mutationInput.attempt}`
        ),
        finalizationPollIntervalMs: 100,
        finalizationTimeoutMs: operationTimeoutMs
      });
    } catch (error) {
      lastError = error;
      if (!String(error instanceof Error ? error.message : error).includes("active deletion")) {
        throw error;
      }
      mutationInput.attempt += 1;
      persistState();
      await sleep(500);
    }
  }
  throw lastError ?? new Error("Timed out waiting to recreate a deleted source path");
}

async function prepareFreshContentReplay(file, action) {
  const canonical = action.replace(/-idempotent-replay$/u, "");
  const mutationId = caseId(file.alias, canonical);
  const originalBytes = fs.readFileSync(file.stagedPath);
  const expectedBytes = buildContentMutationBody(originalBytes, file.alias, action);
  const expectedChecksum = sha256(expectedBytes);
  let mutationInput = state.mutationInputs[mutationId];
  if (mutationInput?.protocol !== "fresh-replay-v1") {
    const source = await getSource(file.alias);
    mutationInput = {
      protocol: "fresh-replay-v1",
      idempotencyKey: idempotencyKey(runId, file.alias, `${canonical}-replay-probe`),
      resourceRevision: source.resourceRevision,
      contentChecksumSha256: expectedChecksum,
      operationId: null
    };
    state.mutationInputs[mutationId] = mutationInput;
    persistState();
  }
  if (mutationInput.contentChecksumSha256 !== expectedChecksum) {
    throw new Error(`Content replay probe changed for ${file.alias}`);
  }
  const accepted = await developer.json(sourceRoute(file, "/content"), {
    method: "PUT",
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "idempotency-key": mutationInput.idempotencyKey,
      "if-match": `"${mutationInput.resourceRevision}"`
    },
    rawBody: expectedBytes,
    expectedStatus: 202
  });
  const operationId = requiredString(
    accepted.operation?.operationId,
    "Content replay probe operation ID"
  );
  if (mutationInput.operationId && mutationInput.operationId !== operationId) {
    throw new Error(`Content replay probe operation identity changed for ${file.alias}`);
  }
  mutationInput.operationId = operationId;
  persistState();
  await waitForOperation(file.knowledgeBaseId, operationId, ["completed"]);
  await waitForSource(file.alias, ["visible"]);
  await assertSourceContentChecksum(file, expectedChecksum);
  state.pendingCase.phase = "prepared";
  persistState();
}

function requiresFreshReplaySetup(action) {
  return [
    "rename-idempotent-replay",
    "move-idempotent-replay",
    "replace-content-idempotent-replay"
  ].includes(action);
}

async function pauseControlledFailureModel() {
  if (!controlledFailureModelId || controlledFailureModelPaused) {
    throw new Error("Controlled failure generation model state is invalid");
  }
  const response = await admin.json(
    `/admin/api/settings/models/${encodeURIComponent(controlledFailureModelId)}/pause`,
    { method: "POST" }
  );
  if (response.model?.status !== "paused" || response.model.isActive !== false) {
    throw new Error("Controlled failure generation model did not pause");
  }
  controlledFailureModelPaused = true;
}

async function restoreControlledFailureModel() {
  if (!controlledFailureModelId || !controlledFailureModelPaused) return;
  const resumed = await admin.json(
    `/admin/api/settings/models/${encodeURIComponent(controlledFailureModelId)}/resume`,
    { method: "POST" }
  );
  if (resumed.model?.status !== "active" || resumed.model.isActive !== false) {
    throw new Error("Controlled failure generation model did not resume");
  }
  const activated = await admin.json(
    `/admin/api/settings/models/${encodeURIComponent(controlledFailureModelId)}/activate`,
    { method: "POST" }
  );
  if (activated.model?.status !== "active" || activated.model.isActive !== true) {
    throw new Error("Controlled failure generation model did not reactivate");
  }
  controlledFailureModelPaused = false;
}

function moveTargetDirectory(file) {
  const currentDirectory = path.posix.dirname(file.originalRelativePath);
  const candidate = files.find((item) =>
    item.family === file.family
    && path.posix.dirname(item.originalRelativePath) !== currentDirectory
  );
  if (!candidate) throw new Error(`No cross-directory move target exists for ${file.alias}`);
  return path.posix.dirname(candidate.originalRelativePath);
}

async function synchronizeStateFromRuntime() {
  const snapshot = await captureSnapshot();
  const expectedMissing = expectedMissingSourceAliases(state);
  const unexpectedMissing = Object.entries(snapshot).filter(
    ([alias, value]) => !value.present && !expectedMissing.has(alias)
  );
  const unexpectedlyPresent = [...expectedMissing].filter((alias) =>
    alias !== state.pendingCase?.alias && snapshot[alias]?.present
  );
  if (unexpectedMissing.length > 0 || unexpectedlyPresent.length > 0) {
    throw new Error(
      `CRUD runtime source presence drifted: ${unexpectedMissing.length} missing, `
      + `${unexpectedlyPresent.length} unexpectedly present`
    );
  }
  synchronizeFileState(snapshot);
  persistState();
}

function synchronizeFileState(snapshot) {
  for (const [alias, source] of Object.entries(snapshot)) {
    const current = state.files[alias];
    current.sourceFileId = source.sourceFileId;
    current.currentRelativePath = source.relativePath;
    current.resourceRevision = source.resourceRevision;
    current.state = source.state;
  }
}

async function captureSnapshot() {
  const pages = [];
  for (const family of ["official", "legacy"]) {
    const knowledgeBaseId = corpusReport.knowledgeBases[family].id;
    pages.push(await listSources(knowledgeBaseId));
  }
  return snapshotSourceFiles(state.files, pages);
}

async function listSources(knowledgeBaseId) {
  const items = [];
  let cursor = null;
  do {
    const page = await developer.json(
      `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-files`,
      { query: { limit: 200, ...(cursor ? { cursor } : {}) } }
    );
    items.push(...(page.items ?? []));
    cursor = page.nextCursor ?? null;
  } while (cursor);
  return items;
}

async function getSource(alias) {
  const file = fileByAlias.get(alias);
  const sourceFileId = state.files[alias].sourceFileId;
  const body = await developer.json(
    `/openapi/v2/knowledge-bases/${encodeURIComponent(file.knowledgeBaseId)}`
      + `/source-files/${encodeURIComponent(sourceFileId)}`
  );
  return body.sourceFile;
}

async function assertSourceContentChecksum(file, expectedChecksum) {
  const response = await developer.request(sourceRoute(file, "/content"));
  const body = Buffer.from(await response.arrayBuffer());
  expectStatus(response, 200, "source content verification");
  if (sha256(body) !== expectedChecksum) {
    throw new Error(`Source content verification failed for ${file.alias}`);
  }
}

async function waitForOperation(
  knowledgeBaseId,
  operationId,
  terminalStates,
  timeoutMs = operationTimeoutMs
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const operation = await getOperation(knowledgeBaseId, operationId);
    if (terminalStates.includes(operation?.state)) return operation;
    if (["failed", "cancelled", "superseded"].includes(operation?.state)) {
      throw new Error(`Resource operation ended in ${operation.state}: ${operation.errorCode ?? "UNKNOWN"}`);
    }
    await sleep(200);
  }
  throw new Error("Resource operation timed out");
}

async function getOperation(knowledgeBaseId, operationId) {
  const body = await developer.json(
    `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`
      + `/operations/${encodeURIComponent(operationId)}`
  );
  return body.operation;
}

async function waitForSource(alias, states, timeoutMs = operationTimeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const source = await getSource(alias);
    if (states.includes(source?.state)) return source;
    if (source?.state === "failed") {
      throw new Error(`Source processing failed: ${source.failure?.code ?? "UNKNOWN"}`);
    }
    await sleep(200);
  }
  throw new Error("Source visibility timed out");
}

async function waitForSourceMissing(file, timeoutMs = operationTimeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await developer.request(sourceRoute(file));
    if (response.status === 404) return;
    if (response.status !== 200) {
      const responseText = await response.text();
      const body = responseText ? JSON.parse(responseText) : null;
      expectStatus(response, 200, "source deletion visibility", body);
    }
    await sleep(200);
  }
  throw new Error("Source deletion visibility timed out");
}

async function uploadRequest(pathname, options) {
  return developer.json(pathname, {
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

function uploadBase(file) {
  return `/openapi/v2/knowledge-bases/${encodeURIComponent(file.knowledgeBaseId)}/upload-sessions`;
}

function sourceRoute(file, suffix = "") {
  return `/openapi/v2/knowledge-bases/${encodeURIComponent(file.knowledgeBaseId)}`
    + `/source-files/${encodeURIComponent(state.files[file.alias].sourceFileId)}${suffix}`;
}

function assertVisibleIdentity(file, source) {
  if (
    source?.sourceFileId !== state.files[file.alias].sourceFileId
    || source.state !== "visible"
    || source.generatedOutputStatus !== "visible"
  ) {
    throw new Error(`Source identity is not visible for ${file.alias}`);
  }
}

function publicReadDetail(source) {
  return {
    state: source.state,
    currentStage: source.currentStage,
    generatedOutputStatus: source.generatedOutputStatus,
    resourceRevision: source.resourceRevision,
    contentRevision: source.contentRevision,
    generatedPathPresent: Boolean(source.generatedPath),
    actionCount: source.actions?.length ?? 0
  };
}

function createHttpClient(input) {
  let cookie = "";
  return {
    async request(pathname, options = {}) {
      const response = await requestWithRateLimitRetry({
        maximumRetries: 12,
        request: async () => {
          const url = new URL(pathname, `${input.baseUrl}/`);
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
    async json(pathname, options = {}) {
      const response = await this.request(pathname, options);
      const text = await response.text();
      const body = text ? JSON.parse(text) : null;
      expectStatus(response, options.expectedStatus ?? 200, pathname, body);
      return body;
    }
  };
}

function expectStatus(response, expectedStatus, label, body = null) {
  if (response.status !== expectedStatus) {
    const safeReason = safeHttpFailureReason(body);
    throw new Error(`${label} returned HTTP ${response.status} (${safeReason})`);
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

function loadState() {
  if (!fs.existsSync(statePath)) {
    const created = createCrudExecutionState(files, runId);
    fs.writeFileSync(statePath, `${JSON.stringify(created, null, 2)}\n`, { mode: 0o600 });
    return created;
  }
  return assertCrudExecutionState(readJson(statePath), files, runId);
}

function persistState() {
  state.updatedAt = new Date().toISOString();
  const temporary = `${statePath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, statePath);
}

function initializeLedger() {
  if (fs.existsSync(ledgerPath)) return;
  appendLedger({
    kind: "header",
    schema: "focowiki-comprehensive-crud-results",
    version: 1,
    runId,
    plannedFiles: files.length,
    plannedCases: plan.counts.cases,
    plannedDispositions: plan.counts.dispositions,
    startedAt: new Date().toISOString()
  });
}

function appendLedger(row) {
  fs.appendFileSync(ledgerPath, `${JSON.stringify(row)}\n`, { mode: 0o600 });
}

function writeSummary() {
  const actionCounts = Object.fromEntries(CRUD_FILE_ACTIONS.map((action) => [action,
    files.filter((file) => completed.has(caseId(file.alias, action))).length
  ]));
  const summary = {
    kind: "focowiki-comprehensive-crud-summary",
    version: 1,
    runId,
    updatedAt: new Date().toISOString(),
    ok: failure === null && Object.values(cleanup).every(Boolean),
    complete: completed.size === plan.counts.cases,
    planned: plan.counts,
    completedCases: completed.size,
    actionCounts,
    cleanup,
    failure
  };
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
}

function readSelectedActions() {
  const requested = process.env.FOCOWIKI_COMPREHENSIVE_CRUD_ACTIONS?.trim();
  if (!requested) return [...CRUD_FILE_ACTIONS];
  const values = requested.split(",").map((value) => value.trim()).filter(Boolean);
  if (values.length === 0 || values.some((value) => !CRUD_FILE_ACTIONS.includes(value))) {
    throw new Error("FOCOWIKI_COMPREHENSIVE_CRUD_ACTIONS contains an unknown action");
  }
  return CRUD_FILE_ACTIONS.filter((action) => values.includes(action));
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
  return crypto.createHash("sha256").update(value).digest("hex");
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

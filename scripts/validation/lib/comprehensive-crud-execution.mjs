import crypto from "node:crypto";

export const READ_ACTIONS = Object.freeze([
  "list",
  "detail-read",
  "content-read",
  "preview-read",
  "final-detail-read",
  "final-content-read",
  "final-preview-read"
]);

export const PATH_ACTIONS = Object.freeze([
  "rename",
  "rename-idempotent-replay",
  "move",
  "move-idempotent-replay",
  "restore-path"
]);

export function buildCrudExecutionFiles(input) {
  const workspaceByChecksum = new Map(
    input.privateWorkspace.files.map((file) => [file.checksumSha256, file])
  );
  const manifestByAlias = new Map(input.manifest.rows.map((row) => [row.alias, row]));
  const result = [];
  for (const planned of input.plan.files) {
    const manifest = manifestByAlias.get(planned.alias);
    const workspace = workspaceByChecksum.get(planned.checksumSha256);
    const prior = input.corpusReport.files?.[planned.alias];
    const knowledgeBaseId = input.corpusReport.knowledgeBases?.[planned.family]?.id;
    if (
      !manifest
      || !workspace?.stagedPath
      || prior?.sourceFileId === undefined
      || !knowledgeBaseId
      || manifest.family !== planned.family
    ) {
      throw new Error(`CRUD execution input is incomplete for ${planned.alias}`);
    }
    result.push({
      alias: planned.alias,
      family: planned.family,
      checksumSha256: planned.checksumSha256,
      stagedPath: workspace.stagedPath,
      originalRelativePath: workspace.path,
      knowledgeBaseId,
      sourceFileId: prior.sourceFileId
    });
  }
  return result;
}

export function createCrudExecutionState(files, runId) {
  return {
    kind: "focowiki-comprehensive-crud-execution-state",
    version: 1,
    runId,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    pendingCase: null,
    completedCaseIds: [],
    files: Object.fromEntries(files.map((file) => [file.alias, {
      sourceFileId: file.sourceFileId,
      knowledgeBaseId: file.knowledgeBaseId,
      originalRelativePath: file.originalRelativePath,
      currentRelativePath: file.originalRelativePath,
      resourceRevision: null,
      state: "visible"
    }]))
  };
}

export function assertCrudExecutionState(state, files, runId) {
  if (
    state?.kind !== "focowiki-comprehensive-crud-execution-state"
    || state.version !== 1
    || state.runId !== runId
    || !Array.isArray(state.completedCaseIds)
    || new Set(state.completedCaseIds).size !== state.completedCaseIds.length
    || Object.keys(state.files ?? {}).length !== files.length
  ) {
    throw new Error("CRUD execution state is incompatible with this run");
  }
  for (const file of files) {
    const current = state.files[file.alias];
    if (
      !current
      || current.knowledgeBaseId !== file.knowledgeBaseId
      || current.originalRelativePath !== file.originalRelativePath
    ) {
      throw new Error(`CRUD execution state drifted for ${file.alias}`);
    }
  }
  return state;
}

export function caseId(alias, action) {
  return `crud-case:${alias}:${action}`;
}

export function idempotencyKey(runId, alias, action) {
  const canonicalAction = action.replace(/-idempotent-replay$/u, "");
  return `clr-${sha256(`${runId}:${alias}:${canonicalAction}`).slice(0, 40)}`;
}

export function actionRelativePath(file, action, options = {}) {
  if (action === "rename" || action === "rename-idempotent-replay") {
    const segments = file.originalRelativePath.split("/");
    const originalName = segments.pop();
    const renamed = originalName.replace(/\.md$/iu, `--${file.alias}-renamed.md`);
    return [...segments, renamed].join("/");
  }
  if (action === "move" || action === "move-idempotent-replay") {
    if (!options.moveDirectory) throw new Error("Move target directory is required");
    return `${options.moveDirectory}/${file.alias}--moved.md`;
  }
  if (action === "restore-path") return file.originalRelativePath;
  throw new Error(`Action ${action} does not define a relative path`);
}

export function replayProbeRelativePath(file, action, options = {}) {
  if (action === "rename-idempotent-replay") {
    const segments = file.originalRelativePath.split("/");
    const originalName = segments.pop();
    const renamed = originalName.replace(/\.md$/iu, `--${file.alias}-replay-probe.md`);
    return [...segments, renamed].join("/");
  }
  if (action === "move-idempotent-replay") {
    if (!options.moveDirectory) throw new Error("Move replay target directory is required");
    return `${options.moveDirectory}/${file.alias}--replay-moved.md`;
  }
  throw new Error(`Action ${action} does not define a replay probe path`);
}

export function shouldPrepareFreshReplay(pendingCase, caseIdentity, protocol) {
  return pendingCase?.id !== caseIdentity
    || pendingCase?.protocol !== protocol
    || pendingCase?.phase === "preparing";
}

export function mutationResumeDecision(input) {
  if (!input.pendingMatches || !input.mutationInput?.operationId) return "new";
  if (["failed", "cancelled", "superseded"].includes(input.operationState)) {
    return "retry";
  }
  return "resume";
}

export function buildReplacementBody(originalBytes, alias, kind = "replacement") {
  const marker = "This complete revision verifies source replacement and publication continuity.";
  return Buffer.concat([
    Buffer.from(originalBytes),
    Buffer.from(`\n\n## Comprehensive ${kind} ${alias}\n\n${marker}\n`)
  ]);
}

export function buildContentMutationBody(originalBytes, alias, action) {
  if (["restore-content", "restore-after-retry"].includes(action)) {
    return Buffer.from(originalBytes);
  }
  if (action === "replace-content") {
    return buildReplacementBody(originalBytes, alias);
  }
  if (action === "replace-content-idempotent-replay") {
    return buildReplacementBody(originalBytes, alias, "replacement-replay");
  }
  throw new Error(`Action ${action} does not define a content mutation body`);
}

export function controlledSourceFailureResumeDecision(input) {
  if (!input.source) return "upload";
  if (input.source.sourceFileId === input.priorSourceFileId) return "delete";
  if (input.source.state === "failed") return "complete";
  if (["queued", "running"].includes(input.source.state)) return "wait";
  throw new Error("Controlled source failure reached an unexpected visible replacement");
}

export function selectControlledFailureModelId(models) {
  const active = Array.isArray(models)
    ? models.filter((model) =>
      model?.status === "active"
      && model.isActive === true
      && typeof model.id === "string"
      && model.id.length > 0)
    : [];
  if (active.length !== 1) {
    throw new Error("Controlled failure requires exactly one active generation model");
  }
  return active[0].id;
}

export function resolveCrudOperationTimeoutMs(configured) {
  const value = configured === undefined || configured === ""
    ? 20 * 60_000
    : Number(configured);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("FOCOWIKI_COMPREHENSIVE_OPERATION_TIMEOUT_MS must be a positive integer");
  }
  if (value < 15 * 60_000) {
    throw new Error("FOCOWIKI_COMPREHENSIVE_OPERATION_TIMEOUT_MS must be at least 900000");
  }
  return value;
}

export function expectedMissingSourceAliases(state) {
  const aliases = new Set();
  for (const id of state?.completedCaseIds ?? []) {
    const match = /^crud-case:([^:]+):(delete|delete-idempotent-replay|recreate)$/u.exec(id);
    if (!match) continue;
    if (match[2] === "recreate") aliases.delete(match[1]);
    else aliases.add(match[1]);
  }
  if (
    state?.pendingCase?.alias
    && [
      "delete",
      "delete-idempotent-replay",
      "recreate",
      "controlled-source-failure"
    ].includes(state.pendingCase.action)
  ) {
    aliases.add(state.pendingCase.alias);
  }
  return aliases;
}

export function classifyDeleteMutationResponse(input) {
  if (input.replay && input.status === 404) {
    return {
      status: "replayed-after-terminal-delete",
      operationId: input.originalOperationId,
      terminalResourceMissing: true
    };
  }
  if (input.status !== 202) {
    throw new Error(`Source deletion returned unexpected HTTP ${input.status}`);
  }
  if (typeof input.operationId !== "string" || input.operationId.length === 0) {
    throw new Error("Source deletion did not return an operation identity");
  }
  if (input.replay && input.operationId !== input.originalOperationId) {
    throw new Error("Delete replay changed operation identity");
  }
  return {
    status: input.replay ? "replayed" : "deleted",
    operationId: input.operationId,
    terminalResourceMissing: false
  };
}

export function safeHttpFailureReason(body) {
  const code = typeof body?.error?.code === "string"
    && /^[A-Z][A-Z0-9_]*$/u.test(body.error.code)
    ? body.error.code
    : "UNKNOWN";
  const reason = typeof body?.error?.message === "string"
    && /^[A-Z][A-Z0-9_]*$/u.test(body.error.message)
    ? body.error.message
    : null;
  return reason ? `${code}:${reason}` : code;
}

export function snapshotSourceFiles(filesByAlias, sourcePages) {
  const sourceById = new Map(sourcePages.flat().map((source) => [source.sourceFileId, source]));
  return Object.fromEntries(Object.entries(filesByAlias).map(([alias, file]) => {
    const source = sourceById.get(file.sourceFileId);
    return [alias, source ? {
      present: true,
      sourceFileId: source.sourceFileId,
      relativePath: source.relativePath,
      resourceRevision: source.resourceRevision,
      contentRevision: source.contentRevision,
      state: source.state,
      currentStage: source.currentStage,
      generatedPath: source.generatedPath ?? null,
      generatedOutputStatus: source.generatedOutputStatus ?? null
    } : {
      present: false,
      sourceFileId: file.sourceFileId,
      relativePath: null,
      resourceRevision: null,
      contentRevision: null,
      state: "deleted",
      currentStage: null,
      generatedPath: null,
      generatedOutputStatus: null
    }];
  }));
}

export function reconcileMutationImpact(input) {
  const rows = [];
  for (const alias of Object.keys(input.before).sort()) {
    const before = input.before[alias];
    const after = input.after[alias];
    const changed = stableSourceState(before) !== stableSourceState(after);
    const expected = alias === input.mutationAlias
      ? input.expectedTargetDisposition
      : "intentionally-unchanged";
    const actual = alias === input.mutationAlias && expected === "deleted" && !after.present
      ? "deleted"
      : changed
        ? (after.present ? "affected" : "deleted")
        : "intentionally-unchanged";
    rows.push({
      id: `crud-impact:${input.mutationAlias}:${input.action}:${alias}`,
      mutationAlias: input.mutationAlias,
      action: input.action,
      observedAlias: alias,
      expectedDisposition: expected,
      actualDisposition: actual,
      ok: actual === expected,
      before: publicSourceState(before),
      after: publicSourceState(after)
    });
  }
  return rows;
}

export function expectedTargetDisposition(action) {
  if ([
    "duplicate-upload",
    "cancel-upload",
    "rename-idempotent-replay",
    "move-idempotent-replay",
    "replace-content-idempotent-replay",
    "restore-after-retry"
  ].includes(action)) return "intentionally-unchanged";
  if (["delete", "delete-idempotent-replay"].includes(action)) return "deleted";
  return "affected";
}

export function publicCaseResult(input) {
  return {
    kind: "case",
    id: caseId(input.alias, input.action),
    alias: input.alias,
    family: input.family,
    action: input.action,
    ok: input.ok,
    status: input.status,
    httpStatus: input.httpStatus ?? null,
    operationIdHash: input.operationId ? sha256(input.operationId) : null,
    sourceFileIdHash: input.sourceFileId ? sha256(input.sourceFileId) : null,
    checksumVerified: input.checksumVerified ?? null,
    detail: input.detail ?? null,
    completedAt: new Date().toISOString()
  };
}

function stableSourceState(value) {
  return JSON.stringify(publicSourceState(value));
}

function publicSourceState(value) {
  return {
    present: value.present,
    sourceFileIdHash: value.sourceFileId ? sha256(value.sourceFileId) : null,
    relativePathHash: value.relativePath ? sha256(value.relativePath) : null,
    resourceRevision: value.resourceRevision,
    contentRevision: value.contentRevision,
    state: value.state,
    currentStage: value.currentStage,
    generatedPathHash: value.generatedPath ? sha256(value.generatedPath) : null,
    generatedOutputStatus: value.generatedOutputStatus
  };
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

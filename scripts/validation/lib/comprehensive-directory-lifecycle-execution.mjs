import path from "node:path";

export function createDirectoryLifecycleExecutionState(directories, runId) {
  return {
    kind: "focowiki-comprehensive-directory-lifecycle-state",
    version: 1,
    runId,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    pendingCase: null,
    completedCaseIds: [],
    directories: Object.fromEntries(directories.map((item) => [
      item.directoryAlias,
      currentDirectoryState(item)
    ]))
  };
}

export function assertDirectoryLifecycleExecutionState(state, directories, runId) {
  if (
    state?.kind !== "focowiki-comprehensive-directory-lifecycle-state"
    || state.version !== 1
    || state.runId !== runId
    || !Array.isArray(state.completedCaseIds)
    || new Set(state.completedCaseIds).size !== state.completedCaseIds.length
    || Object.keys(state.directories ?? {}).length !== directories.length
  ) {
    throw new Error("Comprehensive directory lifecycle state is incompatible");
  }
  for (const directory of directories) {
    const current = state.directories[directory.directoryAlias];
    if (
      !current
      || current.knowledgeBaseId !== directory.knowledgeBaseId
      || current.originalRelativePath !== directory.relativePath
    ) {
      throw new Error("Comprehensive directory lifecycle state is incompatible");
    }
  }
  return state;
}

export function directoryCaseId(directoryAlias, action) {
  return `directory-case:${directoryAlias}:${action}`;
}

export function directoryIdempotencyKey(runId, directoryAlias, action) {
  const canonical = action.replace(/^restore-after-/u, "restore-");
  return `clr-directory-${runId.replace(/^clr-/u, "")}-${directoryAlias}-${canonical}`;
}

export function nextDirectoryMutationAttempt(input) {
  if (!["failed", "cancelled", "superseded"].includes(input.terminalState)) {
    throw new Error("Directory mutation retry requires a terminal state");
  }
  if (!Number.isSafeInteger(input.retryCount) || input.retryCount < 0) {
    throw new Error("Directory mutation retry count is invalid");
  }
  if (input.retryCount >= 1) return null;
  if (!Number.isSafeInteger(input.currentResourceRevision)
    || input.currentResourceRevision < 1) {
    throw new Error("Directory mutation retry revision is invalid");
  }
  const retryCount = input.retryCount + 1;
  const baseIdempotencyKey = input.mutationInput.idempotencyKey.replace(
    /-retry-\d+$/u,
    ""
  );
  return {
    retryCount,
    mutationInput: {
      ...input.mutationInput,
      resourceRevision: input.currentResourceRevision,
      idempotencyKey: `${baseIdempotencyKey}-retry-${retryCount}`
    }
  };
}

export function directoryDeletionResumeDecision(input) {
  if (input.directoryPresent || input.hasMutationInput) return "submit_or_replay";
  return "unowned_missing_target";
}

export function emptyDirectoryFixtureResumeDecision(fixture) {
  if (!fixture) return "upload";
  if (
    fixture.state !== "visible"
    || typeof fixture.sourceFileId !== "string"
    || !fixture.sourceFileId
    || !Number.isSafeInteger(fixture.resourceRevision)
    || fixture.resourceRevision < 1
  ) {
    throw new Error("Comprehensive empty directory fixture is not visible");
  }
  return "reuse";
}

export function reconcileDirectoryImpacts(input) {
  const affectedAliases = new Set(input.directory.descendantAliases);
  return input.files.map((file) => {
    const before = input.before[file.alias];
    const after = input.after[file.alias];
    const changed = JSON.stringify(before) !== JSON.stringify(after);
    const affected = affectedAliases.has(file.alias);
    const expectedDisposition = !affected
      ? "intentionally-unchanged"
      : input.action === "delete"
        ? "deleted"
        : "affected";
    const actualDisposition = affected && !after.present
      ? "deleted"
      : changed
        ? "affected"
        : "intentionally-unchanged";
    const acceptedDispositions = input.alreadyConverged
      && affected
      && input.action === "recreate"
      ? ["affected", "intentionally-unchanged"]
      : [expectedDisposition];
    return {
      id: `directory-impact:${input.directory.directoryAlias}:${input.action}:${file.alias}`,
      directoryAlias: input.directory.directoryAlias,
      action: input.action,
      observedAlias: file.alias,
      expectedDisposition,
      acceptedDispositions,
      actualDisposition,
      ok: acceptedDispositions.includes(actualDisposition),
      before,
      after
    };
  });
}

export function temporaryDirectoryPath(directory, action) {
  if (action === "rename") {
    const parent = path.posix.dirname(directory.relativePath);
    const name = `__clr_${directory.directoryAlias}_renamed`;
    return parent === "." ? name : `${parent}/${name}`;
  }
  if (action === "move") {
    if (directory.depth <= 1) {
      throw new Error("Comprehensive directory root directory cannot be moved distinctly");
    }
    return `__clr_${directory.directoryAlias}_moved`;
  }
  throw new Error(`Comprehensive directory action ${action} has no temporary path`);
}

export function updateDirectorySubtreeState(input) {
  const runtimeByIdentity = new Map(input.runtimeDirectories.map((item) => [
    identity(item.knowledgeBaseId, item.relativePath),
    item
  ]));
  const targetPrefix = `${input.target.relativePath}/`;
  for (const [directoryAlias, current] of Object.entries(input.state.directories)) {
    if (
      current.knowledgeBaseId !== input.target.knowledgeBaseId
      || current.originalRelativePath !== input.target.relativePath
        && !current.originalRelativePath.startsWith(targetPrefix)
    ) continue;
    const runtime = runtimeByIdentity.get(identity(
      current.knowledgeBaseId,
      current.originalRelativePath
    ));
    if (!runtime) {
      throw new Error("Comprehensive directory recreated subtree is incomplete");
    }
    input.state.directories[directoryAlias] = currentDirectoryState({
      ...current,
      directoryId: runtime.directoryId,
      relativePath: current.originalRelativePath,
      resourceRevision: runtime.resourceRevision
    });
  }
}

export function synchronizeDirectoryState(input) {
  const runtimeById = new Map(input.runtimeDirectories.map((item) => [item.directoryId, item]));
  for (const current of Object.values(input.state.directories)) {
    const runtime = runtimeById.get(current.directoryId);
    if (!runtime) continue;
    current.currentRelativePath = runtime.relativePath;
    current.resourceRevision = runtime.resourceRevision;
    current.parentDirectoryId = runtime.parentDirectoryId ?? null;
    current.state = "visible";
  }
}

function currentDirectoryState(item) {
  return {
    directoryId: item.directoryId,
    knowledgeBaseId: item.knowledgeBaseId,
    originalRelativePath: item.originalRelativePath ?? item.relativePath,
    currentRelativePath: item.relativePath,
    parentDirectoryId: item.parentDirectoryId ?? null,
    resourceRevision: item.resourceRevision,
    state: "visible"
  };
}

function identity(knowledgeBaseId, relativePath) {
  return `${knowledgeBaseId}\0${relativePath}`;
}

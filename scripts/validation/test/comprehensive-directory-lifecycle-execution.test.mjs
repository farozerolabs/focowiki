import assert from "node:assert/strict";
import test from "node:test";

import {
  assertDirectoryLifecycleExecutionState,
  createDirectoryLifecycleExecutionState,
  directoryDeletionResumeDecision,
  directoryCaseId,
  emptyDirectoryFixtureResumeDecision,
  nextDirectoryMutationAttempt,
  reconcileDirectoryImpacts,
  temporaryDirectoryPath,
  updateDirectorySubtreeState
} from "../lib/comprehensive-directory-lifecycle-execution.mjs";

const directories = [
  directory("directory-001", "runtime-root", "official"),
  directory("directory-002", "runtime-child", "official/acme")
];

test("creates a resumable state with one current identity per planned directory", () => {
  const state = createDirectoryLifecycleExecutionState(directories, "clr-test");

  assert.equal(state.kind, "focowiki-comprehensive-directory-lifecycle-state");
  assert.equal(state.directories["directory-002"].directoryId, "runtime-child");
  assert.equal(state.directories["directory-002"].currentRelativePath, "official/acme");
  assert.doesNotThrow(() => assertDirectoryLifecycleExecutionState(
    state,
    directories,
    "clr-test"
  ));
  state.completedCaseIds.push(directoryCaseId("directory-001", "list"));
  state.completedCaseIds.push(directoryCaseId("directory-001", "list"));
  assert.throws(() => assertDirectoryLifecycleExecutionState(
    state,
    directories,
    "clr-test"
  ), /incompatible/u);
});

test("builds deterministic rename and move paths without leaving the namespace", () => {
  assert.equal(
    temporaryDirectoryPath(directories[1], "rename"),
    "official/__clr_directory-002_renamed"
  );
  assert.equal(
    temporaryDirectoryPath(directories[1], "move"),
    "__clr_directory-002_moved"
  );
  assert.throws(() => temporaryDirectoryPath(directories[0], "move"), /root directory/u);
});

test("updates every recreated directory in a subtree and rejects missing descendants", () => {
  const state = createDirectoryLifecycleExecutionState(directories, "clr-test");
  updateDirectorySubtreeState({
    state,
    target: directories[0],
    runtimeDirectories: [
      { ...directories[0], directoryId: "runtime-root-next", resourceRevision: 2 },
      { ...directories[1], directoryId: "runtime-child-next", resourceRevision: 3 }
    ]
  });
  assert.equal(state.directories["directory-001"].directoryId, "runtime-root-next");
  assert.equal(state.directories["directory-002"].directoryId, "runtime-child-next");
  assert.throws(() => updateDirectorySubtreeState({
    state,
    target: directories[0],
    runtimeDirectories: [directories[0]]
  }), /subtree is incomplete/u);
});

test("rotates a terminal operation idempotency key once for a resumable retry", () => {
  const first = nextDirectoryMutationAttempt({
    mutationInput: {
      directoryId: "runtime-empty",
      resourceRevision: 1,
      targetPath: "renamed",
      idempotencyKey: "clr-directory-run-directory-002-rename"
    },
    retryCount: 0,
    terminalState: "failed",
    currentResourceRevision: 1
  });

  assert.deepEqual(first, {
    retryCount: 1,
    mutationInput: {
      directoryId: "runtime-empty",
      resourceRevision: 1,
      targetPath: "renamed",
      idempotencyKey: "clr-directory-run-directory-002-rename-retry-1"
    }
  });
  assert.equal(nextDirectoryMutationAttempt({
    mutationInput: first.mutationInput,
    retryCount: first.retryCount,
    terminalState: "failed",
    currentResourceRevision: 1
  }), null);
  assert.throws(() => nextDirectoryMutationAttempt({
    mutationInput: first.mutationInput,
    retryCount: first.retryCount,
    terminalState: "running",
    currentResourceRevision: 1
  }), /terminal state/u);
});

test("never treats an unowned missing directory as a completed deletion", () => {
  assert.equal(directoryDeletionResumeDecision({
    directoryPresent: true,
    hasMutationInput: false
  }), "submit_or_replay");
  assert.equal(directoryDeletionResumeDecision({
    directoryPresent: false,
    hasMutationInput: true
  }), "submit_or_replay");
  assert.equal(directoryDeletionResumeDecision({
    directoryPresent: false,
    hasMutationInput: false
  }), "unowned_missing_target");
});

test("accepts an unchanged recreated subtree only when it was already converged", () => {
  const file = { alias: "official-001" };
  const before = { "official-001": { present: true, revision: 2 } };
  const after = { "official-001": { present: true, revision: 2 } };
  const base = {
    files: [file],
    directory: directories[1],
    action: "recreate",
    before,
    after
  };

  assert.deepEqual(
    reconcileDirectoryImpacts({ ...base, alreadyConverged: false })
      .map((impact) => [impact.actualDisposition, impact.ok]),
    [["intentionally-unchanged", false]]
  );
  assert.deepEqual(
    reconcileDirectoryImpacts({ ...base, alreadyConverged: true })
      .map((impact) => [impact.acceptedDispositions, impact.ok]),
    [[ ["affected", "intentionally-unchanged"], true ]]
  );
});

test("resumes an existing empty-directory fixture without uploading it twice", () => {
  assert.equal(emptyDirectoryFixtureResumeDecision(null), "upload");
  assert.equal(emptyDirectoryFixtureResumeDecision({
    state: "visible",
    sourceFileId: "source-empty",
    resourceRevision: 1
  }), "reuse");
  assert.throws(() => emptyDirectoryFixtureResumeDecision({
    state: "failed",
    sourceFileId: "source-empty",
    resourceRevision: 1
  }), /fixture is not visible/u);
});

function directory(directoryAlias, directoryId, relativePath) {
  return {
    directoryAlias,
    knowledgeBaseId: "knowledge-base-official",
    directoryId,
    relativePath,
    resourceRevision: 1,
    depth: relativePath.split("/").length,
    descendantAliases: ["official-001"]
  };
}

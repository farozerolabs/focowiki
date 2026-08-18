import assert from "node:assert/strict";
import test from "node:test";

import {
  actionRelativePath,
  buildContentMutationBody,
  buildCrudExecutionFiles,
  classifyDeleteMutationResponse,
  controlledSourceFailureResumeDecision,
  createCrudExecutionState,
  expectedTargetDisposition,
  expectedMissingSourceAliases,
  idempotencyKey,
  mutationResumeDecision,
  reconcileMutationImpact,
  replayProbeRelativePath,
  resolveCrudOperationTimeoutMs,
  safeHttpFailureReason,
  selectControlledFailureModelId,
  shouldPrepareFreshReplay,
  snapshotSourceFiles
} from "../lib/comprehensive-crud-execution.mjs";

const files = [{
  alias: "official-001",
  family: "official",
  checksumSha256: "a".repeat(64),
  stagedPath: "/tmp/official.md",
  originalRelativePath: "concepts/one.md",
  knowledgeBaseId: "knowledge-base-one",
  sourceFileId: "source-file-one"
}, {
  alias: "legacy-001",
  family: "legacy",
  checksumSha256: "b".repeat(64),
  stagedPath: "/tmp/legacy.md",
  originalRelativePath: "laws/two.md",
  knowledgeBaseId: "knowledge-base-two",
  sourceFileId: "source-file-two"
}];

test("joins the public manifest to private paths without exposing content", () => {
  const result = buildCrudExecutionFiles({
    plan: { files: files.map(({ stagedPath, originalRelativePath, knowledgeBaseId, sourceFileId, ...file }) => file) },
    manifest: { rows: files.map((file) => ({ alias: file.alias, family: file.family })) },
    privateWorkspace: { files: files.map((file) => ({
      checksumSha256: file.checksumSha256,
      stagedPath: file.stagedPath,
      path: file.originalRelativePath
    })) },
    corpusReport: {
      knowledgeBases: {
        official: { id: "knowledge-base-one" },
        legacy: { id: "knowledge-base-two" }
      },
      files: {
        "official-001": { sourceFileId: "source-file-one" },
        "legacy-001": { sourceFileId: "source-file-two" }
      }
    }
  });
  assert.deepEqual(result, files);
});

test("resumes an interrupted replay probe before recording the replay snapshot", () => {
  assert.equal(shouldPrepareFreshReplay(null, "case", "fresh-replay-v1"), true);
  assert.equal(shouldPrepareFreshReplay({
    id: "case",
    protocol: "fresh-replay-v1",
    phase: "preparing"
  }, "case", "fresh-replay-v1"), true);
  assert.equal(shouldPrepareFreshReplay({
    id: "case",
    protocol: "fresh-replay-v1",
    phase: "prepared"
  }, "case", "fresh-replay-v1"), false);
});

test("retries only a terminal failed mutation with a new durable attempt", () => {
  assert.equal(mutationResumeDecision({ pendingMatches: false }), "new");
  assert.equal(mutationResumeDecision({
    pendingMatches: true,
    mutationInput: { operationId: "operation-running" },
    operationState: "running"
  }), "resume");
  assert.equal(mutationResumeDecision({
    pendingMatches: true,
    mutationInput: { operationId: "operation-failed" },
    operationState: "failed"
  }), "retry");
});

test("uses deterministic replay keys and collision-free validation paths", () => {
  assert.equal(
    idempotencyKey("run", "official-001", "rename"),
    idempotencyKey("run", "official-001", "rename-idempotent-replay")
  );
  assert.equal(actionRelativePath(files[0], "rename"), "concepts/one--official-001-renamed.md");
  assert.equal(
    actionRelativePath(files[0], "move", { moveDirectory: "concepts/archive" }),
    "concepts/archive/official-001--moved.md"
  );
  assert.equal(actionRelativePath(files[0], "restore-path"), "concepts/one.md");
  assert.equal(
    replayProbeRelativePath(files[0], "rename-idempotent-replay"),
    "concepts/one--official-001-replay-probe.md"
  );
  assert.equal(
    replayProbeRelativePath(files[0], "move-idempotent-replay", {
      moveDirectory: "concepts/archive"
    }),
    "concepts/archive/official-001--replay-moved.md"
  );
});

test("builds deterministic content mutation bodies without changing immutable input", () => {
  const original = Buffer.from("# Original\n\nImmutable body.\n");
  const before = Buffer.from(original);
  const replacement = buildContentMutationBody(
    original,
    "official-001",
    "replace-content"
  );
  const replayProbe = buildContentMutationBody(
    original,
    "official-001",
    "replace-content-idempotent-replay"
  );
  const restored = buildContentMutationBody(
    original,
    "official-001",
    "restore-content"
  );

  assert.deepEqual(original, before);
  assert.ok(replacement.subarray(0, original.length).equals(original));
  assert.ok(replayProbe.subarray(0, original.length).equals(original));
  assert.notDeepEqual(replacement, replayProbe);
  assert.deepEqual(restored, original);
  assert.notEqual(restored, original);
  assert.throws(
    () => buildContentMutationBody(original, "official-001", "controlled-failure-replace"),
    /does not define a content mutation body/u
  );
});

test("resumes controlled source failures from the exact durable phase", () => {
  assert.equal(controlledSourceFailureResumeDecision({
    source: source("source-file-one", "concepts/one.md", 1),
    priorSourceFileId: "source-file-one"
  }), "delete");
  assert.equal(controlledSourceFailureResumeDecision({
    source: null,
    priorSourceFileId: "source-file-one"
  }), "upload");
  assert.equal(controlledSourceFailureResumeDecision({
    source: {
      ...source("source-file-next", "concepts/one.md", 1),
      state: "running"
    },
    priorSourceFileId: "source-file-one"
  }), "wait");
  assert.equal(controlledSourceFailureResumeDecision({
    source: {
      ...source("source-file-next", "concepts/one.md", 1),
      state: "failed"
    },
    priorSourceFileId: "source-file-one"
  }), "complete");
  assert.throws(() => controlledSourceFailureResumeDecision({
    source: source("source-file-next", "concepts/one.md", 1),
    priorSourceFileId: "source-file-one"
  }), /unexpected visible replacement/u);
});

test("selects exactly one active generation model for controlled source failures", () => {
  assert.equal(selectControlledFailureModelId([
    { id: "model-paused", status: "paused", isActive: false },
    { id: "model-active", status: "active", isActive: true }
  ]), "model-active");
  assert.throws(
    () => selectControlledFailureModelId([]),
    /exactly one active generation model/u
  );
  assert.throws(
    () => selectControlledFailureModelId([
      { id: "model-a", status: "active", isActive: true },
      { id: "model-b", status: "active", isActive: true }
    ]),
    /exactly one active generation model/u
  );
});

test("keeps CRUD operation waits above the renewable semantic-stage lease window", () => {
  assert.equal(resolveCrudOperationTimeoutMs(undefined), 20 * 60_000);
  assert.equal(resolveCrudOperationTimeoutMs("1200000"), 1_200_000);
  assert.throws(
    () => resolveCrudOperationTimeoutMs("300000"),
    /at least 900000/u
  );
  assert.throws(
    () => resolveCrudOperationTimeoutMs("invalid"),
    /positive integer/u
  );
});

test("allows only sources intentionally deleted by a resumable CRUD lifecycle", () => {
  assert.deepEqual(expectedMissingSourceAliases({
    completedCaseIds: [
      "crud-case:official-001:delete",
      "crud-case:official-002:delete",
      "crud-case:official-002:recreate",
      "crud-case:legacy-001:delete-idempotent-replay"
    ],
    pendingCase: {
      alias: "legacy-002",
      action: "recreate"
    }
  }), new Set(["official-001", "legacy-001", "legacy-002"]));
  assert.deepEqual(expectedMissingSourceAliases({
    completedCaseIds: [],
    pendingCase: {
      alias: "official-001",
      action: "controlled-source-failure"
    }
  }), new Set(["official-001"]));
});

test("accepts exact delete replays and documented terminal missing responses only", () => {
  assert.deepEqual(classifyDeleteMutationResponse({
    replay: false,
    status: 202,
    operationId: "operation-delete",
    originalOperationId: null
  }), { status: "deleted", operationId: "operation-delete", terminalResourceMissing: false });
  assert.deepEqual(classifyDeleteMutationResponse({
    replay: true,
    status: 202,
    operationId: "operation-delete",
    originalOperationId: "operation-delete"
  }), { status: "replayed", operationId: "operation-delete", terminalResourceMissing: false });
  assert.deepEqual(classifyDeleteMutationResponse({
    replay: true,
    status: 404,
    operationId: null,
    originalOperationId: "operation-delete"
  }), {
    status: "replayed-after-terminal-delete",
    operationId: "operation-delete",
    terminalResourceMissing: true
  });
  assert.throws(() => classifyDeleteMutationResponse({
    replay: true,
    status: 202,
    operationId: "operation-other",
    originalOperationId: "operation-delete"
  }), /changed operation identity/u);
  assert.throws(() => classifyDeleteMutationResponse({
    replay: false,
    status: 404,
    operationId: null,
    originalOperationId: null
  }), /unexpected HTTP 404/u);
});

test("retains only public machine-readable failure reasons in CRUD diagnostics", () => {
  assert.equal(safeHttpFailureReason({
    error: { code: "CONFLICT", message: "RESOURCE_REVISION_CONFLICT" }
  }), "CONFLICT:RESOURCE_REVISION_CONFLICT");
  assert.equal(safeHttpFailureReason({
    error: { code: "CONFLICT", message: "Internal row source-file-secret" }
  }), "CONFLICT");
  assert.equal(safeHttpFailureReason(null), "UNKNOWN");
});

test("reconciles every observed file after a mutation", () => {
  const state = createCrudExecutionState(files, "run");
  const before = snapshotSourceFiles(state.files, [[
    source("source-file-one", "concepts/one.md", 1),
    source("source-file-two", "laws/two.md", 1)
  ]]);
  const after = snapshotSourceFiles(state.files, [[
    source("source-file-one", "concepts/renamed.md", 2),
    source("source-file-two", "laws/two.md", 1)
  ]]);
  const impact = reconcileMutationImpact({
    before,
    after,
    mutationAlias: "official-001",
    action: "rename",
    expectedTargetDisposition: expectedTargetDisposition("rename")
  });
  assert.equal(impact.length, 2);
  assert.deepEqual(impact.map((row) => [row.observedAlias, row.actualDisposition, row.ok]), [
    ["legacy-001", "intentionally-unchanged", true],
    ["official-001", "affected", true]
  ]);
  assert.equal(JSON.stringify(impact).includes("concepts/renamed.md"), false);
});

test("treats retry content preservation as an unchanged verification", () => {
  assert.equal(
    expectedTargetDisposition("restore-after-retry"),
    "intentionally-unchanged"
  );
});

function source(sourceFileId, relativePath, resourceRevision) {
  return {
    sourceFileId,
    relativePath,
    resourceRevision,
    contentRevision: resourceRevision,
    state: "visible",
    currentStage: "generation_activation",
    generatedPath: `pages/${relativePath}`,
    generatedOutputStatus: "visible"
  };
}

import assert from "node:assert/strict";
import test from "node:test";

import { assertCorpusPostgresRows } from
  "../lib/comprehensive-corpus-postgres.mjs";

const REQUIRED_STAGES = [
  "extraction",
  "reconciliation",
  "embedding",
  "community",
  "vector",
  "publication"
];

function validRow(overrides = {}) {
  return {
    alias: "official-001",
    family: "official",
    sourceFileId: "source-1",
    expectedChecksumSha256: "a".repeat(64),
    expectedSizeBytes: 42,
    sourceStatus: "ready",
    sourceDeleted: false,
    safeErrorCode: null,
    currentRevisionCount: 1,
    sourceChecksumSha256: "a".repeat(64),
    sourceByteCount: 42,
    objectState: "verified",
    objectChecksumSha256: "a".repeat(64),
    objectByteCount: 42,
    sourceObjectOwnerCount: 1,
    modelInvocationStatus: "completed",
    expectedModelInvocationStatus: "completed",
    modelNameRecorded: true,
    activeSemanticGenerationCount: 1,
    activeSemanticGenerationState: "active",
    projectionContractCount: 1,
    reconciliationCount: 1,
    skeletonSelected: true,
    sourceChunkCount: 2,
    selectedChunkCount: 2,
    completedStages: [...REQUIRED_STAGES, "validation"],
    liveSemanticStageCount: 0,
    liveOperationWorkCount: 0,
    historicalTerminalStages: [],
    activationEventCount: 1,
    latestActivationAt: "2026-08-11T00:00:00.000Z",
    catalogSourceEntryCount: 1,
    catalogObjectState: "verified",
    activeSnapshotCount: 1,
    activeSearchProjectionCount: 1,
    activeSearchProjectionState: "ready",
    activeSearchProviderKind: "opensearch",
    activeVectorDocumentCount: 2,
    activeVectorDimensionMismatchCount: 0,
    ...overrides
  };
}

test("accepts complete per-file PostgreSQL evidence", () => {
  const rows = [
    validRow(),
    validRow({
      alias: "legacy-001",
      family: "legacy",
      sourceFileId: "source-2",
      expectedChecksumSha256: "b".repeat(64),
      sourceChecksumSha256: "b".repeat(64),
      objectChecksumSha256: "b".repeat(64),
      modelInvocationStatus: "skipped",
      expectedModelInvocationStatus: "skipped",
      modelNameRecorded: false,
      skeletonSelected: false,
      selectedChunkCount: 0,
      completedStages: [...REQUIRED_STAGES],
      historicalTerminalStages: [{
        stageKind: "validation",
        state: "failed",
        safeErrorCode: "PUBLICATION_FAILED",
        completedAt: "2026-08-10T23:00:00.000Z"
      }]
    })
  ];
  const result = assertCorpusPostgresRows(rows, {
    expectedAliases: ["official-001", "legacy-001"],
    expectedProvider: "opensearch"
  });
  assert.equal(result.length, 2);
  assert.equal(result[1].historicalTerminalFailuresExplained, true);
});

test("rejects incomplete, duplicate, live, and inconsistent evidence", () => {
  const cases = [
    [[validRow()], ["official-001", "official-002"], /missing/u],
    [[validRow(), validRow()], ["official-001"], /duplicate/u],
    [[validRow({ sourceStatus: "failed" })], ["official-001"], /ready/u],
    [[validRow({ objectState: "reserved" })], ["official-001"], /verified/u],
    [[validRow({ sourceObjectOwnerCount: 0 })], ["official-001"], /object owner/u],
    [[validRow({ completedStages: REQUIRED_STAGES.filter((stage) => stage !== "vector") })],
      ["official-001"], /vector/u],
    [[validRow({ liveSemanticStageCount: 1 })], ["official-001"], /live semantic/u],
    [[validRow({ catalogSourceEntryCount: 2 })], ["official-001"], /catalog/u],
    [[validRow({ activeSearchProjectionState: "indexing" })], ["official-001"], /search projection/u],
    [[validRow({ expectedModelInvocationStatus: "skipped" })], ["official-001"], /model invocation/u],
    [[validRow({ skeletonSelected: false })], ["official-001"], /skeleton/u]
  ];
  for (const [rows, aliases, pattern] of cases) {
    assert.throws(() => assertCorpusPostgresRows(rows, {
      expectedAliases: aliases,
      expectedProvider: "opensearch"
    }), pattern);
  }
});

test("requires every historical failure to be safe and followed by activation", () => {
  assert.throws(() => assertCorpusPostgresRows([
    validRow({
      historicalTerminalStages: [{
        stageKind: "validation",
        state: "failed",
        safeErrorCode: "PUBLICATION_FAILED",
        completedAt: "2026-08-11T01:00:00.000Z"
      }]
    })
  ], {
    expectedAliases: ["official-001"],
    expectedProvider: "opensearch"
  }), /followed by activation/u);

  assert.throws(() => assertCorpusPostgresRows([
    validRow({
      historicalTerminalStages: [{
        stageKind: "embedding",
        state: "failed",
        safeErrorCode: null,
        completedAt: "2026-08-10T23:00:00.000Z"
      }]
    })
  ], {
    expectedAliases: ["official-001"],
    expectedProvider: "opensearch"
  }), /safe error/u);
});

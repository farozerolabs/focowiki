import assert from "node:assert/strict";
import test from "node:test";

import {
  STORAGE_VNEXT_FULL_LIVE_FLOW_KINDS,
  assertStorageVnextFullLiveFlowEvidence,
  createStorageVnextFullLiveFlowUploadKey
} from "../lib/storage-vnext-full-live-flows.mjs";

function completeEvidence() {
  return {
    runId: "svnext-20260803T000000Z-012345abcdef",
    knowledgeBaseId: "knowledge-base-01234567-89ab-cdef-0123-456789abcdef",
    initialSourceCount: 29_736,
    finalSourceCount: 29_736,
    finalChecksumMismatchCount: 0,
    finalPathMismatchCount: 0,
    terminalWorkItems: 0,
    liveCandidates: 0,
    activeSnapshots: 1,
    controlsUnchanged: true,
    flows: STORAGE_VNEXT_FULL_LIVE_FLOW_KINDS.map((kind) => ({ kind, passed: true }))
  };
}

test("accepts every representative live flow after exact full-corpus restoration", () => {
  const summary = assertStorageVnextFullLiveFlowEvidence(completeEvidence());
  assert.equal(summary.flowCount, STORAGE_VNEXT_FULL_LIVE_FLOW_KINDS.length);
  assert.equal(summary.fullCorpusRestored, true);
});

test("rejects a missing flow, residual work, path drift, or control write", () => {
  for (const mutate of [
    (e) => { e.flows.pop(); },
    (e) => { e.terminalWorkItems = 1; },
    (e) => { e.finalPathMismatchCount = 1; },
    (e) => { e.controlsUnchanged = false; }
  ]) {
    const evidence = completeEvidence();
    mutate(evidence);
    assert.throws(
      () => assertStorageVnextFullLiveFlowEvidence(evidence),
      /full live-flow evidence/u
    );
  }
});

test("scopes deletion restore upload retries to the current source identity", () => {
  const runId = "svnext-20260803T000000Z-012345abcdef";
  const sourceFileId = "source-file-01234567-89ab-cdef-0123-456789abcdef";
  const repeated = createStorageVnextFullLiveFlowUploadKey({ runId, sourceFileId });
  const nextAttempt = createStorageVnextFullLiveFlowUploadKey({
    runId,
    sourceFileId: "source-file-fedcba98-7654-3210-fedc-ba9876543210"
  });

  assert.equal(
    repeated,
    createStorageVnextFullLiveFlowUploadKey({ runId, sourceFileId })
  );
  assert.notEqual(repeated, nextAttempt);
  assert.ok(repeated.length <= 255);
});

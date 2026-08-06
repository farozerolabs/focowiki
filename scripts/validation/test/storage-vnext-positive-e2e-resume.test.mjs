import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveCompletedUploadSessionId
} from "../lib/storage-vnext-positive-e2e-resume.mjs";

const scope = {
  runId: "svnext-20260802T101443Z-7aa18b22cafe",
  knowledgeBaseId: "knowledge-base-owned",
  sampleCount: 214
};

test("preserves a validated resumed upload across later retries", () => {
  assert.equal(resolveCompletedUploadSessionId({
    ...scope,
    report: {
      ...scope,
      completedUploadSessionId: "upload-owned",
      phases: [{ name: "corpus-verified", details: {} }]
    }
  }), "upload-owned");
});

test("recovers a completed or resumed upload from the bounded report history", () => {
  for (const name of ["upload-completed", "upload-resumed"]) {
    assert.equal(resolveCompletedUploadSessionId({
      ...scope,
      report: {
        ...scope,
        phases: [],
        resumedFrom: {
          phases: [{ name, details: { sessionId: "upload-owned" } }]
        }
      }
    }), "upload-owned");
  }
});

test("rejects upload state from another validation scope", () => {
  assert.equal(resolveCompletedUploadSessionId({
    ...scope,
    report: {
      ...scope,
      knowledgeBaseId: "knowledge-base-other",
      completedUploadSessionId: "upload-other",
      phases: [{
        name: "upload-completed",
        details: { sessionId: "upload-other" }
      }]
    }
  }), null);
});

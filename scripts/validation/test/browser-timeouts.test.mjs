import assert from "node:assert/strict";
import test from "node:test";
import {
  isSuccessfulUploadFinalizationResponse,
  resolveUploadResponseTimeoutMs
} from "../lib/browser-timeouts.mjs";

test("accepts successful Admin upload finalization responses", () => {
  assert.equal(isSuccessfulUploadFinalizationResponse({
    method: "POST",
    url: "http://127.0.0.1:43000/admin/api/knowledge-bases/kb-1/upload-sessions/session-1/finalize",
    status: 200
  }), true);
  assert.equal(isSuccessfulUploadFinalizationResponse({
    method: "POST",
    url: "http://127.0.0.1:43000/admin/api/knowledge-bases/kb-1/upload-sessions/session-1/finalize",
    status: 202
  }), true);
});

test("rejects failed or unrelated upload responses", () => {
  assert.equal(isSuccessfulUploadFinalizationResponse({
    method: "POST",
    url: "http://127.0.0.1:43000/admin/api/knowledge-bases/kb-1/upload-sessions/session-1/finalize",
    status: 409
  }), false);
  assert.equal(isSuccessfulUploadFinalizationResponse({
    method: "PUT",
    url: "http://127.0.0.1:43000/admin/api/knowledge-bases/kb-1/upload-sessions/session-1/finalize",
    status: 200
  }), false);
  assert.equal(isSuccessfulUploadFinalizationResponse({
    method: "POST",
    url: "http://127.0.0.1:43000/admin/api/knowledge-bases/kb-1/upload-sessions/session-1/reconcile",
    status: 200
  }), false);
});

test("keeps the configured mutation timeout for a single upload", () => {
  assert.equal(resolveUploadResponseTimeoutMs({
    sampleCount: 1,
    configuredTimeoutMs: 30_000,
    taskTimeoutMs: 180_000
  }), 30_000);
});

test("scales the upload response timeout for large browser batches", () => {
  assert.equal(resolveUploadResponseTimeoutMs({
    sampleCount: 119,
    configuredTimeoutMs: 30_000,
    taskTimeoutMs: 600_000
  }), 149_000);
});

test("does not exceed the task timeout", () => {
  assert.equal(resolveUploadResponseTimeoutMs({
    sampleCount: 200,
    configuredTimeoutMs: 30_000,
    taskTimeoutMs: 120_000
  }), 120_000);
});

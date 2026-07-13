import assert from "node:assert/strict";
import test from "node:test";
import { resolveUploadResponseTimeoutMs } from "../lib/browser-timeouts.mjs";

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

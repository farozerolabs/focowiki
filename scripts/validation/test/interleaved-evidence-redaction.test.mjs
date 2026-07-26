import assert from "node:assert/strict";
import test from "node:test";
import {
  createEvidenceRedactor,
  sanitizeEvidenceValue
} from "../lib/interleaved-evidence-redaction.mjs";

test("aliases durable identities consistently without exposing raw values", () => {
  const redactor = createEvidenceRedactor("validation-seed");

  const first = redactor.alias("knowledge_base", "kb-private");
  const second = redactor.alias("knowledge_base", "kb-private");
  const different = redactor.alias("knowledge_base", "kb-other");

  assert.equal(first, second);
  assert.notEqual(first, different);
  assert.match(first, /^knowledge-base-[a-f0-9]{12}$/u);
  assert.doesNotMatch(first, /private/u);
});

test("removes secrets, storage keys, local paths, and provider payloads", () => {
  const localPath = ["", "Users", "example", "source.md"].join("/");
  const value = sanitizeEvidenceValue({
    state: "running",
    objectKey: "private-bucket/source.md",
    redisKey: "queue:private",
    apiKey: "secret",
    requestJson: { prompt: "provider body" },
    localPath,
    nested: {
      logicalPath: "pages/reference.md",
      errorCode: "SAFE_ERROR"
    }
  });

  assert.deepEqual(value, {
    state: "running",
    nested: {
      logicalPath: "pages/reference.md",
      errorCode: "SAFE_ERROR"
    }
  });
});

test("redacts nested internal identities while preserving states and logical paths", () => {
  const redactor = createEvidenceRedactor("validation-seed");
  const value = redactor.redact({
    knowledgeBaseId: "kb-private",
    sourceFileId: "source-private",
    generationId: "generation-private",
    state: "completed",
    logicalPath: "pages/reference.md"
  });

  assert.match(value.knowledgeBaseId, /^knowledge-base-id-[a-f0-9]{12}$/u);
  assert.match(value.sourceFileId, /^source-file-id-[a-f0-9]{12}$/u);
  assert.match(value.generationId, /^generation-id-[a-f0-9]{12}$/u);
  assert.equal(value.state, "completed");
  assert.equal(value.logicalPath, "pages/reference.md");
  assert.doesNotMatch(JSON.stringify(value), /private/u);
});

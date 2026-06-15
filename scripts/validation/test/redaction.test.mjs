import test from "node:test";
import assert from "node:assert/strict";

import { redactPotentialPathText, redactReportText } from "../lib/redaction.mjs";

test("redactPotentialPathText removes local paths, bearer tokens, and object keys", () => {
  const redacted = redactPotentialPathText(
    "Failed /var/tmp/private-project/input.md Authorization: Bearer token-value knowledge-bases/kb/uploads/task/sources/source/file.md"
  );

  assert.equal(redacted.includes("/var/tmp/private-project"), false);
  assert.equal(redacted.includes("token-value"), false);
  assert.equal(redacted.includes("task/sources/source"), false);
  assert.equal(redacted.includes("<redacted-path>"), true);
  assert.equal(redacted.includes("<redacted>"), true);
});

test("redactReportText removes secret-like values from reports", () => {
  const redacted = redactReportText(
    "ADMIN_PASSWORD=admin-secret S3_SECRET_ACCESS_KEY=s3-secret MODEL_API_KEY=model-secret Cookie session-secret"
  );

  assert.equal(redacted.includes("admin-secret"), false);
  assert.equal(redacted.includes("s3-secret"), false);
  assert.equal(redacted.includes("model-secret"), false);
  assert.equal(redacted.includes("session-secret"), false);
});

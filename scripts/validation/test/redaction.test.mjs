import test from "node:test";
import assert from "node:assert/strict";

import { hasSecretLikeAuditData } from "../cleaned-markdown-flow.mjs";
import { redactPotentialPathText, redactReportText } from "../lib/redaction.mjs";

test("redactPotentialPathText removes local paths, bearer tokens, and object keys", () => {
  const redacted = redactPotentialPathText(
    "Failed /var/tmp/private-project/input.md Authorization: Bearer token-value knowledge-bases/kb/upload-sessions/session/entries/entry/content.md"
  );

  assert.equal(redacted.includes("/var/tmp/private-project"), false);
  assert.equal(redacted.includes("token-value"), false);
  assert.equal(redacted.includes("session/entries/entry"), false);
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

test("hasSecretLikeAuditData allows public OpenAPI key lifecycle event names", () => {
  assert.equal(
    hasSecretLikeAuditData([
      {
        event_type: "public_openapi_key_create",
        result: "success",
        error_code: null,
        username: null,
        client_ip: "local",
        user_agent: "node",
        origin: "http://127.0.0.1:43100"
      }
    ]),
    false
  );
});

test("hasSecretLikeAuditData still detects bearer tokens", () => {
  assert.equal(
    hasSecretLikeAuditData([
      {
        event_type: "public_openapi_auth",
        result: "failure",
        error_code: "UNAUTHORIZED",
        username: null,
        client_ip: "local",
        user_agent: "Authorization: Bearer fwok_secret-value",
        origin: "http://127.0.0.1:43100"
      }
    ]),
    true
  );
});

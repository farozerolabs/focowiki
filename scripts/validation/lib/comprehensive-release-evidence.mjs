import crypto from "node:crypto";
import { redactReportText } from "./redaction.mjs";

const REDACTED = Object.freeze({
  path: "<redacted-path>",
  secret: "<redacted-secret>",
  object: "<redacted-object-key>",
  vector: "<redacted-vector>",
  provider: "<redacted-provider-payload>",
  body: "<redacted-corpus-body>"
});
const MAX_STRING_LENGTH = 4096;
const MAX_ARRAY_ITEMS = 100;
const MAX_OBJECT_FIELDS = 100;

export function createSanitizedEvidence(kind, observation) {
  const serialized = JSON.stringify(observation);
  const evidence = {
    schemaVersion: 1,
    kind,
    sha256: crypto.createHash("sha256").update(serialized).digest("hex"),
    byteLength: Buffer.byteLength(serialized),
    observation: sanitize(observation, "", 0)
  };
  assertNoSensitiveEvidence(evidence);
  return evidence;
}

export function assertNoSensitiveEvidence(value) {
  inspectValue(value, "", 0);
  const serialized = JSON.stringify(value);
  const unsafePatterns = [
    /(?:\/Users\/|\/home\/|[A-Z]:\\)[^"'\s]*/u,
    /Bearer\s+(?!<redacted>)[A-Za-z0-9._~+/-]+/iu,
    /(?:MODEL_API_KEY|OPENAPI_KEY|S3_SECRET_ACCESS_KEY|ADMIN_PASSWORD|SESSION_SECRET)\s*[:=]\s*(?!<redacted)[^\s,;}"']+/iu,
    /(?:knowledge-bases|upload-sessions|releases)\/(?!<redacted-object-key>)[^"'\s]+/iu
  ];
  if (unsafePatterns.some((pattern) => pattern.test(serialized))) {
    throw new Error("Comprehensive evidence contains sensitive text");
  }
}

function sanitize(value, key, depth) {
  if (depth > 8) return "<truncated-depth>";
  if (isSensitiveKey(key, "provider")) return REDACTED.provider;
  if (isSensitiveKey(key, "vector")) return REDACTED.vector;
  if (isSensitiveKey(key, "body")) return REDACTED.body;
  if (isSensitiveKey(key, "path")) return REDACTED.path;
  if (isSensitiveKey(key, "object")) return REDACTED.object;
  if (isSensitiveKey(key, "secret")) return REDACTED.secret;
  if (typeof value === "string") {
    return redactReportText(value).slice(0, MAX_STRING_LENGTH);
  }
  if (Array.isArray(value)) {
    if (value.length > 3 && value.every((item) => typeof item === "number")) return REDACTED.vector;
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitize(item, key, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, MAX_OBJECT_FIELDS)
      .map(([childKey, childValue]) => [childKey, sanitize(childValue, childKey, depth + 1)]));
  }
  return value;
}

function inspectValue(value, key, depth) {
  if (depth > 10) throw new Error("Comprehensive evidence contains sensitive excessive depth");
  if (Array.isArray(value)) {
    if (value.length > 3 && value.every((item) => typeof item === "number")) {
      throw new Error("Comprehensive evidence contains sensitive vector data");
    }
    for (const item of value) inspectValue(item, key, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [childKey, childValue] of Object.entries(value)) {
    const redactedValues = Object.values(REDACTED);
    if (isSensitiveKey(childKey, "provider") && !redactedValues.includes(childValue)) {
      throw new Error("Comprehensive evidence contains sensitive provider payload");
    }
    if (isSensitiveKey(childKey, "vector") && !redactedValues.includes(childValue)) {
      throw new Error("Comprehensive evidence contains sensitive vector data");
    }
    if ((isSensitiveKey(childKey, "path") || isSensitiveKey(childKey, "object") || isSensitiveKey(childKey, "secret") || isSensitiveKey(childKey, "body"))
      && !redactedValues.includes(childValue)) {
      throw new Error("Comprehensive evidence contains sensitive field data");
    }
    inspectValue(childValue, childKey, depth + 1);
  }
}

function isSensitiveKey(key, kind) {
  const patterns = {
    provider: /(?:providerPayload|requestPayload|responsePayload|messages|documents|embeddingInput)/iu,
    vector: /(?:vector|embeddingValues)/iu,
    body: /(?:rawBody|markdownBody|corpusBody|documentBody|contentBody|input)$/iu,
    path: /(?:localPath|absolutePath|sourceRoot|corpusRoot)/iu,
    object: /(?:objectKey|storageKey|s3Key)/iu,
    secret: /(?:authorization|cookie|password|secret|apiKey|accessKey|sessionToken)/iu
  };
  return patterns[kind].test(String(key));
}

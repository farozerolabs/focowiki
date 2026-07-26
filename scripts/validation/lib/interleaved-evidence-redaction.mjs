import crypto from "node:crypto";

const OMITTED_KEYS = new Set([
  "apiKey",
  "authorization",
  "baseUrl",
  "encryptedApiKey",
  "idempotencyKey",
  "leaseToken",
  "localPath",
  "lockedBy",
  "objectKey",
  "payloadJson",
  "providerPayload",
  "redisKey",
  "requestJson",
  "requestFingerprint",
  "secret",
  "settingsSnapshotJson",
  "stagingObjectKey",
  "token",
  "writeToken"
]);

export function createEvidenceRedactor(seed) {
  if (!seed) throw new Error("Evidence redaction requires a stable run seed.");

  return {
    alias(kind, identity) {
      if (!kind || identity === undefined || identity === null) {
        throw new Error("Evidence aliases require kind and identity.");
      }
      const normalizedKind = String(kind).replaceAll("_", "-");
      const digest = crypto
        .createHmac("sha256", String(seed))
        .update(`${kind}:${identity}`)
        .digest("hex")
        .slice(0, 12);
      return `${normalizedKind}-${digest}`;
    },
    sanitize(value) {
      return sanitizeEvidenceValue(value);
    },
    redact(value) {
      return redactEvidenceIdentities(
        sanitizeEvidenceValue(value),
        (kind, identity) => this.alias(kind, identity)
      );
    }
  };
}

export function sanitizeEvidenceValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeEvidenceValue);
  if (!value || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !OMITTED_KEYS.has(key))
      .map(([key, entry]) => [key, sanitizeEvidenceValue(entry)])
  );
}

function redactEvidenceIdentities(value, alias, parentKey = "identity") {
  if (Array.isArray(value)) {
    return value.map((entry) =>
      redactEvidenceIdentities(entry, alias, parentKey)
    );
  }
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (isIdentityKey(key)) {
        if (Array.isArray(entry)) {
          return [
            key,
            entry.map((identity) =>
              identity === null ? null : alias(toAliasKind(key), identity)
            )
          ];
        }
        return [
          key,
          entry === null ? null : alias(toAliasKind(key), entry)
        ];
      }
      return [key, redactEvidenceIdentities(entry, alias, key)];
    })
  );
}

function isIdentityKey(key) {
  return (
    key === "id" ||
    key.endsWith("Id") ||
    key.endsWith("Ids") ||
    key === "checksumSha256"
  );
}

function toAliasKind(key) {
  return key
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .toLowerCase();
}

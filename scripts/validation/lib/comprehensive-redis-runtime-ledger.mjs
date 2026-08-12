const EXPECTED_RESPONSIBILITIES = Object.freeze([
  "session",
  "generic-lock",
  "source-file-lock",
  "source-file-graph-lock",
  "knowledge-base-publication-lock",
  "pagination-cursor",
  "page-cache",
  "pagination-invalidation",
  "public-openapi-key-cache",
  "public-openapi-key-usage",
  "runtime-settings-version",
  "rate-limit",
  "source-runtime-cleanup",
  "knowledge-base-runtime-cleanup"
]);

export function expectedComprehensiveRedisResponsibilities() {
  return [...EXPECTED_RESPONSIBILITIES];
}

export function validateComprehensiveRedisRuntimeLedger(input) {
  const rows = Array.isArray(input.rows) ? input.rows : [];
  const existingKeys = Array.isArray(input.existingKeys) ? input.existingKeys : [];
  const expected = new Set(EXPECTED_RESPONSIBILITIES);
  const observed = new Set(rows.map((row) => row.responsibility));
  const failures = [];

  for (const responsibility of expected) {
    if (!observed.has(responsibility)) failures.push(`missing:${responsibility}`);
  }
  for (const responsibility of observed) {
    if (!expected.has(responsibility)) failures.push(`unexpected:${responsibility}`);
  }
  if (observed.size !== rows.length) failures.push("duplicate-responsibility");

  for (const row of rows) {
    const prefix = String(row.responsibility ?? "unknown");
    if (!Number.isSafeInteger(row.keyCount) || row.keyCount < 1) {
      failures.push(`${prefix}:key-count`);
    }
    if (!Array.isArray(row.types) || row.types.length === 0
      || row.types.some((type) => type !== "string")) {
      failures.push(`${prefix}:type`);
    }
    if (!Number.isSafeInteger(row.minimumTtlSeconds) || row.minimumTtlSeconds < 1
      || !Number.isSafeInteger(row.maximumTtlSeconds) || row.maximumTtlSeconds < 1
      || row.maximumTtlSeconds > row.expectedMaximumTtlSeconds) {
      failures.push(`${prefix}:ttl`);
    }
    if (!Number.isSafeInteger(row.memoryBytes) || row.memoryBytes < 1
      || row.memoryBytes > 1_048_576) {
      failures.push(`${prefix}:memory`);
    }
    if (!Number.isFinite(row.latencyMs) || row.latencyMs < 0 || row.latencyMs > 5_000) {
      failures.push(`${prefix}:latency`);
    }
    if (row.recoveryConfirmed !== true) failures.push(`${prefix}:recovery`);
    if (row.cleanupConfirmed !== true) failures.push(`${prefix}:cleanup`);
    if (row.automatedStatus !== "pass" || row.manualStatus !== "pass") {
      failures.push(`${prefix}:review`);
    }
  }

  for (const row of existingKeys) {
    const prefix = `existing:${row.keyFingerprintSha256 ?? "unknown"}`;
    if (!/^[a-f0-9]{64}$/u.test(row.keyFingerprintSha256 ?? "")) {
      failures.push(`${prefix}:fingerprint`);
    }
    if (row.type !== "string") failures.push(`${prefix}:type`);
    if (!Number.isSafeInteger(row.ttlSeconds) || row.ttlSeconds < 1) {
      failures.push(`${prefix}:ttl`);
    }
    if (!Number.isSafeInteger(row.memoryBytes) || row.memoryBytes < 1
      || row.memoryBytes > 1_048_576) {
      failures.push(`${prefix}:memory`);
    }
  }

  if (containsPrivateRuntimeMaterial(input)) failures.push("private-material");

  return {
    ok: failures.length === 0,
    expectedResponsibilityCount: EXPECTED_RESPONSIBILITIES.length,
    observedResponsibilityCount: observed.size,
    existingKeyCount: existingKeys.length,
    failures
  };
}

function containsPrivateRuntimeMaterial(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsPrivateRuntimeMaterial);
  for (const [key, nested] of Object.entries(value)) {
    if (["key", "rawKey", "value", "rawValue", "ownerId"].includes(key)) return true;
    if (containsPrivateRuntimeMaterial(nested)) return true;
  }
  return false;
}

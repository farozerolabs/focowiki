const PER_FILE_TRANSFER_BUDGET_MS = 1_000;

export function resolveUploadResponseTimeoutMs({
  sampleCount,
  configuredTimeoutMs,
  taskTimeoutMs
}) {
  assertPositiveInteger(sampleCount, "sampleCount");
  assertPositiveInteger(configuredTimeoutMs, "configuredTimeoutMs");
  assertPositiveInteger(taskTimeoutMs, "taskTimeoutMs");

  if (sampleCount === 1) {
    return Math.min(configuredTimeoutMs, taskTimeoutMs);
  }

  return Math.min(
    taskTimeoutMs,
    configuredTimeoutMs + sampleCount * PER_FILE_TRANSFER_BUDGET_MS
  );
}

function assertPositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
}

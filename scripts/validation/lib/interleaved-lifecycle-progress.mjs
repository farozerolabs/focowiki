const HEARTBEAT_FIELDS = new Set([
  "heartbeatAt",
  "lastHeartbeatAt",
  "leaseExpiresAt",
  "updatedAt"
]);

const TERMINAL_STATES = new Set([
  "completed",
  "active",
  "failed",
  "cancelled",
  "superseded",
  "expired"
]);

export function createProgressTracker(input = {}) {
  const startedAtMs = input.startedAtMs ?? Date.now();
  const deadlineMs = readPositiveInteger(input.deadlineMs, 5 * 60_000);
  const stallMs = readPositiveInteger(input.stallMs, 60_000);

  return {
    startedAtMs,
    deadlineAtMs: startedAtMs + deadlineMs,
    stallMs,
    lastDurableFingerprint: null,
    lastDurableProgressAtMs: startedAtMs,
    lastProcessed: null,
    observations: []
  };
}

export function observeProgress(tracker, snapshot, observedAtMs = Date.now()) {
  if (observedAtMs > tracker.deadlineAtMs) {
    throw new Error("Lifecycle progress exceeded its deterministic deadline.");
  }

  const processed = readCounter(snapshot?.processed);
  if (
    tracker.lastProcessed !== null &&
    processed !== null &&
    processed < tracker.lastProcessed
  ) {
    throw new Error("Lifecycle progress counter regressed.");
  }

  const fingerprint = durableFingerprint(snapshot);
  const changed = fingerprint !== tracker.lastDurableFingerprint;
  if (changed) {
    tracker.lastDurableFingerprint = fingerprint;
    tracker.lastDurableProgressAtMs = observedAtMs;
  } else if (
    !TERMINAL_STATES.has(snapshot?.state) &&
    observedAtMs - tracker.lastDurableProgressAtMs >= tracker.stallMs
  ) {
    throw new Error("Lifecycle made no durable progress within the stall window.");
  }

  tracker.lastProcessed = processed ?? tracker.lastProcessed;
  tracker.observations.push({
    observedAtMs,
    state: snapshot?.state ?? null,
    processed,
    total: readCounter(snapshot?.total),
    durableChanged: changed
  });
  return { changed, terminal: TERMINAL_STATES.has(snapshot?.state) };
}

export async function waitForStateBarrier(input) {
  const startedAt = Date.now();
  const timeoutMs = readPositiveInteger(input.timeoutMs, 60_000);
  const pollIntervalMs = readNonNegativeInteger(input.pollIntervalMs, 250);
  let lastSnapshot;

  while (Date.now() - startedAt <= timeoutMs) {
    lastSnapshot = await input.sample();
    if (input.matches(lastSnapshot)) return lastSnapshot;
    await sleep(pollIntervalMs);
  }

  throw new Error(
    `${input.description ?? "Lifecycle state"} barrier timed out after ${timeoutMs}ms.`
  );
}

function durableFingerprint(snapshot) {
  return JSON.stringify(sortObject(removeHeartbeatFields(snapshot ?? {})));
}

function removeHeartbeatFields(value) {
  if (Array.isArray(value)) return value.map(removeHeartbeatFields);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !HEARTBEAT_FIELDS.has(key))
      .map(([key, entry]) => [key, removeHeartbeatFields(entry)])
  );
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortObject(value[key])])
  );
}

function readCounter(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function readPositiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function readNonNegativeInteger(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

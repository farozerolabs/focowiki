import { redactReportText } from "./redaction.mjs";

const OWNED_RESOURCE_KINDS = [
  "knowledgeBases",
  "apiKeys",
  "webhooks",
  "uploadSessions",
  "sourceFiles",
  "sourceDirectories",
  "operations",
  "redisKeys",
  "s3Prefixes",
  "screenshots",
  "temporaryFiles",
  "processes"
];

const UNSAFE_COMMAND_PATTERNS = [
  /\bdrop\s+schema\b/i,
  /\btruncate\b/i,
  /\bflush(?:all|db)\b/i,
  /\bs3\s+rm\b.*\s--recursive\b/i,
  /\bdown\b.*\s--volumes\b/i,
  /\brm\s+-rf\s+\/(?:\s|$)/i
];

export function createFullSystemRunState(runId) {
  if (!/^full-system-e2e-[a-z0-9-]+$/.test(runId)) {
    throw new Error("Validation run ID is invalid.");
  }

  return {
    kind: "focowiki-full-system-e2e",
    runId,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    currentLayer: null,
    layers: [],
    owned: Object.fromEntries(OWNED_RESOURCE_KINDS.map((kind) => [kind, []])),
    before: { counts: {}, existingResourceIds: [] },
    after: { counts: {}, existingResourceIds: [] },
    findings: [],
    bugFixes: [],
    blockers: [],
    remainingRisks: [],
    cleanup: { attempted: false, completed: false, unresolved: [] }
  };
}

export function assertCleanupTargetOwned(state, resourceKind, resourceId) {
  const resources = state?.owned?.[resourceKind];

  if (!Array.isArray(resources) || !resources.includes(resourceId)) {
    throw new Error(`${resourceKind}:${resourceId} is not owned by validation run.`);
  }
}

export function assertSafeValidationCommand(command) {
  if (UNSAFE_COMMAND_PATTERNS.some((pattern) => pattern.test(command))) {
    throw new Error(`Unsafe validation command rejected: ${safeCommandLabel(command)}`);
  }
}

export function createOperationCoverageTracker(operationIds) {
  return {
    expected: [...new Set(operationIds)].sort(),
    covered: new Map()
  };
}

export function markOperationCovered(tracker, operationId, evidence = {}) {
  if (!tracker.expected.includes(operationId)) {
    throw new Error(`Unknown operation coverage entry: ${operationId}`);
  }

  tracker.covered.set(operationId, sanitizeEvidence(evidence));
}

export function summarizeOperationCoverage(tracker) {
  const covered = [...tracker.covered.keys()].sort();
  const missing = tracker.expected.filter((operationId) => !tracker.covered.has(operationId));

  return {
    expectedCount: tracker.expected.length,
    coveredCount: covered.length,
    missingCount: missing.length,
    covered,
    missing,
    evidence: Object.fromEntries(
      covered.map((operationId) => [operationId, tracker.covered.get(operationId)])
    )
  };
}

export function serializeSafeRunState(state) {
  return `${redactReportText(JSON.stringify(state, null, 2))}\n`;
}

export function markRunLayer(state, input) {
  const layer = {
    id: input.id,
    status: input.status,
    startedAt: input.startedAt ?? null,
    finishedAt: input.finishedAt ?? null,
    durationMs: input.durationMs ?? null,
    summary: input.summary ? redactReportText(input.summary) : null
  };
  const existingIndex = state.layers.findIndex((entry) => entry.id === input.id);

  if (existingIndex >= 0) {
    state.layers[existingIndex] = layer;
  } else {
    state.layers.push(layer);
  }
  state.currentLayer = input.status === "running" ? input.id : null;

  return layer;
}

function sanitizeEvidence(evidence) {
  const safe = {};

  for (const key of ["status", "requestId", "durationMs", "case", "result"]) {
    if (evidence[key] !== undefined) {
      safe[key] = redactReportText(String(evidence[key]));
    }
  }

  return safe;
}

function safeCommandLabel(command) {
  return command.trim().split(/\s+/).slice(0, 3).join(" ");
}

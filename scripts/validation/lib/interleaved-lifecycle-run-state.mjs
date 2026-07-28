import path from "node:path";

const RUN_ID_PATTERN = /^validation-\d{14}-[a-f0-9]{8}$/u;
const OWNED_KINDS = Object.freeze([
  "knowledgeBases",
  "apiKeys",
  "idempotencyKeys",
  "uploadSessions",
  "operations",
  "sourceFiles",
  "sourceDirectories",
  "deletionIntents",
  "generations",
  "postgresRows",
  "redisKeys",
  "s3Objects",
  "temporaryFiles",
  "services"
]);

export function createInterleavedRunState(input) {
  if (!RUN_ID_PATTERN.test(input?.runId ?? "")) {
    throw new Error("Interleaved validation run ID is invalid.");
  }

  const reportRoot = path.resolve(input.reportRoot);
  const expectedRoot = path.resolve(
    "ReferenceDocs",
    "validate-interleaved-lifecycle-e2e"
  );
  const expectedSuffix = path.join(
    "ReferenceDocs",
    "validate-interleaved-lifecycle-e2e"
  );
  if (
    reportRoot !== expectedRoot &&
    !reportRoot.startsWith(`${expectedRoot}${path.sep}`) &&
    !reportRoot.endsWith(expectedSuffix)
  ) {
    throw new Error("Interleaved validation evidence must stay in its report root.");
  }

  return {
    kind: "focowiki-interleaved-lifecycle-e2e",
    runId: input.runId,
    seed: input.seed ?? input.runId,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    evidenceDir: path.join(reportRoot, "runs", input.runId),
    owned: Object.fromEntries(OWNED_KINDS.map((kind) => [kind, []])),
    baseline: null,
    scenarios: [],
    findings: [],
    cleanup: {
      attempted: false,
      completed: false,
      unresolved: []
    }
  };
}

export function registerInterleavedOwnership(state, kind, identity) {
  const owned = state?.owned?.[kind];
  if (!Array.isArray(owned)) {
    throw new Error(`Unknown interleaved ownership kind: ${kind}.`);
  }
  if (!identity) {
    throw new Error("Interleaved ownership identity is required.");
  }
  if (!owned.includes(identity)) owned.push(identity);
  return identity;
}

export function assertInterleavedRunOwned(state, kind, identity) {
  const owned = state?.owned?.[kind];
  if (!Array.isArray(owned) || !owned.includes(identity)) {
    throw new Error(`${kind}:${identity} is not owned by this validation run.`);
  }
}

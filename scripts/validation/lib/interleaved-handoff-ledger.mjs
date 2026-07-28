const PUBLIC_OUTCOMES = new Set([
  "pending",
  "succeeded",
  "failed",
  "cancelled",
  "superseded",
  "conflicted"
]);

export function createHandoffLedger(input) {
  if (!input?.scenarioId || !input?.knowledgeBaseId) {
    throw new Error("Handoff ledger requires scenario and knowledge-base identities.");
  }

  return {
    scenarioId: input.scenarioId,
    knowledgeBaseId: input.knowledgeBaseId,
    expectedKinds: [...new Set(input.expectedKinds ?? [])],
    expectedTerminalKinds: [...new Set(input.expectedTerminalKinds ?? [])],
    publicOutcome: "pending",
    records: []
  };
}

export function addHandoffRecord(ledger, record) {
  if (!ledger || !record?.kind || !record?.id) {
    throw new Error("Handoff records require kind and identity.");
  }

  ledger.records.push({
    kind: record.kind,
    id: String(record.id),
    knowledgeBaseId: record.knowledgeBaseId ?? ledger.knowledgeBaseId,
    ownerKind: record.ownerKind ?? null,
    ownerId: record.ownerId == null ? null : String(record.ownerId),
    resourceRevision: normalizeRevision(record.resourceRevision),
    predecessorId: record.predecessorId == null
      ? null
      : String(record.predecessorId),
    state: record.state ?? null,
    durable: record.durable === true,
    terminal: record.terminal === true,
    observedAt: record.observedAt ?? null,
    metadata: sanitizeMetadata(record.metadata)
  });

  return ledger.records.at(-1);
}

export function assertHandoffLedger(ledger) {
  if (!PUBLIC_OUTCOMES.has(ledger?.publicOutcome)) {
    throw new Error("Handoff ledger has an invalid public outcome.");
  }

  const records = ledger.records ?? [];
  const identities = new Map(
    records.map((record) => [`${record.kind}:${record.id}`, record])
  );

  for (const record of records) {
    if (record.knowledgeBaseId !== ledger.knowledgeBaseId) {
      throw new Error(`Handoff knowledge base continuity failed for ${record.kind}.`);
    }

    if (record.ownerKind || record.ownerId) {
      if (!record.ownerKind || !record.ownerId) {
        throw new Error(`Handoff owner identity is incomplete for ${record.kind}.`);
      }
      if (!identities.has(`${record.ownerKind}:${record.ownerId}`)) {
        throw new Error(`Handoff owner is missing for ${record.kind}:${record.id}.`);
      }
    } else if (record.durable) {
      throw new Error(`Durable handoff has no owner: ${record.kind}:${record.id}.`);
    }
  }

  if (ledger.publicOutcome === "succeeded") {
    for (const kind of ledger.expectedKinds) {
      if (!records.some((record) => record.kind === kind)) {
        throw new Error(`Missing expected handoff kind: ${kind}.`);
      }
    }
  }

  assertRevisionMonotonicity(records);
  assertModificationPathContinuity(records);
  assertModificationRevisionContinuity(records);
  assertGenerationPredecessorContinuity(records);
  assertSingleActivation(records);
  assertAttemptBounds(records);
  assertTerminalConvergence(ledger, records);
  assertExceptionalOutcome(ledger, records);
  return true;
}

function assertRevisionMonotonicity(records) {
  const revisions = new Map();

  for (const record of records) {
    if (record.resourceRevision === null) continue;
    const key = record.kind === "source_revision"
      ? `${record.kind}:${record.ownerKind ?? ""}:${record.ownerId ?? record.id}`
      : `${record.kind}:${record.id}`;
    const previous = revisions.get(key);

    if (previous !== undefined && record.resourceRevision < previous) {
      throw new Error(`Resource revision regressed for ${record.kind}.`);
    }
    revisions.set(key, record.resourceRevision);
  }
}

function assertSingleActivation(records) {
  const activeIds = new Set(
    records
      .filter((record) => record.kind === "activation")
      .map((record) => record.id)
  );

  if (activeIds.size > 1) {
    throw new Error("Handoff ledger contains multiple active Generations.");
  }
  const knowledgeBase = records.find(
    (record) => record.kind === "knowledge_base"
  );
  const expectedActive = knowledgeBase?.metadata?.activeGenerationId;
  if (
    expectedActive &&
    (activeIds.size !== 1 || !activeIds.has(expectedActive))
  ) {
    throw new Error("Active Generation ownership failed.");
  }
}

function assertAttemptBounds(records) {
  for (const record of records) {
    const attemptCount = record.metadata?.attemptCount;
    const maxAttempts = record.metadata?.maxAttempts;
    if (
      Number.isSafeInteger(attemptCount) &&
      Number.isSafeInteger(maxAttempts) &&
      attemptCount > maxAttempts
    ) {
      throw new Error(`Attempt budget exceeded for ${record.kind}.`);
    }
    if (
      record.state === "retry" &&
      record.metadata?.retryAt === undefined
    ) {
      throw new Error(`Retry schedule is missing for ${record.kind}.`);
    }
  }
}

function assertTerminalConvergence(ledger, records) {
  if (ledger.publicOutcome === "pending") return;

  for (const kind of ledger.expectedTerminalKinds) {
    const matches = records.filter((record) => record.kind === kind);
    if (matches.length === 0) {
      throw new Error(`Missing terminal handoff kind: ${kind}.`);
    }
    if (!matches.some((record) => record.terminal)) {
      throw new Error(`Handoff kind did not converge: ${kind}.`);
    }
  }
}

function assertExceptionalOutcome(ledger, records) {
  if (!["failed", "cancelled", "superseded", "conflicted"].includes(
    ledger.publicOutcome
  )) {
    return;
  }

  const activeGenerationIds = new Set(
    records
      .filter((record) => record.kind === "activation")
      .map((record) => record.id)
  );
  const failedGenerationIds = records
    .filter(
      (record) =>
        record.kind === "generation" &&
        ["failed", "cancelled", "superseded"].includes(record.state)
    )
    .map((record) => record.id);
  if (failedGenerationIds.some((id) => activeGenerationIds.has(id))) {
    throw new Error("Exceptional Generation was activated.");
  }

  if (ledger.publicOutcome === "conflicted") {
    const staged = records.find(
      (record) =>
        record.kind === "source" &&
        (
          record.metadata?.candidateOperationId ||
          record.metadata?.candidateRevisionId ||
          record.metadata?.candidateRelativePath
        )
    );
    if (staged) {
      throw new Error("Conflicted modification left staged source state.");
    }
  }
}

function assertModificationPathContinuity(records) {
  const operation = records.find(
    (record) =>
      ["operation", "public_operation"].includes(record.kind) &&
      typeof record.metadata?.resultingPath === "string"
  );
  if (!operation) return;

  const source = records.find(
    (record) =>
      record.kind === "source" &&
      record.metadata?.logicalPath !== undefined
  );
  if (
    source &&
    source.metadata.logicalPath !== operation.metadata.resultingPath
  ) {
    throw new Error("Modification path continuity failed.");
  }
}

function assertModificationRevisionContinuity(records) {
  const operation = records.find(
    (record) =>
      ["operation", "public_operation"].includes(record.kind) &&
      typeof record.metadata?.mutationKind === "string" &&
      Number.isSafeInteger(record.metadata?.resultingResourceRevision)
  );
  if (!operation) return;

  const expected = operation.metadata.expectedResourceRevision;
  const resulting = operation.metadata.resultingResourceRevision;
  if (Number.isSafeInteger(expected) && resulting <= expected) {
    throw new Error("Modification revision continuity failed.");
  }

  const targetKind = operation.metadata.mutationKind.startsWith(
    "source_directory_"
  )
    ? "directory"
    : operation.metadata.mutationKind === "knowledge_base_metadata_update"
      ? "knowledge_base"
      : "source";
  const target = records.find((record) => record.kind === targetKind);
  if (target && target.resourceRevision !== resulting) {
    throw new Error("Modification revision continuity failed.");
  }
}

function assertGenerationPredecessorContinuity(records) {
  const priorActive = records.find(
    (record) => record.kind === "active_generation"
  );
  const candidate = records.find(
    (record) =>
      record.kind === "generation" &&
      record.metadata?.candidateGeneration === true
  ) ?? records.find((record) => record.kind === "generation");
  if (
    priorActive &&
    candidate &&
    candidate.predecessorId !== priorActive.id
  ) {
    throw new Error("Generation predecessor continuity failed.");
  }
}

function normalizeRevision(value) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Handoff resource revision must be a positive integer.");
  }
  return value;
}

function sanitizeMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) =>
        [
          "state",
          "phase",
          "result",
          "attemptCount",
          "maxAttempts",
          "retryAt",
          "mutationKind",
          "priorPath",
          "resultingPath",
          "logicalPath",
          "expectedResourceRevision",
          "resultingResourceRevision",
          "contentRevision",
          "catalogGeneration",
          "candidateCatalogGeneration",
          "candidateOperationId",
          "candidateRevisionId",
          "candidateRelativePath",
          "projectionKind",
          "action",
          "role",
          "taskKind",
          "transferState",
          "disposition",
          "errorCode",
          "errorMessage",
          "lifecycleState",
          "formatVersion",
          "activeGenerationId",
          "candidateGeneration"
        ].includes(key)
      )
  );
}

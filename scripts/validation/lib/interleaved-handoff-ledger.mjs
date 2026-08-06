const TERMINAL_OPERATION_STATES = new Set([
  "completed", "failed", "cancelled", "superseded", "timed_out", "deleted"
]);

export function createHandoffLedger(input) {
  if (!input?.scenarioId || !input?.knowledgeBaseId) {
    throw new Error("Handoff ledger requires scenario and knowledge-base identities.");
  }
  return {
    kind: "focowiki-storage-vnext-handoff-ledger",
    scenarioId: input.scenarioId,
    knowledgeBaseId: input.knowledgeBaseId,
    capturedAt: new Date().toISOString(),
    publicOutcome: input.publicOutcome ?? null,
    expectedKinds: [...new Set(input.expectedKinds ?? [])],
    expectedTerminalKinds: [...new Set(input.expectedTerminalKinds ?? [])],
    records: []
  };
}

export function addHandoffRecord(ledger, record) {
  if (!record?.kind || !record?.id) {
    throw new Error("Handoff record requires kind and identity.");
  }
  ledger.records.push({
    kind: record.kind,
    id: record.id,
    knowledgeBaseId: record.knowledgeBaseId ?? ledger.knowledgeBaseId,
    ownerKind: record.ownerKind ?? null,
    ownerId: record.ownerId ?? null,
    resourceRevision: record.resourceRevision ?? null,
    state: record.state ?? null,
    durable: record.durable === true,
    terminal: record.terminal === true,
    metadata: record.metadata ?? {}
  });
  return ledger;
}

export function assertHandoffLedger(ledger) {
  if (!ledger?.scenarioId || !ledger?.knowledgeBaseId || !Array.isArray(ledger.records)) {
    throw new Error("Handoff ledger is incomplete.");
  }
  assertUniqueRecords(ledger.records);
  assertKnowledgeBaseContinuity(ledger);
  assertExpectedKinds(ledger);
  assertOwnershipClosure(ledger.records);
  assertResourceRevisions(ledger.records);
  assertAttemptBudgets(ledger.records);
  assertTerminalConvergence(ledger);
  assertCurrentRevisionContinuity(ledger.records);
  assertActiveSnapshotContinuity(ledger);
  assertObjectOwnerClosure(ledger.records);
  assertNoPhysicalDisclosure(ledger);
  return ledger;
}

function assertUniqueRecords(records) {
  const identities = new Set();
  for (const record of records) {
    const key = recordKey(record.kind, record.id);
    if (identities.has(key)) throw new Error(`Duplicate handoff record: ${key}.`);
    identities.add(key);
  }
}

function assertKnowledgeBaseContinuity(ledger) {
  if (ledger.records.some((record) => record.knowledgeBaseId !== ledger.knowledgeBaseId)) {
    throw new Error("Handoff knowledge base continuity failed.");
  }
  const roots = ledger.records.filter((record) => record.kind === "knowledge_base");
  if (roots.length !== 1 || roots[0].id !== ledger.knowledgeBaseId) {
    throw new Error("Handoff ledger must contain exactly one knowledge-base root.");
  }
}

function assertExpectedKinds(ledger) {
  for (const kind of ledger.expectedKinds) {
    if (!ledger.records.some((record) => record.kind === kind)) {
      throw new Error(`Missing expected handoff kind: ${kind}.`);
    }
  }
  for (const kind of ledger.expectedTerminalKinds) {
    const records = ledger.records.filter((record) => record.kind === kind);
    if (records.length === 0 || records.some((record) => !record.terminal)) {
      throw new Error(`Expected terminal handoff kind is incomplete: ${kind}.`);
    }
  }
}

function assertOwnershipClosure(records) {
  const identities = new Set(records.map((record) => recordKey(record.kind, record.id)));
  for (const record of records) {
    if (record.kind === "knowledge_base") continue;
    if (!record.ownerKind || !record.ownerId) {
      if (record.durable) throw new Error(`Durable handoff has no owner: ${record.kind}.`);
      throw new Error(`Handoff has no owner: ${record.kind}.`);
    }
    if (!identities.has(recordKey(record.ownerKind, record.ownerId))) {
      throw new Error(`Handoff owner is missing: ${record.kind}.`);
    }
  }
}

function assertResourceRevisions(records) {
  for (const record of records) {
    if (
      record.resourceRevision !== null
      && (!Number.isSafeInteger(record.resourceRevision) || record.resourceRevision < 0)
    ) {
      throw new Error(`Invalid resource revision for ${record.kind}.`);
    }
  }
}

function assertAttemptBudgets(records) {
  for (const record of records) {
    const attempt = record.metadata?.attemptCount;
    const maximum = record.metadata?.maxAttempts;
    if (
      Number.isSafeInteger(attempt)
      && Number.isSafeInteger(maximum)
      && attempt > maximum
    ) {
      throw new Error(`Attempt budget exceeded for ${record.kind}.`);
    }
  }
}

function assertTerminalConvergence(ledger) {
  if (!new Set(["succeeded", "conflicted", "failed"]).has(ledger.publicOutcome)) return;
  const live = ledger.records.filter((record) => record.kind === "work_item");
  if (live.length > 0) {
    throw new Error("Terminal public outcome retained live work items.");
  }
  for (const operation of ledger.records.filter((record) => record.kind === "operation")) {
    if (!TERMINAL_OPERATION_STATES.has(operation.state)) {
      throw new Error("Terminal public outcome retained a nonterminal operation.");
    }
  }
}

function assertCurrentRevisionContinuity(records) {
  const revisions = new Map(
    records
      .filter((record) => record.kind === "source_revision")
      .map((record) => [record.id, record])
  );
  for (const source of records.filter((record) => record.kind === "source_file")) {
    const currentRevisionId = source.metadata?.currentRevisionId;
    if (source.state === "ready" && !currentRevisionId) {
      throw new Error("Ready source file has no current revision.");
    }
    if (!currentRevisionId) continue;
    const revision = revisions.get(currentRevisionId);
    if (
      !revision
      || revision.ownerId !== source.id
      || revision.metadata?.revisionRole !== "current"
    ) {
      throw new Error("Source current revision continuity failed.");
    }
  }
}

function assertActiveSnapshotContinuity(ledger) {
  const snapshots = ledger.records.filter((record) => record.kind === "active_snapshot");
  if (snapshots.length > 1) throw new Error("Multiple active snapshots were recorded.");
  if (ledger.publicOutcome === "succeeded" && snapshots.length !== 1) {
    throw new Error("Successful handoff has no active snapshot.");
  }
  if (snapshots.length === 0) return;
  const snapshot = snapshots[0];
  const root = findRecord(ledger.records, "release_root", snapshot.metadata.releaseRootId);
  const search = findRecord(
    ledger.records,
    "search_projection",
    snapshot.metadata.searchProjectionId
  );
  const operation = findRecord(ledger.records, "operation", snapshot.metadata.operationId);
  if (!root || root.metadata?.rootRole !== "active") {
    throw new Error("Active snapshot release-root continuity failed.");
  }
  if (!search || search.metadata?.role !== "active" || search.state !== "ready") {
    throw new Error("Active snapshot search continuity failed.");
  }
  if (!operation || operation.state !== "completed") {
    throw new Error("Active snapshot operation continuity failed.");
  }
}

function assertObjectOwnerClosure(records) {
  const ownersByObject = new Map();
  for (const owner of records.filter((record) => record.kind === "object_owner")) {
    const objectId = owner.metadata?.objectId;
    if (!objectId) throw new Error("Object owner has no object identity.");
    const owners = ownersByObject.get(objectId) ?? [];
    owners.push(owner);
    ownersByObject.set(objectId, owners);
  }
  for (const registration of records.filter(
    (record) => record.kind === "object_registration" && record.state !== "deleted"
  )) {
    if ((ownersByObject.get(registration.id) ?? []).length === 0) {
      throw new Error("Object registration has no authoritative owner.");
    }
  }
}

function assertNoPhysicalDisclosure(ledger) {
  const serialized = JSON.stringify(ledger);
  if (/storageKey|objectKey|providerIndexUid|secret|authorization|requestJson/u.test(serialized)) {
    throw new Error("Handoff ledger exposed physical or secret data.");
  }
}

function findRecord(records, kind, id) {
  return records.find((record) => record.kind === kind && record.id === id) ?? null;
}

function recordKey(kind, id) {
  return `${kind}:${id}`;
}

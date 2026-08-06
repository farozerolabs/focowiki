import assert from "node:assert/strict";
import test from "node:test";
import {
  addHandoffRecord,
  assertHandoffLedger,
  createHandoffLedger
} from "../lib/interleaved-handoff-ledger.mjs";

function validLedger() {
  const ledger = createHandoffLedger({
    scenarioId: "upload-during-modification-visible",
    knowledgeBaseId: "kb-validation",
    publicOutcome: "succeeded",
    expectedKinds: [
      "knowledge_base",
      "operation",
      "source_file",
      "source_revision",
      "release_root",
      "search_projection",
      "active_snapshot"
    ]
  });
  addHandoffRecord(ledger, {
    kind: "knowledge_base",
    id: "kb-validation",
    resourceRevision: 2
  });
  addHandoffRecord(ledger, {
    kind: "operation",
    id: "operation-1",
    ownerKind: "knowledge_base",
    ownerId: "kb-validation",
    state: "completed",
    terminal: true
  });
  addHandoffRecord(ledger, {
    kind: "source_file",
    id: "source-1",
    ownerKind: "knowledge_base",
    ownerId: "kb-validation",
    resourceRevision: 2,
    state: "ready",
    durable: true,
    terminal: true,
    metadata: { currentRevisionId: "revision-2" }
  });
  addHandoffRecord(ledger, {
    kind: "source_revision",
    id: "revision-2",
    ownerKind: "source_file",
    ownerId: "source-1",
    durable: true,
    terminal: true,
    metadata: { revisionRole: "current" }
  });
  addHandoffRecord(ledger, {
    kind: "release_root",
    id: "root-2",
    ownerKind: "knowledge_base",
    ownerId: "kb-validation",
    resourceRevision: 2,
    state: "active",
    durable: true,
    terminal: true,
    metadata: { rootRole: "active" }
  });
  addHandoffRecord(ledger, {
    kind: "search_projection",
    id: "search-1",
    ownerKind: "knowledge_base",
    ownerId: "kb-validation",
    resourceRevision: 2,
    state: "ready",
    durable: true,
    terminal: true,
    metadata: { role: "active" }
  });
  addHandoffRecord(ledger, {
    kind: "active_snapshot",
    id: "active-1",
    ownerKind: "knowledge_base",
    ownerId: "kb-validation",
    state: "active",
    durable: true,
    terminal: true,
    metadata: {
      releaseRootId: "root-2",
      searchProjectionId: "search-1",
      operationId: "operation-1"
    }
  });
  return ledger;
}

test("accepts a complete storage vNext ownership and activation chain", () => {
  assert.doesNotThrow(() => assertHandoffLedger(validLedger()));
});

test("rejects public success with a missing expected handoff", () => {
  const ledger = validLedger();
  ledger.records = ledger.records.filter((record) => record.kind !== "active_snapshot");
  assert.throws(
    () => assertHandoffLedger(ledger),
    /missing expected handoff kind: active_snapshot/i
  );
});

test("rejects unowned durable residue and cross-scope records", () => {
  const unowned = validLedger();
  addHandoffRecord(unowned, {
    kind: "release_shard",
    id: "shard-1",
    durable: true
  });
  assert.throws(() => assertHandoffLedger(unowned), /durable handoff has no owner/i);

  const crossed = validLedger();
  crossed.records.find((record) => record.kind === "source_file").knowledgeBaseId = "kb-other";
  assert.throws(() => assertHandoffLedger(crossed), /knowledge base continuity/i);
});

test("rejects broken current revision and active snapshot continuity", () => {
  const revisionMismatch = validLedger();
  revisionMismatch.records.find(
    (record) => record.kind === "source_revision"
  ).metadata.revisionRole = "rollback";
  assert.throws(
    () => assertHandoffLedger(revisionMismatch),
    /current revision continuity/i
  );

  const searchMismatch = validLedger();
  searchMismatch.records.find(
    (record) => record.kind === "search_projection"
  ).metadata.role = "candidate";
  assert.throws(
    () => assertHandoffLedger(searchMismatch),
    /active snapshot search continuity/i
  );
});

test("rejects attempt overflow and live work after a terminal public outcome", () => {
  const exceeded = validLedger();
  addHandoffRecord(exceeded, {
    kind: "cleanup_action",
    id: "cleanup-1",
    ownerKind: "operation",
    ownerId: "operation-1",
    metadata: { attemptCount: 4, maxAttempts: 3 }
  });
  assert.throws(() => assertHandoffLedger(exceeded), /attempt budget exceeded/i);

  const live = validLedger();
  addHandoffRecord(live, {
    kind: "work_item",
    id: "work-1",
    ownerKind: "operation",
    ownerId: "operation-1",
    state: "retry"
  });
  assert.throws(() => assertHandoffLedger(live), /retained live work items/i);
});

test("rejects physical provider identity disclosure", () => {
  const ledger = validLedger();
  ledger.records[0].metadata.storageKey = "private/object.md";
  assert.throws(() => assertHandoffLedger(ledger), /exposed physical or secret data/i);
});

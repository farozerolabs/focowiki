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
    expectedKinds: [
      "request",
      "operation",
      "source",
      "source_revision",
      "generation",
      "activation"
    ]
  });
  addHandoffRecord(ledger, {
    kind: "request",
    id: "request-1",
    knowledgeBaseId: "kb-validation"
  });
  addHandoffRecord(ledger, {
    kind: "operation",
    id: "operation-1",
    knowledgeBaseId: "kb-validation",
    ownerKind: "request",
    ownerId: "request-1"
  });
  addHandoffRecord(ledger, {
    kind: "source",
    id: "source-1",
    knowledgeBaseId: "kb-validation",
    ownerKind: "operation",
    ownerId: "operation-1",
    resourceRevision: 2
  });
  addHandoffRecord(ledger, {
    kind: "source_revision",
    id: "revision-2",
    knowledgeBaseId: "kb-validation",
    ownerKind: "source",
    ownerId: "source-1",
    resourceRevision: 2
  });
  addHandoffRecord(ledger, {
    kind: "generation",
    id: "generation-2",
    knowledgeBaseId: "kb-validation",
    ownerKind: "source_revision",
    ownerId: "revision-2",
    predecessorId: "generation-1"
  });
  addHandoffRecord(ledger, {
    kind: "activation",
    id: "generation-2",
    knowledgeBaseId: "kb-validation",
    ownerKind: "generation",
    ownerId: "generation-2"
  });
  ledger.publicOutcome = "succeeded";
  return ledger;
}

test("accepts a complete successful internal handoff chain", () => {
  assert.doesNotThrow(() => assertHandoffLedger(validLedger()));
});

test("rejects public success with a missing internal handoff", () => {
  const ledger = validLedger();
  ledger.records = ledger.records.filter((record) => record.kind !== "activation");

  assert.throws(
    () => assertHandoffLedger(ledger),
    /missing expected handoff kind: activation/i
  );
});

test("rejects public failure with unowned durable residue", () => {
  const ledger = validLedger();
  ledger.publicOutcome = "failed";
  addHandoffRecord(ledger, {
    kind: "immutable_object",
    id: "object-1",
    knowledgeBaseId: "kb-validation",
    durable: true
  });

  assert.throws(
    () => assertHandoffLedger(ledger),
    /durable handoff has no owner/i
  );
});

test("rejects cross-knowledge-base ownership and revision regression", () => {
  const crossKnowledgeBase = validLedger();
  crossKnowledgeBase.records[2].knowledgeBaseId = "kb-other";
  assert.throws(
    () => assertHandoffLedger(crossKnowledgeBase),
    /knowledge base continuity/
  );

  const regressed = validLedger();
  addHandoffRecord(regressed, {
    kind: "source_revision",
    id: "revision-1",
    knowledgeBaseId: "kb-validation",
    ownerKind: "source",
    ownerId: "source-1",
    resourceRevision: 1
  });
  assert.throws(
    () => assertHandoffLedger(regressed),
    /resource revision regressed/i
  );
});

test("keeps resource revisions independent across sibling sources", () => {
  const ledger = validLedger();
  addHandoffRecord(ledger, {
    kind: "source",
    id: "source-2",
    knowledgeBaseId: "kb-validation",
    ownerKind: "operation",
    ownerId: "operation-1",
    resourceRevision: 1
  });

  assert.doesNotThrow(() => assertHandoffLedger(ledger));
});

test("rejects broken modification path and generation predecessor continuity", () => {
  const pathMismatch = validLedger();
  pathMismatch.records.find((record) => record.kind === "operation").metadata = {
    mutationKind: "source_file_move",
    priorPath: "before.md",
    resultingPath: "after.md"
  };
  pathMismatch.records.find((record) => record.kind === "source").metadata = {
    logicalPath: "unexpected.md"
  };
  assert.throws(
    () => assertHandoffLedger(pathMismatch),
    /modification path continuity/i
  );

  const predecessorMismatch = validLedger();
  predecessorMismatch.records.push({
    kind: "active_generation",
    id: "generation-1",
    knowledgeBaseId: "kb-validation",
    ownerKind: null,
    ownerId: null,
    resourceRevision: null,
    predecessorId: null,
    state: "active",
    durable: false,
    terminal: true,
    metadata: {}
  });
  predecessorMismatch.records.find(
    (record) => record.kind === "generation"
  ).predecessorId = "generation-other";
  assert.throws(
    () => assertHandoffLedger(predecessorMismatch),
    /generation predecessor continuity/i
  );
});

test("rejects modification revision and active Generation ownership mismatches", () => {
  const revisionMismatch = validLedger();
  revisionMismatch.records.find(
    (record) => record.kind === "operation"
  ).metadata = {
    mutationKind: "source_file_move",
    expectedResourceRevision: 1,
    resultingResourceRevision: 3,
    resultingPath: "after.md"
  };
  revisionMismatch.records.find((record) => record.kind === "source").metadata = {
    logicalPath: "after.md"
  };
  assert.throws(
    () => assertHandoffLedger(revisionMismatch),
    /modification revision continuity/i
  );

  const activationMismatch = validLedger();
  activationMismatch.records.unshift({
    kind: "knowledge_base",
    id: "kb-validation",
    knowledgeBaseId: "kb-validation",
    ownerKind: null,
    ownerId: null,
    resourceRevision: 1,
    predecessorId: null,
    state: "active",
    durable: false,
    terminal: false,
    observedAt: null,
    metadata: {
      activeGenerationId: "generation-other"
    }
  });
  assert.throws(
    () => assertHandoffLedger(activationMismatch),
    /active Generation ownership/i
  );
});

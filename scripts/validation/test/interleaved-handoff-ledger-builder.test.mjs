import assert from "node:assert/strict";
import test from "node:test";
import { createEvidenceRedactor } from "../lib/interleaved-evidence-redaction.mjs";
import {
  assertHandoffLedger
} from "../lib/interleaved-handoff-ledger.mjs";
import {
  buildHandoffLedgerFromEvidence
} from "../lib/interleaved-handoff-ledger-builder.mjs";

test("maps modification, publication, projections, storage, and Redis without raw IDs", () => {
  const ledger = buildHandoffLedgerFromEvidence({
    scenarioId: "file-move-control",
    redactor: createEvidenceRedactor("run-seed"),
    publicOutcome: "succeeded",
    expectedKinds: [
      "request",
      "public_operation",
      "operation",
      "source",
      "source_revision",
      "generation",
      "activation",
      "active_projection",
      "immutable_object"
    ],
    expectedTerminalKinds: [
      "public_operation",
      "source",
      "generation",
      "activation"
    ],
    publicRequest: {
      requestId: "request-private",
      idempotencyKey: "idempotency-private",
      mutationKind: "source_file_move"
    },
    publicOperation: {
      requestId: "request-private",
      operationId: "operation-private",
      mutationKind: "source_file_move",
      priorPath: "before.md",
      resultingPath: "after.md",
      expectedResourceRevision: 1,
      resultingResourceRevision: 2,
      state: "completed"
    },
    priorActiveGenerationId: null,
    candidateGenerationId: "generation-raw",
    redis: {
      keys: [{ alias: "redis-key-safe", type: "string" }]
    },
    postgres: fixture()
  });

  assert.doesNotThrow(() => assertHandoffLedger(ledger));
  assert.doesNotMatch(
    JSON.stringify(ledger),
    /private|kb-raw|source-raw|generation-raw|checksum-raw/u
  );
  assert.equal(
    ledger.records.find((record) => record.kind === "source")
      .metadata.logicalPath,
    "after.md"
  );
});

test("rejects attempt exhaustion and incomplete terminal modification handoffs", () => {
  const evidence = fixture();
  evidence.roleJobs = [{
    id: "job-raw",
    sourceFileId: "source-raw",
    status: "dead_letter",
    attemptCount: 4,
    maxAttempts: 3
  }];
  const ledger = buildHandoffLedgerFromEvidence({
    scenarioId: "failed-move",
    redactor: createEvidenceRedactor("run-seed"),
    publicOutcome: "failed",
    postgres: evidence
  });

  assert.throws(
    () => assertHandoffLedger(ledger),
    /attempt budget exceeded/i
  );
});

test("preserves safe failure messages across publication handoffs", () => {
  const evidence = fixture();
  evidence.sourceFiles[0].terminalFailureCode = "PUBLICATION_RETRIES_EXHAUSTED";
  evidence.sourceFiles[0].terminalFailureMessage = "Source publication failed safely.";
  evidence.roleJobs = [{
    id: "job-raw",
    generationId: "generation-raw",
    role: "publication",
    kind: "generation_publication",
    status: "dead_letter",
    attemptCount: 3,
    maxAttempts: 3,
    lastErrorCode: "PUBLICATION_RETRIES_EXHAUSTED",
    lastErrorMessage: "Publication activation failed safely."
  }];
  evidence.generations[0].state = "failed";
  evidence.generations[0].safeErrorCode = "PUBLICATION_RETRIES_EXHAUSTED";
  evidence.generations[0].safeErrorMessage = "Generation activation failed safely.";
  evidence.publicationSubtasks = [{
    id: "subtask-raw",
    generationId: "generation-raw",
    taskKind: "activation",
    state: "failed",
    attemptCount: 3,
    maxAttempts: 3,
    lastErrorCode: "PUBLICATION_RETRIES_EXHAUSTED",
    lastErrorMessage: "Activation subtask failed safely."
  }];

  const ledger = buildHandoffLedgerFromEvidence({
    scenarioId: "failed-publication",
    redactor: createEvidenceRedactor("run-seed"),
    publicOutcome: "failed",
    postgres: evidence
  });

  assert.equal(
    ledger.records.find((record) => record.kind === "source")
      .metadata.errorMessage,
    "Source publication failed safely."
  );
  assert.equal(
    ledger.records.find((record) => record.kind === "role_job")
      .metadata.errorMessage,
    "Publication activation failed safely."
  );
  assert.equal(
    ledger.records.find((record) => record.kind === "generation")
      .metadata.errorMessage,
    "Generation activation failed safely."
  );
  assert.equal(
    ledger.records.find((record) => record.kind === "publication_subtask")
      .metadata.errorMessage,
    "Activation subtask failed safely."
  );
});

test("rejects a conflicted modification that leaves staged source state", () => {
  const evidence = fixture();
  evidence.sourceFiles[0].candidateOperationId = "operation-staged";
  evidence.sourceFiles[0].candidateRelativePath = "staged.md";
  const ledger = buildHandoffLedgerFromEvidence({
    scenarioId: "conflicting-move",
    redactor: createEvidenceRedactor("run-seed"),
    publicOutcome: "conflicted",
    postgres: evidence
  });

  assert.throws(
    () => assertHandoffLedger(ledger),
    /staged source state/i
  );
});

function fixture() {
  return {
    knowledgeBase: {
      id: "kb-raw",
      resourceRevision: 2,
      catalogGeneration: 4,
      activeGenerationId: "generation-raw"
    },
    uploadSessions: [],
    uploadEntries: [],
    operations: [{
      id: "operation-raw",
      operationKind: "source_file_move",
      state: "completed",
      expectedResourceRevision: 1,
      candidateCatalogGeneration: 4
    }],
    operationTargets: [{
      operationId: "operation-raw",
      targetKind: "source_file",
      targetId: "source-raw",
      expectedResourceRevision: 1,
      sequenceNumber: 1
    }],
    sourceDirectories: [],
    sourceFiles: [{
      id: "source-raw",
      relativePath: "after.md",
      resourceRevision: 2,
      contentRevision: 1,
      processingStatus: "completed"
    }],
    sourceRevisions: [{
      id: "revision-raw",
      sourceFileId: "source-raw",
      revision: 2,
      processingStatus: "completed"
    }],
    dispatchMarkers: [],
    sourceEvents: [],
    deletionIntents: [],
    roleJobs: [],
    generations: [{
      id: "generation-raw",
      predecessorGenerationId: null,
      state: "active",
      formatVersion: 4
    }],
    publicationProgress: [{
      generationId: "generation-raw",
      stage: "active",
      processedImpactCount: 1,
      totalImpactCount: 1,
      completedAt: "2026-07-26T00:00:00.000Z"
    }],
    publicationImpacts: [],
    publicationSubtasks: [],
    projectionInputs: [{
      generationId: "generation-raw",
      inputKey: "source:source-raw"
    }],
    generationProjections: [{
      generationId: "generation-raw",
      projectionKind: "tree",
      recordId: "tree-source-raw",
      action: "upsert",
      sourceFileId: "source-raw",
      logicalPath: "pages/after.md"
    }],
    generationObjectRefs: [{
      generationId: "generation-raw",
      refKind: "page",
      refKey: "pages/after.md",
      action: "upsert",
      checksumSha256: "checksum-raw",
      formatVersion: 4,
      logicalPath: "pages/after.md",
      sourceFileId: "source-raw"
    }],
    immutableObjects: [{
      checksumSha256: "checksum-raw",
      formatVersion: 4,
      lifecycleState: "active",
      writeAttemptCount: 1
    }],
    activeProjections: [{
      projectionKind: "tree",
      recordId: "tree-source-raw",
      lastChangedGenerationId: "generation-raw",
      sourceFileId: "source-raw",
      logicalPath: "pages/after.md"
    }],
    projectionRepairs: [],
    projectionRepairSubtasks: [],
    lexicalRebuilds: [],
    lexicalWorkItems: [],
    compactionJobs: [],
    cleanupObjectDeletions: []
  };
}

import assert from "node:assert/strict";
import test from "node:test";
import { createEvidenceRedactor } from "../lib/interleaved-evidence-redaction.mjs";
import { assertHandoffLedger } from "../lib/interleaved-handoff-ledger.mjs";
import {
  buildHandoffLedgerFromEvidence
} from "../lib/interleaved-handoff-ledger-builder.mjs";

test("maps current facts, release activation, unified search, and object ownership without raw IDs", () => {
  const ledger = buildHandoffLedgerFromEvidence({
    scenarioId: "file-move-control",
    redactor: createEvidenceRedactor("run-seed"),
    publicOutcome: "succeeded",
    postgres: fixture()
  });

  assert.doesNotThrow(() => assertHandoffLedger(ledger));
  assert.doesNotMatch(
    JSON.stringify(ledger),
    /private|kb-raw|source-raw|root-raw|object-raw|checksum-raw/u
  );
  assert.equal(
    ledger.records.find((record) => record.kind === "source_file")
      .metadata.logicalPath,
    "after.md"
  );
  assert.equal(
    ledger.records.find((record) => record.kind === "active_snapshot")
      .state,
    "active"
  );
});

test("rejects a terminal public outcome with a live vNext work item", () => {
  const evidence = fixture();
  evidence.workItems = [{
    operationId: "operation-raw",
    workKind: "publication",
    state: "retry",
    operationRevision: 3,
    attemptCount: 2,
    checkpoint: { maxAttempts: 3 },
    safeErrorCode: "SEARCH_PROVIDER_TIMEOUT"
  }];
  const ledger = buildHandoffLedgerFromEvidence({
    scenarioId: "failed-publication",
    redactor: createEvidenceRedactor("run-seed"),
    publicOutcome: "failed",
    postgres: evidence
  });

  assert.throws(
    () => assertHandoffLedger(ledger),
    /retained live work items/i
  );
});

test("preserves bounded error codes without copying safe messages or provider identities", () => {
  const evidence = fixture();
  evidence.sourceFiles[0].safeErrorCode = "SOURCE_PROCESSING_FAILED";
  evidence.sourceFiles[0].safeErrorMessage = "Failure for source-raw.";
  evidence.searchProjections[0].safeErrorCode = null;
  evidence.operationResults[0].safeMessage = "Internal operation-raw detail.";

  const ledger = buildHandoffLedgerFromEvidence({
    scenarioId: "bounded-diagnostics",
    redactor: createEvidenceRedactor("run-seed"),
    publicOutcome: "succeeded",
    postgres: evidence
  });

  const serialized = JSON.stringify(ledger);
  assert.match(serialized, /SOURCE_PROCESSING_FAILED/u);
  assert.doesNotMatch(serialized, /Failure for source-raw|Internal operation-raw/u);
});

test("rejects a verified object whose explicit owner row is missing", () => {
  const evidence = fixture();
  evidence.objectOwners = [];
  const ledger = buildHandoffLedgerFromEvidence({
    scenarioId: "owner-closure",
    redactor: createEvidenceRedactor("run-seed"),
    publicOutcome: "succeeded",
    postgres: evidence
  });

  assert.throws(
    () => assertHandoffLedger(ledger),
    /missing expected handoff kind: object_owner|no authoritative owner/i
  );
});

function fixture() {
  return {
    knowledgeBase: {
      id: "kb-raw",
      resourceRevision: 2,
      activeRootPublicId: "root-raw",
      activeRevision: 4
    },
    uploadSessions: [],
    uploadEntries: [],
    operations: [{
      id: "operation-raw",
      operationKind: "publication",
      state: "completed",
      expectedResourceRevision: 1,
      targetKind: "knowledge_base",
      targetId: "kb-raw"
    }],
    workItems: [],
    operationResults: [{
      id: "operation-raw",
      operationKind: "publication",
      state: "completed",
      resultCode: "PUBLICATION_COMPLETED"
    }],
    operationDependencies: [],
    sourceDirectories: [],
    sourceFiles: [{
      id: "source-raw",
      logicalPath: "after.md",
      resourceRevision: 2,
      currentRevisionId: "revision-raw",
      status: "ready"
    }],
    sourceRevisions: [{
      id: "revision-raw",
      sourceFileId: "source-raw",
      objectId: "object-raw",
      checksumSha256: "checksum-raw",
      revisionRole: "current"
    }],
    graphNodes: [],
    graphEdges: [],
    graphEvidenceRefs: [],
    releaseRoots: [{
      id: "root-raw",
      baseRootId: null,
      rootRole: "active",
      resourceRevision: 4,
      manifestChecksumSha256: "manifest-raw"
    }],
    releaseShards: [],
    releaseRootShards: [],
    releaseCatalogEntries: [{
      releaseRootId: "root-raw",
      logicalPath: "pages/after.md",
      entryKind: "source",
      sourceFileId: "source-raw",
      objectId: "object-generated-raw"
    }],
    releaseCatalogTombstones: [],
    searchProjections: [{
      id: "search-raw",
      role: "active",
      state: "ready",
      resourceRevision: 4,
      documentCount: 1,
      safeErrorCode: null
    }],
    activeSnapshots: [{
      releaseRootId: "root-raw",
      searchProjectionId: "search-raw",
      operationId: "operation-raw",
      resourceRevision: 4
    }],
    releaseCandidates: [],
    releaseCandidateValidations: [],
    releaseEventSummaries: [],
    objectOwners: [{
      id: "owner-raw",
      objectId: "object-raw",
      ownerKind: "source_revision",
      sourceRevisionId: "revision-raw",
      releaseRootId: null,
      releaseShardId: null,
      operationId: null
    }],
    objectRegistrations: [{
      id: "object-raw",
      checksumSha256: "checksum-raw",
      objectFormat: "source-markdown-v1",
      state: "verified",
      byteCount: 512
    }],
    cleanupActions: []
  };
}

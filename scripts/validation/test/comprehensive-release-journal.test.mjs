import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  COMPREHENSIVE_LEDGER_SCHEMAS,
  assertLedgerRecord
} from "../lib/comprehensive-release-schemas.mjs";
import {
  createComprehensiveRunJournal,
  openComprehensiveRunJournal,
  resolveComprehensiveResume
} from "../lib/comprehensive-release-journal.mjs";

const runId = "validation-20260810111944-b648eb2f";
const fingerprints = {
  application: "a".repeat(64),
  corpus: "b".repeat(64),
  model: "c".repeat(64),
  provider: "d".repeat(64),
  settings: "e".repeat(64),
  docker: "f".repeat(64),
  artifactContract: "1".repeat(64)
};

test("owns versioned schemas for every comprehensive ledger family", () => {
  assert.deepEqual(Object.keys(COMPREHENSIVE_LEDGER_SCHEMAS).sort(), [
    "automatedResult",
    "cleanupOwner",
    "corpusFile",
    "crudCase",
    "defect",
    "generatedItem",
    "inventoryItem",
    "manualResult",
    "performanceMeasurement",
    "query",
    "securityCase",
    "vectorOwner"
  ]);
  for (const schema of Object.values(COMPREHENSIVE_LEDGER_SCHEMAS)) {
    assert.equal(schema.owner, "focowiki");
    assert.equal(schema.version, 1);
  }
  assert.doesNotThrow(() => assertLedgerRecord("inventoryItem", {
    id: "surface:one",
    source: "apps/api/src/main.ts",
    fingerprint: "a".repeat(64)
  }));
  assert.throws(() => assertLedgerRecord("inventoryItem", { id: "surface:one" }), /missing/u);
});

test("persists immutable run revisions and resumes only compatible phases", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "focowiki-clr-journal-"));
  try {
    const journalPath = path.join(directory, runId, "journal.json");
    await assert.rejects(
      createComprehensiveRunJournal({
        journalPath: path.join(directory, "unowned.json"),
        runId,
        fingerprints,
        phases: [{ id: "inventory", prerequisites: [], fingerprintKeys: ["application"], expectedItemIds: ["surface:one"] }]
      }),
      /outside run-owned/u
    );
    const journal = await createComprehensiveRunJournal({
      journalPath,
      runId,
      fingerprints,
      phases: [
        { id: "inventory", prerequisites: [], fingerprintKeys: ["application"], expectedItemIds: ["surface:one"] },
        { id: "model-artifacts", prerequisites: ["inventory"], fingerprintKeys: ["corpus", "model", "settings", "artifactContract"], expectedItemIds: ["corpus:one"] },
        { id: "provider-e2e", prerequisites: ["model-artifacts"], fingerprintKeys: ["application", "corpus", "model", "provider", "settings", "docker"], expectedItemIds: ["query:one"] }
      ]
    });
    await assert.rejects(
      journal.completePhase("inventory", [], "2".repeat(64)),
      /cardinality/u
    );
    await journal.completePhase("inventory", ["surface:one"], "2".repeat(64));
    await journal.registerCleanup({ kind: "knowledgeBases", id: `${runId}:kb-one` });
    await journal.completePhase("model-artifacts", ["corpus:one"], "3".repeat(64), {
      reusableExternalArtifact: true,
      verificationHash: "4".repeat(64)
    });

    const reopened = await openComprehensiveRunJournal({ journalPath, runId });
    assert.equal(reopened.state.completedPhases.length, 2);
    assert.equal(reopened.state.cleanupOwners.length, 1);

    const changedApplication = { ...fingerprints, application: "9".repeat(64) };
    const resume = resolveComprehensiveResume(reopened.state, changedApplication);
    assert.deepEqual(resume.invalidatedPhaseIds, ["inventory", "provider-e2e"]);
    assert.deepEqual(resume.reusableExternalPhaseIds, ["model-artifacts"]);

    const changedModel = { ...fingerprints, model: "8".repeat(64) };
    const incompatible = resolveComprehensiveResume(reopened.state, changedModel);
    assert.ok(incompatible.invalidatedPhaseIds.includes("model-artifacts"));
    assert.deepEqual(incompatible.reusableExternalPhaseIds, []);

    await reopened.recordFix({
      id: "defect:one",
      invalidatedPhaseIds: ["inventory"],
      evidenceHash: "5".repeat(64)
    });
    assert.deepEqual(reopened.state.completedPhases.map((phase) => phase.id), []);
    assert.equal(reopened.state.fixes.length, 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertMutationE2ESafety,
  buildScenarioKnowledgeBaseName,
  createInterleavedLifecycleController,
  createValidationRunId
} from "../lib/interleaved-lifecycle-controller.mjs";

test("persists run identity, scenario state, ownership, and resumable evidence", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "interleaved-controller-"));
  const runId = "validation-20260726123000-1234abcd";
  const controller = createInterleavedLifecycleController({
    runId,
    seed: "fixed-seed",
    reportRoot: path.join(root, "ReferenceDocs/validate-interleaved-lifecycle-e2e")
  });

  await controller.initialize();
  controller.registerOwnership("knowledgeBases", "kb-owned");
  controller.startScenario({
    scenarioId: "modification-during-upload",
    deadlineMs: 30_000
  });
  controller.recordBarrier("modification-during-upload", {
    name: "operation-accepted",
    lifecycle: "modification",
    state: "accepted",
    details: {
      operationKind: "source_file_replace"
    }
  });
  controller.completeScenario("modification-during-upload", {
    outcome: "failed",
    errorCode: "HANDOFF_ASSERTION_FAILED",
    errorMessage: "Handoff owner is missing for source revision."
  });
  await controller.persist();

  const persisted = JSON.parse(
    fs.readFileSync(controller.statePath, "utf8")
  );
  assert.equal(persisted.runId, runId);
  assert.deepEqual(persisted.owned.knowledgeBases, ["kb-owned"]);
  assert.equal(persisted.scenarios[0].outcome, "failed");
  assert.deepEqual(persisted.scenarios[0].barriers[0].details, {
    operationKind: "source_file_replace"
  });
  assert.equal(
    persisted.scenarios[0].errorMessage,
    "Handoff owner is missing for source revision."
  );
  assert.equal(
    persisted.evidenceDir,
    path.join(
      "ReferenceDocs",
      "validate-interleaved-lifecycle-e2e",
      "runs",
      runId
    )
  );
  assert.doesNotMatch(JSON.stringify(persisted), new RegExp(escapeRegex(root), "u"));

  const resumed = createInterleavedLifecycleController({
    runId,
    seed: "fixed-seed",
    reportRoot: path.join(root, "ReferenceDocs/validate-interleaved-lifecycle-e2e")
  });
  await resumed.initialize();
  assert.equal(resumed.state.scenarios[0].scenarioId, "modification-during-upload");
});

test("runs registered restoration cleanup in reverse order", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "interleaved-cleanup-"));
  const order = [];
  const controller = createInterleavedLifecycleController({
    runId: "validation-20260726123000-1234abcd",
    reportRoot: path.join(root, "ReferenceDocs/validate-interleaved-lifecycle-e2e")
  });
  await controller.initialize();
  controller.registerCleanup("first", async () => order.push("first"));
  controller.registerCleanup("second", async () => order.push("second"));

  await controller.cleanup();

  assert.deepEqual(order, ["second", "first"]);
  assert.equal(controller.state.cleanup.completed, true);
});

test("restarts an interrupted scenario without duplicating its identity", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "interleaved-restart-"));
  const controller = createInterleavedLifecycleController({
    runId: "validation-20260726123000-1234abcd",
    reportRoot: path.join(root, "ReferenceDocs/validate-interleaved-lifecycle-e2e")
  });
  await controller.initialize();
  controller.startScenario({
    scenarioId: "deletion-during-maintenance",
    deadlineMs: 30_000
  });
  controller.recordBarrier("deletion-during-maintenance", {
    name: "maintenance-started",
    lifecycle: "maintenance",
    state: "running"
  });

  const restarted = controller.startScenario({
    scenarioId: "deletion-during-maintenance",
    deadlineMs: 60_000
  });

  assert.equal(controller.state.scenarios.length, 1);
  assert.equal(restarted.outcome, "running");
  assert.deepEqual(restarted.barriers, []);
  assert.equal(
    Date.parse(restarted.deadlineAt) - Date.parse(restarted.startedAt),
    60_000
  );

  controller.completeScenario("deletion-during-maintenance", {
    outcome: "succeeded"
  });
  assert.throws(
    () => controller.startScenario({
      scenarioId: "deletion-during-maintenance",
      deadlineMs: 30_000
    }),
    /identity must be unique/u
  );
});

test("refuses mutations without an isolated run and passing baseline", () => {
  assert.throws(
    () => assertMutationE2ESafety({ baselinePassed: false, state: null }),
    /baseline/i
  );
  assert.throws(
    () => assertMutationE2ESafety({
      baselinePassed: true,
      state: { runId: "unsafe", evidenceDir: "/tmp" }
    }),
    /isolated validation ownership/i
  );
});

test("creates a stable-format run identity", () => {
  const runId = createValidationRunId(
    new Date("2026-07-26T12:30:00Z"),
    Buffer.from("1234abcd", "hex")
  );
  assert.equal(runId, "validation-20260726123000-1234abcd");
});

test("isolates scenario knowledge-base names by validation run", () => {
  assert.equal(
    buildScenarioKnowledgeBaseName(
      "validation-20260726210000-a1b2c3d4",
      "maintenance-during-deletion"
    ),
    "Interleaved validation-20260726210000-a1b2c3d4 maintenance-during-deletion"
  );
});

function escapeRegex(value) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

import assert from "node:assert/strict";
import test from "node:test";
import {
  createPublicationModeOverride,
  isKnowledgeBaseWorkSettled,
  resolveInterleavedScenarioDeadlineMs
} from "../lib/interleaved-runtime-settings.mjs";

test("keeps delayed publication jobs visible to the settle barrier", () => {
  assert.equal(
    isKnowledgeBaseWorkSettled({
      sourceFileJobs: {
        queuedCount: 0,
        runningCount: 0
      },
      publicationJobs: {
        queuedCount: 1,
        runningCount: 0
      }
    }),
    false
  );
  assert.equal(
    isKnowledgeBaseWorkSettled({
      sourceFileJobs: {
        queuedCount: 0,
        runningCount: 0
      },
      publicationJobs: {
        queuedCount: 0,
        runningCount: 0
      }
    }),
    true
  );
});

test("keeps active maintenance work visible to the settle barrier", () => {
  const idleQueues = {
    sourceFileJobs: {
      queuedCount: 0,
      runningCount: 0
    },
    publicationJobs: {
      queuedCount: 0,
      runningCount: 0
    }
  };
  assert.equal(
    isKnowledgeBaseWorkSettled({
      ...idleQueues,
      maintenanceProgress: {
        migration: null,
        lexicalRebuild: null,
        projectionRepair: { state: "running" },
        compaction: { active: null }
      }
    }, { includeMaintenance: true }),
    false
  );
  assert.equal(
    isKnowledgeBaseWorkSettled({
      ...idleQueues,
      maintenanceProgress: {
        migration: null,
        lexicalRebuild: null,
        projectionRepair: { state: "completed" },
        compaction: { active: null }
      }
    }, { includeMaintenance: true }),
    true
  );
  assert.equal(
    isKnowledgeBaseWorkSettled({
      ...idleQueues,
      maintenanceProgress: {
        migration: null,
        lexicalRebuild: null,
        projectionRepair: null,
        compaction: { active: { state: "running" } }
      }
    }, { includeMaintenance: true }),
    false
  );
  assert.equal(
    isKnowledgeBaseWorkSettled({
      ...idleQueues,
      maintenanceProgress: {
        migration: { state: "pending" },
        lexicalRebuild: null,
        projectionRepair: null,
        compaction: { active: null }
      }
    }, { includeMaintenance: true }),
    true
  );
});

test("temporarily switches publication to per-file and restores the full value", async () => {
  const writes = [];
  const original = {
    mode: "batch",
    batchSize: 300,
    intervalSeconds: 300
  };
  const override = createPublicationModeOverride({
    read: async () => original,
    write: async (value) => writes.push(value)
  });

  await override.enable();
  await override.restore();

  assert.deepEqual(writes, [
    {
      mode: "per_file",
      batchSize: 300,
      intervalSeconds: 300
    },
    original
  ]);
});

test("uses a maintenance-safe scenario deadline with bounded overrides", () => {
  assert.equal(resolveInterleavedScenarioDeadlineMs(undefined), 15 * 60_000);
  assert.equal(resolveInterleavedScenarioDeadlineMs("1200000"), 1_200_000);
  assert.throws(
    () => resolveInterleavedScenarioDeadlineMs("299999"),
    /between 300000 and 1800000 milliseconds/u
  );
  assert.throws(
    () => resolveInterleavedScenarioDeadlineMs("not-a-number"),
    /between 300000 and 1800000 milliseconds/u
  );
});

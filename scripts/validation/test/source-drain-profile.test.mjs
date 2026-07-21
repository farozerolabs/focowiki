import assert from "node:assert/strict";
import test from "node:test";
import { buildSourceDrainProfile } from "../lib/source-drain-profile.mjs";

test("builds source drain evidence from persisted worker settings", () => {
  assert.deepEqual(buildSourceDrainProfile({
    sampleCount: 150,
    workerReplicas: 4,
    worker: {
      sourceFileConcurrency: 32,
      sourceObjectReadConcurrency: 16,
      graphQueryConcurrency: 4,
      databaseMutationConcurrency: 4
    }
  }), {
    sampleCount: 150,
    modelAssistance: "disabled",
    workerReplicas: 4,
    sourceConcurrency: 32,
    sourceObjectReadConcurrency: 16,
    graphQueryConcurrency: 4,
    databaseMutationConcurrency: 4,
    timingBoundary: "first source start to last source completion after all files were accepted"
  });
});

test("rejects missing source drain concurrency settings", () => {
  assert.throws(
    () => buildSourceDrainProfile({ sampleCount: 150, workerReplicas: 1, worker: {} }),
    /sourceFileConcurrency/u
  );
});

test("rejects a missing worker replica count", () => {
  assert.throws(
    () => buildSourceDrainProfile({ sampleCount: 150, workerReplicas: 0, worker: {
      sourceFileConcurrency: 8,
      sourceObjectReadConcurrency: 8,
      graphQueryConcurrency: 4,
      databaseMutationConcurrency: 4
    } }),
    /worker replica count/u
  );
});

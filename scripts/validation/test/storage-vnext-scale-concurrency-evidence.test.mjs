import assert from "node:assert/strict";
import test from "node:test";

import {
  summarizeStorageVnextScaleConcurrencyEvidence
} from "../lib/storage-vnext-scale-concurrency-evidence.mjs";

test("accepts polling evidence that covers one complete four-way lifecycle scenario", () => {
  const result = summarizeStorageVnextScaleConcurrencyEvidence({
    childExitCode: 0,
    scenario: scenario(),
    samples: samples()
  });

  assert.equal(result.requestCount, 30);
  assert.equal(result.failedRequestCount, 0);
  assert.deepEqual(result.surfaces.map((item) => item.surface), [
    "admin-poll",
    "openapi-poll",
    "public-read"
  ]);
  assert.equal(result.scenarioOutcome, "conflicted");
});

test("rejects missing lifecycle, failed polls, or incomplete temporal overlap", () => {
  const missingLifecycle = scenario();
  missingLifecycle.lifecycleOutcomes.pop();
  assert.throws(() => summarizeStorageVnextScaleConcurrencyEvidence({
    childExitCode: 0,
    scenario: missingLifecycle,
    samples: samples()
  }), /lifecycle evidence is incomplete/u);

  const failedPolls = samples();
  failedPolls[0].ok = false;
  assert.throws(() => summarizeStorageVnextScaleConcurrencyEvidence({
    childExitCode: 0,
    scenario: scenario(),
    samples: failedPolls
  }), /polling request failed/u);

  const lateSamples = samples().map((sample) => ({
    ...sample,
    startedAt: "2026-08-03T00:00:05.000Z",
    finishedAt: "2026-08-03T00:00:06.000Z"
  }));
  assert.throws(() => summarizeStorageVnextScaleConcurrencyEvidence({
    childExitCode: 0,
    scenario: scenario(),
    samples: lateSamples
  }), /does not cover the lifecycle window/u);

  const failedMaintenance = scenario();
  failedMaintenance.lifecycleOutcomes.find(
    (item) => item.lifecycle === "maintenance"
  ).state = "failed";
  assert.throws(() => summarizeStorageVnextScaleConcurrencyEvidence({
    childExitCode: 0,
    scenario: failedMaintenance,
    samples: samples()
  }), /maintenance did not complete/u);
});

function scenario() {
  return {
    scenarioId: "four-way-test",
    startedAt: "2026-08-03T00:00:01.000Z",
    completedAt: "2026-08-03T00:00:04.000Z",
    outcome: "conflicted",
    errorCode: null,
    lifecycleOutcomes: [
      { lifecycle: "upload", state: "completed", errorCode: null },
      { lifecycle: "modification", state: "failed", errorCode: "CONFLICT" },
      { lifecycle: "deletion", state: "completed", errorCode: null },
      { lifecycle: "maintenance", state: "completed", errorCode: null }
    ]
  };
}

function samples() {
  return ["admin-poll", "openapi-poll", "public-read"].flatMap((surface) =>
    Array.from({ length: 10 }, (_value, index) => ({
      surface,
      ok: true,
      durationMs: index + 1,
      startedAt: index === 0
        ? "2026-08-03T00:00:00.000Z"
        : "2026-08-03T00:00:02.000Z",
      finishedAt: index === 9
        ? "2026-08-03T00:00:05.000Z"
        : "2026-08-03T00:00:03.000Z"
    }))
  );
}

import assert from "node:assert/strict";
import test from "node:test";
import {
  createProgressTracker,
  observeProgress,
  waitForStateBarrier
} from "../lib/interleaved-lifecycle-progress.mjs";

test("does not treat heartbeat-only changes as work progress", () => {
  const tracker = createProgressTracker({
    startedAtMs: 0,
    deadlineMs: 10_000,
    stallMs: 1_000
  });

  observeProgress(tracker, {
    state: "running",
    processed: 10,
    total: 20,
    heartbeatAt: "2026-01-01T00:00:00Z"
  }, 0);

  assert.throws(
    () => observeProgress(tracker, {
      state: "running",
      processed: 10,
      total: 20,
      heartbeatAt: "2026-01-01T00:00:01Z"
    }, 1_001),
    /no durable progress/
  );
});

test("rejects counters that move backward", () => {
  const tracker = createProgressTracker({
    startedAtMs: 0,
    deadlineMs: 10_000,
    stallMs: 2_000
  });

  observeProgress(tracker, { state: "running", processed: 10, total: 20 }, 0);
  assert.throws(
    () => observeProgress(
      tracker,
      { state: "running", processed: 9, total: 20 },
      100
    ),
    /progress counter regressed/
  );
});

test("waits for a state barrier using bounded polling", async () => {
  const snapshots = [
    { state: "accepted" },
    { state: "processing" },
    { state: "completed" }
  ];

  const result = await waitForStateBarrier({
    description: "operation completion",
    sample: async () => snapshots.shift(),
    matches: (snapshot) => snapshot.state === "completed",
    timeoutMs: 100,
    pollIntervalMs: 0
  });

  assert.equal(result.state, "completed");
});

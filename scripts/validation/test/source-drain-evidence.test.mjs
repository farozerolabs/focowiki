import assert from "node:assert/strict";
import test from "node:test";
import { calculateSourceDrainMetrics } from "../lib/source-drain-evidence.mjs";

test("calculates warmed throughput and separates cold-start drift", () => {
  const rows = Array.from({ length: 10 }, (_, index) => ({
    sourceFileId: `source-${index + 1}`,
    status: "completed",
    startedAt: new Date(index * 100).toISOString(),
    endedAt: new Date(index * 100 + 500).toISOString()
  }));

  const metrics = calculateSourceDrainMetrics(rows, 10);

  assert.equal(metrics.completedCount, 10);
  assert.equal(metrics.quintiles.length, 5);
  assert.equal(metrics.warmupExcludedCount, 2);
  assert.equal(metrics.coldToTailQuintileDriftPercent, 0);
  assert.equal(metrics.warmedQuintileDriftPercent, 0);
  assert.equal(metrics.warmedFilesPerSecond, 10);
});

test("excludes the cold-start quintile from steady-state drift", () => {
  const completionOffsets = [
    0, 1_000,
    1_100, 1_200,
    1_300, 1_400,
    1_500, 1_600,
    1_700, 1_800
  ];
  const rows = completionOffsets.map((offset, index) => ({
    sourceFileId: `source-${index + 1}`,
    status: "completed",
    startedAt: new Date(Math.max(0, offset - 100)).toISOString(),
    endedAt: new Date(offset).toISOString()
  }));

  const metrics = calculateSourceDrainMetrics(rows, 10);

  assert.equal(metrics.coldToTailQuintileDriftPercent, 900);
  assert.equal(metrics.warmedQuintileDriftPercent, 0);
});

test("rejects incomplete or failed source drains", () => {
  assert.throws(
    () => calculateSourceDrainMetrics([{
      sourceFileId: "source-failed",
      status: "failed",
      startedAt: new Date(0).toISOString(),
      endedAt: new Date(100).toISOString()
    }], 1),
    /completed source rows/
  );
});

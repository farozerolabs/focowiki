import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  captureStorageVnextStackResourceSample,
  createStorageVnextStackResourceSampler,
  mergeStorageVnextStackResourceSampleSummaries,
  selectStorageVnextPeakStackEvidence,
  summarizeStorageVnextStackResourceSamples
} from "../lib/storage-vnext-stack-resource-sampler.mjs";

test("captures the four runtime roles and four Compose services in one sample", async () => {
  const memory = new Map([
    ["postgres", "10\n"],
    ["redis", "20\n"],
    ["meilisearch", "30\n"],
    ["minio", "40\n"]
  ]);
  const captured = await captureStorageVnextStackResourceSample({
    execFile: async (file, args) => {
      if (file === "ps") {
        return {
          stdout: [
            " 1 unrelated-process",
            " 2 node /workspace/apps/api/runtime/main.mjs",
            " 3 node /workspace/apps/api/runtime/source-worker.mjs",
            " 4 node /workspace/apps/api/runtime/publication-worker.mjs",
            " 5 node /workspace/apps/api/runtime/maintenance-worker.mjs"
          ].join("\n")
        };
      }
      assert.equal(file, "docker");
      return { stdout: memory.get(args[7]) };
    },
    composeProject: "validation-project",
    composeFile: "docker-compose.local.yml",
    cwd: "/workspace",
    env: {}
  });

  assert.equal(captured.applicationRssBytes, 14 * 1_024);
  assert.equal(captured.stackRssBytes, 14 * 1_024 + 100);
});

test("summarizes concurrent stack samples without adding unrelated historical peaks", () => {
  const summary = summarizeStorageVnextStackResourceSamples([
    sample("2026-08-04T00:00:00.000Z", 100, 10, 20, 30, 40),
    sample("2026-08-04T00:00:05.000Z", 120, 11, 22, 33, 44)
  ]);

  assert.equal(summary.sampleCount, 2);
  assert.equal(summary.maximumStackRssBytes, 230);
  assert.equal(summary.maximumMeilisearchRssBytes, 33);
  assert.equal(summary.startedAt, "2026-08-04T00:00:00.000Z");
  assert.equal(summary.finishedAt, "2026-08-04T00:00:05.000Z");
});

test("samples immediately and once more when stopping", async () => {
  const captures = [
    sample("2026-08-04T00:00:00.000Z", 100, 10, 20, 30, 40),
    sample("2026-08-04T00:00:05.000Z", 120, 11, 22, 33, 44)
  ];
  const sampler = createStorageVnextStackResourceSampler({
    capture: async () => captures.shift(),
    intervalMs: 60_000
  });

  await sampler.start();
  const summary = await sampler.stop();

  assert.equal(summary.sampleCount, 2);
  assert.equal(captures.length, 0);
});

test("merges persisted sampling segments across a resumed rebuild", () => {
  const first = summarizeStorageVnextStackResourceSamples([
    sample("2026-08-04T00:00:00.000Z", 100, 10, 20, 30, 40),
    sample("2026-08-04T00:00:05.000Z", 120, 11, 22, 33, 44)
  ]);
  const resumed = summarizeStorageVnextStackResourceSamples([
    sample("2026-08-04T00:10:00.000Z", 90, 9, 18, 27, 36),
    sample("2026-08-04T00:10:05.000Z", 111, 12, 24, 36, 48)
  ]);

  const merged = mergeStorageVnextStackResourceSampleSummaries([first, resumed]);

  assert.equal(merged.sampleCount, 4);
  assert.equal(merged.segmentCount, 2);
  assert.equal(merged.startedAt, first.startedAt);
  assert.equal(merged.finishedAt, resumed.finishedAt);
  assert.equal(merged.maximumApplicationRssBytes, 120);
  assert.equal(merged.maximumMeilisearchRssBytes, 36);
  assert.equal(merged.maximumStackRssBytes, resumed.maximumStackRssBytes);
  assert.deepEqual(merged.maximumSample, resumed.maximumSample);
});

test("prefers covered concurrent evidence and labels the historical fallback", () => {
  const concurrent = selectStorageVnextPeakStackEvidence({
    sampling: summarizeStorageVnextStackResourceSamples([
      sample("2026-08-04T00:00:00.000Z", 100, 10, 20, 30, 40),
      sample("2026-08-04T00:00:05.000Z", 120, 11, 22, 33, 44)
    ]),
    rebuildStartedAt: "2026-08-04T00:00:00.000Z",
    rebuildFinishedAt: "2026-08-04T00:00:05.000Z",
    peakApplicationRssBytes: 1_000,
    containers: {
      postgres: { peakMemoryBytes: 2_000 },
      redis: { peakMemoryBytes: 3_000 },
      meilisearch: { peakMemoryBytes: 4_000 },
      minio: { peakMemoryBytes: 5_000 }
    }
  });
  const fallback = selectStorageVnextPeakStackEvidence({
    sampling: null,
    rebuildStartedAt: "2026-08-04T00:00:00.000Z",
    rebuildFinishedAt: "2026-08-04T00:00:05.000Z",
    peakApplicationRssBytes: 1_000,
    containers: {
      postgres: { peakMemoryBytes: 2_000 },
      redis: { peakMemoryBytes: 3_000 },
      meilisearch: { peakMemoryBytes: 4_000 },
      minio: { peakMemoryBytes: 5_000 }
    }
  });

  assert.deepEqual(concurrent, {
    peakApplicationRssBytes: 120,
    peakStackRssBytes: 230,
    basis: "concurrent full-rebuild samples",
    acceptanceReady: true
  });
  assert.deepEqual(fallback, {
    peakApplicationRssBytes: 1_000,
    peakStackRssBytes: 15_000,
    basis: "non-concurrent historical peak upper bound",
    acceptanceReady: false
  });
});

test("captures idle database connections after the idle observation window", () => {
  const source = fs.readFileSync(
    "scripts/validation/run-storage-vnext-scale-resources.mjs",
    "utf8"
  );
  const idleWindow = source.indexOf("await sleep(IDLE_WINDOW_MS)");
  const connectionCapture = source.indexOf(
    "await readIdleDatabaseConnectionCount()",
    idleWindow
  );

  assert.notEqual(idleWindow, -1);
  assert.ok(connectionCapture > idleWindow);
});

function sample(at, applicationRssBytes, postgres, redis, meilisearch, minio) {
  return {
    at,
    applicationRssBytes,
    containers: {
      postgres: { currentMemoryBytes: postgres },
      redis: { currentMemoryBytes: redis },
      meilisearch: { currentMemoryBytes: meilisearch },
      minio: { currentMemoryBytes: minio }
    }
  };
}

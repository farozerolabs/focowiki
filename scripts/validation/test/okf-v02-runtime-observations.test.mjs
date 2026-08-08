import assert from "node:assert/strict";
import test from "node:test";

import {
  combineOkfV02ResourceSnapshots,
  createOkfV02ResourceSampler,
  parseOkfV02ContainerResourceSnapshot,
  parseOkfV02ProcessResourceSnapshot,
  summarizeOkfV02NoopPublication
} from "../lib/okf-v02-runtime-observations.mjs";

test("OKF 0.2 process resource snapshots include only runtime services", () => {
  const snapshot = parseOkfV02ProcessResourceSnapshot(`
  12.5 1024 node /repo/apps/api/runtime/main.mjs
   4.5 2048 node /repo/apps/api/runtime/source-worker.mjs
   1.0 4096 unrelated
`);
  assert.deepEqual(snapshot, {
    cpuPercent: 17,
    rssBytes: 3 * 1024 * 1024,
    processCount: 2
  });
});

test("OKF 0.2 container observations add CPU and memory without identities", () => {
  const containers = parseOkfV02ContainerResourceSnapshot(
    "10.5% 128MiB / 1GiB\n2.5% 512KiB / 1GiB\n"
  );
  assert.deepEqual(containers, {
    cpuPercent: 13,
    rssBytes: 128 * 1024 * 1024 + 512 * 1024,
    containerCount: 2
  });
  assert.deepEqual(combineOkfV02ResourceSnapshots(
    { cpuPercent: 7, rssBytes: 100, processCount: 4 },
    containers
  ), {
    cpuPercent: 20,
    rssBytes: 128 * 1024 * 1024 + 512 * 1024 + 100,
    processCount: 6
  });
});

test("OKF 0.2 sampler records bounded peaks and elapsed time", async () => {
  const values = [
    { cpuPercent: 10, rssBytes: 100, processCount: 4 },
    { cpuPercent: 20, rssBytes: 120, processCount: 4 },
    { cpuPercent: 5, rssBytes: 110, processCount: 4 }
  ];
  let index = 0;
  const sampler = createOkfV02ResourceSampler({
    intervalMs: 5,
    capture: async () => values[Math.min(index++, values.length - 1)]
  });
  await sampler.start();
  await new Promise((resolve) => setTimeout(resolve, 8));
  const summary = await sampler.stop();
  assert(summary.sampleCount >= 2);
  assert.equal(summary.maximumCpuPercent, 20);
  assert.equal(summary.maximumRssBytes, 120);
  assert(summary.elapsedMs >= 0);
});

test("OKF 0.2 no-op publication requires stable release, objects, timestamps, and search", () => {
  const before = storeSnapshot();
  assert.deepEqual(summarizeOkfV02NoopPublication({
    before,
    after: structuredClone(before),
    beforeGenerated: "generated:\n  at: 2026-08-08T00:00:00Z",
    afterGenerated: "generated:\n  at: 2026-08-08T00:00:00Z",
    elapsedMs: 100,
    maximumCpuPercent: 25
  }), {
    activeReleaseStable: true,
    generatedBytesStable: true,
    s3ObjectsStable: true,
    searchChecksumStable: true,
    elapsedMs: 100,
    maximumCpuPercent: 25
  });
  assert.throws(() => summarizeOkfV02NoopPublication({
    before,
    after: { ...before, activeReleaseId: "release-b" },
    beforeGenerated: "same",
    afterGenerated: "same",
    elapsedMs: 100,
    maximumCpuPercent: 25
  }), /release/u);
});

function storeSnapshot() {
  return {
    activeReleaseId: "release-a",
    manifestChecksum: "a".repeat(64),
    searchDocumentChecksum: "b".repeat(64),
    searchDocumentCount: 200,
    searchLastBatchChecksum: "d".repeat(64),
    s3ObjectCount: 250,
    s3VersionCount: 250,
    s3TotalBytes: 1000,
    s3Fingerprint: "c".repeat(64),
    postgresTransactions: 10,
    postgresConnections: 5,
    redisCommandsProcessed: 20,
    redisUsedMemoryBytes: 30
  };
}

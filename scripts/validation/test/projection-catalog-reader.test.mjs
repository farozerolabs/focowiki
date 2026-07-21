import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  readProjectionCatalogRecords,
  readProjectionRecords
} from "../lib/projection-catalog-reader.mjs";

test("reads a legacy projection shard", async () => {
  const records = await readProjectionRecords({
    logicalPath: "_index/search/v1/0001.json",
    projectionKind: "search",
    expectedRecordCount: 2,
    readText: async () => JSON.stringify({
      formatVersion: 1,
      projection: "search",
      records: [{ id: "a" }, { id: "b" }]
    })
  });

  assert.deepEqual(records, [{ id: "a" }, { id: "b" }]);
});

test("materializes ordered projection segments", async () => {
  const segmentBodies = new Map([
    ["_segments/search/search/v1/0001/base-1.json", JSON.stringify({
      formatVersion: 2,
      projection: "search",
      logicalPartition: "search/v1/0001",
      segmentKind: "base",
      sequenceNumber: 1,
      records: [{ id: "a", value: 1 }, { id: "b", value: 1 }]
    })],
    ["_segments/search/search/v1/0001/tombstone-2.json", JSON.stringify({
      formatVersion: 2,
      projection: "search",
      logicalPartition: "search/v1/0001",
      segmentKind: "tombstone",
      sequenceNumber: 2,
      tombstones: ["a"]
    })],
    ["_segments/search/search/v1/0001/delta-3.json", JSON.stringify({
      formatVersion: 2,
      projection: "search",
      logicalPartition: "search/v1/0001",
      segmentKind: "delta",
      sequenceNumber: 3,
      records: [{ id: "b", value: 2 }, { id: "c", value: 1 }]
    })]
  ]);
  const segments = [...segmentBodies].map(([path, body], index) => ({
    kind: index === 0 ? "base" : index === 1 ? "tombstone" : "delta",
    sequence: index + 1,
    path,
    checksumSha256: createHash("sha256").update(body).digest("hex"),
    entryCount: index === 0 ? 2 : index === 1 ? 1 : 2,
    encodedBytes: Buffer.byteLength(body)
  }));
  const manifestPath = "_index/search/v1/0001.json";
  const manifest = JSON.stringify({
    formatVersion: 2,
    projection: "search",
    logicalPartition: "search/v1/0001",
    recordCount: 2,
    segments
  });
  const reads = [];

  const records = await readProjectionRecords({
    logicalPath: manifestPath,
    projectionKind: "search",
    expectedRecordCount: 2,
    readText: async (path) => {
      reads.push(path);
      return path === manifestPath ? manifest : segmentBodies.get(path);
    }
  });

  assert.deepEqual(records, [{ id: "b", value: 2 }, { id: "c", value: 1 }]);
  assert.deepEqual(reads, [manifestPath, ...segmentBodies.keys()]);
});

test("materializes a v3 manifest with an inline current segment", async () => {
  const basePath = "_segments/search/search/v1/0001/base-1.json";
  const baseBody = JSON.stringify({
    formatVersion: 2,
    projection: "search",
    logicalPartition: "search/v1/0001",
    segmentKind: "base",
    sequenceNumber: 1,
    records: [{ id: "a", value: 1 }, { id: "b", value: 1 }]
  });
  const manifestPath = "_index/search/v1/0001.json";
  const manifest = JSON.stringify({
    formatVersion: 3,
    projection: "search",
    logicalPartition: "search/v1/0001",
    recordCount: 2,
    segments: [{
      kind: "base",
      sequence: 1,
      path: basePath,
      checksumSha256: createHash("sha256").update(baseBody).digest("hex"),
      entryCount: 2,
      encodedBytes: Buffer.byteLength(baseBody)
    }],
    inlineSegments: [{
      kind: "tombstone",
      sequence: 2,
      entryCount: 1,
      tombstones: ["a"]
    }, {
      kind: "delta",
      sequence: 3,
      entryCount: 2,
      records: [{ id: "b", value: 2 }, { id: "c", value: 1 }]
    }]
  });
  const reads = [];

  const records = await readProjectionRecords({
    logicalPath: manifestPath,
    projectionKind: "search",
    expectedRecordCount: 2,
    readText: async (path) => {
      reads.push(path);
      return path === manifestPath ? manifest : baseBody;
    }
  });

  assert.deepEqual(records, [{ id: "b", value: 2 }, { id: "c", value: 1 }]);
  assert.deepEqual(reads, [manifestPath, basePath]);
});

test("materializes a prior v3 inline manifest through its immutable segment path", async () => {
  const priorPath = "_segments/search/search/v1/0001/delta-1.json";
  const priorBody = JSON.stringify({
    formatVersion: 3,
    projection: "search",
    logicalPartition: "search/v1/0001",
    recordCount: 1,
    segments: [],
    inlineSegments: [{
      kind: "delta",
      sequence: 1,
      entryCount: 1,
      records: [{ id: "a", value: 1 }]
    }]
  });
  const manifestPath = "_index/search/v1/0001.json";
  const manifest = JSON.stringify({
    formatVersion: 3,
    projection: "search",
    logicalPartition: "search/v1/0001",
    recordCount: 2,
    segments: [{
      kind: "delta",
      sequence: 1,
      path: priorPath,
      checksumSha256: createHash("sha256").update(priorBody).digest("hex"),
      entryCount: 1,
      encodedBytes: Buffer.byteLength(priorBody)
    }],
    inlineSegments: [{
      kind: "delta",
      sequence: 2,
      entryCount: 1,
      records: [{ id: "b", value: 2 }]
    }]
  });

  const records = await readProjectionRecords({
    logicalPath: manifestPath,
    projectionKind: "search",
    expectedRecordCount: 2,
    readText: async (path) => path === manifestPath ? manifest : priorBody
  });

  assert.deepEqual(records, [{ id: "a", value: 1 }, { id: "b", value: 2 }]);
});

test("rejects a segment checksum mismatch", async () => {
  await assert.rejects(
    readProjectionRecords({
      logicalPath: "_index/tree/v1/0001.json",
      projectionKind: "tree",
      expectedRecordCount: 1,
      readText: async (path) => path.startsWith("_index/")
        ? JSON.stringify({
            formatVersion: 2,
            projection: "tree",
            logicalPartition: "tree/v1/0001",
            recordCount: 1,
            segments: [{
              kind: "delta",
              sequence: 1,
              path: "_segments/tree/tree/v1/0001/delta-1.json",
              checksumSha256: "0".repeat(64),
              entryCount: 1,
              encodedBytes: 1
            }]
          })
        : JSON.stringify({
            formatVersion: 2,
            projection: "tree",
            logicalPartition: "tree/v1/0001",
            segmentKind: "delta",
            sequenceNumber: 1,
            records: [{ id: "a" }]
          })
    }),
    /checksum/i
  );
});

test("reads projection segments concurrently and applies them in sequence order", async () => {
  const segmentBodies = new Map([
    ["_segments/search/search/v1/0001/base-1.json", JSON.stringify({
      formatVersion: 2,
      projection: "search",
      logicalPartition: "search/v1/0001",
      segmentKind: "base",
      sequenceNumber: 1,
      records: [{ id: "shared", value: 1 }]
    })],
    ["_segments/search/search/v1/0001/delta-2.json", JSON.stringify({
      formatVersion: 2,
      projection: "search",
      logicalPartition: "search/v1/0001",
      segmentKind: "delta",
      sequenceNumber: 2,
      records: [{ id: "shared", value: 2 }]
    })],
    ["_segments/search/search/v1/0001/delta-3.json", JSON.stringify({
      formatVersion: 2,
      projection: "search",
      logicalPartition: "search/v1/0001",
      segmentKind: "delta",
      sequenceNumber: 3,
      records: [{ id: "final", value: 3 }]
    })]
  ]);
  const segments = [...segmentBodies].map(([path, body], index) => ({
    kind: index === 0 ? "base" : "delta",
    sequence: index + 1,
    path,
    checksumSha256: createHash("sha256").update(body).digest("hex"),
    entryCount: 1,
    encodedBytes: Buffer.byteLength(body)
  }));
  const manifestPath = "_index/search/v1/0001.json";
  const manifest = JSON.stringify({
    formatVersion: 2,
    projection: "search",
    logicalPartition: "search/v1/0001",
    recordCount: 2,
    segments
  });
  let activeReads = 0;
  let maxActiveReads = 0;

  const records = await readProjectionRecords({
    logicalPath: manifestPath,
    projectionKind: "search",
    expectedRecordCount: 2,
    segmentReadConcurrency: 2,
    readText: async (path) => {
      if (path === manifestPath) return manifest;
      activeReads += 1;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      await new Promise((resolve) => setTimeout(resolve, path.includes("base-1") ? 30 : 5));
      activeReads -= 1;
      return segmentBodies.get(path);
    }
  });

  assert.equal(maxActiveReads, 2);
  assert.deepEqual(records, [
    { id: "final", value: 3 },
    { id: "shared", value: 2 }
  ]);
});

test("reads catalog shards concurrently and preserves descriptor order", async () => {
  const shardPaths = [
    "_index/search/v1/0001.json",
    "_index/search/v1/0002.json",
    "_index/search/v1/0003.json"
  ];
  let activeReads = 0;
  let maxActiveReads = 0;

  const records = await readProjectionCatalogRecords({
    shards: shardPaths.map((path) => ({ path, recordCount: 1 })),
    projectionKind: "search",
    shardReadConcurrency: 2,
    readText: async (path) => {
      activeReads += 1;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      await new Promise((resolve) => setTimeout(resolve, path.endsWith("0001.json") ? 30 : 5));
      activeReads -= 1;
      return JSON.stringify({
        formatVersion: 1,
        projection: "search",
        records: [{ id: path }]
      });
    }
  });

  assert.equal(maxActiveReads, 2);
  assert.deepEqual(records.map((record) => record.id), shardPaths);
});

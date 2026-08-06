import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStorageVnextCapacityProjection,
  classifyStorageVnextCapacityProjectionAssessment
} from "../lib/storage-vnext-capacity-projection.mjs";

function measured() {
  return {
    fileCount: 29_736,
    sourceBytes: 526_803_253,
    storage: {
      postgresDirectoryBytes: 3_000_000_000,
      s3AllVersionsBytes: 4_000_000_000,
      meilisearchPhysicalBytes: 3_500_000_000,
      redisPersistedBytes: 5_000_000,
      fourStoreTotalBytes: 10_505_000_000
    },
    objects: {
      currentSourceObjects: 29_736,
      activeGeneratedObjects: 80_000,
      searchDocuments: 120_000,
      graphNodes: 29_736,
      graphEdges: 40_000
    },
    throughput: { filesPerSecond: 1.5 },
    boundedTerms: [
      { name: "candidate roots", bounded: true, limit: 1, limitKind: "count" },
      { name: "rollback roots", bounded: true, limit: 1, limitKind: "count" },
      { name: "terminal results", bounded: true, limit: 100_000, limitKind: "count" },
      { name: "security audit", bounded: true, limit: 100_000, limitKind: "count" },
      { name: "structured logs", bounded: true, limit: 1_073_741_824, limitKind: "bytes" },
      { name: "graph edges per source", bounded: true, limit: 20, limitKind: "per-file" }
    ]
  };
}

test("projects exact 100,000 and 1,000,000-file capacities from measured coefficients", () => {
  const result = buildStorageVnextCapacityProjection(measured());
  assert.deepEqual(result.targets.map((target) => target.fileCount), [100_000, 1_000_000]);
  assert.equal(result.coefficients.fileBasis, 29_736);
  assert.equal(result.ageOrGenerationTerms.every((term) => term.bounded), true);
  assert.equal(result.nonlinearComponents.graphEdges.order, "O(n * bounded-degree)");
});

test("rejects inconsistent totals and any unbounded age or Generation term", () => {
  const inconsistent = measured();
  inconsistent.storage.fourStoreTotalBytes -= 1;
  assert.throws(
    () => buildStorageVnextCapacityProjection(inconsistent),
    /capacity projection/u
  );

  const unbounded = measured();
  unbounded.boundedTerms.push({
    name: "Generation history",
    bounded: false,
    limit: null,
    limitKind: null
  });
  assert.throws(
    () => buildStorageVnextCapacityProjection(unbounded),
    /unbounded age or Generation/u
  );
});

test("keeps measured capacity projections available without hiding budget failures", () => {
  assert.equal(classifyStorageVnextCapacityProjectionAssessment({
    ok: true,
    failures: []
  }), "within-budget");
  assert.equal(classifyStorageVnextCapacityProjectionAssessment({
    ok: false,
    failures: ["storage.fourStoreTotalBytes exceeds maximum"]
  }), "measured-with-budget-failures");
  assert.throws(
    () => classifyStorageVnextCapacityProjectionAssessment({ ok: false, failures: [] }),
    /assessment/u
  );
});

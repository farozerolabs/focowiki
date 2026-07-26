import assert from "node:assert/strict";
import test from "node:test";
import {
  buildInterleavedBaselineSnapshot
} from "../lib/interleaved-baseline.mjs";
import { createEvidenceRedactor } from "../lib/interleaved-evidence-redaction.mjs";

test("builds a redacted before-state across PostgreSQL, Redis, S3 ownership, and services", () => {
  const baseline = buildInterleavedBaselineSnapshot({
    redactor: createEvidenceRedactor("run-seed"),
    postgres: {
      counts: { sourceFiles: 10 },
      knowledgeBases: [{
        id: "kb-private",
        activeGenerationId: "generation-private"
      }],
      immutableObjects: [{
        lifecycleState: "active",
        count: 20,
        totalSizeBytes: 1024
      }],
      runtimeSettings: [{ key: "worker", version: 2 }],
      workers: [{ role: "source", activeJobCount: 0 }]
    },
    redis: {
      totalKeys: 1,
      byType: { string: 1 },
      keys: [{ alias: "redis-key-a", type: "string" }]
    },
    services: [
      { name: "postgres", state: "healthy" },
      { name: "api", state: "stopped" }
    ]
  });

  assert.equal(baseline.postgres.counts.sourceFiles, 10);
  assert.match(
    baseline.postgres.knowledgeBases[0].id,
    /^id-[a-f0-9]{12}$/u
  );
  assert.equal(baseline.storage.registeredObjects[0].count, 20);
  assert.equal(baseline.redis.totalKeys, 1);
  assert.equal(baseline.services[1].state, "stopped");
  assert.doesNotMatch(JSON.stringify(baseline), /kb-private|generation-private/u);
});

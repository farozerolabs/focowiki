import assert from "node:assert/strict";
import test from "node:test";

import {
  buildComprehensivePerformanceIdentity,
  compareComprehensivePerformanceIdentity
} from "../lib/comprehensive-performance-identity.mjs";

test("freezes one complete redacted comparable performance identity", () => {
  const identity = buildComprehensivePerformanceIdentity(fixture());
  assert.match(identity.identitySha256, /^[a-f0-9]{64}$/u);
  assert.equal(identity.corpus.fileCount, 200);
  assert.equal(JSON.stringify(identity).includes("credential"), false);
});

test("rejects aggregate corpus substitution and credential-shaped identity fields", () => {
  assert.throws(() => buildComprehensivePerformanceIdentity(fixture({
    corpus: { ...fixture().corpus, fileCount: 199 }
  })), /corpus cardinality/u);
  assert.throws(() => buildComprehensivePerformanceIdentity(fixture({
    runtime: {
      ...fixture().runtime,
      password: "must-not-enter-evidence"
    }
  })), /credential-shaped/u);
});

test("marks a changed provider or measurement window non-comparable", () => {
  const baseline = buildComprehensivePerformanceIdentity(fixture());
  const changed = buildComprehensivePerformanceIdentity(fixture({
    providers: { ...fixture().providers, opensearchVersion: "3.8.1" }
  }));
  assert.deepEqual(compareComprehensivePerformanceIdentity(baseline, changed), {
    comparable: false,
    differences: ["providers"]
  });
});

function fixture(overrides = {}) {
  return {
    runId: "validation-20260810111944-b648eb2f",
    application: {
      commit: "b648eb2f61f50d60ea0800a80061b638270f1698",
      dirtyFileCount: 1,
      worktreeFingerprintSha256: "a".repeat(64)
    },
    corpus: {
      manifestSha256: "b".repeat(64),
      fileCount: 200,
      officialFileCount: 53,
      legalFileCount: 147
    },
    database: { schemaFingerprintSha256: "c".repeat(64) },
    runtime: {
      settingsRevisionPublicId: "settings-revision",
      settingsChecksumSha256: "d".repeat(64)
    },
    models: [
      { role: "generation", revisionPublicId: "generation-1", state: "active" },
      { role: "embedding", revisionPublicId: "embedding-1", dimension: 1024 },
      { role: "reranker", revisionPublicId: "reranker-1", state: "active" }
    ],
    providers: { opensearchVersion: "3.8.0", meilisearchVersion: "1.17.1" },
    docker: {
      roles: ["api", "source-worker", "publication-worker", "maintenance-worker"]
        .map((role) => ({ role, memoryBytes: 1, nanoCpus: 1, pidsLimit: 1 }))
    },
    host: { architecture: "arm64", logicalCpuCount: 8, memoryBytes: 16_000_000_000 },
    measurement: {
      clientConcurrency: [1, 20],
      warmupRepetitions: 1,
      measuredRepetitions: 3,
      telemetryIntervalMs: 1000
    },
    externalTimeClassifications: {
      generation: "external-model",
      embedding: "external-model",
      reranker: "external-model",
      s3: "local-container",
      opensearch: "local-container",
      meilisearch: "local-container"
    },
    ...overrides
  };
}

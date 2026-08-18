import assert from "node:assert/strict";
import test from "node:test";

import { reconcileComprehensiveDockerRuntime } from
  "../lib/comprehensive-docker-runtime-ledger.mjs";

function running(service, overrides = {}) {
  return {
    service,
    state: "running",
    health: "healthy",
    exitCode: 0,
    restartCount: 0,
    privileged: false,
    capAdd: [],
    nanoCpus: service === "worker" ? 2_000_000_000 : 0,
    memoryBytes: service === "worker" ? 2_147_483_648 : 0,
    pidsLimit: service === "worker" ? 128 : null,
    runtimeUid: ["api", "worker"].includes(service) ? 1000 : null,
    publishedPorts: [],
    mounts: [],
    environmentNames: [],
    ...overrides
  };
}

test("reconciles active services, one-shot jobs, and an inactive alternate provider", () => {
  const result = reconcileComprehensiveDockerRuntime({
    selectedProfile: "meilisearch",
    expectedActiveServices: ["api", "migrate", "worker", "meilisearch"],
    oneShotServices: ["migrate"],
    appRuntimeServices: ["api", "worker"],
    resourceLimitedServices: ["worker"],
    allowedInactiveServices: ["opensearch"],
    containers: [
      running("api"),
      running("worker"),
      running("meilisearch"),
      running("migrate", { state: "exited", health: null }),
      running("opensearch", { state: "exited", health: "unhealthy", exitCode: 143 })
    ]
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.counts, {
    activeServices: 4,
    runningServices: 3,
    completedOneShots: 1,
    inactiveServices: 1,
    restarts: 0,
    unsafePorts: 0,
    privileged: 0
  });
});

test("rejects missing services, duplicate containers, unhealthy state, and unsafe ports", () => {
  const base = {
    selectedProfile: "meilisearch",
    expectedActiveServices: ["api"],
    oneShotServices: [],
    appRuntimeServices: ["api"],
    resourceLimitedServices: [],
    allowedInactiveServices: [],
    containers: [running("api")]
  };
  assert.throws(() => reconcileComprehensiveDockerRuntime({
    ...base,
    expectedActiveServices: ["api", "redis"]
  }), /active service identities/u);
  assert.throws(() => reconcileComprehensiveDockerRuntime({
    ...base,
    containers: [running("api"), running("api")]
  }), /duplicate/u);
  assert.throws(() => reconcileComprehensiveDockerRuntime({
    ...base,
    containers: [running("api", { health: "unhealthy" })]
  }), /healthy/u);
  assert.throws(() => reconcileComprehensiveDockerRuntime({
    ...base,
    containers: [running("api", {
      publishedPorts: [{ hostIp: "0.0.0.0", hostPort: "43000", containerPort: "43000/tcp" }]
    })]
  }), /loopback/u);
});

test("rejects root app processes, privilege, restart, and missing worker limits", () => {
  const base = {
    selectedProfile: "meilisearch",
    expectedActiveServices: ["worker"],
    oneShotServices: [],
    appRuntimeServices: ["worker"],
    resourceLimitedServices: ["worker"],
    allowedInactiveServices: [],
    containers: [running("worker")]
  };
  assert.throws(() => reconcileComprehensiveDockerRuntime({
    ...base,
    containers: [running("worker", { runtimeUid: 0 })]
  }), /non-root/u);
  assert.throws(() => reconcileComprehensiveDockerRuntime({
    ...base,
    containers: [running("worker", { privileged: true })]
  }), /privileged/u);
  assert.throws(() => reconcileComprehensiveDockerRuntime({
    ...base,
    containers: [running("worker", { restartCount: 1 })]
  }), /restart/u);
  assert.throws(() => reconcileComprehensiveDockerRuntime({
    ...base,
    containers: [running("worker", { memoryBytes: 0 })]
  }), /resource limits/u);
});

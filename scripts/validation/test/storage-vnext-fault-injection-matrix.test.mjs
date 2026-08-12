import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  FAULT_BOUNDARIES,
  FAULT_COMPONENTS,
  FAULT_INJECTION_CASES,
  FAULT_TYPES,
  LIVE_FAULT_INJECTION_CASES,
  assertStorageVnextFaultInjectionCoverage,
  buildFaultInjectionSuites,
  faultInjectionTestFiles,
  selectLiveFaultInjectionCases
} from "../lib/storage-vnext-fault-injection-matrix.mjs";

test("covers every required component, failure type, and durable boundary", () => {
  const coverage = assertStorageVnextFaultInjectionCoverage(FAULT_INJECTION_CASES);
  assert.deepEqual(coverage, {
    caseCount: 35,
    components: [...FAULT_COMPONENTS],
    faultTypes: [...FAULT_TYPES],
    boundaries: [...FAULT_BOUNDARIES]
  });
  assert.equal(coverage.components.includes("opensearch"), true);
  assert.equal(coverage.components.includes("postgres"), true);
  assert.equal(
    FAULT_INJECTION_CASES.filter((item) => item.component === "postgres").length,
    2
  );
  assert.equal(
    FAULT_INJECTION_CASES.filter((item) => item.component === "opensearch").length,
    6
  );
});

test("binds every fault case to a real named test", () => {
  for (const faultCase of FAULT_INJECTION_CASES) {
    const filePath = path.resolve(faultCase.evidence.file);
    assert.equal(fs.existsSync(filePath), true, faultCase.evidence.file);
    const source = fs.readFileSync(filePath, "utf8");
    assert.equal(
      source.includes(`it(\"${faultCase.evidence.testName}\"`)
        || source.includes(`test(\"${faultCase.evidence.testName}\"`),
      true,
      `${faultCase.id}: ${faultCase.evidence.testName}`
    );
  }
});

test("runs only the unique evidence files declared by the matrix", () => {
  const files = faultInjectionTestFiles(FAULT_INJECTION_CASES);
  assert.equal(files.length, new Set(files).size);
  assert.ok(files.every((file) => file.startsWith("apps/api/test/")
    || file.startsWith("packages/okf/test/")));
});

test("groups contract and owned-database evidence into executable suites", () => {
  const suites = buildFaultInjectionSuites(FAULT_INJECTION_CASES);
  assert.deepEqual(suites.map((suite) => ({
    id: suite.id,
    packageName: suite.packageName,
    requiresOwnedDatabase: suite.requiresOwnedDatabase
  })), [
    {
      id: "api-contract",
      packageName: "@focowiki/api",
      requiresOwnedDatabase: false
    },
    {
      id: "okf-contract",
      packageName: "@focowiki/okf",
      requiresOwnedDatabase: false
    },
    {
      id: "api-repository",
      packageName: "@focowiki/api",
      requiresOwnedDatabase: true
    }
  ]);
  assert.deepEqual(
    [...new Set(suites.flatMap((suite) => suite.files))].sort(),
    faultInjectionTestFiles(FAULT_INJECTION_CASES).sort()
  );
});

test("reserves real runtime disruption for local dependencies and processes", () => {
  assert.deepEqual(LIVE_FAULT_INJECTION_CASES, [
    {
      id: "live-api-restart-pre-write",
      component: "api",
      faultType: "process_restart",
      boundary: "pre_write"
    },
    {
      id: "live-redis-refusal-post-write",
      component: "redis",
      faultType: "refusal",
      boundary: "post_write"
    },
    {
      id: "live-s3-refusal-pre-write",
      component: "s3",
      faultType: "refusal",
      boundary: "pre_write"
    },
    {
      id: "live-worker-restart-post-write",
      component: "worker",
      faultType: "process_restart",
      boundary: "post_write"
    },
    {
      id: "live-meilisearch-refusal-pre-activation",
      component: "meilisearch",
      faultType: "refusal",
      boundary: "pre_activation"
    },
    {
      id: "live-opensearch-refusal-pre-activation",
      component: "opensearch",
      faultType: "refusal",
      boundary: "pre_activation"
    }
  ]);
});

test("selects only the active provider for live Docker disruption", () => {
  assert.deepEqual(
    selectLiveFaultInjectionCases("opensearch").map((item) => item.id),
    [
      "live-api-restart-pre-write",
      "live-redis-refusal-post-write",
      "live-s3-refusal-pre-write",
      "live-worker-restart-post-write",
      "live-opensearch-refusal-pre-activation"
    ]
  );
});

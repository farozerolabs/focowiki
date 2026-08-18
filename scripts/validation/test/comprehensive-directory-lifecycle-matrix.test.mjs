import assert from "node:assert/strict";
import test from "node:test";

import {
  DIRECTORY_LIFECYCLE_ACTIONS,
  assertComprehensiveDirectoryLifecyclePlan,
  buildComprehensiveDirectoryLifecyclePlan
} from "../lib/comprehensive-directory-lifecycle-matrix.mjs";

const files = [
  {
    alias: "official-001",
    knowledgeBaseId: "knowledge-base-official",
    relativePath: "official/acme/metrics/revenue.md"
  },
  {
    alias: "official-002",
    knowledgeBaseId: "knowledge-base-official",
    relativePath: "official/acme/tables/orders.md"
  },
  {
    alias: "legacy-001",
    knowledgeBaseId: "knowledge-base-legacy",
    relativePath: "legacy/civil/code.md"
  }
];

const directories = [
  directory("knowledge-base-official", "directory-official", "official", null),
  directory("knowledge-base-official", "directory-acme", "official/acme", "directory-official"),
  directory("knowledge-base-official", "directory-metrics", "official/acme/metrics", "directory-acme"),
  directory("knowledge-base-official", "directory-tables", "official/acme/tables", "directory-acme"),
  directory("knowledge-base-legacy", "directory-legacy", "legacy", null),
  directory("knowledge-base-legacy", "directory-civil", "legacy/civil", "directory-legacy")
];

test("builds one lifecycle case for every action and every derived directory", () => {
  const plan = buildComprehensiveDirectoryLifecyclePlan({ files, directories });

  assert.equal(plan.counts.files, 3);
  assert.equal(plan.counts.directories, 6);
  assert.equal(plan.counts.cases, 6 * DIRECTORY_LIFECYCLE_ACTIONS.length);
  assert.equal(plan.directories[2].relativePath, "official/acme/metrics");
  assert.deepEqual(plan.directories[2].descendantAliases, ["official-001"]);
  assert.deepEqual(
    plan.cases.filter((item) => item.directoryAlias === "directory-003")
      .map((item) => item.action),
    DIRECTORY_LIFECYCLE_ACTIONS
  );
  assert.doesNotThrow(() => assertComprehensiveDirectoryLifecyclePlan(plan, {
    expectedFileCount: 3,
    expectedDirectoryCount: 6
  }));
});

test("rejects a missing, duplicate, foreign, or bulk-substituted directory", () => {
  assert.throws(() => buildComprehensiveDirectoryLifecyclePlan({
    files,
    directories: directories.slice(1)
  }), /directory coverage/u);
  assert.throws(() => buildComprehensiveDirectoryLifecyclePlan({
    files,
    directories: [...directories, directories[0]]
  }), /directory identity/u);
  assert.throws(() => buildComprehensiveDirectoryLifecyclePlan({
    files,
    directories: [
      ...directories,
      directory("knowledge-base-foreign", "directory-foreign", "foreign", null)
    ]
  }), /directory coverage/u);
  const plan = buildComprehensiveDirectoryLifecyclePlan({ files, directories });
  plan.cases[0].id = "bulk-pass";
  assert.throws(() => assertComprehensiveDirectoryLifecyclePlan(plan, {
    expectedFileCount: 3,
    expectedDirectoryCount: 6
  }), /case cardinality/u);
});

test("includes a run-owned empty runtime directory with explicit zero descendants", () => {
  const plan = buildComprehensiveDirectoryLifecyclePlan({
    files,
    directories: [
      ...directories,
      directory("knowledge-base-official", "directory-empty", "validation", null)
    ]
  });

  assert.equal(plan.counts.directories, 7);
  assert.deepEqual(
    plan.directories.find((item) => item.relativePath === "validation")
      ?.descendantAliases,
    []
  );
});

function directory(knowledgeBaseId, directoryId, relativePath, parentDirectoryId) {
  return {
    knowledgeBaseId,
    directoryId,
    parentDirectoryId,
    relativePath,
    resourceRevision: 1
  };
}

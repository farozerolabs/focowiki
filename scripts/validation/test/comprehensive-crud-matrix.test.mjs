import assert from "node:assert/strict";
import test from "node:test";

import {
  CRUD_FILE_ACTIONS,
  CRUD_MUTATION_ACTIONS,
  assertComprehensiveCrudPlan,
  buildComprehensiveCrudPlan
} from "../lib/comprehensive-crud-matrix.mjs";

const corpus = [
  { alias: "official-001", family: "official", checksumSha256: "a".repeat(64) },
  { alias: "legacy-001", family: "legacy", checksumSha256: "b".repeat(64) }
];

test("enumerates every required CRUD action for every corpus file", () => {
  const plan = buildComprehensiveCrudPlan(corpus);

  assert.doesNotThrow(() => assertComprehensiveCrudPlan(plan, {
    expectedFileCount: 2
  }));
  assert.equal(plan.files.length, 2);
  assert.equal(plan.cases.length, CRUD_FILE_ACTIONS.length * 2);
  assert.equal(CRUD_FILE_ACTIONS.includes("controlled-source-failure"), true);
  assert.equal(CRUD_FILE_ACTIONS.includes("controlled-failure-replace"), false);
  for (const file of plan.files) {
    assert.deepEqual(
      plan.cases.filter((item) => item.alias === file.alias).map((item) => item.action),
      CRUD_FILE_ACTIONS
    );
  }
});

test("creates one explicit all-file disposition row after every individual mutation", () => {
  const plan = buildComprehensiveCrudPlan(corpus);

  assert.equal(
    plan.dispositions.length,
    corpus.length * CRUD_MUTATION_ACTIONS.length * corpus.length
  );
  const rename = plan.dispositions.filter((item) =>
    item.mutationAlias === "official-001" && item.action === "rename");
  assert.deepEqual(rename, [
    {
      id: "crud-impact:official-001:rename:official-001",
      mutationAlias: "official-001",
      action: "rename",
      observedAlias: "official-001",
      expectedDisposition: "affected"
    },
    {
      id: "crud-impact:official-001:rename:legacy-001",
      mutationAlias: "official-001",
      action: "rename",
      observedAlias: "legacy-001",
      expectedDisposition: "intentionally-unchanged"
    }
  ]);
  assert.equal(
    plan.dispositions.find((item) =>
      item.mutationAlias === "official-001"
      && item.action === "restore-after-retry"
      && item.observedAlias === "official-001")?.expectedDisposition,
    "intentionally-unchanged"
  );
});

test("rejects a missing file action or aggregate-only impact row", () => {
  const plan = buildComprehensiveCrudPlan(corpus);
  assert.throws(
    () => assertComprehensiveCrudPlan({
      ...plan,
      cases: plan.cases.slice(1)
    }, { expectedFileCount: 2 }),
    /CRUD case cardinality mismatch/u
  );
  assert.throws(
    () => assertComprehensiveCrudPlan({
      ...plan,
      dispositions: [{ id: "bulk-pass" }]
    }, { expectedFileCount: 2 }),
    /CRUD impact cardinality mismatch/u
  );
});

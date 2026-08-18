import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  assertComprehensiveTestInventorySnapshot,
  assertDeterministicBaseline,
  buildComprehensiveTestInventory,
  buildComprehensiveTestInventorySnapshot,
  buildDeterministicBaselineSummary,
  parseNodeJunitBaselineReport,
  parseVitestBaselineReport
} from "../lib/comprehensive-test-baseline.mjs";

const repositoryRoot = process.cwd();
const inventory = buildComprehensiveTestInventory(repositoryRoot);

test("freezes every current test file and assigns one deterministic taxonomy", () => {
  assert.ok(inventory.every((row) => row.suite && row.taxonomy && /^[a-f0-9]{64}$/u.test(row.sha256)));
  const expected = JSON.parse(fs.readFileSync(
    "scripts/validation/fixtures/comprehensive-test-inventory.json",
    "utf8"
  ));
  assert.doesNotThrow(() => assertComprehensiveTestInventorySnapshot(inventory, expected));
  assert.deepEqual(buildComprehensiveTestInventorySnapshot(inventory), expected);
});

test("parses Vitest and Node test reports into item-level baseline rows", () => {
  const vitest = parseVitestBaselineReport({
    testResults: [{
      name: `${repositoryRoot}/apps/api/test/example.test.ts`,
      assertionResults: [
        { fullName: "passes", status: "passed" },
        { fullName: "waits for Docker", status: "skipped" }
      ]
    }]
  }, repositoryRoot);
  const junit = parseNodeJunitBaselineReport(
    `<testsuites><testcase name="node pass" file="${repositoryRoot}/scripts/validation/test/example.test.mjs"/><testcase name="node skip" file="${repositoryRoot}/scripts/validation/test/example.test.mjs"><skipped/></testcase></testsuites>`,
    repositoryRoot
  );
  assert.deepEqual(vitest.map((row) => row.status), ["passed", "skipped"]);
  assert.deepEqual(junit.map((row) => row.status), ["passed", "skipped"]);
});

test("rejects failures, unknown skips, stale dispositions, and duplicate results", () => {
  const passed = { id: "pass", runner: "test", status: "passed" };
  const skipped = { id: "skip", runner: "test", status: "skipped" };
  assert.throws(() => assertDeterministicBaseline({ rows: [{ ...passed, status: "failed" }] }));
  assert.throws(() => assertDeterministicBaseline({ rows: [skipped], skipDispositions: [] }));
  assert.throws(() => assertDeterministicBaseline({ rows: [passed], skipDispositions: [{ id: "skip", task: "6.1", reason: "later" }] }));
  assert.throws(() => assertDeterministicBaseline({ rows: [passed, passed] }));
  assert.doesNotThrow(() => buildDeterministicBaselineSummary({
    rows: [passed, skipped],
    skipDispositions: [{ id: "skip", task: "6.1", reason: "Requires the immutable official checkout." }],
    inventorySnapshot: { count: 2 }
  }));
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  assertComprehensiveManualChecklist,
  buildComprehensiveManualChecklist
} from "../lib/comprehensive-manual-checklist.mjs";

const REQUIRED_CATEGORIES = ["inventory", "corpus-file", "search-query"];

test("builds one immutable pending row for every source item", () => {
  const report = buildComprehensiveManualChecklist({
    runId: "validation-20260810111944-b648eb2f",
    applicationFingerprint: "a".repeat(64),
    requiredCategories: REQUIRED_CATEGORIES,
    collections: [
      collection("inventory", "source-inventory.json", ["admin-ui:one", "admin-api:one"]),
      collection("corpus-file", "corpus.json", ["official-001", "legacy-001"]),
      collection("search-query", "search.json", ["official-001:exact", "legacy-001:exact"])
    ]
  });

  assert.equal(report.coverageMode, "exhaustive");
  assert.equal(report.rows.length, 6);
  assert.deepEqual(report.counts, {
    "corpus-file": 2,
    inventory: 2,
    "search-query": 2
  });
  assert.equal(report.rows.every((row) => row.manualStatus === "pending"), true);
  assert.equal(new Set(report.rows.map((row) => row.id)).size, 6);
  assert.match(report.checklistFingerprintSha256, /^[a-f0-9]{64}$/u);
  assert.doesNotThrow(() => assertComprehensiveManualChecklist(report));
});

test("rejects missing categories, duplicate items, and aggregate substitutions", () => {
  const base = {
    runId: "validation-20260810111944-b648eb2f",
    applicationFingerprint: "b".repeat(64),
    requiredCategories: REQUIRED_CATEGORIES
  };

  assert.throws(() => buildComprehensiveManualChecklist({
    ...base,
    collections: [
      collection("inventory", "source.json", ["one"]),
      collection("corpus-file", "corpus.json", ["one"])
    ]
  }), /missing required category/u);

  assert.throws(() => buildComprehensiveManualChecklist({
    ...base,
    collections: [
      collection("inventory", "source.json", ["one", "one"]),
      collection("corpus-file", "corpus.json", ["one"]),
      collection("search-query", "search.json", ["one"])
    ]
  }), /duplicate checklist item/u);

  assert.throws(() => buildComprehensiveManualChecklist({
    ...base,
    collections: [
      collection("inventory", "source.json", ["one"]),
      collection("corpus-file", "corpus.json", ["one"]),
      collection("search-query", "search.json", ["bulk-pass"])
    ]
  }), /aggregate checklist item/u);
});

function collection(category, source, ids) {
  return {
    category,
    source,
    granularity: "item",
    items: ids.map((id) => ({ id }))
  };
}

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  MODEL_FAULT_CASES,
  MODEL_FAULT_ROLES,
  MODEL_FAULT_TYPES,
  assertComprehensiveModelFaultCoverage
} from "../lib/comprehensive-model-fault-matrix.mjs";

test("covers every model role and controlled failure type one by one", () => {
  const coverage = assertComprehensiveModelFaultCoverage(MODEL_FAULT_CASES);
  assert.equal(coverage.caseCount, 21);
  assert.deepEqual(coverage.roles, MODEL_FAULT_ROLES);
  assert.deepEqual(coverage.faultTypes, MODEL_FAULT_TYPES);
});

test("binds every controlled model failure to an exact current test", () => {
  for (const item of MODEL_FAULT_CASES) {
    const file = path.resolve(item.file);
    assert.equal(fs.existsSync(file), true, item.id);
    assert.match(fs.readFileSync(file, "utf8"), new RegExp(
      escapeRegExp(item.testName), "u"
    ), item.id);
  }
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

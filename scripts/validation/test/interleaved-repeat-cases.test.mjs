import assert from "node:assert/strict";
import test from "node:test";
import {
  assertRepeatedConflictCoverage,
  REPEATED_CONFLICT_CASES
} from "../lib/interleaved-repeat-cases.mjs";

test("defines unique repeated-operation cases for upload, modification, and deletion", () => {
  const ids = REPEATED_CONFLICT_CASES.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes("task-delete-idempotent-overlap"));
  assert.ok(ids.includes("task-delete-after-terminal"));
  assert.deepEqual(
    [...new Set(REPEATED_CONFLICT_CASES.map((entry) => entry.family))].sort(),
    ["deletion", "modification", "upload"]
  );
});

test("rejects incomplete repeated-operation evidence", () => {
  assert.throws(
    () => assertRepeatedConflictCoverage(["upload-session-idempotent-replay"]),
    /coverage mismatch/u
  );
});

test("accepts exact repeated-operation evidence", () => {
  assert.doesNotThrow(() => assertRepeatedConflictCoverage(
    REPEATED_CONFLICT_CASES.map((entry) => entry.id)
  ));
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  selectInterleavedScenarios
} from "../lib/interleaved-scenario-selection.mjs";

const scenarios = [
  { id: "first", caseIndex: 0 },
  { id: "second", caseIndex: 1 },
  { id: "third", caseIndex: 2 }
];

test("selects requested pending scenarios without changing stable case indexes", () => {
  assert.deepEqual(
    selectInterleavedScenarios({
      scenarios,
      completedIds: new Set(["first"]),
      requestedIds: new Set(["third"]),
      limit: 1
    }),
    [{ id: "third", caseIndex: 2 }]
  );
});

test("rejects unknown requested scenario identities", () => {
  assert.throws(
    () => selectInterleavedScenarios({
      scenarios,
      completedIds: new Set(),
      requestedIds: new Set(["unknown"]),
      limit: 1
    }),
    /unknown interleaved scenario/iu
  );
});

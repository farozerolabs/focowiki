import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  assertInterleavedRunOwned,
  createInterleavedRunState,
  registerInterleavedOwnership
} from "../lib/interleaved-lifecycle-run-state.mjs";

test("creates a run-scoped lifecycle state and exact evidence directory", () => {
  const state = createInterleavedRunState({
    runId: "validation-20260726123000-1234abcd",
    reportRoot: "ReferenceDocs/validate-interleaved-lifecycle-e2e"
  });

  assert.equal(state.runId, "validation-20260726123000-1234abcd");
  assert.equal(
    state.evidenceDir,
    path.resolve(
      "ReferenceDocs/validate-interleaved-lifecycle-e2e",
      "runs",
      state.runId
    )
  );
  assert.equal(state.cleanup.completed, false);
});

test("allows cleanup only for exact run-owned identities", () => {
  const state = createInterleavedRunState({
    runId: "validation-20260726123000-1234abcd",
    reportRoot: "ReferenceDocs/validate-interleaved-lifecycle-e2e"
  });
  registerInterleavedOwnership(state, "knowledgeBases", "kb-owned");

  assert.doesNotThrow(() =>
    assertInterleavedRunOwned(state, "knowledgeBases", "kb-owned")
  );
  assert.throws(
    () => assertInterleavedRunOwned(state, "knowledgeBases", "kb-existing"),
    /not owned by this validation run/
  );
});

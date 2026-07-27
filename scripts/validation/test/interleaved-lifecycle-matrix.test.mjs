import assert from "node:assert/strict";
import test from "node:test";
import {
  LIFECYCLES,
  MODIFICATION_CASES,
  buildDirectedPairwiseMatrix,
  buildFourLifecyclePermutations,
  buildThreeLifecyclePermutations
} from "../lib/interleaved-lifecycle-matrix.mjs";

test("builds every directed pairwise lifecycle overlap", () => {
  const matrix = buildDirectedPairwiseMatrix();

  assert.deepEqual(LIFECYCLES, [
    "upload",
    "modification",
    "deletion",
    "maintenance"
  ]);
  assert.equal(matrix.length, 12);
  assert.equal(new Set(matrix.map((scenario) => scenario.id)).size, 12);

  for (const active of LIFECYCLES) {
    for (const started of LIFECYCLES) {
      if (active === started) continue;
      assert.ok(
        matrix.some(
          (scenario) =>
            scenario.activeLifecycle === active &&
            scenario.startedLifecycle === started
        ),
        `${started} during ${active}`
      );
    }
  }
});

test("builds complete three-way and bounded four-way start orders", () => {
  const threeWay = buildThreeLifecyclePermutations();
  const fourWay = buildFourLifecyclePermutations();

  assert.equal(threeWay.length, 24);
  assert.equal(new Set(threeWay.map((scenario) => scenario.id)).size, 24);
  assert.equal(fourWay.length, 24);
  assert.equal(new Set(fourWay.map((scenario) => scenario.id)).size, 24);
  assert.ok(
    fourWay.some((scenario) => scenario.order[0] === "modification")
  );
  assert.ok(
    fourWay.some((scenario) => scenario.order.at(-1) === "modification")
  );
});

test("keeps every supported modification flow explicit", () => {
  assert.deepEqual(MODIFICATION_CASES, [
    "source-content-replace",
    "source-file-rename",
    "source-file-move",
    "source-directory-rename",
    "source-directory-move",
    "knowledge-base-metadata-update"
  ]);
});

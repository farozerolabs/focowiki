export const LIFECYCLES = Object.freeze([
  "upload",
  "modification",
  "deletion",
  "maintenance"
]);

export const MODIFICATION_CASES = Object.freeze([
  "source-content-replace",
  "source-file-rename",
  "source-file-move",
  "source-directory-rename",
  "source-directory-move",
  "knowledge-base-metadata-update"
]);

export function buildDirectedPairwiseMatrix() {
  return LIFECYCLES.flatMap((activeLifecycle) =>
    LIFECYCLES
      .filter((startedLifecycle) => startedLifecycle !== activeLifecycle)
      .map((startedLifecycle) => ({
        id: `${startedLifecycle}-during-${activeLifecycle}`,
        activeLifecycle,
        startedLifecycle
      }))
  );
}

export function buildThreeLifecyclePermutations() {
  return combinations(LIFECYCLES, 3).flatMap((subset) =>
    permutations(subset).map((order) => ({
      id: `three-way-${order.join("-then-")}`,
      lifecycles: [...subset],
      order
    }))
  );
}

export function buildFourLifecyclePermutations() {
  return permutations(LIFECYCLES).map((order) => ({
    id: `four-way-${order.join("-then-")}`,
    lifecycles: [...LIFECYCLES],
    order
  }));
}

function combinations(values, size, start = 0, prefix = []) {
  if (prefix.length === size) return [prefix];

  const output = [];
  for (let index = start; index <= values.length - (size - prefix.length); index += 1) {
    output.push(
      ...combinations(values, size, index + 1, [...prefix, values[index]])
    );
  }
  return output;
}

function permutations(values) {
  if (values.length <= 1) return [[...values]];

  return values.flatMap((value, index) =>
    permutations([
      ...values.slice(0, index),
      ...values.slice(index + 1)
    ]).map((tail) => [value, ...tail])
  );
}

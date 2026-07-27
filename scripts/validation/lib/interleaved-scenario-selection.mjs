export function selectInterleavedScenarios(input) {
  const completedIds = input.completedIds ?? new Set();
  const requestedIds = input.requestedIds ?? new Set();
  const knownIds = new Set(input.scenarios.map((scenario) => scenario.id));

  for (const requestedId of requestedIds) {
    if (!knownIds.has(requestedId)) {
      throw new Error(`Unknown interleaved scenario: ${requestedId}.`);
    }
  }

  return input.scenarios
    .filter((scenario) => !completedIds.has(scenario.id))
    .filter(
      (scenario) =>
        requestedIds.size === 0 || requestedIds.has(scenario.id)
    )
    .slice(0, input.limit);
}

import type { ResourceBudgetLimits } from "../runtime/resource-budget.js";
import type { RuntimeSettingsSnapshot } from "./types.js";

export function resolveResourceBudgetLimits(
  snapshot: RuntimeSettingsSnapshot
): ResourceBudgetLimits {
  return {
    model: snapshot.activeModel?.suggestionConcurrency ?? 1,
    generatedObjectWrite: snapshot.publication.generatedObjectWriteConcurrency
  };
}

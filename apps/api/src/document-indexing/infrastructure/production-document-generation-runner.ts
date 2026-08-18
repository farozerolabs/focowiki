import type { createDocumentResourcePermits } from
  "../application/document-resource-permits.js";
import type { WeightedGenerationTaskRunner } from
  "../application/weighted-generation-task-runner.js";
import { modelEvaluationError } from
  "./document-model-evaluation-validation.js";

export function runDocumentGeneration<TResult>(
  input: {
    permits?: ReturnType<typeof createDocumentResourcePermits>;
    generation?: WeightedGenerationTaskRunner;
  },
  workClass: "first_layer" | "candidate_delta",
  operation: () => Promise<TResult>,
  options: {
    signal?: AbortSignal;
    onMetric(metric: { waitTimeMs: number; serviceTimeMs: number }): void;
  }
): Promise<TResult> {
  if (input.generation) {
    return input.generation.run(workClass, operation, options);
  }
  if (input.permits) {
    return input.permits.run("generation_model", operation, options);
  }
  throw modelEvaluationError("MODEL_GENERATION_RUNNER_MISSING");
}
